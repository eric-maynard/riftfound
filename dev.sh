#!/bin/bash

# Riftfound Development Server
# Runs backend + frontend (and optionally scraper)

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# PIDs for cleanup
BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
    echo -e "\n${YELLOW}Shutting down...${NC}"
    [ -n "$BACKEND_PID" ] && kill $BACKEND_PID 2>/dev/null
    [ -n "$FRONTEND_PID" ] && kill $FRONTEND_PID 2>/dev/null
    exit 0
}

trap cleanup SIGINT SIGTERM

# Check if dependencies are installed
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}Installing dependencies...${NC}"
    npm install
fi

# Check if database exists, run scraper if not
if [ ! -f "riftfound.db" ]; then
    echo -e "${YELLOW}No database found. Running initial scrape...${NC}"
    npm run dev:scraper -- --run-once 2>/dev/null || (
        cd scraper && npx tsx src/index.ts
    )
    echo -e "${GREEN}Scrape complete!${NC}"
fi

echo -e "${GREEN}Starting Riftfound dev servers...${NC}"
echo ""

# Start backend
echo -e "${YELLOW}Starting backend on http://localhost:3001${NC}"
cd backend && npx tsx src/index.ts &
BACKEND_PID=$!
cd ..

# Wait for backend to start
sleep 2

# Start frontend
echo -e "${YELLOW}Starting frontend on http://localhost:5173${NC}"
cd frontend && npx vite &
FRONTEND_PID=$!
cd ..

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  Riftfound is running!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "  Frontend:  ${YELLOW}http://localhost:5173${NC}"
echo -e "  Backend:   ${YELLOW}http://localhost:3001${NC}"
echo -e "  API:       ${YELLOW}http://localhost:3001/api/events${NC}"
echo ""
echo -e "  Press ${RED}Ctrl+C${NC} to stop"
echo ""

# Wait for either process to exit
wait
