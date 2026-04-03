#!/bin/bash
# Launch Chrome with remote debugging enabled
# Run this on your Mac BEFORE starting a search

echo "Launching Chrome with remote debugging on port 9222..."
echo "Keep this terminal open while using the Etsy Shortlister."
echo "Once Chrome opens, just leave it — the app will control it."
echo ""

/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
    --remote-debugging-port=9222 \
    --remote-allow-origins=* \
    --user-data-dir="$HOME/.chrome-etsy-debug" \
    --no-first-run \
    2>&1
