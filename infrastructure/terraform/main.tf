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
  count       = var.use_ec2 ? 1 : 0
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
  count = var.use_ec2 ? 1 : 0
  name  = "riftfound-ec2-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  count      = var.use_ec2 ? 1 : 0
  role       = aws_iam_role.riftfound_ec2[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "dynamodb" {
  count = var.use_ec2 ? 1 : 0
  name  = "riftfound-dynamodb-access"
  role  = aws_iam_role.riftfound_ec2[0].id

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
  count = var.use_ec2 ? 1 : 0
  name  = "riftfound-ec2-profile"
  role  = aws_iam_role.riftfound_ec2[0].name
}

# EBS Volume (persistent SQLite storage)
resource "aws_ebs_volume" "riftfound_data" {
  count             = var.use_ec2 ? 1 : 0
  availability_zone = data.aws_availability_zones.available.names[0]
  size              = var.ebs_volume_size
  type              = "gp3"
  encrypted         = true
  tags              = { Name = "riftfound-data" }
}

# EC2 Instance
resource "aws_instance" "riftfound" {
  count                  = var.use_ec2 ? 1 : 0
  ami                    = data.aws_ami.amazon_linux_2023.id
  instance_type          = var.instance_type
  key_name               = var.ssh_key_name
  vpc_security_group_ids = [aws_security_group.riftfound_ec2[0].id]
  iam_instance_profile   = aws_iam_instance_profile.riftfound_ec2[0].name
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
  count       = var.use_ec2 ? 1 : 0
  device_name = "/dev/xvdf"
  volume_id   = aws_ebs_volume.riftfound_data[0].id
  instance_id = aws_instance.riftfound[0].id
}

resource "aws_eip" "riftfound" {
  count    = var.use_ec2 ? 1 : 0
  instance = aws_instance.riftfound[0].id
  domain   = "vpc"
  tags     = { Name = "riftfound-eip" }
}

# Optional lookup for an additional EIP-backed origin. Toggled via
# var.extra_origin_eip_name_tag; empty by default so this data source
# is not evaluated.
data "aws_eip" "extra_origin" {
  count = var.extra_origin_eip_name_tag != "" ? 1 : 0
  filter {
    name   = "tag:Name"
    values = [var.extra_origin_eip_name_tag]
  }
}

# S3 Bucket for Frontend
resource "aws_s3_bucket" "frontend" {
  bucket = "riftfound-frontend-${random_id.bucket_suffix.hex}"
  tags   = { Name = "riftfound-frontend" }
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

# CloudFront Function — SPA routing
#
# Rewrites extensionless, non-API paths to /index.html at viewer-request time
# so React Router deep links work WITHOUT a distribution-wide
# `custom_error_response` 404 -> 200 rule. See spa_router.js for the full
# rationale, and the "SPA routing" section of README.md.
#
# Why a CloudFront Function and not Lambda@Edge: this is ~15 lines of string
# matching with no I/O. A CloudFront Function runs at every edge POP in
# sub-millisecond time for $0.10 per million invocations; Lambda@Edge runs in a
# regional cache, adds tens of milliseconds, and costs ~15x more per request
# plus GB-seconds. Narrowing the cache behaviors alone cannot fix this —
# `custom_error_response` is a distribution-level setting in the CloudFront API,
# so there is no way to scope the old rule to the S3 behavior only.
resource "aws_cloudfront_function" "spa_router" {
  name    = "riftfound-spa-router-${var.environment}"
  runtime = "cloudfront-js-2.0"
  comment = "Rewrite SPA deep links to /index.html; leave /api/*, /iykyk* and real files alone"
  publish = true
  code    = file("${path.module}/spa_router.js")
}

# CloudFront caching for /api/*
#
# Every /api/* response used to be served with min/default/max TTL of 0, so the
# edge was a pass-through: one Lambda invocation, one API Gateway request and a
# full set of DynamoDB reads per visitor per request, even though the answers
# are byte-identical for everyone. The rankings endpoints are the worst fit for
# that — the rating engine only refits every RANKING_REFIT_INTERVAL_HOURS
# (24h), so an hour of edge cache costs nothing in freshness and collapses a
# traffic spike to a handful of origin hits.
#
# **The TTLs are not here.** They are `s-maxage` on the responses themselves
# (backend/src/middleware/cacheControl.ts), because the code that knows how
# often a thing changes is the code that serves it: the ranking routes follow
# the refit cadence, the event list follows the hourly scraper, /visit must
# never be cached at all. These policies exist to let those headers through —
# `default_ttl = 0` means a response that forgets to say anything is not
# cached, which is the safe direction to fail.
resource "aws_cloudfront_origin_request_policy" "api" {
  name    = "riftfound-api-origin-${var.environment}"
  comment = "Forward the whole query string and the CORS trio to the API; no cookies"

  # The cache *key* is deliberately narrower than this (see below), and
  # anything left out of a cache key is also left out of the origin request
  # unless an origin request policy puts it back. Without this the API would
  # stop seeing query parameters it was never caching on.
  query_strings_config {
    query_string_behavior = "all"
  }

  headers_config {
    header_behavior = "whitelist"
    headers {
      items = ["Origin", "Access-Control-Request-Headers", "Access-Control-Request-Method"]
    }
  }

  # The API has no sessions and reads no cookies. Forwarding them would only
  # risk a third-party cookie reaching the origin.
  cookies_config {
    cookie_behavior = "none"
  }
}

# The general API cache key: every query parameter, nothing else.
#
# Keying on all of them is never *wrong* — a parameter that changes the answer
# always changes the key — it only splits the cache when a caller adds a
# parameter that does not matter. For the event list that is the right trade:
# the query carries lat/lng/radiusKm/eventType/dates and the set grows, so a
# whitelist here would eventually serve one filter's answer for another's.
resource "aws_cloudfront_cache_policy" "api" {
  name    = "riftfound-api-${var.environment}"
  comment = "API responses, TTL from the origin's Cache-Control"

  min_ttl     = 0
  default_ttl = 0 # no Cache-Control from the origin => not cached
  max_ttl     = 604800

  parameters_in_cache_key_and_forwarded_to_origin {
    # CloudFront gzips/brotlis at the edge for free and the API was sending
    # none: the calendar's `calendarMode` payload measured 149,904 bytes on the
    # wire with `Accept-Encoding: gzip` already on the request, because the
    # /api/* behavior never set `compress`. JSON of that shape compresses about
    # 8x.
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true

    query_strings_config {
      query_string_behavior = "all"
    }

    # `Access-Control-Allow-Origin` is `*` in Lambda mode (see app.ts), so the
    # body does not vary by Origin and the header has no business in the key.
    # OPTIONS is not in `cached_methods`, so preflights still reach the origin.
    headers_config {
      header_behavior = "none"
    }

    cookies_config {
      cookie_behavior = "none"
    }
  }
}

# The ranking family's cache key: only the parameters those routes read.
#
# These endpoints are the expensive ones — /api/rankings alone costs ~66 read
# units and four DynamoDB round trips — and their parameters are a short, fixed
# list, so the key is worth narrowing: a crawler or a share link that appends
# something of its own gets the cached answer instead of a refit-scale query.
#
# NOTE: a new query parameter on /api/rankings, /api/players/* or /api/sets
# must be added here, or the edge will ignore it and serve another value's
# answer. The list as of now, route by route:
#   /api/rankings              scope, limit, cursor
#   /api/players/search        q, limit
#   /api/players/:id           -
#   /api/players/:id/matches   limit, cursor, setId
#   /api/players/:id/ratings   scope, limit
#   /api/sets                  -
resource "aws_cloudfront_cache_policy" "api_ranking" {
  name    = "riftfound-api-ranking-${var.environment}"
  comment = "Ranking/player/set responses, keyed on their own query parameters only"

  min_ttl     = 0
  default_ttl = 0
  max_ttl     = 604800

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true

    query_strings_config {
      query_string_behavior = "whitelist"
      query_strings {
        items = ["scope", "limit", "cursor", "setId", "q"]
      }
    }

    headers_config {
      header_behavior = "none"
    }

    cookies_config {
      cookie_behavior = "none"
    }
  }
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

  # EC2-API origin (only when EC2 is enabled)
  dynamic "origin" {
    for_each = var.use_ec2 ? [1] : []
    content {
      domain_name = aws_eip.riftfound[0].public_dns
      origin_id   = "EC2-API"
      custom_origin_config {
        http_port              = 3001
        https_port             = 443
        origin_protocol_policy = "http-only"
        origin_ssl_protocols   = ["TLSv1.2"]
      }
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

  # Optional extra origin (see var.extra_origin_*)
  dynamic "origin" {
    for_each = var.extra_origin_eip_name_tag != "" ? [1] : []
    content {
      domain_name = data.aws_eip.extra_origin[0].public_dns
      origin_id   = "ExtraOrigin"
      custom_origin_config {
        http_port              = 80
        https_port             = 443
        origin_protocol_policy = "http-only"
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

    # SPA deep-link rewrite. Deliberately ONLY on the default behavior: the
    # /api/* and /iykyk* behaviors must never run it.
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa_router.arn
    }
  }

  # The ranking family, ahead of /api/* so the narrower cache key wins. These
  # three patterns do not overlap each other, so their relative order is
  # irrelevant; being *before* the catch-all is not.
  dynamic "ordered_cache_behavior" {
    for_each = ["/api/rankings*", "/api/players*", "/api/sets*"]
    content {
      path_pattern           = ordered_cache_behavior.value
      allowed_methods        = ["GET", "HEAD", "OPTIONS"]
      cached_methods         = ["GET", "HEAD"]
      target_origin_id       = var.use_dynamodb || !var.use_ec2 ? "APIGateway" : "EC2-API"
      viewer_protocol_policy = "redirect-to-https"
      compress               = true

      cache_policy_id          = aws_cloudfront_cache_policy.api_ranking.id
      origin_request_policy_id = aws_cloudfront_origin_request_policy.api.id
    }
  }

  # Everything else under /api/*. Still one behavior, because the thing that
  # decides whether a response is cached is the response: /api/events answers
  # with the scraper's cadence, /api/events/<id>/visit answers `no-store` and
  # keeps its click in the access log. `default_ttl = 0` on the policy means a
  # route that says nothing is not cached, so a new endpoint is safe by
  # default and opts in by sending a header.
  ordered_cache_behavior {
    path_pattern           = "/api/*"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = var.use_dynamodb || !var.use_ec2 ? "APIGateway" : "EC2-API"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    cache_policy_id          = aws_cloudfront_cache_policy.api.id
    origin_request_policy_id = aws_cloudfront_origin_request_policy.api.id
  }

  # Optional extra cache behavior (see var.extra_origin_*)
  dynamic "ordered_cache_behavior" {
    for_each = var.extra_origin_path_pattern != "" && var.extra_origin_eip_name_tag != "" ? [1] : []
    content {
      path_pattern           = var.extra_origin_path_pattern
      allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
      cached_methods         = ["GET", "HEAD"]
      target_origin_id       = "ExtraOrigin"
      viewer_protocol_policy = "redirect-to-https"
      min_ttl                = 0
      default_ttl            = 0
      max_ttl                = 0
      compress               = true
      forwarded_values {
        query_string = true
        # CloudFront disallows Connection/Host/Upgrade in the legacy header
        # whitelist — WebSocket upgrade is handled automatically for custom
        # origins regardless of what's forwarded here.
        headers = ["Origin", "Access-Control-Request-Headers", "Access-Control-Request-Method", "Authorization", "Sec-WebSocket-Key", "Sec-WebSocket-Version", "Sec-WebSocket-Protocol", "Sec-WebSocket-Extensions"]
        cookies { forward = "all" }
      }
    }
  }

  # NO custom_error_response here, on purpose.
  #
  # There used to be 403 -> /index.html (200) and 404 -> /index.html (200).
  # `custom_error_response` is distribution-wide, so those rules also rewrote
  # every legitimate API error: /api/players/does-not-exist answered 200
  # text/html, so clients got response.ok === true and then failed parsing the
  # SPA shell as JSON — which is why "not found" surfaced as a generic error
  # instead of an empty state. They also masked stale deploys, serving the
  # shell for a missing /assets/*.js.
  #
  # aws_cloudfront_function.spa_router now does the deep-link rewrite on the
  # default behavior only. Everything else returns its real status: /api/* its
  # JSON 400/404, a missing asset the 403 that S3 returns through OAC.
  # Do not add a blanket rule back.

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate.main.arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags       = { Name = "riftfound-cdn" }
  depends_on = [aws_acm_certificate.main]
}
