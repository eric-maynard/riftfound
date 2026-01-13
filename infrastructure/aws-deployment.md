# AWS Deployment Guide

This guide explains the production deployment of Riftfound on AWS.

## Architecture

```
User → CloudFront (HTTPS)
         ├── /* → S3 (frontend static files)
         └── /api/* → API Gateway → Lambda (backend API)

Lambda Functions:
├── riftfound-api-prod     # Backend API (active, routed via CloudFront)
└── riftfound-scraper-prod # Event scraper (active, runs hourly via EventBridge)

DynamoDB Table: riftfound-prod
├── Events (PK: EVENT#<id>)
├── Shops (PK: SHOP#<id>)
└── Scrape runs, geocache

EC2 Instance: Still running (standby for rollback if needed)
```

**Current State (Serverless):**
- Frontend: S3 + CloudFront ✅
- Backend API: Lambda + API Gateway ✅ (routed via CloudFront)
- Scraper: Lambda + EventBridge ✅ (hourly)
- Database: DynamoDB ✅
- EC2: Running but idle (standby for rollback)

## Components

| Component | Service | Status |
|-----------|---------|--------|
| Frontend | S3 + CloudFront | ✅ Active |
| Backend API | Lambda + API Gateway | ✅ Active (via CloudFront) |
| Scraper | Lambda + EventBridge | ✅ Active (hourly) |
| Database | DynamoDB | ✅ Active |
| Geocoding | Google Maps API | ✅ Active |
| EC2 | t3a.xlarge | ⏸️ Standby (for rollback) |

## Deployment

### Prerequisites

1. AWS account with admin access
2. AWS CLI configured (`aws configure`)
3. Terraform installed

### Initial Setup

```bash
cd infrastructure/terraform

# Create config
cp terraform.tfvars.example terraform.tfvars
# Edit with your values:
# - use_dynamodb = true
# - google_maps_api_key (or set via TF_VAR_google_maps_api_key env var)

# Deploy infrastructure
terraform init
terraform apply
```

### Deploy Commands

From project root:

```bash
# Frontend (S3 + CloudFront)
./deploy.sh frontend

# Lambda functions
./deploy.sh backend-lambda   # Backend API
./deploy.sh scraper-lambda   # Scraper
./deploy.sh lambdas          # Both

# Legacy EC2 (backend still routed here)
./deploy.sh backend          # Deploy to EC2
```

### Lambda Management

```bash
# View scraper logs
aws logs tail /aws/lambda/riftfound-scraper-prod --region us-west-2 --follow

# View API logs
aws logs tail /aws/lambda/riftfound-api-prod --region us-west-2 --follow

# Test scraper manually (async - doesn't wait for completion)
aws lambda invoke --function-name riftfound-scraper-prod --invocation-type Event /tmp/out.json

# Check Lambda configuration
aws lambda get-function-configuration --function-name riftfound-scraper-prod --region us-west-2
```

### EventBridge Schedule

The scraper runs on a schedule defined in Terraform:
- Rule: `riftfound-scraper-schedule-prod`
- Schedule: `rate(60 minutes)`

```bash
# Check schedule status
aws events describe-rule --name riftfound-scraper-schedule-prod --region us-west-2

# Disable schedule (if needed)
aws events disable-rule --name riftfound-scraper-schedule-prod --region us-west-2

# Re-enable schedule
aws events enable-rule --name riftfound-scraper-schedule-prod --region us-west-2
```

## EC2 Management (Standby)

EC2 is running but idle. It's kept as a fallback in case Lambda has issues.

### SSH Access

```bash
ssh -i ~/.ssh/riftfound.pem ec2-user@<EC2_IP>
```

### PM2 Commands

```bash
pm2 status           # Check service status
pm2 logs             # View logs
pm2 restart all      # Restart services
```

## Infrastructure Updates

```bash
cd infrastructure/terraform
terraform plan         # Preview changes
terraform apply        # Apply changes
```

### Key Terraform Variables

In `terraform.tfvars`:
```hcl
use_dynamodb = true              # Enable Lambda + DynamoDB
use_ec2      = true              # Keep EC2 (for now)
google_maps_api_key = "..."      # Or use TF_VAR_google_maps_api_key
```

## Costs (Estimated)

| Resource | Monthly Cost |
|----------|-------------|
| DynamoDB (on-demand) | ~$1-5 |
| Lambda (scraper + API) | ~$1-2 |
| S3 + CloudFront | ~$1-2 |
| EC2 t3a.xlarge (temporary) | ~$100 |
| **Total (after EC2 removal)** | **~$5-10** |

## Troubleshooting

### Scraper not running
```bash
# Check EventBridge rule
aws events describe-rule --name riftfound-scraper-schedule-prod --region us-west-2

# Check recent invocations
aws logs tail /aws/lambda/riftfound-scraper-prod --since 1h --region us-west-2

# Manual test
aws lambda invoke --function-name riftfound-scraper-prod --invocation-type Event /tmp/out.json
```

### API errors
```bash
# Check Lambda logs
aws logs tail /aws/lambda/riftfound-api-prod --since 1h --region us-west-2

# Test Lambda directly
curl "https://$(terraform output -raw api_gateway_url)/api/events/info"
```

### DynamoDB issues
```bash
# Check table status
aws dynamodb describe-table --table-name riftfound-prod --region us-west-2

# Query event count
aws dynamodb scan --table-name riftfound-prod --select COUNT --region us-west-2
```

## Rollback to EC2 (if needed)

If Lambda has issues, you can quickly rollback to EC2:

```bash
cd infrastructure/terraform

# Edit terraform.tfvars
# Set: use_dynamodb = false

terraform apply
```

This will route CloudFront back to EC2. The EC2 instance is still running with the backend deployed.

## Decommission EC2 (when ready)

Once confident Lambda is stable:

1. Stop the EC2 instance manually (or via AWS Console)
2. Set `use_ec2 = false` in terraform.tfvars
3. Run `terraform apply` to remove EC2 resources
4. This saves ~$100/month
