#!/bin/bash
# Download CloudFront logs from S3 for analysis
#
# Usage: ./download-logs.sh [days]
#   days: Number of days of logs to download (default: 30)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS_DIR="${SCRIPT_DIR}/logs"
DAYS="${1:-30}"

# Load config
if [ -f "${SCRIPT_DIR}/../../deploy.env" ]; then
    source "${SCRIPT_DIR}/../../deploy.env"
fi

# Get logs bucket name from Terraform output or environment
if [ -z "$LOGS_BUCKET" ]; then
    echo "Getting logs bucket name from Terraform..."
    cd "${SCRIPT_DIR}/../../infrastructure/terraform"
    LOGS_BUCKET=$(terraform output -raw logs_bucket_name 2>/dev/null || echo "")
    cd - > /dev/null
fi

if [ -z "$LOGS_BUCKET" ]; then
    echo "Error: LOGS_BUCKET not set. Either:"
    echo "  1. Set LOGS_BUCKET in deploy.env"
    echo "  2. Run 'terraform output logs_bucket_name' to get the bucket name"
    exit 1
fi

echo "Downloading logs from s3://${LOGS_BUCKET}/cloudfront/"
echo "Date range: last ${DAYS} days"
echo ""

# Create logs directory
mkdir -p "$LOGS_DIR"

# Calculate date range
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    START_DATE=$(date -v-${DAYS}d +%Y-%m-%d)
else
    # Linux
    START_DATE=$(date -d "-${DAYS} days" +%Y-%m-%d)
fi

echo "Downloading logs since ${START_DATE}..."

# Download logs (CloudFront logs are gzipped)
aws s3 sync "s3://${LOGS_BUCKET}/cloudfront/" "$LOGS_DIR" \
    --exclude "*" \
    --include "*.gz"

# Count downloaded files
FILE_COUNT=$(find "$LOGS_DIR" -name "*.gz" | wc -l | tr -d ' ')
echo ""
echo "Downloaded ${FILE_COUNT} log files to ${LOGS_DIR}"

# Decompress for analysis
echo "Decompressing logs..."
gunzip -kf "$LOGS_DIR"/*.gz 2>/dev/null || true

echo "Done! Run ./analyze-logs.sh to generate metrics."
