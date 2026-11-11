#!/usr/bin/env bash
# Serve the Coco AI mirror locally with its mock backend.
# Usage: ./serve.sh [port]   (default port: 12000)
set -euo pipefail
PORT="${1:-12000}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -d "$DIR/mock-server/node_modules" ]; then
  echo "Installing mock backend dependencies..."
  (cd "$DIR/mock-server" && npm install --omit=dev)
fi

echo "Serving $DIR at http://localhost:$PORT/ (mock backend)"
cd "$DIR"
exec env PORT="$PORT" node mock-server/server.js
