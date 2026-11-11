#!/usr/bin/env bash
# Serve the static Coco AI frontend locally.
# Usage: ./serve.sh [port]   (default port: 12000)
set -euo pipefail
PORT="${1:-12000}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "Serving $DIR at http://localhost:$PORT/"
exec python3 -m http.server "$PORT" --directory "$DIR"
