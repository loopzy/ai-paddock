#!/bin/sh
set -eu

OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-/workspace/.openclaw}"
OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$OPENCLAW_STATE_DIR/openclaw.json}"
OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"

mkdir -p "$OPENCLAW_STATE_DIR" /var/log /var/run

cd /opt/paddock/openclaw-runtime
nohup env \
  OPENCLAW_STATE_DIR="$OPENCLAW_STATE_DIR" \
  OPENCLAW_CONFIG_PATH="$OPENCLAW_CONFIG_PATH" \
  OPENCLAW_SKIP_CHANNELS="${OPENCLAW_SKIP_CHANNELS:-1}" \
  NO_PROXY="${NO_PROXY:-127.0.0.1,localhost}" \
  node ./openclaw.mjs gateway run --port "$OPENCLAW_GATEWAY_PORT" --bind loopback --allow-unconfigured \
  > /var/log/openclaw.log 2>&1 &
echo $! > /var/run/openclaw.pid
