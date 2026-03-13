#!/bin/bash
# Build Sidecar as a standalone executable for deployment to VM

set -e

cd "$(dirname "$0")/.."

echo "Preparing Node.js guest runtimes..."
./scripts/prepare-node-runtime.sh

echo "Building @paddock/types..."
cd packages/types
pnpm build
cd ../..

echo "Building Sidecar..."
cd packages/sidecar
pnpm build

echo "Creating deployment bundle..."
mkdir -p ../../dist/sidecar
cp -r dist/* ../../dist/sidecar/
cp package.json ../../dist/sidecar/

echo "Installing production dependencies..."
cd ../../dist/sidecar
node <<'EOF'
const fs = require('node:fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
if (pkg.dependencies) {
  delete pkg.dependencies['@paddock/types'];
}
delete pkg.devDependencies;
delete pkg.scripts;
fs.writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
EOF
CI=1 NO_UPDATE_NOTIFIER=1 pnpm install --ignore-workspace --no-frozen-lockfile --prod --ignore-scripts --modules-dir node_modules --virtual-store-dir node_modules/.pnpm --offline || \
  CI=1 NO_UPDATE_NOTIFIER=1 pnpm install --ignore-workspace --no-frozen-lockfile --prod --ignore-scripts --modules-dir node_modules --virtual-store-dir node_modules/.pnpm --prefer-offline

echo "Fixing workspace package layout for deployment..."
mkdir -p node_modules/@paddock/types/dist
cp ../../packages/types/package.json node_modules/@paddock/types/package.json
cp -r ../../packages/types/dist/* node_modules/@paddock/types/dist/

echo "Packaging AMP OpenClaw adapter..."
cd ../../packages/amp-openclaw
mkdir -p ../../dist/amp-openclaw
cp -r paddock_amp pyproject.toml ../../dist/amp-openclaw/

echo "Packaging official OpenClaw deployer scripts..."
cd ../control-plane
mkdir -p ../../dist/deployers/openclaw
cp -R deployers/openclaw/. ../../dist/deployers/openclaw/
chmod +x ../../dist/deployers/openclaw/*.sh

echo "Sidecar bundle ready at dist/sidecar/"
echo "AMP adapter ready at dist/amp-openclaw/"
