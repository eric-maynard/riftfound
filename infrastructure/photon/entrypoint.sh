#!/bin/bash
set -e

DATA_DIR="/photon/photon_data"
COUNTRY="${PHOTON_COUNTRY:-us}"

# Check if data already exists
if [ ! -d "$DATA_DIR/elasticsearch" ]; then
    echo "Downloading Photon data for country: $COUNTRY"
    echo "This may take a while (~8GB for US)..."

    DOWNLOAD_URL="https://download1.graphhopper.com/public/extracts/by-country-code/${COUNTRY}/photon-db-${COUNTRY}-latest.tar.bz2"

    mkdir -p "$DATA_DIR"
    cd "$DATA_DIR"

    curl -L "$DOWNLOAD_URL" | tar -xjf -

    echo "Download complete!"
else
    echo "Photon data already exists, starting server..."
fi

cd /photon
exec java -jar photon.jar -data-path "$DATA_DIR"
