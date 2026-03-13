import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { COMPUTER_BOX_ROOTFS_ENV } from '../sandbox/sandbox-rootfs.js';

const constructorCalls: Array<Record<string, unknown>> = [];

vi.mock('@boxlite-ai/boxlite', () => {
  class MockComputerBox {
    name?: string;

    constructor(options: Record<string, unknown>) {
      constructorCalls.push(options);
      this.name = typeof options.name === 'string' ? options.name : undefined;
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
});
