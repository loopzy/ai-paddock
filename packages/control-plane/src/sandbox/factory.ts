import type { SandboxType, SandboxDriver } from '@paddock/types';
import { SimpleBoxDriver } from './simple-box-driver.js';
import { ComputerBoxDriver } from './computer-box-driver.js';
import { CUADriver } from './cua-driver.js';

/**
 * Factory function to create the appropriate sandbox driver.
 */
export function createSandbox(type: SandboxType): SandboxDriver {
  switch (type) {
    case 'simple-box':
      return new SimpleBoxDriver();
    case 'computer-box':
      return new ComputerBoxDriver();
    case 'cua':
      return new CUADriver();
    default:
      throw new Error(`Unknown sandbox type: ${type}`);
  }
}
