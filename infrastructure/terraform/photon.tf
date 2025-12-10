# Security group for Photon
resource "aws_security_group" "photon" {
  name        = "${var.project_name}-photon"
  description = "Security group for Photon geocoder"
  vpc_id      = data.aws_vpc.default.id

  # Photon API (restrict to your backend in production)
  ingress {
    description = "Photon API"
    from_port   = 2322
    to_port     = 2322
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"] # TODO: Restrict to backend security group
  }

  # SSH access (optional, for debugging)
  dynamic "ingress" {
    for_each = var.ssh_key_name != "" ? [1] : []
    content {
      description = "SSH"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = [var.allowed_ssh_cidr]
    }
  }

  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project_name}-photon"
  }
}

# IAM role for EC2 (allows SSM Session Manager instead of SSH)
resource "aws_iam_role" "photon" {
  name = "${var.project_name}-photon-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "photon_ssm" {
  role       = aws_iam_role.photon.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "photon" {
  name = "${var.project_name}-photon-profile"
  role = aws_iam_role.photon.name
}

# User data script to install Docker and run Photon
locals {
  # Build docker run command with optional country filter
  photon_env_flag = var.photon_country != "" ? "-e PHOTON_COUNTRY=${var.photon_country}" : ""

  photon_user_data = <<-EOF
    #!/bin/bash
    set -ex

    # Install Docker
    dnf install -y docker
    systemctl enable docker
    systemctl start docker

    # Mount the data EBS volume
    # Wait for volume to attach
    while [ ! -e /dev/nvme1n1 ] && [ ! -e /dev/xvdf ]; do sleep 1; done

    # Format if new (check if has filesystem)
    DEVICE=$([ -e /dev/nvme1n1 ] && echo /dev/nvme1n1 || echo /dev/xvdf)
    if ! blkid $DEVICE; then
      mkfs.ext4 $DEVICE
    fi

    # Mount
    mkdir -p /photon_data
    mount $DEVICE /photon_data
    echo "$DEVICE /photon_data ext4 defaults,nofail 0 2" >> /etc/fstab

    # Run Photon container
    # Worldwide data (~70GB) takes 1-2 hours to download
    # US-only data (~8GB) takes 20-30 minutes
    docker run -d \
      --name photon \
      --restart unless-stopped \
      -p 2322:2322 \
      -v /photon_data:/photon/photon_data \
      ${local.photon_env_flag} \
      komoot/photon

    # Log completion
    echo "Photon container started at $(date)" >> /var/log/photon-setup.log
    echo "Country filter: ${var.photon_country != "" ? var.photon_country : "worldwide"}" >> /var/log/photon-setup.log
  EOF
}

# EC2 instance for Photon
resource "aws_instance" "photon" {
  ami                    = data.aws_ami.amazon_linux.id
  instance_type          = var.photon_instance_type
  subnet_id              = data.aws_subnets.default.ids[0]
  vpc_security_group_ids = [aws_security_group.photon.id]
  iam_instance_profile   = aws_iam_instance_profile.photon.name
  key_name               = var.ssh_key_name != "" ? var.ssh_key_name : null

  # Root volume for OS
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }

  # Data volume for Photon (persists across instance replacements if you snapshot)
  ebs_block_device {
    device_name           = "/dev/sdf"
    volume_size           = var.photon_volume_size
    volume_type           = "gp3"
    delete_on_termination = false # Keep data if instance is terminated
  }

  user_data = base64encode(local.photon_user_data)

  tags = {
    Name = "${var.project_name}-photon"
  }

  # Wait for instance to be ready before considering it created
  lifecycle {
    create_before_destroy = true
  }
}

# Elastic IP for stable address
resource "aws_eip" "photon" {
  instance = aws_instance.photon.id
  domain   = "vpc"

  tags = {
    Name = "${var.project_name}-photon"
  }
}
