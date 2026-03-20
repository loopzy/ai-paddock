import { SimpleBox, type BoxliteError } from '@boxlite-ai/boxlite';
import { resolve } from 'node:path';
import type { SandboxDriver, SandboxConfig, VMInfo, ExecResult, SandboxSnapshot } from '@paddock/types';
import { getSimpleBoxImageSource } from './simple-box-rootfs.js';
import {
  buildSnapshotName,
  getNativeSnapshotHandle,
  refreshNativeBoxHandle,
  removeBoxRuntime,
  toSandboxSnapshot,
  type SnapshotCapableBox,
} from './boxlite-snapshot.js';

const SIMPLE_BOX_DEFAULT_DISK_SIZE_GB = 12;

/**
 * SimpleBoxDriver — wraps BoxLite SDK for headless Linux MicroVMs.
 * Refactored from the original BoxLiteDriver to implement SandboxDriver.
 */
export class SimpleBoxDriver implements SandboxDriver {
  private boxes = new Map<string, SimpleBox>();

  private async createSnapshotWithMode(vmId: string, label: string | undefined, consistencyMode: 'live' | 'stopped'): Promise<SandboxSnapshot> {
    const box = this.boxes.get(vmId);
    if (!box) throw new Error(`VM ${vmId} not found`);

    const snapshotName = buildSnapshotName(label);

    if (consistencyMode === 'stopped') {
      await box.stop();
      const nativeBox = await refreshNativeBoxHandle(box as unknown as SnapshotCapableBox, vmId);
      const snapshotHandle = nativeBox.snapshot;
      if (!snapshotHandle || typeof snapshotHandle.create !== 'function') {
        throw new Error('Installed BoxLite package does not expose snapshot APIs');
      }
      const snapshotInfo = await snapshotHandle.create(snapshotName, {});
      if (typeof nativeBox.start !== 'function') {
        throw new Error('Installed BoxLite package does not expose box.start()');
      }
      await nativeBox.start();
      return toSandboxSnapshot(vmId, snapshotName, label, snapshotInfo, 'stopped');
    }

    const snapshotHandle = await getNativeSnapshotHandle(box as unknown as SnapshotCapableBox);
    const snapshotInfo = await snapshotHandle.create(snapshotName, {});
    return toSandboxSnapshot(vmId, snapshotName, label, snapshotInfo, 'live');
  }

  async createBox(config: SandboxConfig = { sandboxType: 'simple-box' }): Promise<string> {
    const box = new SimpleBox({
      ...getSimpleBoxImageSource(),
      name: config.name,
      cpus: config.cpus,
      memoryMib: config.memoryMiB,
      autoRemove: false,
      // Full browser-ready OpenClaw deployments need more room than BoxLite's tiny default root disk.
      diskSizeGb: config.diskSizeGB ?? SIMPLE_BOX_DEFAULT_DISK_SIZE_GB,
    });
    const id = await box.getId();
    this.boxes.set(id, box);
    return id;
  }

  async getInfo(vmId: string): Promise<VMInfo | null> {
    const box = this.boxes.get(vmId);
    if (!box) return null;
    await box.getInfo();
    const id = await box.getId();
    return { id, name: box.name ?? vmId, status: 'running', created: new Date() };
  }

  async exec(vmId: string, command: string): Promise<ExecResult> {
    const box = this.boxes.get(vmId);
    if (!box) throw new Error(`VM ${vmId} not found`);
    try {
      const result = await box.exec('sh', '-c', command);
      return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.exitCode ?? 0 };
    } catch (err) {
      const e = err as BoxliteError;
      return { stdout: '', stderr: e.message, exitCode: 1 };
    }
  }

  async copyIn(vmId: string, hostPath: string, vmPath: string): Promise<void> {
    const box = this.boxes.get(vmId);
    if (!box) throw new Error(`VM ${vmId} not found`);
    await box.copyIn(resolve(hostPath), vmPath);
  }

  async copyOut(vmId: string, vmPath: string, hostPath: string): Promise<void> {
    const box = this.boxes.get(vmId);
    if (!box) throw new Error(`VM ${vmId} not found`);
    await box.copyOut(vmPath, resolve(hostPath));
  }

  async createSnapshot(vmId: string, label?: string): Promise<SandboxSnapshot> {
    return this.createSnapshotWithMode(vmId, label, 'live');
  }

  async createConsistentSnapshot(vmId: string, label?: string): Promise<SandboxSnapshot> {
    return this.createSnapshotWithMode(vmId, label, 'stopped');
  }

  async restoreSnapshot(vmId: string, snapshotId: string): Promise<void> {
    const box = this.boxes.get(vmId);
    if (!box) throw new Error(`VM ${vmId} not found`);
    await box.stop();
    const nativeBox = await refreshNativeBoxHandle(box as unknown as SnapshotCapableBox, vmId);
    const snapshotHandle = nativeBox.snapshot;
    if (!snapshotHandle || typeof snapshotHandle.restore !== 'function') {
      throw new Error('Installed BoxLite package does not expose snapshot APIs');
    }
    await snapshotHandle.restore(snapshotId);
    if (typeof nativeBox.start !== 'function') {
      throw new Error('Installed BoxLite package does not expose box.start()');
    }
    await nativeBox.start();
  }

  async destroyBox(vmId: string): Promise<void> {
    const box = this.boxes.get(vmId);
    if (!box) return;
    await box.stop();
    await removeBoxRuntime(box as unknown as SnapshotCapableBox, vmId);
    this.boxes.delete(vmId);
  }

  async getMetrics(vmId: string): Promise<{ cpuPercent: number; memoryMiB: number }> {
    const box = this.boxes.get(vmId);
    if (!box) throw new Error(`VM ${vmId} not found`);
    const metrics = await box.metrics();
    return { cpuPercent: metrics.cpuPercent ?? 0, memoryMiB: metrics.memoryMiB ?? 0 };
  }
}
