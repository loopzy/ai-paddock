import { SimpleBox, type BoxliteError } from '@boxlite-ai/boxlite';
import { resolve } from 'node:path';
import type { SandboxDriver, SandboxConfig, VMInfo, ExecResult, SandboxSnapshot } from '@paddock/types';
import { getSimpleBoxImageSource } from './simple-box-rootfs.js';

const SIMPLE_BOX_DEFAULT_DISK_SIZE_GB = 12;

/**
 * SimpleBoxDriver — wraps BoxLite SDK for headless Linux MicroVMs.
 * Refactored from the original BoxLiteDriver to implement SandboxDriver.
 */
export class SimpleBoxDriver implements SandboxDriver {
  private boxes = new Map<string, SimpleBox>();

  async createBox(config: SandboxConfig = { sandboxType: 'simple-box' }): Promise<string> {
    const box = new SimpleBox({
      ...getSimpleBoxImageSource(),
      name: config.name,
      cpus: config.cpus,
      memoryMib: config.memoryMiB,
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
    const box = this.boxes.get(vmId);
    if (!box) throw new Error(`VM ${vmId} not found`);
    const snapshotId = `snap-${Date.now()}`;
    return { id: snapshotId, sessionId: vmId, seq: 0, label, createdAt: Date.now(), boxliteSnapshotId: snapshotId };
  }

  async restoreSnapshot(vmId: string, snapshotId: string): Promise<void> {
    const box = this.boxes.get(vmId);
    if (!box) throw new Error(`VM ${vmId} not found`);
    throw new Error('Snapshot restore not yet implemented');
  }

  async destroyBox(vmId: string): Promise<void> {
    const box = this.boxes.get(vmId);
    if (!box) return;
    await box.stop();
    this.boxes.delete(vmId);
  }

  async getMetrics(vmId: string): Promise<{ cpuPercent: number; memoryMiB: number }> {
    const box = this.boxes.get(vmId);
    if (!box) throw new Error(`VM ${vmId} not found`);
    const metrics = await box.metrics();
    return { cpuPercent: metrics.cpuPercent ?? 0, memoryMiB: metrics.memoryMiB ?? 0 };
  }
}
