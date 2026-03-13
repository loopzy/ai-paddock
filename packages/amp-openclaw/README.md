# AMP OpenClaw Adapter

AMP (Agent Monitoring Protocol) adapter for OpenClaw-compatible agents.

## Overview

This package provides a Python-based agent that integrates with Paddock's AMP security framework. It includes:

- **Agent Lifecycle Management** - Ready, error, exit, and heartbeat reporting
- **LLM Integration** - Supports Anthropic, OpenAI, OpenRouter, and Google providers
- **Native Tool Loop** - Anthropic/OpenAI-compatible tool calling with OpenClaw-style tool names
- **Sandbox-Local Tools** - `read`, `write`, `edit`, `list`, `apply_patch`, `exec`, `browser`
- **Control-Plane Tools** - `sessions_*`, `subagents`, `cron`, `rollback`
- **Tool Interception** - All tool calls go through AMP Gate for approval
- **Command Polling** - Receives commands from Dashboard via file-based queue

## Build

```bash
# Build from package directory
cd packages/amp-openclaw
pnpm build

# Or build from project root (includes all packages)
cd ../..
pnpm build
```

The package build copies Python source files to `dist/amp-openclaw/` for deployment. The VM-ready Sidecar + adapter bundle is produced from the repo root via:

```bash
pnpm build
./scripts/build-sidecar.sh
```

## Development

```bash
# Run tests
pnpm test

# Or run Python tests directly
PYTHONPATH=. python3 -m unittest discover -s paddock_amp/__tests__ -p 'test_*.py'
```

## Architecture

```
┌─────────────────────────────────────┐
│  Control Plane (Host)               │
│  - Session Management               │
│  - Event Storage                    │
│  - HITL Decision Making             │
└──────────────┬──────────────────────┘
               │ vsock/network
┌──────────────┴──────────────────────┐
│  VM/Sandbox                         │
│  ┌───────────────────────────────┐  │
│  │ Sidecar                       │  │
│  │ - LLM Proxy (port 8800)       │  │
│  │ - AMP Gate (port 8801)        │  │
│  │ - Event Reporting             │  │
│  └───────────────────────────────┘  │
│  ┌───────────────────────────────┐  │
│  │ Agent (builtin_agent.py)      │  │
│  │ - Polls for commands          │  │
│  │ - Runs native tool loop       │  │
│  │ - Reports lifecycle events    │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
```

## Configuration

Environment variables (read from `/etc/environment` in VM):

- `PADDOCK_SIDECAR_URL` - Sidecar URL (default: `http://localhost:8801`)
- `PADDOCK_LLM_PROVIDER` - LLM provider (`anthropic`, `openai`, `openrouter`, `google`)
- `PADDOCK_AGENT_MODEL` - Model name (e.g., `claude-3-5-haiku-latest`)
- `PADDOCK_COMMAND_FILE` - Command queue file (default: `/tmp/paddock-commands.jsonl`)
- `PADDOCK_BROWSER_ENABLED` - Enables sandbox-local browser automation
- `PADDOCK_BROWSER_HEADLESS` - Browser mode (`1` for headless SimpleBox, `0` for headed ComputerBox)
- `PADDOCK_BROWSER_OUTPUT_DIR` - Browser output directory for screenshots/PDFs

## Files

- `paddock_amp/plugin.py` - AMP protocol implementation
- `paddock_amp/builtin_agent.py` - Native OpenClaw-compatible tool loop
- `paddock_amp/llm_client.py` - LLM provider abstraction
- `paddock_amp/tools/` - Sandbox-local, control-plane, and MCP tool adapters
- `build.sh` - Build script that copies files to dist/

## Deployment

The Control Plane deployment flow:

1. Builds the project (`pnpm build`)
2. Builds VM bundles (`./scripts/build-sidecar.sh`)
3. Copies `dist/sidecar/` and `dist/amp-openclaw/` into the VM
4. Installs Python/browser runtime dependencies inside the VM for the compatibility adapter path (`pip install -r requirements.txt`, `playwright install chromium`)
5. Starts the runtime: `python3 -m paddock_amp.builtin_agent`

## License

MIT
