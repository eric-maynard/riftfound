#!/bin/bash
# Analyze CloudFront logs for visitor metrics
#
# Usage: ./analyze-logs.sh [period]
#   period: "day", "week", "month", or "all" (default: all)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS_DIR="${SCRIPT_DIR}/logs"
PERIOD="${1:-all}"

# Check if logs exist
if [ ! -d "$LOGS_DIR" ] || [ -z "$(ls -A "$LOGS_DIR" 2>/dev/null)" ]; then
    echo "No logs found. Run ./download-logs.sh first."
    exit 1
fi

# Calculate date filter
case "$PERIOD" in
    day)
        if [[ "$OSTYPE" == "darwin"* ]]; then
            DATE_FILTER=$(date -v-1d +%Y-%m-%d)
        else
            DATE_FILTER=$(date -d "-1 day" +%Y-%m-%d)
        fi
        PERIOD_DESC="last 24 hours"
        ;;
    week)
        if [[ "$OSTYPE" == "darwin"* ]]; then
            DATE_FILTER=$(date -v-7d +%Y-%m-%d)
        else
            DATE_FILTER=$(date -d "-7 days" +%Y-%m-%d)
        fi
        PERIOD_DESC="last 7 days"
        ;;
    month)
        if [[ "$OSTYPE" == "darwin"* ]]; then
            DATE_FILTER=$(date -v-30d +%Y-%m-%d)
        else
            DATE_FILTER=$(date -d "-30 days" +%Y-%m-%d)
        fi
        PERIOD_DESC="last 30 days"
        ;;
    *)
        DATE_FILTER=""
        PERIOD_DESC="all time"
        ;;
esac

echo "=========================================="
echo "RIFTFOUND METRICS - ${PERIOD_DESC}"
echo "=========================================="
echo ""

# Combine all log files, skip comment lines
# CloudFront log format (tab-separated):
# 1:date 2:time 3:edge-location 4:bytes 5:client-ip 6:method 7:host
# 8:uri-stem 9:status 10:referer 11:user-agent 12:query-string ...

ALL_LOGS=$(cat "$LOGS_DIR"/*.????????-* 2>/dev/null | grep -v "^#" || echo "")

if [ -z "$ALL_LOGS" ]; then
    echo "No log data found."
    exit 0
fi

# Apply date filter if set
if [ -n "$DATE_FILTER" ]; then
    FILTERED_LOGS=$(echo "$ALL_LOGS" | awk -v date="$DATE_FILTER" '$1 >= date')
else
    FILTERED_LOGS="$ALL_LOGS"
fi

if [ -z "$FILTERED_LOGS" ]; then
    echo "No log data found for the specified period."
    exit 0
fi

# Helper to count
count_lines() {
    echo "$1" | grep -c . || echo "0"
}

echo "TRAFFIC OVERVIEW"
echo "----------------------------------------"

# Total requests
TOTAL_REQUESTS=$(count_lines "$FILTERED_LOGS")
echo "Total requests: $TOTAL_REQUESTS"

# Unique IPs (visitors)
UNIQUE_IPS=$(echo "$FILTERED_LOGS" | awk -F'\t' '{print $5}' | sort -u | wc -l | tr -d ' ')
echo "Unique visitors (by IP): $UNIQUE_IPS"

# Successful requests (2xx, 3xx)
SUCCESS_REQUESTS=$(echo "$FILTERED_LOGS" | awk -F'\t' '$9 ~ /^[23]/' | wc -l | tr -d ' ')
echo "Successful requests: $SUCCESS_REQUESTS"

echo ""
echo "PAGE VIEWS"
echo "----------------------------------------"

# Homepage views
HOMEPAGE_VIEWS=$(echo "$FILTERED_LOGS" | awk -F'\t' '$8 == "/" || $8 == "/index.html"' | wc -l | tr -d ' ')
HOMEPAGE_UNIQUE=$(echo "$FILTERED_LOGS" | awk -F'\t' '$8 == "/" || $8 == "/index.html" {print $5}' | sort -u | wc -l | tr -d ' ')
echo "Homepage views: $HOMEPAGE_VIEWS (${HOMEPAGE_UNIQUE} unique)"

# Event detail page views (pattern: /event/UUID or /events/UUID)
EVENT_DETAIL_VIEWS=$(echo "$FILTERED_LOGS" | awk -F'\t' '$8 ~ /\/events?\/[a-f0-9-]+/' | wc -l | tr -d ' ')
EVENT_DETAIL_UNIQUE=$(echo "$FILTERED_LOGS" | awk -F'\t' '$8 ~ /\/events?\/[a-f0-9-]+/ {print $5}' | sort -u | wc -l | tr -d ' ')
echo "Event detail views: $EVENT_DETAIL_VIEWS (${EVENT_DETAIL_UNIQUE} unique)"

# Unique events viewed
UNIQUE_EVENTS=$(echo "$FILTERED_LOGS" | awk -F'\t' '$8 ~ /\/events?\/[a-f0-9-]+/ {print $8}' | sort -u | wc -l | tr -d ' ')
echo "Unique events viewed: $UNIQUE_EVENTS"

echo ""
echo "API USAGE"
echo "----------------------------------------"

# API calls
API_CALLS=$(echo "$FILTERED_LOGS" | awk -F'\t' '$8 ~ /^\/api\//' | wc -l | tr -d ' ')
echo "Total API calls: $API_CALLS"

# Events API (main calendar data)
EVENTS_API=$(echo "$FILTERED_LOGS" | awk -F'\t' '$8 == "/api/events"' | wc -l | tr -d ' ')
echo "Calendar data requests: $EVENTS_API"

# Geocode API (location searches)
GEOCODE_API=$(echo "$FILTERED_LOGS" | awk -F'\t' '$8 ~ /^\/api\/events\/geocode/' | wc -l | tr -d ' ')
echo "Location searches: $GEOCODE_API"

echo ""
echo "EXTERNAL CLICKS (Visit Store Links)"
echo "----------------------------------------"

# Track clicks to external URLs (store registration pages)
# These would be tracked if you add a redirect endpoint like /api/events/:id/visit
# For now, check if there's a pattern in the logs
VISIT_CLICKS=$(echo "$FILTERED_LOGS" | awk -F'\t' '$8 ~ /\/visit$/ || $8 ~ /\/register$/' | wc -l | tr -d ' ')
if [ "$VISIT_CLICKS" -gt 0 ]; then
    VISIT_UNIQUE=$(echo "$FILTERED_LOGS" | awk -F'\t' '($8 ~ /\/visit$/ || $8 ~ /\/register$/) {print $5}' | sort -u | wc -l | tr -d ' ')
    echo "Store visit clicks: $VISIT_CLICKS (${VISIT_UNIQUE} unique)"
else
    echo "Store visit clicks: Not tracked (see docs for setup)"
fi

echo ""
echo "TOP PAGES"
echo "----------------------------------------"
echo "$FILTERED_LOGS" | awk -F'\t' '{print $8}' | sort | uniq -c | sort -rn | head -10

echo ""
echo "TRAFFIC BY DAY"
echo "----------------------------------------"
echo "$FILTERED_LOGS" | awk -F'\t' '{print $1}' | sort | uniq -c | sort -k2

echo ""
echo "TOP LOCATIONS (by edge location)"
echo "----------------------------------------"
echo "$FILTERED_LOGS" | awk -F'\t' '{print $3}' | sort | uniq -c | sort -rn | head -10

echo ""
echo "=========================================="
echo "Run with 'day', 'week', or 'month' for filtered results"
echo "Example: ./analyze-logs.sh week"
