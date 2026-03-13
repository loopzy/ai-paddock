#!/bin/sh
set -eu

OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-/workspace/.openclaw}"
OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$OPENCLAW_STATE_DIR/openclaw.json}"
OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"

mkdir -p "$OPENCLAW_STATE_DIR" "$OPENCLAW_STATE_DIR/logs" "$OPENCLAW_STATE_DIR/workspace"

if [ ! -f "$OPENCLAW_CONFIG_PATH" ]; then
  cat >"$OPENCLAW_CONFIG_PATH" <<EOF
{
  "gateway": {
    "mode": "local",
    "port": $OPENCLAW_GATEWAY_PORT,
    "bind": "loopback",
    "auth": { "mode": "none" }
  },
  "browser": {
    "enabled": true
  }
}
EOF
fi

test -f /opt/paddock/openclaw-runtime/openclaw.mjs
test -f /opt/paddock/openclaw-runtime/package.json

