# AWS Deployment Guide

This guide explains the production deployment of Riftfound on AWS.

## Architecture

```
User → CloudFront (HTTPS)
         ├── /* → S3 (frontend static files)
         └── /api/* → EC2:3001 (backend API) [migration to Lambda in progress]

Lambda Functions:
├── riftfound-api-prod     # Backend API (ready, not yet routed from CloudFront)
└── riftfound-scraper-prod # Event scraper (active, runs hourly via EventBridge)

DynamoDB Table: riftfound-prod
├── Events (PK: EVENT#<id>)
├── Shops (PK: SHOP#<id>)
└── Scrape runs, geocache
```

**Current State (Hybrid):**
- Frontend: S3 + CloudFront ✅
- Backend API: EC2 (CloudFront routes /api/* here) - Lambda ready but not routed
- Scraper: Lambda + EventBridge ✅ (hourly)
- Database: DynamoDB ✅

## Components

| Component | Service | Status |
|-----------|---------|--------|
| Frontend | S3 + CloudFront | ✅ Active |
| Backend API | Lambda + API Gateway | ✅ Deployed (not routed yet) |
| Backend API | EC2 t3a.xlarge | ✅ Active (current route) |
| Scraper | Lambda + EventBridge | ✅ Active (hourly) |
| Database | DynamoDB | ✅ Active |
| Geocoding | Google Maps API | ✅ Active |

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

## EC2 Management (Legacy)

EC2 still runs the backend API (until CloudFront is updated to route to Lambda).

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

## Next Steps

To complete serverless migration:
1. Update CloudFront to route `/api/*` to API Gateway instead of EC2
2. Disable EC2 instance
3. Set `use_ec2 = false` in terraform.tfvars
4. Run `terraform apply` to remove EC2 resources
