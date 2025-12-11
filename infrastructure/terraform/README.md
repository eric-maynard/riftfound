# Riftfound AWS Infrastructure

Terraform configuration to deploy Riftfound on AWS.

## Architecture

```
                    ┌─────────────────┐
                    │   CloudFront    │
                    │   (CDN + HTTPS) │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              │
        ┌─────────┐    ┌──────────┐         │
        │   S3    │    │   EC2    │         │
        │Frontend │    │ Backend  │         │
        └─────────┘    │ Scraper  │         │
                       │ SQLite   │         │
                       └────┬─────┘         │
                            │               │
                       ┌────▼────┐          │
                       │   EBS   │          │
                       │  (data) │          │
                       └─────────┘          │
```

## What Gets Created

| Resource | Purpose | Est. Cost |
|----------|---------|-----------|
| EC2 t3.small | Backend API + Scraper | ~$15/mo |
| EBS 30GB gp3 | Root volume | ~$3/mo |
| EBS 20GB gp3 | SQLite data (persistent) | ~$2/mo |
| S3 bucket | Frontend static files | ~$1/mo |
| CloudFront | CDN + HTTPS | ~$1/mo |
| ACM Certificate | SSL for custom domain | Free |
| Elastic IP | Stable public IP | Free (while attached) |

**Total: ~$20-25/month**

## Prerequisites

1. **AWS Account** with admin access
2. **AWS CLI** installed and configured:
   ```bash
   aws configure
   # Enter your Access Key ID, Secret Access Key, region (us-west-2)
   ```
3. **Terraform** installed:
   ```bash
   # Download from https://www.terraform.io/downloads
   ```
4. **SSH Key Pair** created in AWS Console (EC2 → Key Pairs)

## Quick Start

```bash
cd infrastructure/terraform

# Create your config
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your values

# Initialize and deploy
terraform init
terraform plan     # Preview changes
terraform apply    # Deploy (type 'yes')
```

After deployment, Terraform outputs:
- CloudFront domain for DNS setup
- EC2 public IP for SSH
- S3 bucket name for frontend uploads
- GoDaddy DNS instructions

## Configuration

Edit `terraform.tfvars`:

```hcl
aws_region       = "us-west-2"
domain_name      = "riftfound.com"
instance_type    = "t3.small"
ssh_key_name     = "your-key-pair-name"
allowed_ssh_cidr = "YOUR_IP/32"        # Your IP for SSH access
ebs_volume_size  = 20
```

## DNS Setup (GoDaddy)

After `terraform apply`, you need to:

1. **Validate SSL Certificate**: Add the CNAME records shown in `acm_validation_records` output
2. **Point www to CloudFront**: Add CNAME record `www` → `<cloudfront-domain>.cloudfront.net`
3. **Root domain**: Either forward to www or use GoDaddy's forwarding feature

## Connecting to the Server

```bash
ssh -i ~/.ssh/your-key.pem ec2-user@<EC2_PUBLIC_IP>

# Check services
pm2 status
pm2 logs
```

## Deploying Updates

Use the deploy script from the project root:

```bash
./deploy.sh frontend   # Build and upload React app
./deploy.sh backend    # Package and deploy backend/scraper
./deploy.sh all        # Both
```

## Destroying Infrastructure

```bash
terraform destroy
```

**Warning**: This deletes everything including the EBS data volume.

## Troubleshooting

### Certificate stuck in PENDING_VALIDATION
- Verify DNS records are correct in GoDaddy
- Wait up to 30 minutes for DNS propagation
- Check: `aws acm describe-certificate --certificate-arn <ARN> --region us-east-1`

### CloudFront returns 403
- Ensure S3 bucket policy allows CloudFront access
- Check CloudFront origin access control is configured

### Can't SSH to EC2
- Verify your IP in `allowed_ssh_cidr` matches `curl ifconfig.me`
- Check security group allows port 22 from your IP
