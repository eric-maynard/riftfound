# Security group for Backend API
resource "aws_security_group" "backend" {
  name        = "${var.project_name}-backend"
  description = "Security group for Backend API"
  vpc_id      = data.aws_vpc.default.id

  # HTTP API
  ingress {
    description = "HTTP API"
    from_port   = 3001
    to_port     = 3001
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # HTTPS (if you add a reverse proxy later)
  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # SSH access (optional)
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
    Name = "${var.project_name}-backend"
  }
}

# IAM role for Backend EC2
resource "aws_iam_role" "backend" {
  name = "${var.project_name}-backend-role"

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

# SSM access for Session Manager
resource "aws_iam_role_policy_attachment" "backend_ssm" {
  role       = aws_iam_role.backend.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# Allow backend to read database password from SSM Parameter Store
resource "aws_iam_role_policy" "backend_ssm_params" {
  name = "${var.project_name}-backend-ssm-params"
  role = aws_iam_role.backend.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters"
        ]
        Resource = "arn:aws:ssm:${var.aws_region}:*:parameter/${var.project_name}/*"
      }
    ]
  })
}

resource "aws_iam_instance_profile" "backend" {
  name = "${var.project_name}-backend-profile"
  role = aws_iam_role.backend.name
}

# User data script to set up backend
locals {
  backend_user_data = <<-EOF
    #!/bin/bash
    set -ex

    # Install Node.js 20 and PostgreSQL client
    dnf install -y nodejs20 npm git postgresql15

    # Install PM2 for process management
    npm install -g pm2

    # Create app user
    useradd -m -s /bin/bash riftfound || true

    # Clone repo (you'll need to set up deploy keys or make repo public)
    cd /home/riftfound
    sudo -u riftfound git clone ${var.github_repo} app || true
    cd app

    # Install dependencies
    sudo -u riftfound npm install
    cd backend && sudo -u riftfound npm install && cd ..
    cd scraper && sudo -u riftfound npm install && cd ..

    # Get database password from SSM Parameter Store
    DB_PASSWORD=$(aws ssm get-parameter --name "/${var.project_name}/database/password" --with-decryption --query 'Parameter.Value' --output text --region ${var.aws_region})

    # Create environment file
    cat > /home/riftfound/app/.env << ENVFILE
    NODE_ENV=production
    DB_TYPE=postgres
    DATABASE_URL=postgresql://riftfound:$DB_PASSWORD@${aws_db_instance.main.endpoint}/riftfound
    PHOTON_URL=http://${aws_eip.photon.public_ip}:2322
    ENVFILE
    chown riftfound:riftfound /home/riftfound/app/.env
    chmod 600 /home/riftfound/app/.env

    # Wait for RDS to be available
    until PGPASSWORD=$DB_PASSWORD psql -h ${aws_db_instance.main.address} -U riftfound -d riftfound -c '\q' 2>/dev/null; do
      echo "Waiting for RDS..."
      sleep 5
    done

    # Start backend with PM2
    cd /home/riftfound/app/backend
    sudo -u riftfound pm2 start "npx tsx src/index.ts" --name backend
    sudo -u riftfound pm2 save

    # Start scraper with PM2
    cd /home/riftfound/app/scraper
    sudo -u riftfound pm2 start "npx tsx src/index.ts" --name scraper
    sudo -u riftfound pm2 save

    # Set PM2 to start on boot
    env PATH=$PATH:/usr/bin pm2 startup systemd -u riftfound --hp /home/riftfound

    echo "Backend setup complete at $(date)" >> /var/log/backend-setup.log
  EOF
}

# EC2 instance for Backend
resource "aws_instance" "backend" {
  ami                    = data.aws_ami.amazon_linux.id
  instance_type          = var.backend_instance_type
  subnet_id              = data.aws_subnets.default.ids[0]
  vpc_security_group_ids = [aws_security_group.backend.id]
  iam_instance_profile   = aws_iam_instance_profile.backend.name
  key_name               = var.ssh_key_name != "" ? var.ssh_key_name : null

  root_block_device {
    volume_size           = 20
    volume_type           = "gp3"
    delete_on_termination = true
  }

  user_data = base64encode(local.backend_user_data)

  # Wait for Photon to be created first (need its IP)
  depends_on = [aws_eip.photon]

  tags = {
    Name = "${var.project_name}-backend"
  }
}

# Elastic IP for Backend
resource "aws_eip" "backend" {
  instance = aws_instance.backend.id
  domain   = "vpc"

  tags = {
    Name = "${var.project_name}-backend"
  }
}
