import type { SandboxType } from '@paddock/types';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..', '..');

type RootfsSandboxType = Extract<SandboxType, 'simple-box' | 'computer-box'>;

type SandboxRootfsConfig = {
  label: string;
  image: string;
  rootfsEnv: string;
  rootfsPath: string;
  prepareScript: string;
};

type SandboxRootfsFeatures = {
  browserRuntime?: boolean;
};

const ROOTFS_FEATURES_FILE = 'paddock-rootfs-features.json';

export const SIMPLE_BOX_IMAGE = 'ubuntu:22.04';
export const SIMPLE_BOX_ROOTFS_ENV = 'PADDOCK_SIMPLEBOX_ROOTFS';
export const SIMPLE_BOX_ROOTFS_PATH = resolve(PROJECT_ROOT, 'dist', 'simplebox-rootfs', 'ubuntu-22.04');

export const COMPUTER_BOX_IMAGE = 'lscr.io/linuxserver/webtop:ubuntu-xfce';
export const COMPUTER_BOX_ROOTFS_ENV = 'PADDOCK_COMPUTERBOX_ROOTFS';
export const COMPUTER_BOX_ROOTFS_PATH = resolve(PROJECT_ROOT, 'dist', 'computerbox-rootfs', 'ubuntu-xfce');

const ROOTFS_CONFIG: Record<RootfsSandboxType, SandboxRootfsConfig> = {
  'simple-box': {
    label: 'SimpleBox',
    image: SIMPLE_BOX_IMAGE,
    rootfsEnv: SIMPLE_BOX_ROOTFS_ENV,
    rootfsPath: SIMPLE_BOX_ROOTFS_PATH,
    prepareScript: 'prepare:simplebox-rootfs',
  },
  'computer-box': {
    label: 'ComputerBox',
    image: COMPUTER_BOX_IMAGE,
    rootfsEnv: COMPUTER_BOX_ROOTFS_ENV,
    rootfsPath: COMPUTER_BOX_ROOTFS_PATH,
    prepareScript: 'prepare:computerbox-rootfs',
  },
};

function isRootfsSandboxType(sandboxType: SandboxType): sandboxType is RootfsSandboxType {
  return sandboxType === 'simple-box' || sandboxType === 'computer-box';
}

function hasOciLayout(rootfsPath: string): boolean {
  return existsSync(resolve(rootfsPath, 'oci-layout')) && existsSync(resolve(rootfsPath, 'index.json'));
}

function readSandboxRootfsFeatures(rootfsPath: string): SandboxRootfsFeatures | undefined {
  try {
    const raw = readFileSync(resolve(rootfsPath, ROOTFS_FEATURES_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed as SandboxRootfsFeatures : undefined;
  } catch {
    return undefined;
  }
}

function getRootfsConfig(sandboxType: RootfsSandboxType): SandboxRootfsConfig {
  return ROOTFS_CONFIG[sandboxType];
}

export function getSandboxImageName(sandboxType: SandboxType): string {
  if (!isRootfsSandboxType(sandboxType)) return sandboxType;
  return getRootfsConfig(sandboxType).image;
}

export function getSandboxRootfsPath(sandboxType: RootfsSandboxType): string {
  return getRootfsConfig(sandboxType).rootfsPath;
}

export function resolveSandboxRootfsPath(sandboxType: RootfsSandboxType): string | undefined {
  const config = getRootfsConfig(sandboxType);
  const configuredPath = process.env[config.rootfsEnv]?.trim();
  if (configuredPath) {
    return hasOciLayout(configuredPath) ? configuredPath : undefined;
  }

  return hasOciLayout(config.rootfsPath) ? config.rootfsPath : undefined;
}

export function getSandboxRootfsOverride(sandboxType: RootfsSandboxType): { rootfsPath: string } | Record<string, never> {
  const rootfsPath = resolveSandboxRootfsPath(sandboxType);
  return rootfsPath ? { rootfsPath } : {};
}

export function getSandboxStartupMessage(sandboxType: SandboxType): string {
  if (!isRootfsSandboxType(sandboxType)) {
    return `Preparing sandbox ${sandboxType}...`;
  }

  const config = getRootfsConfig(sandboxType);
  const rootfsPath = resolveSandboxRootfsPath(sandboxType);
  if (rootfsPath) {
    const features = readSandboxRootfsFeatures(rootfsPath);
    const suffix = features?.browserRuntime ? ' (browser runtime preloaded)' : '';
    return `Using local ${config.label} rootfs: ${rootfsPath}${suffix}`;
  }

  return `Pulling image ${config.image} (first time may take a few minutes). To prepare ${config.label} offline: docker pull ${config.image} && pnpm run ${config.prepareScript}`;
}
