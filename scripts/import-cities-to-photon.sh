#!/bin/bash
# Import cities JSON into Photon's OpenSearch index
# Run this on EC2: ./import-cities-to-photon.sh /tmp/cities.json

set -e

CITIES_FILE="${1:-/tmp/cities.json}"
CONTAINER="photon"
ES_URL="http://localhost:9200"
INDEX="photon"

if [ ! -f "$CITIES_FILE" ]; then
    echo "Error: Cities file not found: $CITIES_FILE"
    exit 1
fi

count=$(wc -l < "$CITIES_FILE")
echo "Importing $count cities from $CITIES_FILE into Photon..."

# Convert to ES5 bulk format using jq (requires _type for ES 5.x)
# Each line is already a document, we just need to add the index action line
BULK_FILE="/tmp/cities_bulk.ndjson"
jq -c '{"index":{"_index":"photon","_type":"place","_id":(.osm_id|tostring)}}, .' "$CITIES_FILE" > "$BULK_FILE"

echo "Prepared bulk file: $(wc -l < "$BULK_FILE") lines"

# Import via docker exec - copy file into container first
docker cp "$BULK_FILE" "$CONTAINER:/tmp/cities_bulk.ndjson"

echo "Sending bulk request to OpenSearch..."
docker exec "$CONTAINER" curl -s -X POST "$ES_URL/_bulk" \
    -H 'Content-Type: application/x-ndjson' \
    --data-binary @/tmp/cities_bulk.ndjson | jq '{took, errors, items: (.items | length)}'

# Refresh the index
echo "Refreshing index..."
docker exec "$CONTAINER" curl -s -X POST "$ES_URL/$INDEX/_refresh" | jq .

echo "Done! Imported $count cities."

# Test a query
echo ""
echo "Testing search for 'Berlin'..."
docker exec "$CONTAINER" curl -s "http://localhost:2322/api?q=berlin&limit=3" | jq '.features[].properties | {name, country, countrycode}'
