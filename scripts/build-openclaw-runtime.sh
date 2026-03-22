#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -n "${OPENCLAW_SRC:-}" ]; then
  RESOLVED_OPENCLAW_SRC="$OPENCLAW_SRC"
elif [ -f "$PROJECT_ROOT/thirdparty/openclaw/package.json" ]; then
  RESOLVED_OPENCLAW_SRC="$PROJECT_ROOT/thirdparty/openclaw"
else
  RESOLVED_OPENCLAW_SRC="$PROJECT_ROOT/thirdparty/openclaw"
fi
OPENCLAW_SRC="$RESOLVED_OPENCLAW_SRC"
DIST_DIR="${DIST_DIR:-$PROJECT_ROOT/dist/openclaw-runtime}"
DIST_TARBALL="${DIST_TARBALL:-$PROJECT_ROOT/dist/openclaw-runtime.tar.gz}"
STAGE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-runtime.XXXXXX")"
NPM_CACHE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-npm-cache.XXXXXX")"

cleanup() {
  rm -rf "$STAGE_ROOT" "$NPM_CACHE_DIR"
}
trap cleanup EXIT

if [ ! -f "$OPENCLAW_SRC/package.json" ]; then
  echo "OpenClaw source tree not found at $OPENCLAW_SRC" >&2
  echo "Set OPENCLAW_SRC=/path/to/openclaw, or place the upstream source at thirdparty/openclaw." >&2
  exit 1
fi

cd "$PROJECT_ROOT"

if [ ! -d "$OPENCLAW_SRC/node_modules" ]; then
  echo "Installing upstream OpenClaw dependencies..."
  pnpm --dir "$OPENCLAW_SRC" install --ignore-scripts --no-frozen-lockfile
fi

echo "Building upstream OpenClaw..."
pnpm --dir "$OPENCLAW_SRC" build

echo "Packing upstream OpenClaw release files..."
PACK_FILE="$(
  cd "$OPENCLAW_SRC" && \
    npm_config_cache="$NPM_CACHE_DIR" \
    npm_config_loglevel=error \
    npm pack --ignore-scripts | tail -n 1
)"

cp "$OPENCLAW_SRC/pnpm-lock.yaml" "$STAGE_ROOT/pnpm-lock.yaml"
tar -xf "$OPENCLAW_SRC/$PACK_FILE" -C "$STAGE_ROOT"
rm -f "$OPENCLAW_SRC/$PACK_FILE"
mv "$STAGE_ROOT/pnpm-lock.yaml" "$STAGE_ROOT/package/pnpm-lock.yaml"

echo "Preparing staged OpenClaw runtime manifest and sources..."
pnpm --filter @paddock/control-plane exec node --import tsx "$PROJECT_ROOT/scripts/prepare-openclaw-runtime-stage.ts" "$OPENCLAW_SRC" "$STAGE_ROOT/package"

echo "Installing OpenClaw runtime dependencies..."
(
  cd "$STAGE_ROOT/package"
  CI=1 NO_UPDATE_NOTIFIER=1 pnpm install --no-frozen-lockfile
  CI=1 NO_UPDATE_NOTIFIER=1 pnpm prune --prod
)

echo "Injecting OpenClaw runtime stubs for disabled runtime packages..."
pnpm --filter @paddock/control-plane exec node --import tsx "$PROJECT_ROOT/scripts/write-openclaw-runtime-stubs.ts" "$STAGE_ROOT/package"

echo "Verifying packaged OpenClaw runtime..."
(
  cd "$STAGE_ROOT/package"
  node ./openclaw.mjs gateway --help >/dev/null
  node ./openclaw.mjs agent --help >/dev/null
)

echo "Writing runtime bundle to $DIST_DIR..."
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"
cp -R "$STAGE_ROOT/package/." "$DIST_DIR/"

# Strip macOS extended attributes so Linux tar extractors in the VM do not
# see LIBARCHIVE/SCHILY xattr headers when unpacking the runtime bundle.
if command -v xattr >/dev/null 2>&1; then
  xattr -cr "$DIST_DIR" 2>/dev/null || true
fi

echo "Packing compressed runtime bundle to $DIST_TARBALL..."
rm -f "$DIST_TARBALL"
python3 - "$PROJECT_ROOT/dist" "$DIST_TARBALL" <<'PY'
import os
import sys
import tarfile

dist_root, tar_path = sys.argv[1:3]
source = os.path.join(dist_root, "openclaw-runtime")

with tarfile.open(tar_path, "w:gz", format=tarfile.PAX_FORMAT) as archive:
    archive.add(source, arcname="openclaw-runtime", recursive=True)
PY

echo "OpenClaw runtime bundle ready at $DIST_DIR"
echo "Compressed runtime bundle ready at $DIST_TARBALL"
