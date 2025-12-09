# AWS Deployment Guide

This guide explains how to deploy Riftfound to AWS without exposing credentials in the open-source codebase.

## Architecture

- **Frontend**: S3 + CloudFront (static hosting)
- **Backend API**: Lambda + API Gateway (or ECS Fargate)
- **Scraper**: Lambda with EventBridge scheduled rule
- **Database**: RDS PostgreSQL
- **Secrets**: AWS Secrets Manager

## Credential Management

### Development
- Copy `.env.local.example` to `.env`
- Use `docker-compose up` for local PostgreSQL
- Credentials are only in your local `.env` file (gitignored)

### Production
Credentials are managed through AWS Secrets Manager:

1. **Create a Secret in AWS Secrets Manager:**
   ```bash
   aws secretsmanager create-secret \
     --name riftfound/database \
     --secret-string '{
       "host": "your-rds-endpoint.region.rds.amazonaws.com",
       "port": 5432,
       "database": "riftfound",
       "username": "your_db_user",
       "password": "your_secure_password"
     }'
   ```

2. **Set environment variable in your deployment:**
   ```
   AWS_SECRETS_DB_ARN=arn:aws:secretsmanager:region:account:secret:riftfound/database-xxxxx
   ```

3. **Grant IAM permissions to your Lambda/ECS task:**
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": [
           "secretsmanager:GetSecretValue"
         ],
         "Resource": "arn:aws:secretsmanager:region:account:secret:riftfound/database-*"
       }
     ]
   }
   ```

## Deployment Steps

### 1. Database (RDS)

```bash
# Create RDS instance (example using AWS CLI)
aws rds create-db-instance \
  --db-instance-identifier riftfound-db \
  --db-instance-class db.t3.micro \
  --engine postgres \
  --engine-version 16 \
  --master-username riftfound_admin \
  --master-user-password <your-password> \
  --allocated-storage 20 \
  --vpc-security-group-ids sg-xxxxx \
  --db-subnet-group-name your-subnet-group

# Run migrations (connect via bastion or VPN)
psql -h <rds-endpoint> -U riftfound_admin -d postgres -f infrastructure/init.sql
```

### 2. Backend API (Lambda)

```bash
# Build
cd backend
npm run build

# Package (zip dist folder with node_modules)
zip -r backend.zip dist node_modules package.json

# Deploy to Lambda
aws lambda create-function \
  --function-name riftfound-api \
  --runtime nodejs20.x \
  --handler dist/index.handler \
  --zip-file fileb://backend.zip \
  --role arn:aws:iam::account:role/riftfound-lambda-role \
  --environment Variables="{AWS_SECRETS_DB_ARN=arn:aws:secretsmanager:...}"
```

### 3. Scraper (Lambda with Schedule)

```bash
# Build
cd scraper
npm run build

# Package
zip -r scraper.zip dist node_modules package.json

# Deploy to Lambda
aws lambda create-function \
  --function-name riftfound-scraper \
  --runtime nodejs20.x \
  --handler dist/index.handler \
  --zip-file fileb://scraper.zip \
  --role arn:aws:iam::account:role/riftfound-lambda-role \
  --timeout 300 \
  --environment Variables="{AWS_SECRETS_DB_ARN=arn:aws:secretsmanager:...}"

# Create EventBridge rule for hourly execution
aws events put-rule \
  --name riftfound-scraper-schedule \
  --schedule-expression "rate(1 hour)"

aws events put-targets \
  --rule riftfound-scraper-schedule \
  --targets "Id=scraper,Arn=arn:aws:lambda:region:account:function:riftfound-scraper"
```

### 4. Frontend (S3 + CloudFront)

```bash
# Build
cd frontend
npm run build

# Create S3 bucket
aws s3 mb s3://riftfound-frontend

# Upload build
aws s3 sync dist/ s3://riftfound-frontend --delete

# Create CloudFront distribution pointing to S3
# (Use AWS Console or CloudFormation for easier configuration)
```

## Infrastructure as Code

For production deployments, consider using:
- **AWS CDK** (TypeScript) - add to `/infrastructure/cdk/`
- **Terraform** - add to `/infrastructure/terraform/`
- **CloudFormation** - add to `/infrastructure/cloudformation/`

These tools let you version control your infrastructure without exposing secrets,
as secrets are referenced by ARN rather than stored in code.

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `AWS_SECRETS_DB_ARN` | Production | ARN of the Secrets Manager secret |
| `AWS_REGION` | Production | AWS region (default: us-east-1) |
| `NODE_ENV` | Yes | `development` or `production` |
| `FRONTEND_URL` | Yes | Frontend URL for CORS |
| `RIFTBOUND_EVENTS_URL` | Yes | Source URL to scrape |
