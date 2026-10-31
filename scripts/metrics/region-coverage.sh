#!/bin/bash
# Region coverage: what the hand-drawn scene polygons cover, and what they miss.
#
# A scene is a drawn region polygon now (scraper/src/ranking/regions.ts), and a
# store's scene is a point-in-polygon test. That is the whole point - a polygon
# does not move, so a reader's scene label and their bookmarked ?scene= link
# only change when a human edits a boundary. The cost is that the map is only as
# complete as somebody has drawn it, and a store outside every polygon gets no
# scene at all. It is never snapped to the nearest one: snapping is how a
# Mexicali store ended up filed in California.
#
# So this report is the feedback loop for the drawing pass. It prints:
#
#   - every venue in no region, busiest first, with its coordinates and the
#     scene it is filed under today - which says which polygon to draw next;
#   - every region holding no store, which is the only visible symptom of a
#     swapped [lat, lng] pair that stayed inside both coordinate ranges;
#   - regions wider than a metro, and regions below the play-share bar.
#
# Everything is read-only. It writes nothing, touches no derived item and
# cannot trigger a refit.
#
# Usage:
#   ./region-coverage.sh                    # local SQLite
#   ./region-coverage.sh --remote           # production DynamoDB (read-only)
#   ./region-coverage.sh --remote --json    # machine-readable, for an agent drawing
#
#   --remote              Read production DynamoDB (needs AWS credentials)
#   --days N              History window to replay (default: 400)
#   --max-unplaced N      How many unplaced stores to list (default: 40)
#   --dir PATH            Read polygons from somewhere other than the repo
#   --json                Machine-readable output
#
# The format the polygons are written in, and the four rules a region file has
# to follow, are in scraper/src/ranking/regions/README.md. Invalid data is
# refused with every problem listed at once, so one run fixes a batch.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${SCRIPT_DIR}/../.."
REMOTE=false
PASSTHROUGH=()

while [[ $# -gt 0 ]]; do
    case $1 in
        --remote)
            REMOTE=true
            shift
            ;;
        --days|--max-unplaced|--dir)
            PASSTHROUGH+=("$1=$2")
            shift 2
            ;;
        --days=*|--max-unplaced=*|--dir=*|--json)
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
echo "RIFTFOUND REGION COVERAGE"
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
exec npx tsx src/ranking/regionCoverage.ts "${PASSTHROUGH[@]}"
