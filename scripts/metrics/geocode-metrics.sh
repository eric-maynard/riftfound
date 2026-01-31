#!/bin/bash
# Analyze geocoding metrics from Lambda CloudWatch logs
# Usage: ./geocode-metrics.sh [--days N] [--with-traffic]
#
# Options:
#   --days N        Number of days to analyze (default: 7)
#   --with-traffic  Include traffic data to calculate places API calls per visit

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../deploy.env" 2>/dev/null || true

# Defaults
DAYS=7
WITH_TRAFFIC=false
LOG_GROUP="/aws/lambda/riftfound-api-prod"
REGION="${AWS_REGION:-us-west-2}"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --days)
            DAYS="$2"
            shift 2
            ;;
        --with-traffic)
            WITH_TRAFFIC=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: ./geocode-metrics.sh [--days N] [--with-traffic]"
            exit 1
            ;;
    esac
done

# Calculate time range (milliseconds since epoch)
if [[ "$OSTYPE" == "darwin"* ]]; then
    START_TIME=$(date -v-${DAYS}d +%s)000
else
    START_TIME=$(date -d "-${DAYS} days" +%s)000
fi

echo "Fetching geocode metrics from CloudWatch..."
echo "Log group: $LOG_GROUP"
echo "Region: $REGION"
echo "Time range: last $DAYS days"
echo ""

# Fetch logs with [GEOCODE] entries from CloudWatch
LOG_DATA=$(aws logs filter-log-events \
    --log-group-name "$LOG_GROUP" \
    --start-time "$START_TIME" \
    --filter-pattern '"[GEOCODE]"' \
    --region "$REGION" \
    --query 'events[].message' \
    --output text 2>/dev/null || echo "")

if [[ -z "$LOG_DATA" ]]; then
    echo "No geocoding metrics found in logs."
    echo ""
    echo "This could mean:"
    echo "  - No geocoding requests in the last $DAYS days"
    echo "  - Log group '$LOG_GROUP' doesn't exist"
    echo "  - AWS credentials not configured"
    exit 0
fi

echo "=== Geocoding Metrics ==="
echo ""

# Count by type
echo "Requests by type:"
echo "$LOG_DATA" | grep -oP 'type=\K[a-z_]+' | sort | uniq -c | sort -rn
echo ""

# Cache hit rate
CACHE_HITS=$(echo "$LOG_DATA" | grep -c 'type=cache_hit' || echo "0")
CACHE_MISSES=$(echo "$LOG_DATA" | grep -c 'type=cache_miss' || echo "0")
TOTAL_CACHE=$((CACHE_HITS + CACHE_MISSES))

if [[ $TOTAL_CACHE -gt 0 ]]; then
    HIT_RATE=$(echo "scale=1; $CACHE_HITS * 100 / $TOTAL_CACHE" | bc)
    echo "Cache stats:"
    echo "  Hits:      $CACHE_HITS"
    echo "  Misses:    $CACHE_MISSES"
    echo "  Hit rate:  $HIT_RATE%"
    echo ""
fi

# Mapbox API calls
MAPBOX_FORWARD=$(echo "$LOG_DATA" | grep -c 'type=mapbox_forward' || echo "0")
MAPBOX_REVERSE=$(echo "$LOG_DATA" | grep -c 'type=mapbox_reverse' || echo "0")
MAPBOX_AUTO=$(echo "$LOG_DATA" | grep -c 'type=mapbox_autocomplete' || echo "0")
MAPBOX_TOTAL=$((MAPBOX_FORWARD + MAPBOX_REVERSE + MAPBOX_AUTO))

echo "Mapbox API calls:"
echo "  Forward geocode:  $MAPBOX_FORWARD"
echo "  Reverse geocode:  $MAPBOX_REVERSE"
echo "  Autocomplete:     $MAPBOX_AUTO"
echo "  Total:            $MAPBOX_TOTAL"
echo ""

# Error rate
ERRORS=$(echo "$LOG_DATA" | grep -c 'success=false' || echo "0")
SUCCESSES=$(echo "$LOG_DATA" | grep -c 'success=true' || echo "0")
TOTAL_API=$((ERRORS + SUCCESSES))

if [[ $TOTAL_API -gt 0 ]]; then
    ERROR_RATE=$(echo "scale=1; $ERRORS * 100 / $TOTAL_API" | bc)
    echo "API success rate:"
    echo "  Successes: $SUCCESSES"
    echo "  Errors:    $ERRORS"
    echo "  Error rate: $ERROR_RATE%"
    echo ""
fi

# Traffic correlation (if requested and logs available)
if [[ "$WITH_TRAFFIC" == "true" ]]; then
    LOGS_DIR="$SCRIPT_DIR/logs"

    if [[ ! -d "$LOGS_DIR" ]] || [[ -z "$(ls -A "$LOGS_DIR" 2>/dev/null)" ]]; then
        echo "Traffic correlation requested but no CloudFront logs found."
        echo "Run ./download-logs.sh first to enable this feature."
    else
        echo "=== Traffic Correlation ==="
        echo ""

        # Calculate date filter for CloudFront logs
        if [[ "$OSTYPE" == "darwin"* ]]; then
            DATE_FILTER=$(date -v-${DAYS}d +%Y-%m-%d)
        else
            DATE_FILTER=$(date -d "-${DAYS} days" +%Y-%m-%d)
        fi

        # Get unique visitors from CloudFront logs
        ALL_LOGS=$(cat "$LOGS_DIR"/* 2>/dev/null | grep -v "^#" || echo "")
        FILTERED_LOGS=$(echo "$ALL_LOGS" | awk -v date="$DATE_FILTER" '$1 >= date')

        if [[ -n "$FILTERED_LOGS" ]]; then
            # Count unique visitors (by IP)
            UNIQUE_VISITORS=$(echo "$FILTERED_LOGS" | awk -F'\t' '{print $5}' | sort -u | wc -l | tr -d ' ')

            # Count location searches from CloudFront (frontend requests to geocode endpoint)
            LOCATION_SEARCHES=$(echo "$FILTERED_LOGS" | awk -F'\t' '$8 ~ /^\/api\/events\/geocode/' | wc -l | tr -d ' ')

            echo "Visitors (last $DAYS days):        $UNIQUE_VISITORS"
            echo "Location searches (frontend):      $LOCATION_SEARCHES"
            echo "Mapbox API calls:                  $MAPBOX_AUTO"
            echo ""

            if [[ $UNIQUE_VISITORS -gt 0 ]]; then
                # API calls per visitor
                API_PER_VISIT=$(echo "scale=3; $MAPBOX_AUTO / $UNIQUE_VISITORS" | bc)
                echo "API calls per visitor:             $API_PER_VISIT"

                # Cache effectiveness: how many frontend searches resulted in API calls
                if [[ $LOCATION_SEARCHES -gt 0 ]]; then
                    API_RATE=$(echo "scale=1; $MAPBOX_AUTO * 100 / $LOCATION_SEARCHES" | bc)
                    CACHE_SAVINGS=$((LOCATION_SEARCHES - MAPBOX_AUTO))
                    echo "API calls per location search:     ${API_RATE}%"
                    echo "Searches served from cache:        $CACHE_SAVINGS (saved API calls)"
                fi
            fi
        else
            echo "No CloudFront logs found for the specified time range."
            echo "Run ./download-logs.sh $DAYS to download recent logs."
        fi
    fi
fi

echo ""
echo "=== Summary ==="
echo ""
echo "Cache is saving $(echo "scale=0; $CACHE_HITS" | bc) Google API calls"
if [[ $TOTAL_CACHE -gt 0 ]]; then
    echo "Every ${HIT_RATE}% of geocode lookups hit cache"
fi
