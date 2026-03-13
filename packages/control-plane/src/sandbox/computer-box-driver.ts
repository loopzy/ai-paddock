import { ComputerBox, type BoxliteError } from '@boxlite-ai/boxlite';
import { resolve } from 'node:path';
import type { SandboxDriver, SandboxConfig, VMInfo, ExecResult, SandboxSnapshot } from '@paddock/types';
import { getSandboxRootfsOverride } from './sandbox-rootfs.js';

const COMPUTER_BOX_DEFAULT_DISK_SIZE_GB = 16;

/**
 * ComputerBoxDriver — GUI Linux sandbox with screenshot/mouse/keyboard support.
 * Uses BoxLite's ComputerBox for full desktop environment.
 * Dynamic port allocation starting from 13000.
 */
export class ComputerBoxDriver implements SandboxDriver {
  private boxes = new Map<string, ComputerBox>();
  private portMap = new Map<string, { httpPort: number; httpsPort: number }>();
  private nextPort = 13000;

  private allocatePorts(): { httpPort: number; httpsPort: number } {
    const httpPort = this.nextPort++;
    const httpsPort = this.nextPort++;
    return { httpPort, httpsPort };
  }

  getGuiPorts(vmId: string): { httpPort: number; httpsPort: number } | undefined {
    return this.portMap.get(vmId);
  }

  async createBox(config: SandboxConfig = { sandboxType: 'computer-box' }): Promise<string> {
    const ports = this.allocatePorts();
    const box = new ComputerBox({
      ...getSandboxRootfsOverride('computer-box'),
      cpus: config.cpus ?? 4,
      memoryMib: config.memoryMiB ?? 4096,
      diskSizeGb: config.diskSizeGB ?? COMPUTER_BOX_DEFAULT_DISK_SIZE_GB,
      guiHttpPort: ports.httpPort,
      guiHttpsPort: ports.httpsPort,
      name: config.name,
    });
    const id = await box.getId();
    this.boxes.set(id, box);
    this.portMap.set(id, ports);
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
    this.portMap.delete(vmId);
  }

  async getMetrics(vmId: string): Promise<{ cpuPercent: number; memoryMiB: number }> {
    const box = this.boxes.get(vmId);
    if (!box) throw new Error(`VM ${vmId} not found`);
    const metrics = await box.metrics();
    return { cpuPercent: metrics.cpuPercent ?? 0, memoryMiB: metrics.memoryMiB ?? 0 };
  }

  // GUI-specific methods
  async screenshot(vmId: string): Promise<Buffer> {
    const box = this.boxes.get(vmId);
    if (!box) throw new Error(`VM ${vmId} not found`);
    const screenshot = await box.screenshot();
    return Buffer.from(screenshot.data, 'base64');
  }

  async mouseClick(vmId: string, x: number, y: number): Promise<void> {
    const box = this.boxes.get(vmId);
    if (!box) throw new Error(`VM ${vmId} not found`);
    await box.mouseMove(x, y);
    await box.leftClick();
  }

  async keyPress(vmId: string, key: string): Promise<void> {
    const box = this.boxes.get(vmId);
    if (!box) throw new Error(`VM ${vmId} not found`);
    await box.key(key);
  }
}
