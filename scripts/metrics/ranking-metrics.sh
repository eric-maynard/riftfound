#!/bin/bash
# Player rating metrics: co-play graph connectivity, held-out accuracy, and what
# the publishing bar admits.
#
# The co-play graph is the measurement that decides whether a *global* ladder
# means anything at all: in any paired-comparison model, ratings are identified
# only up to a constant per connected component, so two scenes that never play
# each other have independently floating scales. Run this before trusting any
# number the ranking UI shows, and re-run it as the data grows.
#
# Usage:
#   ./ranking-metrics.sh connectivity            # measure the co-play graph
#   ./ranking-metrics.sh validate                # held-out accuracy vs Riot's tiebreakers
#   ./ranking-metrics.sh bar                     # how many players clear each publishing bar
#   ./ranking-metrics.sh fit                     # dry-run refit summary (writes nothing)
#   ./ranking-metrics.sh all                     # everything
#
#   --remote                 Read production DynamoDB (needs AWS credentials)
#   --days N                 History window to replay (default: 400)
#   --holdout-days N         Days held out for validation (default: 7)
#   --file PATH              Read captured facts from an NDJSON file instead of a database
#                            (one {externalId, results, roster} object per line - how a
#                             regional sample is analysed before the backfill finishes)
#
# Everything is read-only. `fit` is a dry run and never writes derived items.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${SCRIPT_DIR}/../.."
COMMAND="all"
REMOTE=false
PASSTHROUGH=()

while [[ $# -gt 0 ]]; do
    case $1 in
        connectivity|validate|bar|fit|all)
            COMMAND="$1"
            shift
            ;;
        --remote)
            REMOTE=true
            shift
            ;;
        --days|--holdout-days|--file|--set-table)
            PASSTHROUGH+=("$1=$2")
            shift 2
            ;;
        --days=*|--holdout-days=*|--file=*|--set-table=*)
            PASSTHROUGH+=("$1")
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

echo "=========================================="
echo "RIFTFOUND PLAYER RATING METRICS"
echo "=========================================="

if [ "$REMOTE" = true ]; then
    if [ -f "${ROOT_DIR}/deploy.env" ]; then
        # shellcheck disable=SC1091
        source "${ROOT_DIR}/deploy.env"
    fi
    export DB_TYPE=dynamodb
    export DYNAMODB_TABLE_NAME="${DYNAMODB_TABLE_NAME:-riftfound-prod}"
    export AWS_REGION="${AWS_REGION:-us-west-2}"
    echo "Source: DynamoDB table ${DYNAMODB_TABLE_NAME} (${AWS_REGION})"
    if ! aws sts get-caller-identity >/dev/null 2>&1; then
        echo "Error: no usable AWS credentials. Run 'aws sts get-caller-identity' to check."
        exit 1
    fi
else
    export DB_TYPE="${DB_TYPE:-sqlite}"
    export SQLITE_PATH="${SQLITE_PATH:-${ROOT_DIR}/riftfound.db}"
    echo "Source: ${DB_TYPE} (${SQLITE_PATH})"
fi

echo ""
cd "${ROOT_DIR}/scraper"
exec npx tsx src/ranking/report.ts "$COMMAND" "${PASSTHROUGH[@]}"
