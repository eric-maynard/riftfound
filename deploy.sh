#!/bin/bash
set -e

# Load deployment config
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ ! -f "$SCRIPT_DIR/deploy.env" ]; then
    echo "Error: deploy.env not found. Copy deploy.env.example to deploy.env and fill in your values."
    exit 1
fi
source "$SCRIPT_DIR/deploy.env"

# Expand tilde in SSH_KEY_PATH
SSH_KEY_PATH="${SSH_KEY_PATH/#\~/$HOME}"

usage() {
    echo "Usage: ./deploy.sh [frontend|backend|backend-lambda|scraper-lambda|lambdas|all]"
    echo ""
    echo "Commands:"
    echo "  frontend       - Build and deploy React frontend to S3/CloudFront"
    echo "  backend        - Deploy backend and scraper to EC2"
    echo "  backend-lambda - Deploy backend API to AWS Lambda"
    echo "  scraper-lambda - Deploy scraper to AWS Lambda"
    echo "  lambdas        - Deploy both backend and scraper to Lambda"
    echo "  all            - Deploy frontend and backend (EC2)"
    echo ""
    echo "Examples:"
    echo "  ./deploy.sh frontend"
    echo "  ./deploy.sh backend"
    echo "  ./deploy.sh lambdas"
    echo "  ./deploy.sh all"
    exit 1
}

deploy_frontend() {
    echo "==> Building frontend..."
    cd "$SCRIPT_DIR/frontend"
    npm run build

    echo "==> Uploading hashed assets (cached 1 year)..."
    aws s3 sync dist "s3://$S3_BUCKET" \
        --delete \
        --region "$AWS_REGION" \
        --exclude "index.html" \
        --cache-control "public, max-age=31536000, immutable"

    echo "==> Uploading index.html (no cache)..."
    aws s3 cp dist/index.html "s3://$S3_BUCKET/index.html" \
        --region "$AWS_REGION" \
        --cache-control "no-cache, no-store, must-revalidate"

    echo "==> Invalidating CloudFront cache for index.html..."
    aws cloudfront create-invalidation \
        --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" \
        --paths "/index.html" "/" \
        --region "$AWS_REGION" > /dev/null

    echo "==> Frontend deployed!"
}

deploy_backend() {
    echo "==> Creating deployment package..."
    cd "$SCRIPT_DIR"
    tar -czf /tmp/riftfound-deploy.tar.gz \
        --exclude='node_modules' \
        --exclude='.git' \
        --exclude='frontend' \
        backend scraper package.json package-lock.json

    echo "==> Uploading to EC2..."
    scp -i "$SSH_KEY_PATH" /tmp/riftfound-deploy.tar.gz "$EC2_USER@$EC2_HOST:/tmp/"

    echo "==> Installing on EC2..."
    ssh -i "$SSH_KEY_PATH" "$EC2_USER@$EC2_HOST" << 'REMOTE_SCRIPT'
set -e
cd /opt/riftfound
sudo tar -xzf /tmp/riftfound-deploy.tar.gz
sudo chown -R ec2-user:ec2-user /opt/riftfound
npm install --omit=dev
cd backend && npm install --omit=dev && cd ..
cd scraper && npm install --omit=dev && cd ..
pm2 restart all
rm /tmp/riftfound-deploy.tar.gz
REMOTE_SCRIPT

    rm /tmp/riftfound-deploy.tar.gz
    echo "==> Backend deployed!"
}

deploy_backend_lambda() {
    echo "==> Building backend for Lambda..."
    cd "$SCRIPT_DIR/backend"

    # Build TypeScript
    npm run build

    # Create temp directory for Lambda package
    LAMBDA_DIR=$(mktemp -d)
    echo "==> Packaging in $LAMBDA_DIR..."

    # Copy built files
    cp -r dist/* "$LAMBDA_DIR/"

    # Copy package.json and install production deps
    cp package.json "$LAMBDA_DIR/"
    cd "$LAMBDA_DIR"
    npm install --omit=dev --ignore-scripts

    # Create zip
    echo "==> Creating deployment zip..."
    zip -r /tmp/backend-lambda.zip . > /dev/null

    # Get zip size
    ZIP_SIZE=$(du -h /tmp/backend-lambda.zip | cut -f1)
    echo "==> Package size: $ZIP_SIZE"

    # Deploy to Lambda
    FUNCTION_NAME="${API_LAMBDA_NAME:-riftfound-api-prod}"
    echo "==> Deploying to Lambda function: $FUNCTION_NAME..."
    aws lambda update-function-code \
        --function-name "$FUNCTION_NAME" \
        --zip-file fileb:///tmp/backend-lambda.zip \
        --region "$AWS_REGION" > /dev/null

    # Cleanup
    rm -rf "$LAMBDA_DIR"
    rm /tmp/backend-lambda.zip

    echo "==> Backend Lambda deployed!"
    echo ""
    echo "API Gateway URL: Check terraform output for api_gateway_url"
}

deploy_scraper_lambda() {
    echo "==> Building scraper for Lambda..."
    cd "$SCRIPT_DIR/scraper"

    # Build TypeScript
    npm run build

    # Create temp directory for Lambda package
    LAMBDA_DIR=$(mktemp -d)
    echo "==> Packaging in $LAMBDA_DIR..."

    # Copy built files
    cp -r dist/* "$LAMBDA_DIR/"

    # Copy package.json and install production deps
    cp package.json "$LAMBDA_DIR/"
    cd "$LAMBDA_DIR"
    npm install --omit=dev --ignore-scripts

    # Create zip
    echo "==> Creating deployment zip..."
    zip -r /tmp/scraper-lambda.zip . > /dev/null

    # Get zip size
    ZIP_SIZE=$(du -h /tmp/scraper-lambda.zip | cut -f1)
    echo "==> Package size: $ZIP_SIZE"

    # Deploy to Lambda
    FUNCTION_NAME="${SCRAPER_LAMBDA_NAME:-riftfound-scraper-prod}"
    echo "==> Deploying to Lambda function: $FUNCTION_NAME..."
    aws lambda update-function-code \
        --function-name "$FUNCTION_NAME" \
        --zip-file fileb:///tmp/scraper-lambda.zip \
        --region "$AWS_REGION" > /dev/null

    # Cleanup
    rm -rf "$LAMBDA_DIR"
    rm /tmp/scraper-lambda.zip

    echo "==> Scraper Lambda deployed!"
    echo ""
    echo "To test manually: aws lambda invoke --function-name $FUNCTION_NAME /tmp/out.json && cat /tmp/out.json"
}

# Parse command
case "${1:-}" in
    frontend)
        deploy_frontend
        ;;
    backend)
        deploy_backend
        ;;
    backend-lambda)
        deploy_backend_lambda
        ;;
    scraper-lambda)
        deploy_scraper_lambda
        ;;
    lambdas)
        deploy_backend_lambda
        deploy_scraper_lambda
        ;;
    all)
        deploy_frontend
        deploy_backend
        ;;
    *)
        usage
        ;;
esac

echo ""
echo "Done! Site is live at https://www.riftfound.com"
