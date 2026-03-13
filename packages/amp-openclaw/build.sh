#!/bin/bash
set -e

# Build script for amp-openclaw package
# Copies Python source files to dist/ for deployment

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SRC_DIR="$SCRIPT_DIR"
DIST_DIR="$PROJECT_ROOT/dist/amp-openclaw"

echo "Building amp-openclaw..."
echo "  Source: $SRC_DIR"
echo "  Target: $DIST_DIR"

# Clean old dist
if [ -d "$DIST_DIR" ]; then
  echo "  Cleaning old dist..."
  rm -rf "$DIST_DIR"
fi

# Create dist directory
mkdir -p "$DIST_DIR"

# Copy Python package
echo "  Copying paddock_amp..."
cp -r "$SRC_DIR/paddock_amp" "$DIST_DIR/"

# Remove test files and cache
echo "  Removing test files and cache..."
rm -rf "$DIST_DIR/paddock_amp/__tests__"
rm -rf "$DIST_DIR/paddock_amp/__pycache__"
find "$DIST_DIR" -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
find "$DIST_DIR" -type d -name ".pytest_cache" -exec rm -rf {} + 2>/dev/null || true
find "$DIST_DIR" -name "*.pyc" -delete 2>/dev/null || true

# Copy metadata files if they exist
if [ -f "$SRC_DIR/pyproject.toml" ]; then
  echo "  Copying pyproject.toml..."
  cp "$SRC_DIR/pyproject.toml" "$DIST_DIR/"
fi

if [ -f "$SRC_DIR/requirements.txt" ]; then
  echo "  Copying requirements.txt..."
  cp "$SRC_DIR/requirements.txt" "$DIST_DIR/"
fi

if [ -f "$SRC_DIR/README.md" ]; then
  echo "  Copying README.md..."
  cp "$SRC_DIR/README.md" "$DIST_DIR/"
fi

# Create a simple requirements.txt if it doesn't exist
if [ ! -f "$DIST_DIR/requirements.txt" ]; then
  echo "  Creating requirements.txt..."
  cat > "$DIST_DIR/requirements.txt" << EOF
requests>=2.31.0
EOF
fi

echo "✓ Built amp-openclaw to $DIST_DIR"

# Verify the build
if [ -f "$DIST_DIR/paddock_amp/__init__.py" ] && \
   [ -f "$DIST_DIR/paddock_amp/plugin.py" ] && \
   [ -f "$DIST_DIR/paddock_amp/builtin_agent.py" ]; then
  echo "✓ Build verification passed"
else
  echo "✗ Build verification failed - missing required files"
  exit 1
fi
