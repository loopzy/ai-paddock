import type { SandboxDriver, SandboxConfig, VMInfo, ExecResult, SandboxSnapshot } from '@paddock/types';

/**
 * CUADriver — stub for CUA (Computer Use Agent) sandbox.
 * TODO: Requires Python bridge for CUA integration.
 */
export class CUADriver implements SandboxDriver {
  async createBox(config?: SandboxConfig): Promise<string> {
    throw new Error('CUADriver not yet implemented — requires Python bridge');
  }
  async getInfo(vmId: string): Promise<VMInfo | null> {
    throw new Error('CUADriver not yet implemented');
  }
  async exec(vmId: string, command: string): Promise<ExecResult> {
    throw new Error('CUADriver not yet implemented');
  }
  async copyIn(vmId: string, hostPath: string, vmPath: string): Promise<void> {
    throw new Error('CUADriver not yet implemented');
  }
  async copyOut(vmId: string, vmPath: string, hostPath: string): Promise<void> {
    throw new Error('CUADriver not yet implemented');
  }
  async pauseBox(vmId: string): Promise<void> {
    throw new Error('CUADriver not yet implemented');
  }
  async resumeBox(vmId: string): Promise<void> {
    throw new Error('CUADriver not yet implemented');
  }
  async createSnapshot(vmId: string, label?: string): Promise<SandboxSnapshot> {
    throw new Error('CUADriver not yet implemented');
  }
  async restoreSnapshot(vmId: string, snapshotId: string): Promise<void> {
    throw new Error('CUADriver not yet implemented');
  }
  async destroyBox(vmId: string): Promise<void> {
    throw new Error('CUADriver not yet implemented');
  }
  async getMetrics(vmId: string): Promise<{ cpuPercent: number; memoryMiB: number }> {
    throw new Error('CUADriver not yet implemented');
  }
}
