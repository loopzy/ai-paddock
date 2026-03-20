import type { SandboxSnapshot } from '@paddock/types';

type SnapshotInfoLike = {
  id?: string;
  name?: string;
  createdAt?: number;
  sizeBytes?: number;
  containerDiskBytes?: number;
};

type NativeSnapshotHandle = {
  create: (name: string, options?: Record<string, never>) => Promise<SnapshotInfoLike>;
  restore: (name: string) => Promise<void>;
  remove?: (name: string) => Promise<void>;
  list?: () => Promise<SnapshotInfoLike[]>;
};

type RuntimeRemoveCapable = {
  remove?: (idOrName: string, force?: boolean) => Promise<void>;
  get?: (idOrName: string) => Promise<NativeBoxHandle | null | undefined>;
};

type NativeBoxHandle = {
  snapshot?: NativeSnapshotHandle;
  start?: () => Promise<void>;
  stop?: () => Promise<void>;
};

export type SnapshotCapableBox = {
  _ensureBox?: () => Promise<NativeBoxHandle>;
  _box?: NativeBoxHandle | null;
  _runtime?: RuntimeRemoveCapable;
  stop?: () => Promise<void>;
};

function normalizeCreatedAt(value: number | undefined): number {
  if (!value || Number.isNaN(value)) return Date.now();
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

export async function getNativeBoxHandle(box: SnapshotCapableBox): Promise<NativeBoxHandle> {
  if (typeof box._ensureBox === 'function') {
    return box._ensureBox();
  }
  if (box._box) {
    return box._box;
  }
  throw new Error('BoxLite native box handle is unavailable');
}

export async function getNativeSnapshotHandle(box: SnapshotCapableBox): Promise<NativeSnapshotHandle> {
  const nativeBox = await getNativeBoxHandle(box);
  if (!nativeBox.snapshot || typeof nativeBox.snapshot.create !== 'function' || typeof nativeBox.snapshot.restore !== 'function') {
    throw new Error('Installed BoxLite package does not expose snapshot APIs');
  }
  return nativeBox.snapshot;
}

export async function refreshNativeBoxHandle(box: SnapshotCapableBox, vmId: string): Promise<NativeBoxHandle> {
  if (typeof box._runtime?.get === 'function') {
    const refreshed = await box._runtime.get(vmId);
    if (refreshed) {
      box._box = refreshed;
      return refreshed;
    }
  }
  return getNativeBoxHandle(box);
}

export function buildSnapshotName(label?: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (!label) return `paddock-${suffix}`;
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return base ? `${base}-${suffix}` : `paddock-${suffix}`;
}

export function toSandboxSnapshot(
  vmId: string,
  snapshotName: string,
  label: string | undefined,
  info: SnapshotInfoLike,
  consistencyMode: 'live' | 'stopped' = 'live',
): SandboxSnapshot {
  return {
    id: info.id ?? snapshotName,
    sessionId: vmId,
    seq: 0,
    label,
    createdAt: normalizeCreatedAt(info.createdAt),
    boxliteSnapshotId: info.name ?? snapshotName,
    sizeBytes: typeof info.sizeBytes === 'number' ? info.sizeBytes : undefined,
    containerDiskBytes: typeof info.containerDiskBytes === 'number' ? info.containerDiskBytes : undefined,
    consistencyMode,
  };
}

export async function removeBoxRuntime(box: SnapshotCapableBox, vmId: string): Promise<void> {
  if (typeof box._runtime?.remove === 'function') {
    await box._runtime.remove(vmId, true);
  }
}
