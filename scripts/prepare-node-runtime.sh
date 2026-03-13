#!/bin/bash
# Download pre-built Node.js binaries for VM guests.
# These are copied into the VM via copyIn to avoid slow apt-get installs.
set -e

NODE_VERSION="v22.16.0"
DIST_DIR="$(cd "$(dirname "$0")/.." && pwd)/dist"

current_version() {
  local version_file="$1/VERSION"
  if [ -f "$version_file" ]; then
    cat "$version_file"
  fi
}

for ARCH in arm64 x64; do
  DIR="$DIST_DIR/node-bin-$ARCH/bin"
  TARGET_DIR="$DIST_DIR/node-bin-$ARCH"
  EXISTING_VERSION="$(current_version "$TARGET_DIR")"

  if [ -f "$DIR/node" ] && [ "$EXISTING_VERSION" = "$NODE_VERSION" ]; then
    echo "node-bin-$ARCH already at $NODE_VERSION, skipping"
    continue
  fi

  if [ -f "$DIR/node" ]; then
    echo "Refreshing stale node-bin-$ARCH runtime (found ${EXISTING_VERSION:-unknown}, want $NODE_VERSION)..."
    rm -rf "$TARGET_DIR"
  fi

  echo "Downloading Node.js $NODE_VERSION for linux-$ARCH..."
  mkdir -p "$DIR"
  TMP=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-$ARCH.tar.gz" \
    | tar -xz -C "$TMP" --strip-components=1
  cp "$TMP/bin/node" "$DIR/node"
  chmod +x "$DIR/node"
  printf '%s\n' "$NODE_VERSION" > "$TARGET_DIR/VERSION"
  rm -rf "$TMP"
  echo "  → $DIR/node ($(du -h "$DIR/node" | cut -f1))"
done

echo "Done. Node.js binaries ready in dist/node-bin-{arm64,x64}/"
