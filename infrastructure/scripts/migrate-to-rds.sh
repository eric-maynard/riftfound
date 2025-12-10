#!/bin/bash
set -e

# Migrate local SQLite data to remote RDS PostgreSQL
# Usage: ./migrate-to-rds.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SQLITE_DB="$PROJECT_ROOT/backend/data/riftfound.db"
TERRAFORM_DIR="$PROJECT_ROOT/infrastructure/terraform"

echo "=== Riftfound DB Migration Tool ==="
echo ""

# Check SQLite database exists
if [ ! -f "$SQLITE_DB" ]; then
  echo "Error: SQLite database not found at $SQLITE_DB"
  echo "Run the scraper locally first to populate the database."
  exit 1
fi

# Get RDS connection info from Terraform
echo "Getting RDS connection info from Terraform..."
cd "$TERRAFORM_DIR"

RDS_ENDPOINT=$(terraform output -raw database_endpoint 2>/dev/null || echo "")
if [ -z "$RDS_ENDPOINT" ]; then
  echo "Error: Could not get RDS endpoint from Terraform."
  echo "Make sure you've run 'terraform apply' first."
  exit 1
fi

# Extract host and port from endpoint (format: hostname:port)
RDS_HOST=$(echo "$RDS_ENDPOINT" | cut -d: -f1)
RDS_PORT=$(echo "$RDS_ENDPOINT" | cut -d: -f2)
RDS_DB="riftfound"
RDS_USER="riftfound"

# Get password from SSM
echo "Getting database password from SSM..."
RDS_PASSWORD=$(aws ssm get-parameter --name "/riftfound/database/password" --with-decryption --query 'Parameter.Value' --output text)

if [ -z "$RDS_PASSWORD" ]; then
  echo "Error: Could not get database password from SSM."
  exit 1
fi

echo ""
echo "Source: $SQLITE_DB"
echo "Target: postgresql://$RDS_USER@$RDS_HOST:$RDS_PORT/$RDS_DB"
echo ""

# Check if psql is available
if ! command -v psql &> /dev/null; then
  echo "Error: psql command not found. Install PostgreSQL client:"
  echo "  Ubuntu/Debian: sudo apt install postgresql-client"
  echo "  macOS: brew install libpq"
  exit 1
fi

# Test RDS connection
echo "Testing RDS connection..."
if ! PGPASSWORD="$RDS_PASSWORD" psql -h "$RDS_HOST" -p "$RDS_PORT" -U "$RDS_USER" -d "$RDS_DB" -c '\q' 2>/dev/null; then
  echo "Error: Could not connect to RDS."
  echo "Make sure your IP is allowed in the security group."
  exit 1
fi
echo "Connection successful!"
echo ""

# Create temp directory for export
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Export data from SQLite
echo "Exporting data from SQLite..."

# Export events
sqlite3 -header -csv "$SQLITE_DB" "SELECT * FROM events" > "$TEMP_DIR/events.csv"
EVENT_COUNT=$(wc -l < "$TEMP_DIR/events.csv")
echo "  - Events: $((EVENT_COUNT - 1)) rows"

# Export shops
sqlite3 -header -csv "$SQLITE_DB" "SELECT * FROM shops" > "$TEMP_DIR/shops.csv"
SHOP_COUNT=$(wc -l < "$TEMP_DIR/shops.csv")
echo "  - Shops: $((SHOP_COUNT - 1)) rows"

# Export geocache
sqlite3 -header -csv "$SQLITE_DB" "SELECT * FROM geocache" > "$TEMP_DIR/geocache.csv"
GEOCACHE_COUNT=$(wc -l < "$TEMP_DIR/geocache.csv")
echo "  - Geocache: $((GEOCACHE_COUNT - 1)) rows"

echo ""
echo "Importing data to RDS..."

# Create tables if they don't exist (init.sql should have run, but just in case)
PGPASSWORD="$RDS_PASSWORD" psql -h "$RDS_HOST" -p "$RDS_PORT" -U "$RDS_USER" -d "$RDS_DB" << 'EOF'
-- Create tables if not exists
CREATE TABLE IF NOT EXISTS shops (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  location_text VARCHAR(255),
  latitude DECIMAL(10, 7),
  longitude DECIMAL(10, 7),
  geocoded_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(name, location_text)
);

CREATE TABLE IF NOT EXISTS events (
  id VARCHAR(255) PRIMARY KEY,
  external_id VARCHAR(255) NOT NULL,
  name VARCHAR(500) NOT NULL,
  description TEXT,
  location VARCHAR(500),
  address VARCHAR(500),
  city VARCHAR(255),
  state VARCHAR(255),
  country VARCHAR(255),
  latitude DECIMAL(10, 7),
  longitude DECIMAL(10, 7),
  start_date DATE NOT NULL,
  start_time TIME,
  end_date DATE,
  event_type VARCHAR(100),
  organizer VARCHAR(255),
  player_count INTEGER,
  price VARCHAR(100),
  url VARCHAR(1000),
  image_url VARCHAR(1000),
  shop_id INTEGER REFERENCES shops(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS geocache (
  query VARCHAR(255) PRIMARY KEY,
  latitude DECIMAL(10, 7) NOT NULL,
  longitude DECIMAL(10, 7) NOT NULL,
  display_name VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scrape_runs (
  id SERIAL PRIMARY KEY,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP,
  events_found INTEGER DEFAULT 0,
  events_created INTEGER DEFAULT 0,
  events_updated INTEGER DEFAULT 0,
  status VARCHAR(50) DEFAULT 'running'
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_events_start_date ON events(start_date);
CREATE INDEX IF NOT EXISTS idx_events_shop_id ON events(shop_id);
CREATE INDEX IF NOT EXISTS idx_events_coords ON events(latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_shops_coords ON shops(latitude, longitude);
EOF

# Clear existing data (fresh import)
echo "Clearing existing data in RDS..."
PGPASSWORD="$RDS_PASSWORD" psql -h "$RDS_HOST" -p "$RDS_PORT" -U "$RDS_USER" -d "$RDS_DB" << 'EOF'
TRUNCATE events, shops, geocache, scrape_runs RESTART IDENTITY CASCADE;
EOF

# Import shops first (events reference them)
echo "Importing shops..."
PGPASSWORD="$RDS_PASSWORD" psql -h "$RDS_HOST" -p "$RDS_PORT" -U "$RDS_USER" -d "$RDS_DB" << EOF
\copy shops(id, name, location_text, latitude, longitude, geocoded_at, created_at, updated_at) FROM '$TEMP_DIR/shops.csv' WITH (FORMAT csv, HEADER true);
SELECT setval('shops_id_seq', (SELECT MAX(id) FROM shops));
EOF

# Import events
echo "Importing events..."
PGPASSWORD="$RDS_PASSWORD" psql -h "$RDS_HOST" -p "$RDS_PORT" -U "$RDS_USER" -d "$RDS_DB" << EOF
\copy events FROM '$TEMP_DIR/events.csv' WITH (FORMAT csv, HEADER true);
EOF

# Import geocache
echo "Importing geocache..."
PGPASSWORD="$RDS_PASSWORD" psql -h "$RDS_HOST" -p "$RDS_PORT" -U "$RDS_USER" -d "$RDS_DB" << EOF
\copy geocache FROM '$TEMP_DIR/geocache.csv' WITH (FORMAT csv, HEADER true);
EOF

# Verify import
echo ""
echo "Verifying import..."
PGPASSWORD="$RDS_PASSWORD" psql -h "$RDS_HOST" -p "$RDS_PORT" -U "$RDS_USER" -d "$RDS_DB" << 'EOF'
SELECT 'events' as table_name, COUNT(*) as row_count FROM events
UNION ALL
SELECT 'shops', COUNT(*) FROM shops
UNION ALL
SELECT 'geocache', COUNT(*) FROM geocache;
EOF

echo ""
echo "Migration complete!"
