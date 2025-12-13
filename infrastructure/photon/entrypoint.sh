#!/bin/bash
set -e

VOLUME_DIR="/photon/photon_data"
COUNTRY="${PHOTON_COUNTRY:-}"

# Photon with -data-dir X looks for elasticsearch at X/photon_data/elasticsearch/
# Tar extracts photon_data/elasticsearch/... into VOLUME_DIR
# So DATA_DIR must be VOLUME_DIR (not VOLUME_DIR/photon_data)
DATA_DIR="$VOLUME_DIR"

if [ -d "$VOLUME_DIR/photon_data/elasticsearch/data/nodes" ]; then
    echo "Found existing Photon data, starting server..."
else
    if [ -n "$COUNTRY" ]; then
        echo "Downloading Photon data for country: $COUNTRY"
        echo "This may take a while..."
        DOWNLOAD_URL="https://download1.graphhopper.com/public/extracts/by-country-code/${COUNTRY}/photon-db-${COUNTRY}-latest.tar.bz2"
    else
        echo "Downloading WORLDWIDE Photon data (~70GB)"
        echo "This will take a long time..."
        DOWNLOAD_URL="https://download1.graphhopper.com/public/photon-db-latest.tar.bz2"
    fi

    mkdir -p "$VOLUME_DIR"
    cd "$VOLUME_DIR"
    curl -L "$DOWNLOAD_URL" | tar -xjf -

    echo "Download complete!"
fi

cd /photon
echo "Starting Photon with data-dir: $DATA_DIR"
exec java -jar photon.jar -data-dir "$DATA_DIR"
