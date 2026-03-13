import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  COMPUTER_BOX_IMAGE,
  COMPUTER_BOX_ROOTFS_ENV,
  SIMPLE_BOX_IMAGE,
  SIMPLE_BOX_ROOTFS_ENV,
  getSandboxImageName,
  getSandboxRootfsOverride,
  getSandboxStartupMessage,
} from '../sandbox/sandbox-rootfs.js';

const originalSimpleRootfsEnv = process.env[SIMPLE_BOX_ROOTFS_ENV];
const originalComputerRootfsEnv = process.env[COMPUTER_BOX_ROOTFS_ENV];

function createOciLayoutDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'paddock-rootfs-'));
  writeFileSync(join(dir, 'oci-layout'), '{"imageLayoutVersion":"1.0.0"}\n');
  writeFileSync(join(dir, 'index.json'), '{"schemaVersion":2,"manifests":[]}\n');
  mkdirSync(join(dir, 'blobs', 'sha256'), { recursive: true });
  return dir;
}

afterEach(() => {
  if (originalSimpleRootfsEnv === undefined) delete process.env[SIMPLE_BOX_ROOTFS_ENV];
  else process.env[SIMPLE_BOX_ROOTFS_ENV] = originalSimpleRootfsEnv;

  if (originalComputerRootfsEnv === undefined) delete process.env[COMPUTER_BOX_ROOTFS_ENV];
  else process.env[COMPUTER_BOX_ROOTFS_ENV] = originalComputerRootfsEnv;
});

describe('sandbox-rootfs', () => {
  it('prefers the configured SimpleBox OCI layout when present', () => {
    const rootfsDir = createOciLayoutDir();
    process.env[SIMPLE_BOX_ROOTFS_ENV] = rootfsDir;

    try {
      expect(getSandboxRootfsOverride('simple-box')).toEqual({ rootfsPath: rootfsDir });
      expect(getSandboxStartupMessage('simple-box')).toContain(rootfsDir);
    } finally {
      rmSync(rootfsDir, { recursive: true, force: true });
    }
  });

  it('prefers the configured ComputerBox OCI layout when present', () => {
    const rootfsDir = createOciLayoutDir();
    process.env[COMPUTER_BOX_ROOTFS_ENV] = rootfsDir;

    try {
      expect(getSandboxRootfsOverride('computer-box')).toEqual({ rootfsPath: rootfsDir });
      expect(getSandboxStartupMessage('computer-box')).toContain(rootfsDir);
    } finally {
      rmSync(rootfsDir, { recursive: true, force: true });
    }
  });

  it('advertises the correct image names for local sandbox preparation', () => {
    delete process.env[SIMPLE_BOX_ROOTFS_ENV];
    delete process.env[COMPUTER_BOX_ROOTFS_ENV];

    expect(getSandboxImageName('simple-box')).toBe(SIMPLE_BOX_IMAGE);
    expect(getSandboxImageName('computer-box')).toBe(COMPUTER_BOX_IMAGE);
  });

  it('mentions preloaded browser runtime when the local rootfs metadata declares it', () => {
    const rootfsDir = createOciLayoutDir();
    process.env[SIMPLE_BOX_ROOTFS_ENV] = rootfsDir;
    writeFileSync(join(rootfsDir, 'paddock-rootfs-features.json'), JSON.stringify({ browserRuntime: true }));

    try {
      expect(getSandboxStartupMessage('simple-box')).toContain('browser runtime preloaded');
    } finally {
      rmSync(rootfsDir, { recursive: true, force: true });
    }
  });
});
