-- Database initialization script for local development
-- This runs automatically when the PostgreSQL container starts

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Shops dimension table (stores/organizers with geocoded locations)
CREATE TABLE IF NOT EXISTS shops (
    id SERIAL PRIMARY KEY,
    external_id INTEGER UNIQUE NOT NULL,
    name VARCHAR(500) NOT NULL,
    location_text VARCHAR(500),
    latitude DECIMAL(10, 8),
    longitude DECIMAL(11, 8),
    geocode_status VARCHAR(50) DEFAULT 'pending',
    geocode_error TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shops_external_id ON shops(external_id);
CREATE INDEX IF NOT EXISTS idx_shops_name ON shops(name);
CREATE INDEX IF NOT EXISTS idx_shops_geocode_status ON shops(geocode_status);
CREATE INDEX IF NOT EXISTS idx_shops_lat_lng ON shops(latitude, longitude);

-- Events table
CREATE TABLE IF NOT EXISTS events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    external_id VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(500) NOT NULL,
    description TEXT,
    location VARCHAR(500),
    address VARCHAR(500),
    city VARCHAR(255),
    state VARCHAR(255),
    country VARCHAR(255),
    latitude DECIMAL(10, 8),
    longitude DECIMAL(11, 8),
    start_date TIMESTAMP WITH TIME ZONE NOT NULL,
    start_time VARCHAR(50),
    end_date TIMESTAMP WITH TIME ZONE,
    event_type VARCHAR(100),
    organizer VARCHAR(255),
    player_count INTEGER,
    price VARCHAR(50),
    url VARCHAR(1000),
    image_url VARCHAR(1000),
    shop_id INTEGER REFERENCES shops(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    scraped_at TIMESTAMP WITH TIME ZONE NOT NULL
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_events_start_date ON events(start_date);
CREATE INDEX IF NOT EXISTS idx_events_city ON events(city);
CREATE INDEX IF NOT EXISTS idx_events_state ON events(state);
CREATE INDEX IF NOT EXISTS idx_events_country ON events(country);
CREATE INDEX IF NOT EXISTS idx_events_external_id ON events(external_id);
CREATE INDEX IF NOT EXISTS idx_events_shop_id ON events(shop_id);

-- Full text search index
CREATE INDEX IF NOT EXISTS idx_events_search ON events USING gin(
    to_tsvector('english', coalesce(name, '') || ' ' || coalesce(description, '') || ' ' || coalesce(location, ''))
);

-- Geocache table for caching user city searches
CREATE TABLE IF NOT EXISTS geocache (
    id SERIAL PRIMARY KEY,
    query VARCHAR(500) UNIQUE NOT NULL,
    latitude DECIMAL(10, 8) NOT NULL,
    longitude DECIMAL(11, 8) NOT NULL,
    display_name VARCHAR(1000),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_geocache_query ON geocache(query);

-- Scrape metadata table to track scraping runs
CREATE TABLE IF NOT EXISTS scrape_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    started_at TIMESTAMP WITH TIME ZONE NOT NULL,
    completed_at TIMESTAMP WITH TIME ZONE,
    status VARCHAR(50) NOT NULL DEFAULT 'running',
    events_found INTEGER DEFAULT 0,
    events_created INTEGER DEFAULT 0,
    events_updated INTEGER DEFAULT 0,
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_scrape_runs_started_at ON scrape_runs(started_at DESC);
