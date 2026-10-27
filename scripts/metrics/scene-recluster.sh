#!/bin/bash
# Re-cluster the scenes: the deliberate, occasional operation that decides which
# store belongs to which local scene.
#
# This is NOT a cron job and must not become one. A scene is a Louvain community
# of the co-play graph, and a partition refitted on 90% of the matches moves
# 12-18% of its labels - so a scene recomputed every refit would reshuffle the
# UI's scene selector daily. The assignment is therefore persisted, read by every
# rating refit, and rewritten only when a human runs this script and accepts the
# diff. See "Scenes" in scraper/CLAUDE.md and the runbook in this directory's
# README.md.
#
# Read-only unless --write is passed.
#
# Usage:
#   ./scene-recluster.sh --remote                 # propose and diff production, write nothing
#   ./scene-recluster.sh --remote --write         # accept the proposal
#   ./scene-recluster.sh --remote --show          # print the live assignment and stop
#   ./scene-recluster.sh --remote --rollback --write   # restore the assignment this one replaced
#
#   --remote              Read (and with --write, write) production DynamoDB
#   --resolution N        Louvain resolution (default: 1, the measured stability optimum)
#   --carry-jaccard N     Minimum venue-set overlap to keep a scene's id (default: 0.5)
#   --days N              History window to replay (default: 400)
#   --max-moves N         How many moved stores to list (default: 25)
#   --json                Machine-readable output, for an agent driving this
#
# What to look at before accepting, what a bad result looks like, and how to roll
# back are all in the runbook: scripts/metrics/README.md, "Re-clustering scenes".

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${SCRIPT_DIR}/../.."
REMOTE=false
WRITE=false
PASSTHROUGH=()

while [[ $# -gt 0 ]]; do
    case $1 in
        --remote)
            REMOTE=true
            shift
            ;;
        --write)
            WRITE=true
            PASSTHROUGH+=("$1")
            shift
            ;;
        --show|--rollback|--json)
            PASSTHROUGH+=("$1")
            shift
            ;;
        --resolution|--carry-jaccard|--days|--max-moves)
            PASSTHROUGH+=("$1=$2")
            shift 2
            ;;
        --resolution=*|--carry-jaccard=*|--days=*|--max-moves=*)
            PASSTHROUGH+=("$1")
            shift
            ;;
        -h|--help)
            sed -n '2,29p' "${BASH_SOURCE[0]}"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

echo "=========================================="
echo "RIFTFOUND SCENE RE-CLUSTERING"
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

if [ "$WRITE" = true ]; then
    echo "Mode: WRITE - the assignment will be replaced if the run completes"
else
    echo "Mode: dry run (nothing will be written)"
fi
echo ""

cd "${ROOT_DIR}/scraper"
exec npx tsx src/ranking/recluster.ts "${PASSTHROUGH[@]}"
