#!/usr/bin/env bash
# setup-trueforge.sh
# ---------------------------------------------------------------------------
# Interactive setup for the TrueForge Coding Agent (Ezra) VS Code extension.
# Run this ONCE after cloning the repo. It:
#   1. Checks for / starts TrueForge on port 8790
#   2. Configures your LLM API key inside TrueForge
#   3. Optionally configures a fallback model (required for Task C demo)
#   4. Registers the embedded MCP server manifest
#   5. Creates the ezra-code-agent inside TrueForge
# ---------------------------------------------------------------------------
set -euo pipefail

TRUEFORGE_PORT="${TRUEFORGE_PORT:-8790}"
BASE_URL="http://localhost:${TRUEFORGE_PORT}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# ── Colours ────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[info]${NC}  $*"; }
success() { echo -e "${GREEN}[ok]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[warn]${NC}  $*"; }
err()     { echo -e "${RED}[error]${NC} $*" >&2; }

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║   TrueForge Coding Agent – Ezra – Setup Script      ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ── 1. TrueForge health check ───────────────────────────────────────────────
info "Checking TrueForge at ${BASE_URL} …"
check_health() {
  curl -sf "${BASE_URL}/healthz" > /dev/null 2>&1 || \
  curl -sf "${BASE_URL}/api/v1/agents" > /dev/null 2>&1 || \
  curl -sf "${BASE_URL}/api/v1/models" > /dev/null 2>&1
}

if ! check_health; then
  warn "TrueForge is not running. Attempting to start it …"
  nohup env NETWORK_POLICY_ENABLED=false HOST=0.0.0.0 OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]' npx -y @truefoundry/trueforge@latest --port "${TRUEFORGE_PORT}" \
    > /tmp/trueforge.log 2>&1 &
  TRUEFORGE_PID=$!
  echo "  PID: ${TRUEFORGE_PID} — waiting up to 20 s …"
  for i in $(seq 1 20); do
    sleep 1
    if check_health; then
      success "TrueForge started (PID ${TRUEFORGE_PID})"
      break
    fi
    if [ "$i" -eq 20 ]; then
      err "TrueForge did not start in time. Check /tmp/trueforge.log"
      exit 1
    fi
  done
else
  success "TrueForge already running at ${BASE_URL}"
fi

# ── 2. Provider selection ──────────────────────────────────────────────────
echo ""
echo "Which LLM provider do you want to configure?"
echo "  1) OpenAI   (requires OPENAI_API_KEY)"
echo "  2) Anthropic (requires ANTHROPIC_API_KEY)"
echo "  3) Google / Gemini (requires GEMINI_API_KEY)"
read -rp "Choice [1]: " PROVIDER_CHOICE
PROVIDER_CHOICE="${PROVIDER_CHOICE:-1}"

case "$PROVIDER_CHOICE" in
  1)
    PROVIDER_TYPE="openai"
    read -rp "OpenAI API key (or set OPENAI_API_KEY env): " INPUT_KEY
    API_KEY="${INPUT_KEY:-${OPENAI_API_KEY:-}}"
    PRIMARY_MODEL="openai/gpt-4o"
    FALLBACK_MODEL="openai/gpt-4o-mini"
    PRIMARY_MODEL_ID="gpt-4o"
    FALLBACK_MODEL_ID="gpt-4o-mini"
    PRIMARY_MODEL_NAME="gpt-4o"
    FALLBACK_MODEL_NAME="gpt-4o-mini"
    ;;
  2)
    PROVIDER_TYPE="anthropic"
    read -rp "Anthropic API key (or set ANTHROPIC_API_KEY env): " INPUT_KEY
    API_KEY="${INPUT_KEY:-${ANTHROPIC_API_KEY:-}}"
    PRIMARY_MODEL="anthropic/claude-3-5-sonnet-20241022"
    FALLBACK_MODEL="anthropic/claude-3-haiku-20240307"
    PRIMARY_MODEL_ID="claude-3-5-sonnet-20241022"
    FALLBACK_MODEL_ID="claude-3-haiku-20240307"
    PRIMARY_MODEL_NAME="claude-3-5-sonnet-20241022"
    FALLBACK_MODEL_NAME="claude-3-haiku-20240307"
    ;;
  3)
    PROVIDER_TYPE="google-gemini"
    read -rp "Gemini API key (or set GEMINI_API_KEY env): " INPUT_KEY
    API_KEY="${INPUT_KEY:-${GEMINI_API_KEY:-}}"
    PRIMARY_MODEL="google-gemini/gemini-3-1-flash-lite"
    FALLBACK_MODEL="google-gemini/gemini-3-flash-preview"
    PRIMARY_MODEL_ID="gemini-3.1-flash-lite"
    FALLBACK_MODEL_ID="gemini-3-flash-preview"
    PRIMARY_MODEL_NAME="gemini-3-1-flash-lite"
    FALLBACK_MODEL_NAME="gemini-3-flash-preview"
    ;;
  *)
    err "Invalid choice"
    exit 1
    ;;
esac

if [ -z "${API_KEY:-}" ]; then
  err "No API key provided. Exiting."
  exit 1
fi

# ── 3. Register primary model provider ────────────────────────────────────
info "Registering primary model provider (${PROVIDER_TYPE}) …"
PROVIDER_PAYLOAD=$(python3 -c "
import json, urllib.request

base_url = '${BASE_URL}'
p_type = '${PROVIDER_TYPE}'
api_key = '${API_KEY}'
primary_id = '${PRIMARY_MODEL_ID}'
primary_name = '${PRIMARY_MODEL_NAME}'
fallback_id = '${FALLBACK_MODEL_ID}'
fallback_name = '${FALLBACK_MODEL_NAME}'

models = [
    {'model_id': primary_id, 'name': primary_name, 'properties': {'context_length': 1048576, 'max_output_tokens': 65536}},
    {'model_id': fallback_id, 'name': fallback_name, 'properties': {'context_length': 1048576, 'max_output_tokens': 65536}}
]

# Fetch existing provider models to prevent 409 droppedModelNames conflicts
try:
    req = urllib.request.Request(f'{base_url}/api/v1/settings/model-providers')
    with urllib.request.urlopen(req, timeout=3) as resp:
        data = json.loads(resp.read().decode())
        items = data if isinstance(data, list) else data.get('data', [])
        for p in items:
            if p.get('name') == p_type or p.get('manifest', {}).get('type') == p_type:
                for m in p.get('manifest', {}).get('models', []):
                    if not any(x['name'] == m.get('name') for x in models):
                        models.append(m)
except Exception:
    pass

payload = {
    'manifest': {
        'type': p_type,
        'auth': {'api_key': api_key},
        'models': models
    }
}
print(json.dumps(payload))
")

RESP=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X PUT "${BASE_URL}/api/v1/settings/model-providers" \
  -H "Content-Type: application/json" \
  -d "${PROVIDER_PAYLOAD}")
STATUS_CODE=$(echo "$RESP" | grep "HTTP_STATUS:" | cut -d: -f2)
BODY=$(echo "$RESP" | grep -v "HTTP_STATUS:")
if [ "$STATUS_CODE" != "200" ] && [ "$STATUS_CODE" != "201" ]; then
  err "Failed to configure model provider (HTTP $STATUS_CODE): $BODY"
  exit 1
fi
success "Model provider configured (${PROVIDER_TYPE})"

# ── 4. MCP server registration ────────────────────────────────────────────
info "Registering embedded MCP server …"
MCP_PAYLOAD=$(cat <<EOF
{
  "manifest": {
    "type": "remote",
    "name": "editor-tools",
    "url": "http://localhost:8920",
    "description": "Ezra editor tools: read_file, file_search, grep_search, find_symbols, propose_edit, execute_command"
  }
}
EOF
)

RESP=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X PUT "${BASE_URL}/api/v1/settings/mcp-servers" \
  -H "Content-Type: application/json" \
  -d "${MCP_PAYLOAD}")
STATUS_CODE=$(echo "$RESP" | grep "HTTP_STATUS:" | cut -d: -f2)
BODY=$(echo "$RESP" | grep -v "HTTP_STATUS:")

if [ "$STATUS_CODE" != "200" ] && [ "$STATUS_CODE" != "201" ]; then
  if echo "$BODY" | grep -q -i "blocked"; then
    warn "Local MCP URL was blocked by network policy. Restarting TrueForge with local network policy disabled …"
    pkill -f "trueforge" || true
    sleep 2
    nohup env NETWORK_POLICY_ENABLED=false HOST=0.0.0.0 OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]' npx -y @truefoundry/trueforge@latest --port "${TRUEFORGE_PORT}" \
      > /tmp/trueforge.log 2>&1 &
    sleep 3
    for i in $(seq 1 15); do
      if check_health; then break; fi
      sleep 1
    done
    # Re-register model provider
    curl -s -X PUT "${BASE_URL}/api/v1/settings/model-providers" -H "Content-Type: application/json" -d "${PROVIDER_PAYLOAD}" > /dev/null 2>&1 || true
    # Retry MCP server
    RESP=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X PUT "${BASE_URL}/api/v1/settings/mcp-servers" \
      -H "Content-Type: application/json" \
      -d "${MCP_PAYLOAD}")
    STATUS_CODE=$(echo "$RESP" | grep "HTTP_STATUS:" | cut -d: -f2)
    BODY=$(echo "$RESP" | grep -v "HTTP_STATUS:")
  fi
fi

if [ "$STATUS_CODE" != "200" ] && [ "$STATUS_CODE" != "201" ]; then
  err "Failed to register MCP server (HTTP $STATUS_CODE): $BODY"
  exit 1
fi
success "MCP server manifest registered (editor-tools @ port 8920)"

# ── 5. Register the agent ─────────────────────────────────────────────────
info "Registering ezra-code-agent …"
EXISTING_AGENT_ID=$(curl -sf "${BASE_URL}/api/v1/agents" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); items=d if isinstance(d,list) else d.get('data',[]); print(next((a['id'] for a in items if a.get('name')=='ezra-code-agent'), ''))" 2>/dev/null || true)

if [ -n "$EXISTING_AGENT_ID" ]; then
  info "Updating existing agent (${EXISTING_AGENT_ID}) …"
  AGENT_PAYLOAD=$(python3 -c "import json; spec=json.load(open('${REPO_ROOT}/agent/agent.json')); spec.setdefault('manifest',{}).setdefault('model',{})['name']='${PRIMARY_MODEL}'; print(json.dumps({'description': spec.get('description',''), 'manifest': spec['manifest']}))")
  RESP=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X PUT "${BASE_URL}/api/v1/agents/${EXISTING_AGENT_ID}" \
    -H "Content-Type: application/json" \
    -d "${AGENT_PAYLOAD}")
else
  info "Creating new agent ezra-code-agent …"
  AGENT_PAYLOAD=$(python3 -c "import json; spec=json.load(open('${REPO_ROOT}/agent/agent.json')); spec.setdefault('manifest',{}).setdefault('model',{})['name']='${PRIMARY_MODEL}'; print(json.dumps(spec))")
  RESP=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X POST "${BASE_URL}/api/v1/agents" \
    -H "Content-Type: application/json" \
    -d "${AGENT_PAYLOAD}")
fi

STATUS_CODE=$(echo "$RESP" | grep "HTTP_STATUS:" | cut -d: -f2)
BODY=$(echo "$RESP" | grep -v "HTTP_STATUS:")
if [ "$STATUS_CODE" != "200" ] && [ "$STATUS_CODE" != "201" ]; then
  err "Failed to register agent (HTTP $STATUS_CODE): $BODY"
  exit 1
fi
success "Agent 'ezra-code-agent' registered with model ${PRIMARY_MODEL}"

# ── 6. Verify models available ───────────────────────────────────────────
echo ""
info "Available models in TrueForge:"
curl -sf "${BASE_URL}/api/v1/models" 2>/dev/null | \
  python3 -c "import sys,json; d=json.load(sys.stdin); items = d if isinstance(d, list) else d.get('data', []); [print('  -', m.get('name', m.get('model_id', '?'))) for m in items if isinstance(m, dict)]" \
  2>/dev/null || warn "Could not list models (server may still be warming up)"

# ── 7. Write .env ────────────────────────────────────────────────────────
ENV_FILE="${REPO_ROOT}/.env"
cat > "${ENV_FILE}" <<ENVEOF
# Auto-generated by setup-trueforge.sh — DO NOT COMMIT
TRUEFORGE_SERVER_URL=http://localhost:${TRUEFORGE_PORT}
PRIMARY_MODEL=${PRIMARY_MODEL}
FALLBACK_MODEL=${FALLBACK_MODEL}
ENVEOF
success ".env written with primary model ${PRIMARY_MODEL}"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║   Setup complete! Next steps:                        ║"
echo "║                                                      ║"
echo "║   1. Open VS Code in this repository:                ║"
echo "║      code "$REPO_ROOT""
echo "║                                                      ║"
echo "║   2. Press F5 (Run Extension – Flask Fixture)        ║"
echo "║      A new Extension Development Host window opens   ║"
echo "║      with the Flask fixture already loaded.          ║"
echo "║                                                      ║"
echo "║   3. In the Extension Host window:                   ║"
echo "║      - Open src/flask/helpers.py                     ║"
echo "║      - Select get_debug_flag, press Cmd+Alt+I        ║"
echo "║      - Enter the Task A instruction and review diff  ║"
echo "║                                                      ║"
echo "║   See README.md for full Task A/B/C walkthroughs.   ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
