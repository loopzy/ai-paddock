import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { COMPUTER_BOX_ROOTFS_ENV } from '../sandbox/sandbox-rootfs.js';

const constructorCalls: Array<Record<string, unknown>> = [];
const snapshotCalls: Array<{ method: string; args: unknown[] }> = [];
const runtimeRemoveCalls: Array<unknown[]> = [];

vi.mock('@boxlite-ai/boxlite', () => {
  class MockComputerBox {
    name?: string;
    private nativeBox = {
      start: async () => {
        snapshotCalls.push({ method: 'native.start', args: [] });
      },
      snapshot: {
        create: async (name: string) => {
          snapshotCalls.push({ method: 'snapshot.create', args: [name] });
          return {
            id: 'native-gui-snap-1',
            name,
            createdAt: 1_700_000_100,
            sizeBytes: 16384,
            containerDiskBytes: 32768,
          };
        },
        restore: async (name: string) => {
          snapshotCalls.push({ method: 'snapshot.restore', args: [name] });
        },
      },
    };
    _runtime = {
      get: async () => this.nativeBox,
      remove: async (...args: unknown[]) => {
        runtimeRemoveCalls.push(args);
      },
    };

    constructor(options: Record<string, unknown>) {
      constructorCalls.push(options);
      this.name = typeof options.name === 'string' ? options.name : undefined;
    }

    async _ensureBox() {
      return this.nativeBox;
    }

    async getId() { return 'vm-computer-123'; }
    async getInfo() { return { id: 'vm-computer-123' }; }
    async exec() { return { stdout: '', stderr: '', exitCode: 0 }; }
    async copyIn() {}
    async copyOut() {}
    async stop() {}
    async metrics() { return { cpuPercent: 0, memoryMiB: 0 }; }
    async screenshot() { return { data: '', width: 0, height: 0, format: 'png' as const }; }
    async mouseMove() {}
    async leftClick() {}
    async key() {}
  }

  return {
    ComputerBox: MockComputerBox,
    BoxliteError: class MockBoxliteError extends Error {},
  };
});

describe('ComputerBoxDriver', () => {
  const originalComputerRootfsEnv = process.env[COMPUTER_BOX_ROOTFS_ENV];

  beforeEach(() => {
    constructorCalls.length = 0;
    snapshotCalls.length = 0;
    runtimeRemoveCalls.length = 0;
  });

  afterEach(() => {
    if (originalComputerRootfsEnv === undefined) delete process.env[COMPUTER_BOX_ROOTFS_ENV];
    else process.env[COMPUTER_BOX_ROOTFS_ENV] = originalComputerRootfsEnv;
  });

  it('passes a local ComputerBox rootfsPath to BoxLite when configured', async () => {
    const rootfsDir = mkdtempSync(join(tmpdir(), 'paddock-computer-rootfs-'));
    writeFileSync(join(rootfsDir, 'oci-layout'), '{"imageLayoutVersion":"1.0.0"}\n');
    writeFileSync(join(rootfsDir, 'index.json'), '{"schemaVersion":2,"manifests":[]}\n');
    mkdirSync(join(rootfsDir, 'blobs', 'sha256'), { recursive: true });
    process.env[COMPUTER_BOX_ROOTFS_ENV] = rootfsDir;

    try {
      const { ComputerBoxDriver } = await import('../sandbox/computer-box-driver.js');
      const driver = new ComputerBoxDriver();
      await driver.createBox({ sandboxType: 'computer-box', name: 'gui-test' });

      expect(constructorCalls).toHaveLength(1);
      expect(constructorCalls[0].rootfsPath).toBe(rootfsDir);
      expect(constructorCalls[0].name).toBe('gui-test');
      expect(constructorCalls[0].diskSizeGb).toBe(16);
      expect(constructorCalls[0].autoRemove).toBe(false);
    } finally {
      rmSync(rootfsDir, { recursive: true, force: true });
    }
  });

  it('allows the caller to override the default disk size', async () => {
    const { ComputerBoxDriver } = await import('../sandbox/computer-box-driver.js');
    const driver = new ComputerBoxDriver();
    await driver.createBox({ sandboxType: 'computer-box', diskSizeGB: 24 });

    expect(constructorCalls).toHaveLength(1);
    expect(constructorCalls[0].diskSizeGb).toBe(24);
  });

  it('creates a real GUI snapshot via the native snapshot handle', async () => {
    const { ComputerBoxDriver } = await import('../sandbox/computer-box-driver.js');
    const driver = new ComputerBoxDriver();
    const vmId = await driver.createBox({ sandboxType: 'computer-box' });

    const snapshot = await driver.createSnapshot(vmId, 'before-gui-test');

    expect(snapshot.boxliteSnapshotId).toContain('before-gui-test');
    expect(snapshot.sizeBytes).toBe(16384);
    expect(snapshot.containerDiskBytes).toBe(32768);
    expect(snapshot.createdAt).toBe(1_700_000_100_000);
    expect(snapshotCalls.some((call) => call.method === 'snapshot.create')).toBe(true);
  });

  it('restores a GUI snapshot and restarts the native box', async () => {
    const { ComputerBoxDriver } = await import('../sandbox/computer-box-driver.js');
    const driver = new ComputerBoxDriver();
    const vmId = await driver.createBox({ sandboxType: 'computer-box' });

    await driver.restoreSnapshot(vmId, 'gui-snap-restore-1');

    expect(snapshotCalls).toEqual(
      expect.arrayContaining([
        { method: 'snapshot.restore', args: ['gui-snap-restore-1'] },
        { method: 'native.start', args: [] },
      ]),
    );
  });

  it('removes a GUI box from the runtime when destroyed', async () => {
    const { ComputerBoxDriver } = await import('../sandbox/computer-box-driver.js');
    const driver = new ComputerBoxDriver();
    const vmId = await driver.createBox({ sandboxType: 'computer-box' });

    await driver.destroyBox(vmId);

    expect(runtimeRemoveCalls).toEqual([[vmId, true]]);
  });
});
