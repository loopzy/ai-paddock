import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
const DOCKER_BUILD_PROXY_ENV_NAMES = ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'no_proxy'];
const DOCKER_BUILD_PROXY_HOST = 'host.docker.internal';

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

function isLoopbackHostname(hostname) {
  const normalized = String(hostname).trim().replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function rewriteDockerBuildProxyValue(rawValue) {
  const value = String(rawValue).trim();
  if (!value) return { value, rewritten: false };

  try {
    const parsed = new URL(value);
    if (!isLoopbackHostname(parsed.hostname)) {
      return { value, rewritten: false };
    }

    const auth =
      parsed.username || parsed.password ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@` : '';
    const port = parsed.port ? `:${parsed.port}` : '';
    const suffix =
      parsed.pathname === '/' && !value.endsWith('/') && !parsed.search && !parsed.hash
        ? ''
        : `${parsed.pathname}${parsed.search}${parsed.hash}`;

    return {
      value: `${parsed.protocol}//${auth}${DOCKER_BUILD_PROXY_HOST}${port}${suffix}`,
      rewritten: true,
      originalHost: parsed.hostname,
    };
  } catch {
    const match = value.match(/^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)(?=[:/]|$)(.*)$/i);
    if (!match) {
      return { value, rewritten: false };
    }
    return {
      value: `${DOCKER_BUILD_PROXY_HOST}${match[2]}`,
      rewritten: true,
      originalHost: match[1],
    };
  }
}

function getDockerBuildArgs(env = process.env) {
  const args = [];
  const notices = [];
  let needsHostGateway = false;

  for (const envName of DOCKER_BUILD_PROXY_ENV_NAMES) {
    const rawValue = env[envName]?.trim();
    if (!rawValue) continue;

    let value = rawValue;
    if (envName !== 'NO_PROXY' && envName !== 'no_proxy') {
      const rewritten = rewriteDockerBuildProxyValue(rawValue);
      value = rewritten.value;
      if (rewritten.rewritten) {
        needsHostGateway = true;
        notices.push(
          `[prepare-sandbox-rootfs] Rewriting ${envName} from ${rewritten.originalHost} to ${DOCKER_BUILD_PROXY_HOST} for Docker build reachability.`,
        );
      } else if (value.includes(DOCKER_BUILD_PROXY_HOST)) {
        needsHostGateway = true;
      }
    }
    args.push(`--build-arg ${envName}=${shellQuote(value)}`);
  }

  return {
    argString: args.join(' '),
    notices,
    needsHostGateway,
  };
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
    const { argString: buildArgs, notices, needsHostGateway } = getDockerBuildArgs();
    for (const notice of notices) {
      console.log(notice);
    }
    runShell(
      [
        'docker build',
        '--pull=false',
        needsHostGateway ? `--add-host ${DOCKER_BUILD_PROXY_HOST}=host-gateway` : '',
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

function main(argv = process.argv) {
  const target = argv[2] ?? 'all';
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { DOCKER_BUILD_PROXY_HOST, getDockerBuildArgs, main, rewriteDockerBuildProxyValue };
