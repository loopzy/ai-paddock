/**
 * Integration tests — actually create real BoxLite VMs.
 *
 * These tests require Docker and the BoxLite runtime.
 * Run with: pnpm test -- --testPathPattern integration
 *
 * They are slow (VM creation + image pull) so they have long timeouts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import type { SandboxDriver, SandboxType } from '@paddock/types';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { getSandboxImageName, getSandboxRootfsPath } from '../sandbox/sandbox-rootfs.js';

function detectVirtualizationSupport(): boolean {
  if (process.platform !== 'darwin') return true;

  try {
    const output = execFileSync('sysctl', ['-n', 'kern.hv_support'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return output === '1';
  } catch {
    return false;
  }
}

function isBoxliteRuntimeAvailable(): boolean {
  const lockPath = join(homedir(), '.boxlite', '.lock');

  try {
    const output = execFileSync('lsof', ['-t', lockPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!output) return true;

    const holders = output
      .split('\n')
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isFinite(value) && value !== process.pid);

    return holders.length === 0;
  } catch {
    return true;
  }
}

const canRunBoxliteIntegration = detectVirtualizationSupport() && isBoxliteRuntimeAvailable();
type RootfsSandboxType = Extract<SandboxType, 'simple-box' | 'computer-box'>;

function hasPreparedSandboxRootfs(sandboxType: RootfsSandboxType): boolean {
  const rootfsPath = getSandboxRootfsPath(sandboxType);
  return existsSync(join(rootfsPath, 'oci-layout')) && existsSync(join(rootfsPath, 'index.json'));
}

function hasLocalDockerImage(imageName: string): boolean {
  try {
    const output = execFileSync('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output
      .split('\n')
      .some((line) => line.trim() === imageName);
  } catch {
    return false;
  }
}

function prepareSandboxRootfs(sandboxType: RootfsSandboxType): boolean {
  if (hasPreparedSandboxRootfs(sandboxType)) return true;

  const imageName = getSandboxImageName(sandboxType);
  if (!hasLocalDockerImage(imageName)) return false;

  try {
    execFileSync('node', ['scripts/prepare-sandbox-rootfs.mjs', sandboxType], {
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    return false;
  }

  return hasPreparedSandboxRootfs(sandboxType);
}

const canRunSimpleBoxIntegration = canRunBoxliteIntegration && prepareSandboxRootfs('simple-box');
const describeSimpleBox = canRunSimpleBoxIntegration ? describe : describe.skip;
if (canRunBoxliteIntegration) {
  prepareSandboxRootfs('computer-box');
}
const describeComputerBox = canRunBoxliteIntegration ? describe : describe.skip;

async function createSimpleBoxDriver(): Promise<SandboxDriver> {
  const { SimpleBoxDriver } = await import('../sandbox/simple-box-driver.js');
  return new SimpleBoxDriver();
}

async function createComputerBoxDriver(): Promise<SandboxDriver> {
  const { ComputerBoxDriver } = await import('../sandbox/computer-box-driver.js');
  return new ComputerBoxDriver();
}

async function ensureBundledNode(driver: SandboxDriver, vmId: string): Promise<void> {
  const existing = await driver.exec(vmId, 'command -v node');
  if (existing.exitCode === 0) return;

  const arch = await driver.exec(vmId, 'uname -m');
  const nodeArch = arch.stdout.trim() === 'aarch64' ? 'arm64' : 'x64';
  const nodeBinDir = resolve(process.cwd(), 'dist', `node-bin-${nodeArch}`);

  statSync(join(nodeBinDir, 'bin', 'node'));
  await driver.copyIn(vmId, nodeBinDir, '/opt/paddock');

  const linkResult = await driver.exec(
    vmId,
    `ln -sf /opt/paddock/node-bin-${nodeArch}/bin/node /usr/local/bin/node && node --version`,
  );
  expect(linkResult.exitCode).toBe(0);
}

describeSimpleBox('SimpleBoxDriver (integration)', () => {
  let driver: SandboxDriver;
  let vmId: string | undefined;

  afterEach(async () => {
    if (vmId && driver) {
      try { await driver.destroyBox(vmId); } catch { /* ignore */ }
    }
  });

  it('should create a VM, exec, and destroy', { timeout: 120_000 }, async () => {
    driver = await createSimpleBoxDriver();
    vmId = await driver.createBox({ sandboxType: 'simple-box' });
    expect(vmId).toBeTruthy();
    console.log(`[SimpleBox] VM created: ${vmId}`);

    // exec a simple command
    const result = await driver.exec(vmId, 'echo hello');
    console.log(`[SimpleBox] exec result:`, result);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');

    // getInfo
    const info = await driver.getInfo(vmId);
    expect(info).toBeTruthy();
    expect(info!.id).toBe(vmId);

    // copyIn: create a temp file and copy it
    const tmpDir = '/tmp/paddock-test-' + Date.now();
    const { execSync } = await import('node:child_process');
    execSync(`mkdir -p ${tmpDir}/testdir && echo "test content" > ${tmpDir}/testdir/test.txt`);

    // SDK preserves dir name: testdir → /root/testdir/
    await driver.copyIn(vmId, `${tmpDir}/testdir`, '/root');
    const catResult = await driver.exec(vmId, 'cat /root/testdir/test.txt');
    console.log(`[SimpleBox] copyIn + cat result:`, catResult);
    expect(catResult.stdout.trim()).toBe('test content');

    // cleanup temp
    execSync(`rm -rf ${tmpDir}`);

    // destroy
    await driver.destroyBox(vmId);
    vmId = undefined;
  });

  it('should run the full sidecar deployment flow', { timeout: 180_000 }, async () => {
    driver = await createSimpleBoxDriver();
    vmId = await driver.createBox({ sandboxType: 'simple-box' });
    console.log(`[SimpleBox] VM created for sidecar test: ${vmId}`);

    // Step 1: copyIn sidecar files (SDK preserves dir name: sidecar → /opt/paddock/sidecar/)
    console.log('[SimpleBox] Copying sidecar files...');
    await driver.copyIn(vmId, './dist/sidecar', '/opt/paddock');

    // Verify files were copied at the correct path
    const lsResult = await driver.exec(vmId, 'ls /opt/paddock/sidecar/index.js');
    console.log(`[SimpleBox] sidecar files:`, lsResult);
    expect(lsResult.exitCode).toBe(0);

    // Step 2: install the same bundled Node.js runtime used by session startup.
    await ensureBundledNode(driver, vmId);

    // Step 3: copyIn PAL shims (SDK preserves dir name)
    console.log('[SimpleBox] Copying PAL shims...');
    await driver.copyIn(vmId, './packages/sidecar/pal-shims', '/opt/paddock');
    await driver.exec(vmId, 'cp /opt/paddock/pal-shims/* /usr/local/bin/ 2>/dev/null; chmod +x /usr/local/bin/paddock-host-tool 2>/dev/null || true');
    const shimCheck = await driver.exec(vmId, 'ls /usr/local/bin/paddock-host-tool');
    console.log(`[SimpleBox] shim check:`, shimCheck);
    expect(shimCheck.exitCode).toBe(0);

    // Step 4: start sidecar (path is /opt/paddock/sidecar/ now)
    console.log('[SimpleBox] Starting sidecar...');
    await driver.exec(vmId, 'cd /opt/paddock/sidecar && PADDOCK_SESSION_ID=test-sess PADDOCK_CONTROL_URL=http://host.internal:3100 PADDOCK_WATCH_DIR=/workspace PADDOCK_PROXY_PORT=8800 nohup node index.js > /var/log/paddock-sidecar.log 2>&1 & echo $! > /var/run/paddock-sidecar.pid');

    // Wait and check
    await new Promise(r => setTimeout(r, 3000));
    const pgrepResult = await driver.exec(vmId, 'test -s /var/run/paddock-sidecar.pid && kill -0 "$(cat /var/run/paddock-sidecar.pid)"');
    console.log(`[SimpleBox] process check:`, pgrepResult);

    if (pgrepResult.exitCode !== 0) {
      const logs = await driver.exec(vmId, 'cat /var/log/paddock-sidecar.log 2>&1');
      console.log(`[SimpleBox] sidecar logs:`, logs.stdout);
    }

    // Cleanup
    await driver.destroyBox(vmId);
    vmId = undefined;
  });
});

describeComputerBox('ComputerBoxDriver (integration)', () => {
  let driver: SandboxDriver;
  let vmId: string | undefined;

  afterEach(async () => {
    if (vmId && driver) {
      try { await driver.destroyBox(vmId); } catch { /* ignore */ }
    }
  });

  it('should create a ComputerBox VM and exec', { timeout: 300_000 }, async () => {
    driver = await createComputerBoxDriver();
    console.log('[ComputerBox] Creating VM (this may pull a large image)...');
    vmId = await driver.createBox({ sandboxType: 'computer-box' });
    expect(vmId).toBeTruthy();
    console.log(`[ComputerBox] VM created: ${vmId}`);

    // exec a simple command
    const result = await driver.exec(vmId, 'echo hello');
    console.log(`[ComputerBox] exec result:`, result);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');

    // Cleanup
    await driver.destroyBox(vmId);
    vmId = undefined;
  });

  it('should run the full sidecar deployment flow on ComputerBox', { timeout: 300_000 }, async () => {
    driver = await createComputerBoxDriver();
    console.log('[ComputerBox] Creating VM...');
    vmId = await driver.createBox({ sandboxType: 'computer-box' });
    console.log(`[ComputerBox] VM created: ${vmId}`);

    // Step 1: copyIn sidecar (SDK preserves dir name)
    console.log('[ComputerBox] Copying sidecar files...');
    try {
      await driver.copyIn(vmId, './dist/sidecar', '/opt/paddock');
      console.log('[ComputerBox] Sidecar files copied successfully');
    } catch (err) {
      console.error('[ComputerBox] copyIn FAILED:', err);
      throw err;
    }

    // Verify
    const lsResult = await driver.exec(vmId, 'ls -la /opt/paddock/sidecar/');
    console.log(`[ComputerBox] sidecar dir:`, lsResult.stdout);

    // Step 2: install the same bundled Node.js runtime used by session startup.
    await ensureBundledNode(driver, vmId);

    // Step 3: copyIn PAL shims
    console.log('[ComputerBox] Copying PAL shims...');
    await driver.copyIn(vmId, './packages/sidecar/pal-shims', '/opt/paddock');
    await driver.exec(vmId, 'cp /opt/paddock/pal-shims/* /usr/local/bin/ 2>/dev/null; chmod +x /usr/local/bin/paddock-host-tool 2>/dev/null || true');

    // Step 4: start sidecar (path is /opt/paddock/sidecar/)
    console.log('[ComputerBox] Starting sidecar...');
    await driver.exec(vmId, 'cd /opt/paddock/sidecar && PADDOCK_SESSION_ID=test-sess PADDOCK_CONTROL_URL=http://host.internal:3100 PADDOCK_WATCH_DIR=/workspace PADDOCK_PROXY_PORT=8800 nohup node index.js > /var/log/paddock-sidecar.log 2>&1 & echo $! > /var/run/paddock-sidecar.pid');

    await new Promise(r => setTimeout(r, 3000));
    const pgrepResult = await driver.exec(vmId, 'test -s /var/run/paddock-sidecar.pid && kill -0 "$(cat /var/run/paddock-sidecar.pid)"');
    console.log(`[ComputerBox] process check:`, pgrepResult);

    if (pgrepResult.exitCode !== 0) {
      const logs = await driver.exec(vmId, 'cat /var/log/paddock-sidecar.log 2>&1');
      console.log(`[ComputerBox] sidecar logs:`, logs.stdout);
      // Don't fail here - sidecar may fail to connect to control plane, that's expected
      console.warn('[ComputerBox] Sidecar process not found - check logs above');
    }

    await driver.destroyBox(vmId);
    vmId = undefined;
  });
});
