# AWS Deployment Guide

This guide explains the production deployment of Riftfound on AWS.

## Architecture

```
User → CloudFront (HTTPS)
         ├── /* → S3 (frontend static files)
         └── /api/* → EC2:3001 (backend API)

EC2 Instance (t3.small)
├── Backend API (Express.js on port 3001)
├── Scraper (runs every 60min via PM2)
└── SQLite database on EBS volume
```

**Why this architecture?**
- Simple and cost-effective (~$20-25/month)
- SQLite on EBS is sufficient for read-heavy workload
- No need for RDS/managed database
- No need for containers or Lambda complexity

## Components

| Component | Service | Notes |
|-----------|---------|-------|
| Frontend | S3 + CloudFront | React SPA, HTTPS via ACM certificate |
| Backend | EC2 t3.small | Express.js API on port 3001 |
| Scraper | EC2 (same instance) | PM2-managed, distributes requests across 60min cycle |
| Database | SQLite on EBS | 20GB gp3 volume, persists across restarts |
| SSL | ACM + CloudFront | Free SSL certificate for custom domain |

## Deployment

### Prerequisites

1. AWS account with admin access
2. AWS CLI configured (`aws configure`)
3. Terraform installed
4. SSH key pair created in AWS Console

### Initial Setup

```bash
cd infrastructure/terraform

# Create config
cp terraform.tfvars.example terraform.tfvars
# Edit with your values:
# - domain_name
# - ssh_key_name
# - allowed_ssh_cidr (your IP)

# Deploy infrastructure
terraform init
terraform apply
```

### DNS Setup (GoDaddy)

After Terraform completes:

1. Add ACM validation CNAME records (shown in Terraform output)
2. Wait for certificate to validate (~5-30 minutes)
3. Run `terraform apply` again to create CloudFront
4. Add CNAME: `www` → `<cloudfront-domain>.cloudfront.net`

### Application Deployment

From project root:

```bash
# First time: create deploy.env
cp deploy.env.example deploy.env
# Edit with values from Terraform output

# Deploy
./deploy.sh all
```

## Server Management

### SSH Access

```bash
ssh -i ~/.ssh/riftfound.pem ec2-user@<EC2_IP>
```

### PM2 Commands

```bash
pm2 status           # Check service status
pm2 logs             # View logs
pm2 logs --lines 50  # Last 50 lines
pm2 restart all      # Restart services
pm2 stop all         # Stop services
```

### Database Location

SQLite database is stored at `/data/riftfound.db` on the EBS volume. This persists across EC2 restarts and can be backed up:

```bash
# On EC2 instance
sqlite3 /data/riftfound.db ".backup /tmp/backup.db"
```

## Updating

### Code Updates

```bash
./deploy.sh frontend   # React app changes
./deploy.sh backend    # Backend/scraper changes
./deploy.sh all        # Both
```

### Infrastructure Updates

```bash
cd infrastructure/terraform
terraform plan         # Preview changes
terraform apply        # Apply changes
```

## Costs

| Resource | Monthly Cost |
|----------|-------------|
| EC2 t3.small | ~$15 |
| EBS 30GB (root) | ~$3 |
| EBS 20GB (data) | ~$2 |
| S3 + CloudFront | ~$1-2 |
| Elastic IP | Free |
| **Total** | **~$20-25** |

## Troubleshooting

### Services not running
```bash
ssh -i ~/.ssh/riftfound.pem ec2-user@<IP>
pm2 status
pm2 logs --err
```

### API returns 502
- Check backend is running: `pm2 status`
- Check logs: `pm2 logs riftfound-backend`
- Verify port 3001 is accessible: `curl localhost:3001/api/events/info`

### CloudFront returns 403
- Ensure frontend was deployed: `./deploy.sh frontend`
- Check S3 bucket has files: `aws s3 ls s3://<bucket-name>`

### Database issues
```bash
ssh -i ~/.ssh/riftfound.pem ec2-user@<IP>
sqlite3 /data/riftfound.db "SELECT COUNT(*) FROM events;"
```
