export {
  SIMPLE_BOX_IMAGE,
  SIMPLE_BOX_ROOTFS_ENV,
  SIMPLE_BOX_ROOTFS_PATH,
} from './sandbox-rootfs.js';

import { getSandboxImageName, getSandboxRootfsOverride, getSandboxStartupMessage, resolveSandboxRootfsPath } from './sandbox-rootfs.js';

export function resolveSimpleBoxRootfsPath(): string | undefined {
  return resolveSandboxRootfsPath('simple-box');
}

export function getSimpleBoxImageSource(): { image: string } | { rootfsPath: string } {
  const override = getSandboxRootfsOverride('simple-box');
  return 'rootfsPath' in override ? { rootfsPath: override.rootfsPath } : { image: getSandboxImageName('simple-box') };
}

export function getSimpleBoxStartupMessage(): string {
  return getSandboxStartupMessage('simple-box');
}
