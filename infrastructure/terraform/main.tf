terraform {
  required_version = ">= 1.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_ami" "amazon_linux_2023" {
  most_recent = true
  owners      = ["amazon"]
  filter {
    name   = "name"
    values = ["al2023-ami-*-x86_64"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

data "aws_vpc" "default" {
  default = true
}

resource "random_id" "bucket_suffix" {
  byte_length = 4
}

# Security Group
resource "aws_security_group" "riftfound_ec2" {
  name        = "riftfound-ec2-sg"
  description = "Security group for Riftfound EC2"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.allowed_ssh_cidr]
    description = "SSH"
  }

  ingress {
    from_port   = 3001
    to_port     = 3001
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "API"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "riftfound-ec2-sg" }
}

# IAM Role
resource "aws_iam_role" "riftfound_ec2" {
  name = "riftfound-ec2-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.riftfound_ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "dynamodb" {
  name = "riftfound-dynamodb-access"
  role = aws_iam_role.riftfound_ec2.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:Scan",
        "dynamodb:BatchGetItem",
        "dynamodb:BatchWriteItem",
        "dynamodb:DescribeTable"
      ]
      Resource = [
        "arn:aws:dynamodb:us-west-2:*:table/riftfound-prod",
        "arn:aws:dynamodb:us-west-2:*:table/riftfound-prod/index/*"
      ]
    }]
  })
}

resource "aws_iam_instance_profile" "riftfound_ec2" {
  name = "riftfound-ec2-profile"
  role = aws_iam_role.riftfound_ec2.name
}

# EBS Volume (persistent SQLite storage)
resource "aws_ebs_volume" "riftfound_data" {
  availability_zone = data.aws_availability_zones.available.names[0]
  size              = var.ebs_volume_size
  type              = "gp3"
  encrypted         = true
  tags = { Name = "riftfound-data" }
}

# EC2 Instance
resource "aws_instance" "riftfound" {
  ami                    = data.aws_ami.amazon_linux_2023.id
  instance_type          = var.instance_type
  key_name               = var.ssh_key_name
  vpc_security_group_ids = [aws_security_group.riftfound_ec2.id]
  iam_instance_profile   = aws_iam_instance_profile.riftfound_ec2.name
  availability_zone      = data.aws_availability_zones.available.names[0]

  root_block_device {
    volume_size = 30
    volume_type = "gp3"
    encrypted   = true
  }

  user_data = <<-USERDATA
    #!/bin/bash
    set -e
    dnf update -y
    dnf install -y nodejs20 npm git
    useradd -m -s /bin/bash riftfound || true
    while [ ! -e /dev/xvdf ]; do sleep 1; done
    if ! blkid /dev/xvdf; then mkfs -t ext4 /dev/xvdf; fi
    mkdir -p /data
    mount /dev/xvdf /data || true
    grep -q '/dev/xvdf' /etc/fstab || echo '/dev/xvdf /data ext4 defaults,nofail 0 2' >> /etc/fstab
    chown -R riftfound:riftfound /data
    mkdir -p /opt/riftfound
    chown -R riftfound:riftfound /opt/riftfound
    npm install -g pm2
  USERDATA

  tags = { Name = "riftfound-server" }

  # Prevent instance replacement when AMI updates
  lifecycle {
    ignore_changes = [ami, user_data]
  }
}

resource "aws_volume_attachment" "riftfound_data" {
  device_name = "/dev/xvdf"
  volume_id   = aws_ebs_volume.riftfound_data.id
  instance_id = aws_instance.riftfound.id
}

resource "aws_eip" "riftfound" {
  instance = aws_instance.riftfound.id
  domain   = "vpc"
  tags = { Name = "riftfound-eip" }
}

# S3 Bucket for Frontend
resource "aws_s3_bucket" "frontend" {
  bucket = "riftfound-frontend-${random_id.bucket_suffix.hex}"
  tags = { Name = "riftfound-frontend" }
}

# S3 Bucket for CloudFront Logs
resource "aws_s3_bucket" "logs" {
  bucket = "riftfound-logs-${random_id.bucket_suffix.hex}"
  tags   = { Name = "riftfound-logs" }
}

resource "aws_s3_bucket_ownership_controls" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    object_ownership = "BucketOwnerPreferred"
  }
}

resource "aws_s3_bucket_acl" "logs" {
  depends_on = [aws_s3_bucket_ownership_controls.logs]
  bucket     = aws_s3_bucket.logs.id
  acl        = "private"
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    id     = "expire-old-logs"
    status = "Enabled"

    expiration {
      days = 90
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket                  = aws_s3_bucket.frontend.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ACM Certificate
resource "aws_acm_certificate" "main" {
  provider                  = aws.us_east_1
  domain_name               = var.domain_name
  subject_alternative_names = ["www.${var.domain_name}"]
  validation_method         = "DNS"
  lifecycle { create_before_destroy = true }
  tags = { Name = "riftfound-cert" }
}

# CloudFront OAC
resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "riftfound-frontend-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# S3 Bucket Policy
resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontAccess"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.frontend.arn}/*"
      Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.main.arn } }
    }]
  })
}

# CloudFront Distribution
resource "aws_cloudfront_distribution" "main" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  aliases             = [var.domain_name, "www.${var.domain_name}"]
  price_class         = "PriceClass_100"

  logging_config {
    include_cookies = false
    bucket          = aws_s3_bucket.logs.bucket_domain_name
    prefix          = "cloudfront/"
  }

  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = "S3-Frontend"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  origin {
    domain_name = aws_eip.riftfound.public_dns
    origin_id   = "EC2-API"
    custom_origin_config {
      http_port              = 3001
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # API Gateway origin (serverless backend)
  dynamic "origin" {
    for_each = var.use_dynamodb ? [1] : []
    content {
      domain_name = replace(aws_apigatewayv2_api.main[0].api_endpoint, "https://", "")
      origin_id   = "APIGateway"
      custom_origin_config {
        http_port              = 80
        https_port             = 443
        origin_protocol_policy = "https-only"
        origin_ssl_protocols   = ["TLSv1.2"]
      }
    }
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "S3-Frontend"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true
    forwarded_values {
      query_string = false
      cookies { forward = "none" }
    }
  }

  ordered_cache_behavior {
    path_pattern           = "/api/*"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = var.use_dynamodb ? "APIGateway" : "EC2-API"
    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 0
    max_ttl                = 0
    forwarded_values {
      query_string = true
      headers      = ["Origin", "Access-Control-Request-Headers", "Access-Control-Request-Method"]
      cookies { forward = "none" }
    }
  }

  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }

  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate.main.arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = { Name = "riftfound-cdn" }
  depends_on = [aws_acm_certificate.main]
}
