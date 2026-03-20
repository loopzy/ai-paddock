// Sandbox abstraction types

export type SandboxType = 'simple-box' | 'computer-box' | 'cua';

export interface SandboxConfig {
  name?: string;
  cpus?: number;
  memoryMiB?: number;
  diskSizeGB?: number;
  sandboxType: SandboxType;
}

export interface VMInfo {
  id: string;
  name: string;
  status: 'running' | 'stopped';
  created: Date;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxSnapshot {
  id: string;
  sessionId: string;
  seq: number;
  label?: string;
  createdAt: number;
  boxliteSnapshotId: string;
  sizeBytes?: number;
  containerDiskBytes?: number;
  consistencyMode?: 'live' | 'stopped';
}

/** Common interface all sandbox drivers must implement */
export interface SandboxDriver {
  createBox(config?: SandboxConfig): Promise<string>;
  getInfo(vmId: string): Promise<VMInfo | null>;
  exec(vmId: string, command: string): Promise<ExecResult>;
  copyIn(vmId: string, hostPath: string, vmPath: string): Promise<void>;
  copyOut(vmId: string, vmPath: string, hostPath: string): Promise<void>;
  createSnapshot(vmId: string, label?: string): Promise<SandboxSnapshot>;
  restoreSnapshot(vmId: string, snapshotId: string): Promise<void>;
  destroyBox(vmId: string): Promise<void>;
  getMetrics(vmId: string): Promise<{ cpuPercent: number; memoryMiB: number }>;
}
