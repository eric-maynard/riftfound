# Riftfound

A web application that scrapes and displays Riftbound events in a better format.

## Project Structure

```
riftfound/
├── backend/          # Express.js API server (TypeScript)
├── frontend/         # React application (TypeScript + Vite)
├── scraper/          # Event scraper service (TypeScript)
├── infrastructure/   # Database schema and deployment docs
└── docker-compose.yml
```

## Quick Start (Local Development)

### Prerequisites

- Node.js 18+
- Docker (for local PostgreSQL)

### Setup

1. **Clone and install dependencies:**
   ```bash
   npm install
   ```

2. **Set up environment:**
   ```bash
   cp .env.local.example .env
   ```

3. **Start local database:**
   ```bash
   docker-compose up -d
   ```

4. **Start development servers:**
   ```bash
   # Terminal 1 - Backend API
   npm run dev:backend

   # Terminal 2 - Frontend
   npm run dev:frontend
   ```

5. **Run the scraper (to populate data):**
   ```bash
   npm run dev:scraper
   ```

The frontend will be available at http://localhost:5173

## Development Commands

| Command | Description |
|---------|-------------|
| `npm run dev:backend` | Start backend in dev mode |
| `npm run dev:frontend` | Start frontend in dev mode |
| `npm run dev:scraper` | Run scraper once |
| `npm run build` | Build all packages |
| `docker-compose up -d` | Start local PostgreSQL |
| `docker-compose down` | Stop local PostgreSQL |

## Production Deployment

See [infrastructure/aws-deployment.md](infrastructure/aws-deployment.md) for AWS deployment instructions.

**Key points:**
- Database credentials are stored in AWS Secrets Manager (not in code)
- The `.env` file is gitignored and never committed
- Copy `.env.example` or `.env.local.example` for your local setup

## Architecture

### Backend
- Express.js with TypeScript
- PostgreSQL database (RDS in production)
- Zod for validation
- RESTful API at `/api/events`

### Frontend
- React 18 with TypeScript
- Vite for bundling
- React Router for navigation

### Scraper
- Runs periodically (Lambda + EventBridge in production)
- Parses events from the source page
- Upserts events to avoid duplicates

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/events` | List events (with pagination & filters) |
| GET | `/api/events/:id` | Get single event |
| GET | `/api/health` | Health check |

### Query Parameters for `/api/events`

- `page` - Page number (default: 1)
- `limit` - Items per page (default: 20)
- `search` - Search in name/description/location
- `city` - Filter by city
- `state` - Filter by state
- `country` - Filter by country
- `startDateFrom` - Filter events starting after date
- `startDateTo` - Filter events starting before date

## License

MIT
