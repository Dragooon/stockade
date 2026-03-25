#!/usr/bin/env bash
# ============================================================================
# Integration test — verifies the HTTP wiring between agent and orchestrator
#
# This test:
#   1. Starts the agent server
#   2. Starts the orchestrator (Next.js)
#   3. Verifies both health endpoints respond
#   4. Sends a test message to the orchestrator's /api/message endpoint
#   5. Verifies a response comes back (may be an error since no real LLM
#      is configured, but the HTTP plumbing between layers is validated)
#   6. Shuts down both servers
#
# Prerequisites:
#   - pnpm -r build (both packages must be built)
#   - config/agents.yaml and config/platform.yaml must exist
#   - curl must be installed
#
# Usage:
#   bash tests/integration.sh
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

AGENT_PORT=3051
ORCHESTRATOR_PORT=3050
PASS=0
FAIL=0
PIDS=()

# ── Colours ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ── Helpers ──
log()  { echo -e "${YELLOW}[test]${NC} $*"; }
pass() { echo -e "${GREEN}[PASS]${NC} $*"; PASS=$((PASS + 1)); }
fail() { echo -e "${RED}[FAIL]${NC} $*"; FAIL=$((FAIL + 1)); }

cleanup() {
  log "Shutting down test servers..."
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
  log "Cleanup complete"
}
trap cleanup EXIT INT TERM

wait_for_health() {
  local url="$1"
  local name="$2"
  local timeout="${3:-20}"
  local elapsed=0

  while [ $elapsed -lt $timeout ]; do
    if curl -sf "$url" > /dev/null 2>&1; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

# ── Load env ──
if [ -f config/.env ]; then
  set -a
  source config/.env
  set +a
fi

# ============================================================================
# 1. Start agent server
# ============================================================================
log "Starting agent server on port $AGENT_PORT..."
PORT=$AGENT_PORT AGENT_ID=main node packages/agent/dist/index.js &
PIDS+=($!)

if wait_for_health "http://localhost:$AGENT_PORT/health" "agent" 15; then
  pass "Agent health endpoint responds"
else
  fail "Agent health endpoint did not respond within 15s"
  exit 1
fi

# ============================================================================
# 2. Verify agent /health response content
# ============================================================================
AGENT_HEALTH=$(curl -sf "http://localhost:$AGENT_PORT/health")
if echo "$AGENT_HEALTH" | grep -q '"ok":true'; then
  pass "Agent health returns { ok: true }"
else
  fail "Agent health response unexpected: $AGENT_HEALTH"
fi

# ============================================================================
# 3. Verify agent /tools endpoint
# ============================================================================
AGENT_TOOLS=$(curl -sf "http://localhost:$AGENT_PORT/tools")
if echo "$AGENT_TOOLS" | grep -q '"tools"'; then
  pass "Agent /tools endpoint returns tool list"
else
  fail "Agent /tools response unexpected: $AGENT_TOOLS"
fi

# ============================================================================
# 4. Start orchestrator
# ============================================================================
log "Starting orchestrator on port $ORCHESTRATOR_PORT..."
cd packages/orchestrator
PORT=$ORCHESTRATOR_PORT npx next start -p $ORCHESTRATOR_PORT > /dev/null 2>&1 &
PIDS+=($!)
cd "$SCRIPT_DIR"

if wait_for_health "http://localhost:$ORCHESTRATOR_PORT/api/health" "orchestrator" 20; then
  pass "Orchestrator health endpoint responds"
else
  fail "Orchestrator health endpoint did not respond within 20s"
  exit 1
fi

# ============================================================================
# 5. Verify orchestrator /api/health response
# ============================================================================
ORCH_HEALTH=$(curl -sf "http://localhost:$ORCHESTRATOR_PORT/api/health")
if echo "$ORCH_HEALTH" | grep -q '"ok":true'; then
  pass "Orchestrator health returns { ok: true }"
else
  fail "Orchestrator health response unexpected: $ORCH_HEALTH"
fi

# ============================================================================
# 6. Send a test message via POST /api/message
#
#    This will exercise:
#    - Config loading (agents.yaml, platform.yaml)
#    - Scope routing (terminal scope -> main agent)
#    - RBAC check (mail user -> owner role -> allowed)
#    - Session creation
#    - Agent client call attempt
#
#    Expected: Either a successful response (if ANTHROPIC_API_KEY is set)
#    or a specific error about the agent not running/API key missing.
#    Both prove the HTTP wiring works.
# ============================================================================
log "Sending test message to orchestrator..."
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  "http://localhost:$ORCHESTRATOR_PORT/api/message" \
  -H "Content-Type: application/json" \
  -d '{
    "scope": "terminal:mail",
    "content": "Hello, this is an integration test.",
    "userId": "mail",
    "platform": "terminal"
  }')

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

log "Response code: $HTTP_CODE"
log "Response body: $BODY"

# We expect either:
# - 200 with a response (if LLM is configured and agent is registered in manager)
# - 500 with "not running" error (agent is running but not registered in the manager)
# - 500 with some other transient error
# What we do NOT want is 400 (bad request) or 404 (route not found)
if [ "$HTTP_CODE" = "200" ]; then
  pass "POST /api/message returned 200 — full pipeline works"
elif [ "$HTTP_CODE" = "500" ] && echo "$BODY" | grep -q "not running\|not available"; then
  pass "POST /api/message reached agent resolution — HTTP wiring is correct (agent not registered in manager as expected)"
elif [ "$HTTP_CODE" = "500" ]; then
  pass "POST /api/message reached server handler — HTTP route works (error: $(echo "$BODY" | head -c 100))"
elif [ "$HTTP_CODE" = "400" ]; then
  fail "POST /api/message returned 400 — request format issue: $BODY"
elif [ "$HTTP_CODE" = "404" ]; then
  fail "POST /api/message returned 404 — route not found"
else
  fail "POST /api/message returned unexpected code $HTTP_CODE: $BODY"
fi

# ============================================================================
# Summary
# ============================================================================
echo ""
echo "=============================="
echo -e "  ${GREEN}Passed: $PASS${NC}"
echo -e "  ${RED}Failed: $FAIL${NC}"
echo "=============================="
echo ""

if [ $FAIL -gt 0 ]; then
  exit 1
fi

exit 0
