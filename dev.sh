#!/bin/bash

# Riftfound Development Server
# Runs backend + frontend with docker-compose services (PostgreSQL, Photon)

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# PIDs for cleanup
BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
    echo -e "\n${YELLOW}Shutting down...${NC}"

    # Kill process groups (negative PID kills the group)
    [ -n "$BACKEND_PID" ] && kill -- -$BACKEND_PID 2>/dev/null || kill $BACKEND_PID 2>/dev/null || true
    [ -n "$FRONTEND_PID" ] && kill -- -$FRONTEND_PID 2>/dev/null || kill $FRONTEND_PID 2>/dev/null || true

    # Also kill any remaining node processes from this script
    pkill -P $$ 2>/dev/null || true

    # Optionally stop docker services
    if [ "$STOP_DOCKER" = "true" ]; then
        echo -e "${YELLOW}Stopping docker services...${NC}"
        docker compose down
    fi

    echo -e "${GREEN}Stopped.${NC}"
    exit 0
}

trap cleanup SIGINT SIGTERM EXIT

# Parse arguments
USE_DOCKER=false
USE_POSTGRES=false
USE_PHOTON=false
STOP_DOCKER=false

for arg in "$@"; do
    case $arg in
        --docker)
            USE_DOCKER=true
            ;;
        --postgres)
            USE_POSTGRES=true
            USE_DOCKER=true
            ;;
        --photon)
            USE_PHOTON=true
            USE_DOCKER=true
            ;;
        --stop-docker)
            STOP_DOCKER=true
            ;;
    esac
done

# Check if dependencies are installed
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}Installing dependencies...${NC}"
    npm install
fi

# Start docker services if requested
if [ "$USE_DOCKER" = "true" ]; then
    echo -e "${BLUE}Starting docker services...${NC}"

    if [ "$USE_PHOTON" = "true" ]; then
        echo -e "${YELLOW}Starting with Photon (first run will download ~8GB)...${NC}"
        docker compose --profile geocoding up -d
    else
        docker compose up -d
    fi

    # Wait for services to be healthy
    echo -e "${YELLOW}Waiting for services to be ready...${NC}"
    sleep 5

    # Export environment for PostgreSQL
    if [ "$USE_POSTGRES" = "true" ]; then
        export DB_TYPE=postgres
        export DB_HOST=localhost
        export DB_PORT=5432
        export DB_NAME=riftfound
        export DB_USER=riftfound
        export DB_PASSWORD=localdevpassword
    fi

    echo -e "${GREEN}Docker services started!${NC}"
    echo -e "  PostgreSQL: ${YELLOW}localhost:5432${NC}"
    if [ "$USE_PHOTON" = "true" ]; then
        export PHOTON_URL=http://localhost:2322
        echo -e "  Photon:     ${YELLOW}localhost:2322${NC}"
    fi
    echo ""
fi

# Check if database exists (SQLite mode only), run scraper if not
if [ "$USE_POSTGRES" != "true" ] && [ ! -f "riftfound.db" ]; then
    echo -e "${YELLOW}No database found. Running initial scrape...${NC}"
    npm run dev:scraper -- --run-once 2>/dev/null || (
        cd scraper && npx tsx src/index.ts
    )
    echo -e "${GREEN}Scrape complete!${NC}"
fi

echo -e "${GREEN}Starting Riftfound dev servers...${NC}"
echo ""

# Start backend in its own process group
echo -e "${YELLOW}Starting backend on http://localhost:3001${NC}"
set -m  # Enable job control for process groups
(cd "$SCRIPT_DIR/backend" && exec npx tsx src/index.ts) &
BACKEND_PID=$!

# Wait for backend to start
sleep 2

# Start frontend in its own process group
echo -e "${YELLOW}Starting frontend on http://localhost:5173${NC}"
(cd "$SCRIPT_DIR/frontend" && exec npx vite) &
FRONTEND_PID=$!

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  Riftfound is running!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "  Frontend:  ${YELLOW}http://localhost:5173${NC}"
echo -e "  Backend:   ${YELLOW}http://localhost:3001${NC}"
echo -e "  API:       ${YELLOW}http://localhost:3001/api/events${NC}"
if [ "$USE_DOCKER" = "true" ]; then
    echo -e "  PostgreSQL:${YELLOW}localhost:5432${NC}"
    if [ "$USE_PHOTON" = "true" ]; then
        echo -e "  Photon:    ${YELLOW}http://localhost:2322${NC}"
    fi
fi
echo ""
echo -e "  ${BLUE}Options:${NC}"
echo -e "    --docker      Start PostgreSQL via docker compose"
echo -e "    --postgres    Use PostgreSQL instead of SQLite (implies --docker)"
echo -e "    --photon      Also start Photon geocoder (first run downloads ~8GB)"
echo -e "    --stop-docker Stop docker services on exit"
echo ""
echo -e "  Press ${RED}Ctrl+C${NC} to stop"
echo ""

# Wait for either process to exit
wait
