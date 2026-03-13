import { describe, it, expect } from 'vitest';
import { createSandbox } from '../sandbox/factory.js';
import { SimpleBoxDriver } from '../sandbox/simple-box-driver.js';
import { ComputerBoxDriver } from '../sandbox/computer-box-driver.js';
import { CUADriver } from '../sandbox/cua-driver.js';

describe('SandboxFactory', () => {
  it('should create SimpleBoxDriver for simple-box', () => {
    const driver = createSandbox('simple-box');
    expect(driver).toBeInstanceOf(SimpleBoxDriver);
  });

  it('should create ComputerBoxDriver for computer-box', () => {
    const driver = createSandbox('computer-box');
    expect(driver).toBeInstanceOf(ComputerBoxDriver);
  });

  it('should create CUADriver for cua', () => {
    const driver = createSandbox('cua');
    expect(driver).toBeInstanceOf(CUADriver);
  });

  it('should throw for unknown sandbox type', () => {
    expect(() => createSandbox('unknown' as any)).toThrow('Unknown sandbox type');
  });
});
