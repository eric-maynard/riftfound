#!/bin/bash
# Analyze geocoding metrics from PM2 logs
# Usage: ./geocode-metrics.sh [--remote]

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../deploy.env" 2>/dev/null || true

if [[ "$1" == "--remote" ]]; then
    echo "Fetching logs from remote server..."
    SSH_KEY_PATH="${SSH_KEY_PATH/#\~/$HOME}"
    LOG_DATA=$(ssh -i "$SSH_KEY_PATH" "$EC2_USER@$EC2_HOST" "pm2 logs riftfound-backend --lines 10000 --nostream 2>&1 | grep '\[GEOCODE\]'" 2>/dev/null || echo "")
else
    echo "Analyzing local PM2 logs..."
    LOG_DATA=$(pm2 logs riftfound-backend --lines 10000 --nostream 2>&1 | grep '\[GEOCODE\]' || echo "")
fi

if [[ -z "$LOG_DATA" ]]; then
    echo "No geocoding metrics found in logs."
    exit 0
fi

echo ""
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

# Google API calls
GOOGLE_FORWARD=$(echo "$LOG_DATA" | grep -c 'type=google_forward' || echo "0")
GOOGLE_REVERSE=$(echo "$LOG_DATA" | grep -c 'type=google_reverse' || echo "0")
GOOGLE_AUTO=$(echo "$LOG_DATA" | grep -c 'type=google_autocomplete' || echo "0")
GOOGLE_TOTAL=$((GOOGLE_FORWARD + GOOGLE_REVERSE + GOOGLE_AUTO))

echo "Google API calls:"
echo "  Forward geocode:  $GOOGLE_FORWARD"
echo "  Reverse geocode:  $GOOGLE_REVERSE"
echo "  Autocomplete:     $GOOGLE_AUTO"
echo "  Total:            $GOOGLE_TOTAL"
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
fi
