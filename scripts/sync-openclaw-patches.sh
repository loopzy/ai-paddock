#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PATCH_SOURCE_ROOT="$PROJECT_ROOT/patches/openclaw-overlay"
TARGET_ROOT="${1:-${OPENCLAW_SRC:-}}"

if [ -z "${TARGET_ROOT:-}" ]; then
  echo "Usage: $0 /path/to/openclaw" >&2
  echo "Or set OPENCLAW_SRC=/path/to/openclaw before running." >&2
  exit 1
fi

if [ ! -f "$TARGET_ROOT/package.json" ]; then
  echo "OpenClaw source tree not found at $TARGET_ROOT" >&2
  exit 1
fi

if [ ! -d "$PATCH_SOURCE_ROOT" ]; then
  echo "OpenClaw patch overlay not found at $PATCH_SOURCE_ROOT" >&2
  exit 1
fi

FILES=(
  "src/agents/pi-embedded-runner/run/attempt.ts"
  "src/plugins/hooks.ts"
  "src/plugins/types.ts"
)

echo "Syncing Paddock OpenClaw patch overlay into: $TARGET_ROOT"

for relative_path in "${FILES[@]}"; do
  src="$PATCH_SOURCE_ROOT/$relative_path"
  dst="$TARGET_ROOT/$relative_path"

  if [ ! -f "$src" ]; then
    echo "Missing patch source file: $src" >&2
    exit 1
  fi

  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
  echo "  updated $relative_path"
done

echo
echo "OpenClaw patch sync complete."
echo "Next steps:"
echo "  1. pnpm run build:openclaw-runtime"
echo "  2. ./scripts/build-sidecar.sh"
echo "  3. Restart control-plane"
echo "  4. Deploy Agent again"
