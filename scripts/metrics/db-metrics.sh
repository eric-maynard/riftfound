#!/bin/bash
# Database metrics for shops and events
#
# Usage:
#   ./db-metrics.sh                    # Use local SQLite (dev mode)
#   ./db-metrics.sh --remote           # SSH to EC2 and query production DB
#   ./db-metrics.sh --days 7           # Last 7 days (default: 30)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${SCRIPT_DIR}/../.."
DAYS=30
REMOTE=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --remote)
            REMOTE=true
            shift
            ;;
        --days)
            DAYS="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# SQL queries
read -r -d '' METRICS_SQL << 'EOF' || true
-- Events and shops overview
SELECT 'Total Events' as metric, COUNT(*) as value FROM events
UNION ALL
SELECT 'Total Shops', COUNT(*) FROM shops
UNION ALL
SELECT 'Events with coordinates', COUNT(*) FROM events WHERE shop_id IS NOT NULL;
EOF

read -r -d '' DAILY_EVENTS_SQL << 'EOF' || true
-- Events added per day (last N days)
SELECT
    date(created_at) as date,
    COUNT(*) as events_added
FROM events
WHERE created_at >= date('now', '-DAYS_PLACEHOLDER days')
GROUP BY date(created_at)
ORDER BY date DESC;
EOF

read -r -d '' DAILY_SHOPS_SQL << 'EOF' || true
-- Shops added per day (last N days)
SELECT
    date(created_at) as date,
    COUNT(*) as shops_added
FROM shops
WHERE created_at >= date('now', '-DAYS_PLACEHOLDER days')
GROUP BY date(created_at)
ORDER BY date DESC;
EOF

read -r -d '' EVENT_TYPES_SQL << 'EOF' || true
-- Events by type
SELECT
    COALESCE(event_type, 'Unknown') as event_type,
    COUNT(*) as count
FROM events
GROUP BY event_type
ORDER BY count DESC
LIMIT 15;
EOF

read -r -d '' SHOPS_BY_STATE_SQL << 'EOF' || true
-- Shops by state
SELECT
    COALESCE(state, 'Unknown') as state,
    COUNT(*) as count
FROM shops
WHERE country = 'United States' OR country IS NULL
GROUP BY state
ORDER BY count DESC
LIMIT 15;
EOF

read -r -d '' SCRAPE_STATS_SQL << 'EOF' || true
-- Recent scrape runs
SELECT
    started_at,
    completed_at,
    events_found,
    events_new,
    status
FROM scrape_runs
ORDER BY started_at DESC
LIMIT 10;
EOF

# Replace placeholder with actual days value
DAILY_EVENTS_SQL="${DAILY_EVENTS_SQL//DAYS_PLACEHOLDER/$DAYS}"
DAILY_SHOPS_SQL="${DAILY_SHOPS_SQL//DAYS_PLACEHOLDER/$DAYS}"

echo "=========================================="
echo "RIFTFOUND DATABASE METRICS"
echo "=========================================="
echo ""

if [ "$REMOTE" = true ]; then
    # Load deploy config
    if [ -f "${ROOT_DIR}/deploy.env" ]; then
        source "${ROOT_DIR}/deploy.env"
    else
        echo "Error: deploy.env not found. Required for remote access."
        exit 1
    fi

    if [ -z "$EC2_HOST" ] || [ -z "$SSH_KEY_PATH" ]; then
        echo "Error: EC2_HOST and SSH_KEY_PATH must be set in deploy.env"
        exit 1
    fi

    EC2_USER="${EC2_USER:-ec2-user}"
    DB_PATH="${REMOTE_DB_PATH:-/data/riftfound.db}"

    echo "Connecting to ${EC2_HOST}..."
    echo ""

    run_sql() {
        ssh -i "$SSH_KEY_PATH" "${EC2_USER}@${EC2_HOST}" "sqlite3 -header -column '$DB_PATH' \"$1\""
    }
else
    # Local SQLite
    DB_PATH="${ROOT_DIR}/data/riftfound.db"

    if [ ! -f "$DB_PATH" ]; then
        echo "Error: Local database not found at $DB_PATH"
        echo "Run the backend in dev mode first, or use --remote for production."
        exit 1
    fi

    echo "Using local database: $DB_PATH"
    echo ""

    run_sql() {
        sqlite3 -header -column "$DB_PATH" "$1"
    }
fi

echo "OVERVIEW"
echo "----------------------------------------"
run_sql "$METRICS_SQL"

echo ""
echo "EVENTS ADDED (last ${DAYS} days)"
echo "----------------------------------------"
run_sql "$DAILY_EVENTS_SQL"

echo ""
echo "SHOPS ADDED (last ${DAYS} days)"
echo "----------------------------------------"
run_sql "$DAILY_SHOPS_SQL"

echo ""
echo "EVENTS BY TYPE"
echo "----------------------------------------"
run_sql "$EVENT_TYPES_SQL"

echo ""
echo "SHOPS BY STATE (US)"
echo "----------------------------------------"
run_sql "$SHOPS_BY_STATE_SQL"

echo ""
echo "RECENT SCRAPE RUNS"
echo "----------------------------------------"
run_sql "$SCRAPE_STATS_SQL"

echo ""
echo "=========================================="
