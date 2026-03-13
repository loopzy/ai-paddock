import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SIMPLE_BOX_ROOTFS_ENV } from '../sandbox/simple-box-rootfs.js';

const constructorCalls: Array<Record<string, unknown>> = [];

vi.mock('@boxlite-ai/boxlite', () => {
  class MockSimpleBox {
    name?: string;

    constructor(options: Record<string, unknown>) {
      constructorCalls.push(options);
      this.name = typeof options.name === 'string' ? options.name : undefined;
    }

    async getId() { return 'vm-simple-123'; }
    async getInfo() { return { id: 'vm-simple-123' }; }
    async exec() { return { stdout: '', stderr: '', exitCode: 0 }; }
    async copyIn() {}
    async copyOut() {}
    async stop() {}
    async metrics() { return { cpuPercent: 0, memoryMiB: 0 }; }
  }

  return {
    SimpleBox: MockSimpleBox,
    BoxliteError: class MockBoxliteError extends Error {},
  };
});

describe('SimpleBoxDriver', () => {
  const originalSimpleRootfsEnv = process.env[SIMPLE_BOX_ROOTFS_ENV];

  beforeEach(() => {
    constructorCalls.length = 0;
  });

  afterEach(() => {
    if (originalSimpleRootfsEnv === undefined) delete process.env[SIMPLE_BOX_ROOTFS_ENV];
    else process.env[SIMPLE_BOX_ROOTFS_ENV] = originalSimpleRootfsEnv;
  });

  it('passes a local SimpleBox rootfsPath to BoxLite when configured', async () => {
    const rootfsDir = mkdtempSync(join(tmpdir(), 'paddock-simple-rootfs-'));
    writeFileSync(join(rootfsDir, 'oci-layout'), '{"imageLayoutVersion":"1.0.0"}\n');
    writeFileSync(join(rootfsDir, 'index.json'), '{"schemaVersion":2,"manifests":[]}\n');
    mkdirSync(join(rootfsDir, 'blobs', 'sha256'), { recursive: true });
    process.env[SIMPLE_BOX_ROOTFS_ENV] = rootfsDir;

    try {
      const { SimpleBoxDriver } = await import('../sandbox/simple-box-driver.js');
      const driver = new SimpleBoxDriver();
      await driver.createBox({ sandboxType: 'simple-box', name: 'headless-test' });

      expect(constructorCalls).toHaveLength(1);
      expect(constructorCalls[0].rootfsPath).toBe(rootfsDir);
      expect(constructorCalls[0].name).toBe('headless-test');
      expect(constructorCalls[0].diskSizeGb).toBe(12);
    } finally {
      rmSync(rootfsDir, { recursive: true, force: true });
    }
  });

  it('allows the caller to override the default disk size', async () => {
    const { SimpleBoxDriver } = await import('../sandbox/simple-box-driver.js');
    const driver = new SimpleBoxDriver();
    await driver.createBox({ sandboxType: 'simple-box', diskSizeGB: 18 });

    expect(constructorCalls).toHaveLength(1);
    expect(constructorCalls[0].diskSizeGb).toBe(18);
  });
});
