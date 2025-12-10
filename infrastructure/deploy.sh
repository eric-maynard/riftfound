#!/bin/bash
set -e

# Riftfound Deployment Script
# Usage: ./deploy.sh [frontend|backend|all]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TERRAFORM_DIR="$SCRIPT_DIR/terraform"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[DEPLOY]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# Get Terraform outputs
get_output() {
    cd "$TERRAFORM_DIR"
    terraform output -raw "$1" 2>/dev/null
}

deploy_frontend() {
    log "Building frontend..."
    cd "$PROJECT_ROOT/frontend"
    npm run build

    log "Getting S3 bucket name..."
    BUCKET=$(get_output s3_bucket_name)
    [ -z "$BUCKET" ] && error "Could not get S3 bucket name. Run terraform first."

    log "Uploading to S3 bucket: $BUCKET"
    aws s3 sync dist/ "s3://$BUCKET/" --delete

    log "Invalidating CloudFront cache..."
    DIST_ID=$(get_output cloudfront_distribution_id)
    aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" > /dev/null

    log "Frontend deployed successfully!"
}

deploy_backend() {
    log "Getting EC2 IP..."
    EC2_IP=$(get_output ec2_public_ip)
    [ -z "$EC2_IP" ] && error "Could not get EC2 IP. Run terraform first."

    SSH_KEY="${SSH_KEY:-~/.ssh/riftfound.pem}"
    [ ! -f "$SSH_KEY" ] && error "SSH key not found at $SSH_KEY. Set SSH_KEY env var."

    log "Deploying backend to $EC2_IP..."
    
    # Create deployment package
    cd "$PROJECT_ROOT"
    tar -czf /tmp/riftfound-deploy.tar.gz \
        --exclude='node_modules' \
        --exclude='.git' \
        --exclude='infrastructure' \
        --exclude='frontend/node_modules' \
        --exclude='frontend/dist' \
        backend scraper package.json package-lock.json

    # Upload and extract
    scp -i "$SSH_KEY" -o StrictHostKeyChecking=no /tmp/riftfound-deploy.tar.gz "ec2-user@$EC2_IP:/tmp/"

    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "ec2-user@$EC2_IP" << 'REMOTE'
        set -e
        sudo -u riftfound bash << 'INNER'
            cd /opt/riftfound
            tar -xzf /tmp/riftfound-deploy.tar.gz
            npm install --production
            cd backend && npm install --production && cd ..
            cd scraper && npm install --production && cd ..

            # Create .env if not exists
            if [ ! -f .env ]; then
                cat > .env << 'ENVFILE'
DB_TYPE=sqlite
SQLITE_PATH=/data/riftfound.db
PORT=3001
NODE_ENV=production
ENVFILE
            fi

            # Start/restart with PM2
            pm2 delete riftfound-backend 2>/dev/null || true
            pm2 delete riftfound-scraper 2>/dev/null || true
            pm2 start backend/dist/index.js --name riftfound-backend
            pm2 start scraper/dist/index.js --name riftfound-scraper
            pm2 save
INNER
        sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u riftfound --hp /home/riftfound 2>/dev/null || true
REMOTE

    rm /tmp/riftfound-deploy.tar.gz
    log "Backend deployed successfully!"
}

case "${1:-all}" in
    frontend)
        deploy_frontend
        ;;
    backend)
        deploy_backend
        ;;
    all)
        deploy_frontend
        deploy_backend
        ;;
    *)
        echo "Usage: $0 [frontend|backend|all]"
        exit 1
        ;;
esac
