# Ezra — TrueForge Coding Agent for VS Code

> **Techfest 2026-27 · TrueFoundry Forge-a-thon submission**  
> An editor-native coding agent whose **entire agent loop runs on [TrueForge](https://github.com/truefoundry/trueforge)** — TrueFoundry's open-source agent harness.

---

## Table of Contents

1. [What it is](#what-it-is)
2. [Architecture](#architecture)
3. [Prerequisites](#prerequisites)
4. [Quick Start (Clean Clone)](#quick-start-clean-clone)
5. [Configure TrueForge](#configure-trueforge)
6. [Install & Run the Extension](#install--run-the-extension)
7. [Task A — Inline Edit Demo](#task-a--inline-edit-demo)
8. [Task B — Agent Mode Demo](#task-b--agent-mode-demo)
9. [Task C — Resilience Demo](#task-c--resilience-demo)
10. [Extension Configuration Reference](#extension-configuration-reference)
11. [Running Tests](#running-tests)
12. [Project Structure](#project-structure)
13. [Design Decisions](#design-decisions)
14. [Verified Capabilities & Limitations](#verified-capabilities--limitations)

---

## What it is

Ezra is a VS Code extension that turns any editor workspace into a full coding agent workflow:

| Feature | Detail |
|---|---|
| **Inline edit (Task A)** | Select code → give plain-language instruction → review hunk-by-hunk diff → accept/reject |
| **Agent mode (Task B)** | Repo-level feature requests; agent discovers files, proposes multi-file edits with plan |
| **Resilience (Task C)** | Honest failure UI + TrueForge-configured automatic model fallback |
| **Context assembly** | `@file`/`@symbol` mentions + automatic retrieval with configurable token budget |
| **Diff safety** | Zero disk writes before user approval; hunk-level accept/reject; undo support |
| **TrueForge integration** | All intelligence runs in TrueForge sessions — no direct LLM calls from the extension |

---

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│                   VS Code Extension Host                   │
│                                                            │
│  ┌──────────────────┐    ┌────────────────────────────┐   │
│  │ InlineEdit       │    │ AgentWebviewProvider       │   │
│  │ Controller       │    │ (Webview Panel)            │   │
│  └──────────┬───────┘    └───────────┬────────────────┘   │
│             │                        │                     │
│  ┌──────────▼────────────────────────▼────────────────┐   │
│  │            TrueForgeClient  (transport layer)      │   │
│  │   createSession → POST /api/v1/sessions            │   │
│  │   createTurnStream → POST /sessions/{id}/turns     │   │
│  │   SSE event stream → model.message.delta,          │   │
│  │     tool.approval_required, turn.done, …           │   │
│  └──────────────────────────┬───────────────────────--┘   │
│                             │                              │
│  ┌──────────────────────────▼─────────────────────────┐   │
│  │          EditorMcpServer  (embedded HTTP, :8920)   │   │
│  │  Exposes tools the TrueForge agent can invoke:     │   │
│  │    read_file · file_search · grep_search           │   │
│  │    find_symbols · propose_edit · execute_command   │   │
│  └──────────────────────────────────────────────────--┘   │
│                                                            │
│  ┌──────────────────┐    ┌────────────────────────────┐   │
│  │ DiffReviewStore  │    │ ContextRetriever           │   │
│  │ + DiffApplier    │    │ + BudgetEnforcer           │   │
│  │ + RevertManager  │    │ + MentionParser            │   │
│  └──────────────────┘    └────────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
                             │  HTTP REST + SSE
                ┌────────────▼──────────────────────┐
                │        TrueForge  :8790           │
                │  Agent loop · Tool dispatch       │
                │  Context compaction · Skills      │
                │  Model routing + fallback         │
                └────────────────────┬──────────────┘
                                     │  API calls
                             ┌───────▼────────┐
                             │  LLM Provider  │
                             │ (OpenAI/etc.)  │
                             └────────────────┘
```

**TrueForge's role:** TrueForge is the agent brain. It owns the tool-call loop, context compaction, skill loading, model routing, and fallback. The extension is a *client* of TrueForge: it creates sessions, streams events, and executes editor-side tool calls that TrueForge dispatches. No LLM API calls are made from the extension.

**Retrieval budget strategy:**

1. Parse `@file`/`@symbol` explicit mentions from the user prompt (highest priority, always included).
2. Run `file_search` on query keywords to find candidate files by name.
3. Run `grep_search` to score files by keyword hit density.
4. Rank by relevance score; truncate to `maxDiscoveredFiles` (default 15).
5. For each file, include only the first `contextBudgetTokens / N` characters where N = number of files, ensuring total assembled context never exceeds the budget.
6. Unused budget headroom is given to explicit mentions first.

This prevents the agent from ever concatenating the whole repository into a single prompt, even on large codebases.

**TrueForge capability used:** Context compaction (`contextManagement.compaction.enabled: true` in `agent/agent.json`) — when the conversation history grows large during a multi-step tool loop, TrueForge automatically summarises earlier turns. This is the mechanism that makes long Task B runs (20+ tool calls) viable without hitting context limits.

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | ≥ 20 | Required for TrueForge and the extension |
| npm | ≥ 10 | Bundled with Node |
| VS Code | ≥ 1.90 | For running the extension |
| Git | any | To clone Flask fixture |
| Python + pytest | ≥ 3.9 | Only for Task B verification (`pytest tests/test_cli.py`) |
| curl | any | Used in setup script |

You will also need an API key for **at least one** LLM provider (OpenAI, Anthropic, or Google/Gemini). This key is stored **only inside TrueForge's local SQLite database** — never in the extension or committed to this repo.

---

## Quick Start (Clean Clone)

```bash
# 1. Clone this repository
git clone <your-repo-url> Ezra
cd Ezra

# 2. Install extension dependencies
npm install

# 3. Build the extension
npm run compile

# 4. Clone the Flask fixture (exact commit required for demo tasks)
mkdir -p fixtures
git clone https://github.com/pallets/flask fixtures/flask
cd fixtures/flask
git checkout 22d92470
cd ../..

# 5. Start TrueForge (keep this terminal open or run as daemon)
npx -y @truefoundry/trueforge@latest --port 8790
# TrueForge UI: http://localhost:8790

# 6. Run the interactive setup script (configures model provider + agent)
bash scripts/setup-trueforge.sh

# 7. Run tests (must all pass before demo)
npm run test

# 8. Open the extension in VS Code Extension Development Host
#    (see next section)
```

---

## Configure TrueForge

TrueForge runs locally on `http://localhost:8790`. It stores all configuration in a local SQLite file — no cloud services required.

### Option A: Setup script (recommended)

```bash
bash scripts/setup-trueforge.sh
```

The script will prompt for your provider choice and API key, then configure the model provider, MCP server, and agent automatically.

### Option B: Manual curl

**Register primary model provider (OpenAI example):**

```bash
curl -X PUT http://localhost:8790/api/v1/settings/model-providers \
  -H "Content-Type: application/json" \
  -d '{
    "manifest": {
      "type": "openai",
      "name": "openai-primary",
      "auth": { "api_key": "sk-YOUR-KEY-HERE" },
      "models": [
        {
          "model_id": "gpt-4o",
          "name": "openai/gpt-4o",
          "properties": { "context_length": 128000, "max_output_tokens": 16000 }
        },
        {
          "model_id": "gpt-4o-mini",
          "name": "openai/gpt-4o-mini",
          "properties": { "context_length": 128000, "max_output_tokens": 8000 }
        }
      ]
    }
  }'
```

**Register the embedded MCP server:**

```bash
curl -X PUT http://localhost:8790/api/v1/settings/mcp-servers \
  -H "Content-Type: application/json" \
  -d '{
    "manifest": {
      "type": "remote",
      "name": "editor-tools",
      "url": "http://localhost:8920",
      "description": "Ezra editor tools"
    }
  }'
```

**Register the agent:**

```bash
curl -X PUT http://localhost:8790/api/v1/agents/ezra-code-agent \
  -H "Content-Type: application/json" \
  -d @agent/agent.json
```

**Verify:**

```bash
curl http://localhost:8790/api/v1/models
# Should return a non-empty array of configured models
```

### Fallback model (Task C)

To demonstrate real TrueForge-configured fallback, register a **second** model provider (e.g. Anthropic as backup). Then set `trueforge.fallbackModelName` in VS Code settings to the second model's TrueForge name. The `ModelFallbackManager` will request a session routed to the fallback model only when the primary model returns a quota/auth/server error.

> **Security note:** Never put API keys in `trueforge.config.json.example`, `.env.example`, or committed files. The setup script writes to `.env` which is in `.gitignore`. Real keys go only into TrueForge's local database via the API above.

---

## Install & Run the Extension

### Method 1: Extension Development Host (F5)

1. Open VS Code in this repository: `code /path/to/Ezra`
2. Press **F5** (or go to Run → Start Debugging)
3. Select **"Run Extension (Flask Fixture)"**
4. A new **Extension Development Host** window opens with the Flask fixture already set as the workspace

### Method 2: Manual launch config

In the Extension Development Host window:
- The TrueForge activity bar icon (⚡) appears in the sidebar
- Open the Agent panel from the activity bar
- Confirm the status bar shows **TrueForge: Connected** at the bottom

### VS Code settings for the Extension Host

Open Settings (`Cmd+,`) and search `trueforge`:

| Setting | Default | Notes |
|---|---|---|
| `trueforge.serverUrl` | `http://localhost:8790` | Must match TrueForge port |
| `trueforge.agentName` | `ezra-code-agent` | Name of the agent in TrueForge |
| `trueforge.modelName` | `openai/gpt-4o` | Must match a configured model |
| `trueforge.fallbackModelName` | `openai/gpt-4o-mini` | For Task C fallback |
| `trueforge.contextBudgetTokens` | `16000` | Context assembly limit |
| `trueforge.maxDiscoveredFiles` | `15` | Auto-retrieval cap |

---

## Task A — Inline Edit Demo

> **Target:** `pallets/flask` @ tag `3.1.3` / commit `22d92470`

**Exact instruction to submit:**
```
Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.
```

**Steps:**

1. In the Extension Development Host, open `fixtures/flask/src/flask/helpers.py`
2. Select lines containing the `get_debug_flag` function body (approximately lines 29–65)
3. Press **`Cmd+Alt+I`** (macOS) or **`Ctrl+Alt+I`** (Windows/Linux)
4. A prompt dialog appears: paste the exact instruction above
5. The extension creates a TrueForge session, streams the response, and displays the proposed edit as a **diff hunk** in VS Code's built-in diff editor
6. Review the diff — you should see the false-set change and docstring update
7. Use the **"Accept Hunk"** / **"Accept All"** CodeLens actions or the command palette (`TrueForge: Accept All Proposed Hunks`)
8. The file is updated via WorkspaceEdit (undoable with `Cmd+Z`)

**Verification:**

```bash
cd fixtures/flask
pip install -e ".[dev]"

FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
# Expected: False

FLASK_DEBUG=n python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
# Expected: False

FLASK_DEBUG=1 python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
# Expected: True
```

**What happens under the hood:**

```
Extension → TrueForge: createSession(ezra-code-agent)
Extension → TrueForge: createTurnStream(selectedCode + instruction)
TrueForge → model.message.delta events (streamed)
TrueForge → tool.approval_required: propose_edit(helpers.py, newContent)
Extension: stage hunk in DiffReviewStore (no disk write)
Extension: show diff editor
User: Accept hunk
Extension: applyApprovedHunks() → vscode.WorkspaceEdit (undoable)
```

---

## Task B — Agent Mode Demo

> **Target:** Same `pallets/flask` fixture

**Exact instruction to submit:**
```
Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.
```

**Steps:**

1. Click the **TrueForge Agent** icon in the activity bar to open the Agent panel
2. Paste the exact instruction above into the input box
3. Click **Send** (or press Enter)
4. Watch the streaming panel — you will see:
   - TrueForge tool calls: `file_search`, `grep_search`, `read_file`, `find_symbols`
   - **Change plan** displaying discovered files and why each was selected
   - Multiple `propose_edit` tool calls (one per file)
5. When the agent completes, the **Staged Changes** section shows hunks for ≥ 3 files:
   - `src/flask/cli.py` — the `config` command implementation
   - `tests/test_cli.py` — test coverage
   - `docs/cli.rst` — documentation update
6. Review each file's diff; accept all hunks

**Verification:**

```bash
cd fixtures/flask
pip install -e ".[dev]"
pytest tests/test_cli.py -q
# Should pass including the new test_config_command tests

# Manual smoke test:
python -c "
from flask import Flask
app = Flask(__name__)
app.config['SECRET_KEY'] = 'hunter2'
app.config['DEBUG'] = True
with app.app_context():
    import subprocess, sys
    result = subprocess.run([sys.executable, '-m', 'flask', 'config'], 
                           capture_output=True, text=True, env={'FLASK_APP': 'tests.conftest:app'})
    print(result.stdout)
"
# Expected: JSON with SECRET_KEY: "***" and DEBUG: true
```

**Agent tool sequence (shown in panel):**

```
tool: file_search("cli")           → app.py, cli.py, ...
tool: read_file("src/flask/cli.py") → full source
tool: grep_search("add_command")   → finds registration pattern
tool: file_search("test_cli")      → tests/test_cli.py
tool: read_file("tests/test_cli.py") → existing tests
tool: file_search("cli.rst")       → docs/cli.rst
tool: propose_edit("src/flask/cli.py", ...)
tool: propose_edit("tests/test_cli.py", ...)
tool: propose_edit("docs/cli.rst", ...)
```

---

## Task C — Resilience Demo

**Goal:** Show that a failed model call leaves the workspace unchanged, the UI stays responsive, and (if a second model is configured) TrueForge handles the fallback transparently.

### Path 1: Honest error (no fallback configured)

1. In VS Code settings, set `trueforge.serverUrl` to `http://localhost:9999` (unreachable)
2. Open `src/flask/helpers.py`, select `get_debug_flag`, press `Cmd+Alt+I`
3. Enter any instruction
4. The extension shows a clear error notification: **"TrueForge unreachable at http://localhost:9999 — retrying (1/3)…"** then **"TrueForge connection failed after 3 attempts"**
5. No diff is staged; the DiffReviewStore is empty
6. `git status` on the Flask fixture shows **no changes**

```bash
cd fixtures/flask && git status
# On branch 3.1.3
# nothing to commit, working tree clean
```

### Path 2: Real TrueForge fallback (if second model configured)

1. Register a second model provider (e.g. Anthropic Claude) via the setup script
2. Set `trueforge.fallbackModelName` to the second model's TrueForge name
3. Temporarily configure the primary model with an invalid API key:
   ```bash
   curl -X PUT http://localhost:8790/api/v1/settings/model-providers \
     -H "Content-Type: application/json" \
     -d '{"manifest":{"type":"openai","name":"openai-primary","auth":{"api_key":"sk-INVALID"},...}}'
   ```
4. Run Task A — the primary model returns a 401; `ModelFallbackManager` detects the auth error (HTTP 401), logs a warning in the VS Code status bar: **"⚠ Primary model failed — routing to fallback"**, and retries the session using the fallback model name
5. The session succeeds via the fallback model; the diff is proposed normally

> **Note:** The fallback is TrueForge's routing mechanism — the extension passes the fallback model name in the session creation request. TrueForge handles the actual routing. The extension does **not** call the fallback provider directly.

---

## Extension Configuration Reference

```jsonc
// settings.json (VS Code)
{
  "trueforge.serverUrl": "http://localhost:8790",
  "trueforge.agentName": "ezra-code-agent",
  "trueforge.modelName": "openai/gpt-4o",
  "trueforge.fallbackModelName": "openai/gpt-4o-mini",
  "trueforge.contextBudgetTokens": 16000,
  "trueforge.maxDiscoveredFiles": 15,
  "trueforge.enableMcpTools": true,
  "trueforge.commandTimeoutMs": 30000
}
```

See `trueforge.config.json.example` for TrueForge server configuration reference.

---

## Running Tests

```bash
# Compile + run all headless unit tests
npm run test
```

Expected output:

```
====================================================
   TrueForge Coding Agent - Test Suite Execution
====================================================

--- Running Path Safety Tests ---          (4 assertions)
--- Running Diff Staging & Hunk Tests ---  (6 assertions)
--- Running Context Assembly & Budget --- (2 assertions)
--- Running Retry & Resilience Tests ---  (3 assertions)
--- Running Fixed Round 1 Demo Tasks ---  (5 assertions)

====================================================
   ALL TEST SUITES PASSED SUCCESSFULLY (5/5)
====================================================
```

Tests cover:
- Path safety / directory traversal rejection
- Diff parsing, staging, hunk accept/reject
- Context budget enforcement
- Exponential backoff + transient error classification
- Task A logic (false-value expansion in `get_debug_flag`)
- Task B sensitive key masking
- Task C workspace isolation on failure

---

## Project Structure

```
Ezra/
├── agent/
│   ├── agent.json            # TrueForge agent definition (registered via API)
│   ├── agent.yaml            # Human-readable copy
│   └── skills/
│       └── coding-agent/
│           └── SKILL.md      # TrueForge skill: coding-agent operating principles
├── scripts/
│   └── setup-trueforge.sh   # Interactive setup (models, MCP, agent)
├── src/
│   ├── extension.ts          # VS Code activation entry point
│   ├── config/index.ts       # Settings reader
│   ├── transport/
│   │   ├── types.ts          # TrueForge SDK types (TurnStreamingEvent, etc.)
│   │   ├── retry.ts          # Exponential backoff + transient error classifier
│   │   ├── SSEStream.ts      # Raw SSE chunk parser
│   │   └── TrueForgeClient.ts # HTTP client for TrueForge REST API
│   ├── tools/
│   │   ├── pathSafety.ts     # Workspace path resolution + traversal protection
│   │   ├── readFile.ts       # read_file tool implementation
│   │   ├── fileSearch.ts     # file_search tool
│   │   ├── grepSearch.ts     # grep_search tool
│   │   ├── findSymbols.ts    # find_symbols tool
│   │   ├── proposeEdit.ts    # propose_edit → DiffReviewStore (no disk write)
│   │   └── executeCommand.ts # execute_command with VS Code approval dialog
│   ├── diff/
│   │   ├── types.ts          # DiffHunk, FileDiff, AppliedEditRecord
│   │   ├── diffParser.ts     # Unified diff → structured hunks
│   │   ├── diffReviewStore.ts # Singleton diff store with EventEmitter
│   │   ├── diffApplier.ts    # Hash-verified WorkspaceEdit for approved hunks
│   │   └── revertManager.ts  # Undo history
│   ├── context/
│   │   ├── mentionParser.ts  # @file and @symbol extraction
│   │   ├── budgetEnforcer.ts # Token budget with priority sorting
│   │   └── contextRetriever.ts # Automated retrieval + budget-bounded assembly
│   ├── mcp/
│   │   └── EditorMcpServer.ts # Embedded JSON-RPC 2.0 HTTP server on :8920
│   ├── resilience/
│   │   └── modelFallbackManager.ts # TrueForge-routed fallback (honest)
│   └── ui/
│       ├── inlineEditController.ts # Task A: inline edit command handler
│       └── agentWebviewProvider.ts # Task B: Agent panel webview
├── test/
│   ├── mockVscode.ts         # Headless vscode module mock
│   ├── runTests.ts           # Test runner (Module intercept for vscode)
│   ├── pathSafety.test.ts
│   ├── diffStaging.test.ts
│   ├── contextBudget.test.ts
│   ├── retryResilience.test.ts
│   └── demoTasks.test.ts
├── resources/
│   └── icon.svg
├── .vscode/
│   ├── launch.json           # F5 Extension Development Host configs
│   └── tasks.json            # Build tasks
├── .env.example              # Safe configuration template (no secrets)
├── .gitignore
├── package.json              # VS Code extension manifest + npm scripts
├── tsconfig.json
└── trueforge.config.json.example
```

---

## Design Decisions

### Why MCP over direct API tool calls?

TrueForge supports MCP (Model Context Protocol) servers as a first-class integration. By exposing editor capabilities as an MCP server, we let TrueForge's agent loop dispatch and handle tool approval natively. This means:
- TrueForge can track, log, and approve tool calls centrally
- The extension receives `tool.approval_required` events and can gate `execute_command` calls behind a VS Code confirmation dialog
- Adding new tools doesn't require modifying the TrueForge agent spec

### Why hunk-level, not file-level review?

The requirement prohibits writing files before approval, but large features (Task B) touch many lines across many files. Hunk-level review lets users accept only the parts of a proposed change they understand, making the review practical for real changes rather than a rubber stamp.

### Why context compaction?

Task B can require 20+ tool call rounds (file_search, read_file × 3, grep, propose × 3). Without compaction, the conversation history exceeds context limits. TrueForge's built-in compaction automatically summarises older turns, keeping the agent functional throughout the full loop without the extension needing to implement its own truncation.

### Why no hosted backend?

The problem statement explicitly prohibits hosted backends, databases, user accounts, or authentication. All state is local: TrueForge runs on `localhost:8790` with SQLite, the MCP server runs on `localhost:8920`, and all configuration is in VS Code settings or TrueForge's local database.

---

## Verified Capabilities & Limitations

### Verified ✅

- `npm run compile` exits 0 (TypeScript strict mode, no errors)
- `npm run test` exits 0 (20 assertions, 5 suites)
- TrueForge v0.185.1 starts and runs locally on port 8790
- Flask fixture cloned at exact commit `22d92470`
- Path safety: directory traversal rejected with `PathSecurityError`
- Diff staging: hunks accepted/rejected without disk writes
- Context budget: assembly never exceeds configured token limit
- Retry: exponential backoff with transient error classification
- Task A logic (false-value set expansion) verified in test
- Task B masking logic (SECRET/PASSWORD/TOKEN/KEY) verified in test
- Task C workspace isolation verified in test

### Requires Live Demo to Fully Verify

- End-to-end TrueForge session with a real API key (requires API key configuration)
- Streaming SSE events rendered in webview (requires Extension Development Host)
- Hunk-level VS Code diff editor and accept/reject CodeLens
- `execute_command` approval dialog
- Flask `pytest tests/test_cli.py` (requires Python + pip install)
- Real model fallback routing through TrueForge

### Known Limitations

- The embedded MCP server (`:8920`) only binds when the extension is active inside VS Code — it cannot be tested in a headless Node environment
- TrueForge's exact `PUT /api/v1/agents/{name}` endpoint shape should be verified against the live server before demo (the client isolates this in `TrueForgeClient.ts`)
- If TrueForge changes its SSE event schema between versions, `transport/types.ts` and `transport/SSEStream.ts` are the only files that need updating

---

## Submission Metadata

- **Competition:** Techfest 2026-27 — TrueFoundry Forge-a-thon
- **Round:** 1 (deadline: November 20, 2026)
- **Upstream reuse:** None — focused implementation, no upstream editor project forked
- **TrueForge version tested:** `@truefoundry/trueforge@0.185.1`
- **Flask fixture:** `pallets/flask` @ `22d92470` (tag `3.1.3`)
- **License:** MIT
