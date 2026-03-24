#!/bin/bash
set -e

WHISPER_PORT="${WHISPER_PORT:-5555}"

echo "[start] Launching Whisper service on port ${WHISPER_PORT}..."
.venv/bin/python3 whisper_service.py &
WHISPER_PID=$!

# Wait for Whisper to be ready (up to 60s for cold start model load)
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${WHISPER_PORT}/health" > /dev/null 2>&1; then
    echo "[start] Whisper service ready."
    break
  fi
  sleep 2
done

echo "[start] Launching Node.js server on port ${PORT:-3000}..."
exec node server.js
