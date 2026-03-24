#!/bin/bash
set -e

echo "[start] Launching Whisper service..."
python whisper_service.py &
WHISPER_PID=$!

# Wait for Whisper to be ready
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:${WHISPER_PORT:-5555}/health > /dev/null 2>&1; then
    echo "[start] Whisper service ready."
    break
  fi
  sleep 2
done

echo "[start] Launching Node.js server..."
exec node server.js
