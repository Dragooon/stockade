#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Load environment variables from config/.env ──
if [ -f config/.env ]; then
  set -a
  source config/.env
  set +a
  echo "[startup] Loaded environment from config/.env"
else
  echo "[startup] WARNING: config/.env not found"
fi

# ── Helper: wait for a health endpoint ──
wait_for_health() {
  local url="$1"
  local name="$2"
  local timeout="${3:-30}"
  local elapsed=0

  echo "[startup] Waiting for $name at $url/health ..."
  while [ $elapsed -lt $timeout ]; do
    if curl -sf "$url/health" > /dev/null 2>&1; then
      echo "[startup] $name is healthy"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  echo "[startup] ERROR: $name did not become healthy within ${timeout}s"
  return 1
}

# ── Cleanup on exit ──
PIDS=()
cleanup() {
  echo ""
  echo "[startup] Shutting down..."
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
  echo "[startup] All processes stopped"
}
trap cleanup EXIT INT TERM

# ── 1. Start the agent server (port 3001) ──
echo "[startup] Starting agent server on port 3001..."
PORT=3001 AGENT_ID=main node packages/agent/dist/index.js &
PIDS+=($!)

wait_for_health "http://localhost:3001" "Agent server"

# ── 2. Start the orchestrator (port 3000) ──
echo "[startup] Starting orchestrator on port 3000..."
cd packages/orchestrator
PORT=3000 npx next start -p 3000 &
PIDS+=($!)
cd "$SCRIPT_DIR"

wait_for_health "http://localhost:3000/api/health" "Orchestrator"

# ── 3. Optionally start the terminal channel adapter ──
if [ "${TERMINAL:-true}" = "true" ]; then
  echo "[startup] Starting terminal adapter..."
  ORCHESTRATOR_URL=http://localhost:3000 \
  TERMINAL_ENABLED=true \
  TERMINAL_AGENT=main \
    node --import tsx packages/channels/src/main.ts &
  PIDS+=($!)
  echo "[startup] Terminal adapter started"
fi

echo ""
echo "[startup] All services running:"
echo "  Agent:        http://localhost:3001"
echo "  Orchestrator: http://localhost:3000"
echo "  Terminal:     attached to stdin"
echo ""
echo "Press Ctrl+C to stop all services"

# Wait for any child to exit
wait
