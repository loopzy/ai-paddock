import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const dockerTempDir = resolve(repoRoot, '.paddock', 'tmp', 'docker-temp');
const dockerBuildContextDir = resolve(repoRoot, '.paddock', 'tmp', 'docker-build-context');

const SANDBOX_ROOTFS = {
  'simple-box': {
    label: 'SimpleBox',
    imageName: 'ubuntu:22.04',
    preparedImageName: 'paddock/simplebox-rootfs:ubuntu-22.04-browser',
    outputDir: resolve(repoRoot, 'dist', 'simplebox-rootfs', 'ubuntu-22.04'),
  },
  'computer-box': {
    label: 'ComputerBox',
    imageName: 'lscr.io/linuxserver/webtop:ubuntu-xfce',
    preparedImageName: 'paddock/computerbox-rootfs:ubuntu-xfce-browser',
    outputDir: resolve(repoRoot, 'dist', 'computerbox-rootfs', 'ubuntu-xfce'),
  },
};

const ROOTFS_FEATURES_FILE = 'paddock-rootfs-features.json';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function runShell(command, options = {}) {
  execFileSync('/bin/sh', ['-lc', command], {
    stdio: 'inherit',
    env: { ...process.env, TMPDIR: dockerTempDir },
    ...options,
  });
}

function getDockerBuildArgs() {
  const args = [];
  for (const envName of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'no_proxy']) {
    const value = process.env[envName]?.trim();
    if (value) {
      args.push(`--build-arg ${envName}=${shellQuote(value)}`);
    }
  }
  return args.join(' ');
}

function hasLocalDockerImage(tag) {
  try {
    execFileSync('docker', ['image', 'inspect', tag], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 15000,
    });
    return true;
  } catch {
    return false;
  }
}

function assertLocalDockerImage(imageName) {
  if (hasLocalDockerImage(imageName)) return;
  console.error(`[prepare-sandbox-rootfs] Local Docker image ${imageName} not found.`);
  console.error(`[prepare-sandbox-rootfs] Run: docker pull ${imageName}`);
  process.exit(1);
}

function prepareSandboxRootfs(sandboxType) {
  const config = SANDBOX_ROOTFS[sandboxType];
  const forceRebuild = process.env.PADDOCK_REBUILD_SANDBOX_ROOTFS === '1';

  assertLocalDockerImage(config.imageName);
  mkdirSync(dockerTempDir, { recursive: true });
  rmSync(dockerBuildContextDir, { recursive: true, force: true });
  mkdirSync(dockerBuildContextDir, { recursive: true });
  copyFileSync(resolve(repoRoot, 'packages', 'amp-openclaw', 'requirements.txt'), resolve(dockerBuildContextDir, 'requirements.txt'));

  if (forceRebuild || !hasLocalDockerImage(config.preparedImageName)) {
    console.log(`[prepare-sandbox-rootfs] Baking browser-ready ${config.label} rootfs from ${config.imageName}...`);
    const buildArgs = getDockerBuildArgs();
    runShell(
      [
        'docker build',
        '--pull=false',
        `--build-arg BASE_IMAGE=${shellQuote(config.imageName)}`,
        buildArgs,
        `-f ${shellQuote(resolve(repoRoot, 'scripts', 'Dockerfile.sandbox-rootfs-browser'))}`,
        `-t ${shellQuote(config.preparedImageName)}`,
        shellQuote(dockerBuildContextDir),
      ]
        .filter(Boolean)
        .join(' '),
    );
  } else {
    console.log(`[prepare-sandbox-rootfs] Reusing existing prepared image ${config.preparedImageName}.`);
  }

  console.log(`[prepare-sandbox-rootfs] Exporting prepared image ${config.preparedImageName}...`);

  console.log(`[prepare-sandbox-rootfs] Extracting OCI layout to ${config.outputDir}...`);
  rmSync(config.outputDir, { recursive: true, force: true });
  mkdirSync(config.outputDir, { recursive: true });
  try {
    runShell(`docker save ${shellQuote(config.preparedImageName)} | tar -xf - -C ${shellQuote(config.outputDir)}`);
  } catch (error) {
    rmSync(config.outputDir, { recursive: true, force: true });
    throw error;
  }

  const hasLayout = existsSync(resolve(config.outputDir, 'oci-layout')) && existsSync(resolve(config.outputDir, 'index.json'));
  if (!hasLayout) {
    rmSync(config.outputDir, { recursive: true, force: true });
    throw new Error(`Extracted archive at ${config.outputDir} is missing OCI layout metadata`);
  }

  writeFileSync(
    resolve(config.outputDir, ROOTFS_FEATURES_FILE),
    JSON.stringify(
      {
        browserRuntime: true,
        preparedFrom: config.imageName,
        preparedImage: config.preparedImageName,
        preparedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  console.log(`[prepare-sandbox-rootfs] Ready: ${config.outputDir}`);
  console.log(`[prepare-sandbox-rootfs] ${config.label} will now use the local rootfsPath instead of pulling from the registry.`);
  console.log('[prepare-sandbox-rootfs] Python + Playwright + Chromium are preloaded, so first OpenClaw deploy can stay offline.');
}

const target = process.argv[2] ?? 'all';
if (target === 'all') {
  prepareSandboxRootfs('simple-box');
  prepareSandboxRootfs('computer-box');
} else if (target === 'simple-box' || target === 'computer-box') {
  prepareSandboxRootfs(target);
} else {
  console.error(`[prepare-sandbox-rootfs] Unknown target: ${target}`);
  console.error('[prepare-sandbox-rootfs] Use one of: simple-box, computer-box, all');
  process.exit(1);
}
