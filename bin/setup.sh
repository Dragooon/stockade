#!/usr/bin/env bash
set -euo pipefail

# Stockade setup script — gets you from clone to running in one command.
# Usage: ./bin/setup.sh [--no-docker]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

NO_DOCKER=false
for arg in "$@"; do
  case "$arg" in
    --no-docker) NO_DOCKER=true ;;
  esac
done

echo "=== Stockade Setup ==="
echo ""

# 1. Check Node.js
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js not found. Install Node.js 22+ first."
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 22 ]; then
  echo "ERROR: Node.js $NODE_VERSION found, need 22+."
  exit 1
fi
echo "[ok] Node.js $(node -v)"

# 2. Check pnpm
if ! command -v pnpm &>/dev/null; then
  echo "[..] pnpm not found, installing via corepack..."
  corepack enable
  corepack prepare pnpm@latest --activate
fi
echo "[ok] pnpm $(pnpm -v)"

# 3. Check Docker (optional)
if [ "$NO_DOCKER" = false ] && command -v docker &>/dev/null; then
  DOCKER_OK=true
  echo "[ok] Docker $(docker --version | grep -oP '\d+\.\d+\.\d+')"
else
  DOCKER_OK=false
  if [ "$NO_DOCKER" = true ]; then
    echo "[--] Docker skipped (--no-docker)"
  else
    echo "[--] Docker not found — sandboxed agents won't work, using local mode"
  fi
fi

# 4. Install dependencies
echo ""
echo "[..] Installing dependencies..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
echo "[ok] Dependencies installed"

# 5. Copy config files
echo ""
if [ ! -f config/config.yaml ]; then
  cp config/config.example.yaml config/config.yaml
  echo "[ok] Created config/config.yaml from example"

  # If no Docker, flip all agents to sandboxed: false
  if [ "$DOCKER_OK" = false ]; then
    sed -i 's/sandboxed: true/sandboxed: false/g' config/config.yaml
    echo "[ok] Set all agents to sandboxed: false (no Docker)"
  fi
else
  echo "[ok] config/config.yaml already exists"
fi

if [ ! -f config/proxy.yaml ]; then
  cp config/proxy.example.yaml config/proxy.yaml
  echo "[ok] Created config/proxy.yaml from example"
else
  echo "[ok] config/proxy.yaml already exists"
fi

# 6. API key setup
echo ""
mkdir -p config/secrets

if [ -f config/secrets/anthropic-api-key ]; then
  echo "[ok] API key already exists in config/secrets/anthropic-api-key"
elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  printf '%s' "$ANTHROPIC_API_KEY" > config/secrets/anthropic-api-key
  echo "[ok] Wrote ANTHROPIC_API_KEY from environment to config/secrets/"
else
  echo "[!!] No API key found."
  echo "     Set ANTHROPIC_API_KEY in your environment and re-run, or:"
  echo "     echo 'sk-ant-...' > config/secrets/anthropic-api-key"
  echo ""
fi

# 7. Docker network
if [ "$DOCKER_OK" = true ]; then
  if docker network inspect stockade-net &>/dev/null; then
    echo "[ok] Docker network stockade-net exists"
  else
    docker network create --driver bridge --internal stockade-net
    echo "[ok] Created Docker network: stockade-net"
  fi
fi

# 8. Build
echo ""
echo "[..] Building..."
pnpm build
echo "[ok] Build complete"

# 9. Done
echo ""
echo "=== Setup Complete ==="
echo ""
if [ "$DOCKER_OK" = true ]; then
  echo "Full stack (containers + proxy):"
  echo "  Terminal 1: pnpm start:proxy"
  echo "  Terminal 2: pnpm start:orchestrator"
  echo ""
  echo "Simple (no containers):"
  echo "  pnpm start:orchestrator"
else
  echo "Start:"
  echo "  pnpm start:orchestrator"
fi
echo ""
echo "Verify:  pnpm test"
echo "Docs:    https://dragooon.github.io/stockade/"
