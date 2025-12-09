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
SCRAPER_PID=""

cleanup() {
    echo -e "\n${YELLOW}Shutting down...${NC}"

    # Kill process groups (negative PID kills the group)
    [ -n "$BACKEND_PID" ] && kill -- -$BACKEND_PID 2>/dev/null || kill $BACKEND_PID 2>/dev/null || true
    [ -n "$FRONTEND_PID" ] && kill -- -$FRONTEND_PID 2>/dev/null || kill $FRONTEND_PID 2>/dev/null || true
    [ -n "$SCRAPER_PID" ] && kill -- -$SCRAPER_PID 2>/dev/null || kill $SCRAPER_PID 2>/dev/null || true

    # Also kill any remaining node processes from this script
    pkill -P $$ 2>/dev/null || true

    # Stop docker services if we started them (unless --keep-docker)
    if [ "$USE_DOCKER" = "true" ] && [ "$KEEP_DOCKER" != "true" ]; then
        echo -e "${YELLOW}Stopping docker services...${NC}"
        if [ "$USE_PHOTON" = "true" ]; then
            docker compose --profile geocoding down
        else
            docker compose down
        fi
    fi

    echo -e "${GREEN}Stopped.${NC}"
    exit 0
}

trap cleanup SIGINT SIGTERM EXIT

# Parse arguments
USE_DOCKER=false
USE_POSTGRES=false
USE_PHOTON=false
KEEP_DOCKER=false
RESET_DATA=false
RESET_DB_ONLY=false

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
        --keep-docker)
            KEEP_DOCKER=true
            ;;
        --reset)
            RESET_DATA=true
            ;;
        --reset-db)
            RESET_DB_ONLY=true
            ;;
    esac
done

# Handle --reset flag
if [ "$RESET_DATA" = "true" ]; then
    echo -e "${YELLOW}Resetting all data...${NC}"

    # Stop any running docker services first
    echo -e "${YELLOW}Stopping docker services...${NC}"
    docker compose --profile geocoding down 2>/dev/null || true

    # Remove docker volumes
    echo -e "${YELLOW}Removing docker volumes...${NC}"
    docker volume rm riftfound_postgres_data 2>/dev/null && echo -e "  ${GREEN}Removed postgres_data volume${NC}" || echo -e "  ${BLUE}postgres_data volume not found${NC}"
    docker volume rm riftfound_photon_data 2>/dev/null && echo -e "  ${GREEN}Removed photon_data volume${NC}" || echo -e "  ${BLUE}photon_data volume not found${NC}"

    # Remove SQLite database
    if [ -f "riftfound.db" ]; then
        rm -f "riftfound.db"
        echo -e "  ${GREEN}Removed riftfound.db${NC}"
    else
        echo -e "  ${BLUE}riftfound.db not found${NC}"
    fi

    echo -e "${GREEN}Reset complete!${NC}"
    echo ""
fi

# Handle --reset-db flag (database only, preserves Photon)
if [ "$RESET_DB_ONLY" = "true" ]; then
    echo -e "${YELLOW}Resetting database only (Photon preserved)...${NC}"

    # Stop postgres container if running
    docker compose stop postgres 2>/dev/null || true

    # Remove postgres volume
    docker volume rm riftfound_postgres_data 2>/dev/null && echo -e "  ${GREEN}Removed postgres_data volume${NC}" || echo -e "  ${BLUE}postgres_data volume not found${NC}"

    # Remove SQLite database
    if [ -f "riftfound.db" ]; then
        rm -f "riftfound.db"
        echo -e "  ${GREEN}Removed riftfound.db${NC}"
    else
        echo -e "  ${BLUE}riftfound.db not found${NC}"
    fi

    echo -e "${GREEN}Database reset complete!${NC}"
    echo ""
fi

# Check if dependencies are installed
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}Installing dependencies...${NC}"
    npm install
fi

# Start docker services if requested
if [ "$USE_DOCKER" = "true" ]; then
    echo -e "${BLUE}Starting docker services...${NC}"

    # Stop any existing containers first to ensure clean state
    if [ "$USE_PHOTON" = "true" ]; then
        docker compose --profile geocoding down 2>/dev/null || true
        echo -e "${YELLOW}Starting with Photon (first run will download ~8GB)...${NC}"
        docker compose --profile geocoding up -d --build
    else
        docker compose down 2>/dev/null || true
        docker compose up -d --build
    fi

    # Wait for PostgreSQL to be healthy
    echo -e "${YELLOW}Waiting for PostgreSQL...${NC}"
    until docker compose exec -T postgres pg_isready -U riftfound > /dev/null 2>&1; do
        sleep 1
    done
    echo -e "${GREEN}PostgreSQL ready!${NC}"

    # Export environment for PostgreSQL
    if [ "$USE_POSTGRES" = "true" ]; then
        export DB_TYPE=postgres
        export DB_HOST=localhost
        export DB_PORT=5432
        export DB_NAME=riftfound
        export DB_USER=riftfound
        export DB_PASSWORD=localdevpassword
    fi

    # Wait for Photon if enabled
    if [ "$USE_PHOTON" = "true" ]; then
        export PHOTON_URL=http://localhost:2322
        echo -e "${YELLOW}Waiting for Photon...${NC}"

        # Check if Photon is healthy by hitting the API
        PHOTON_READY=false
        WAIT_COUNT=0
        while [ "$PHOTON_READY" = "false" ]; do
            if curl -s "http://localhost:2322/api?q=test" > /dev/null 2>&1; then
                PHOTON_READY=true
            else
                WAIT_COUNT=$((WAIT_COUNT + 1))
                # Every 30 seconds, show progress
                if [ $((WAIT_COUNT % 15)) -eq 0 ]; then
                    # Try to get download progress from container
                    PROGRESS=$(docker logs --tail 1 riftfound-photon 2>&1 | grep -oE '[0-9]+%' | tail -1 || echo "")
                    if [ -n "$PROGRESS" ]; then
                        echo -e "${YELLOW}  Photon downloading: ${PROGRESS}${NC}"
                    else
                        echo -e "${YELLOW}  Still waiting for Photon... (docker logs riftfound-photon)${NC}"
                    fi
                fi
                sleep 2
            fi
        done
        echo -e "${GREEN}Photon ready!${NC}"
    fi

    echo -e "${GREEN}Docker services started!${NC}"
    echo -e "  PostgreSQL: ${YELLOW}localhost:5432${NC}"
    if [ "$USE_PHOTON" = "true" ]; then
        echo -e "  Photon:     ${YELLOW}localhost:2322${NC}"
    fi
    echo ""
fi

echo -e "${GREEN}Starting Riftfound dev servers...${NC}"
echo ""

set -m  # Enable job control for process groups

# Start backend
echo -e "${YELLOW}Starting backend on http://localhost:3001${NC}"
(cd "$SCRIPT_DIR/backend" && exec npx tsx src/index.ts) &
BACKEND_PID=$!

# Start frontend
echo -e "${YELLOW}Starting frontend on http://localhost:5173${NC}"
(cd "$SCRIPT_DIR/frontend" && exec npx vite) &
FRONTEND_PID=$!

# Start scraper (runs continuously with interval)
echo -e "${YELLOW}Starting scraper (runs every ${SCRAPE_INTERVAL_MINUTES:-60} minutes)${NC}"
(cd "$SCRIPT_DIR/scraper" && exec npx tsx src/index.ts) &
SCRAPER_PID=$!

# Wait for servers to initialize before printing summary
sleep 3

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  Riftfound is running!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "  ${GREEN}>>> Open: ${YELLOW}http://localhost:5173${NC} ${GREEN}<<<${NC}"
echo ""
echo -e "  Backend:  ${YELLOW}http://localhost:3001${NC}"
echo -e "  Scraper:  ${YELLOW}Running (interval: ${SCRAPE_INTERVAL_MINUTES:-60}m)${NC}"
if [ "$USE_DOCKER" = "true" ]; then
    if [ "$USE_PHOTON" = "true" ]; then
        echo -e "  Photon:   ${YELLOW}http://localhost:2322${NC}"
    fi
fi
echo ""
echo -e "  Press ${RED}Ctrl+C${NC} to stop"
echo ""

# Wait for either process to exit
wait
