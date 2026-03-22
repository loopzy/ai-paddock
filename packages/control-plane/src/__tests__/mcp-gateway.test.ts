import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const gatewayMocks = vi.hoisted(() => {
  const execFileCalls: Array<{ file: string; args: string[] }> = [];
  const spawnCalls: Array<{ file: string; args: string[]; stdin: string }> = [];

  const execFileMockBase = vi.fn((file: string, args: string[] | undefined, callback?: (...cbArgs: unknown[]) => void) => {
    const normalizedArgs = Array.isArray(args) ? args : [];
    execFileCalls.push({ file, args: normalizedArgs });
    callback?.(null, '', '');
  });

  (
    execFileMockBase as typeof execFileMockBase & {
      [key: symbol]: unknown;
    }
  )[Symbol.for('nodejs.util.promisify.custom')] = (
    file: string,
    args?: string[],
  ) => {
    const normalizedArgs = Array.isArray(args) ? args : [];
    execFileCalls.push({ file, args: normalizedArgs });
    return Promise.resolve({ stdout: '', stderr: '' });
  };

  const spawnMock = vi.fn((file: string, args: string[] = []) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let stdin = '';

    const listeners = new Map<string, Set<(...eventArgs: unknown[]) => void>>();
    const child = {
      stdout,
      stderr,
      stdin: new Writable({
        write(chunk, _encoding, callback) {
          stdin += chunk.toString();
          callback();
        },
        final(callback) {
          spawnCalls.push({ file, args, stdin });
          callback();
          setImmediate(() => {
            child.emit('close', 0);
          });
        },
      }),
      on(event: string, handler: (...eventArgs: unknown[]) => void) {
        const bucket = listeners.get(event) ?? new Set();
        bucket.add(handler);
        listeners.set(event, bucket);
        return this;
      },
      emit(event: string, ...eventArgs: unknown[]) {
        for (const handler of listeners.get(event) ?? []) {
          handler(...eventArgs);
        }
      },
    };

    return child;
  });

  return {
    execFileCalls,
    spawnCalls,
    execFileMockBase,
    spawnMock,
  };
});

vi.mock('node:child_process', () => ({
  execFile: gatewayMocks.execFileMockBase,
  spawn: gatewayMocks.spawnMock,
}));

import { MCPGateway } from '../mcp/gateway.js';

describe('MCPGateway', () => {
  afterEach(() => {
    gatewayMocks.execFileCalls.length = 0;
    gatewayMocks.spawnCalls.length = 0;
    gatewayMocks.execFileMockBase.mockClear();
    gatewayMocks.spawnMock.mockClear();
  });

  it('passes browser URLs as execFile arguments instead of shell strings', async () => {
    const gateway = new MCPGateway();
    const maliciousUrl = '"; rm -rf / #';

    const result = await gateway.callTool('browser.open', { url: maliciousUrl });

    expect(result).toEqual({ exitCode: 0 });
    expect(gatewayMocks.execFileCalls).toEqual([
      {
        file: 'open',
        args: [maliciousUrl],
      },
    ]);
  });

  it('writes clipboard text through stdin instead of shell interpolation', async () => {
    const gateway = new MCPGateway();
    const maliciousText = '"; rm -rf / #';

    const result = await gateway.callTool('clipboard.write', { text: maliciousText });

    expect(result).toEqual({ exitCode: 0 });
    expect(gatewayMocks.spawnCalls).toEqual([
      {
        file: 'pbcopy',
        args: [],
        stdin: maliciousText,
      },
    ]);
  });

  it('passes applescript source as an osascript argument instead of a shell fragment', async () => {
    const gateway = new MCPGateway();
    const maliciousScript = 'display dialog "ok"\n do shell script "rm -rf /"';

    const result = await gateway.callTool('applescript.run', { script: maliciousScript });

    expect(result).toEqual({ stdout: '', stderr: '', exitCode: 0 });
    expect(gatewayMocks.execFileCalls).toEqual([
      {
        file: 'osascript',
        args: ['-e', maliciousScript],
      },
    ]);
  });

  it('passes speech text and voice as execFile arguments', async () => {
    const gateway = new MCPGateway();

    const result = await gateway.callTool('tts.speak', {
      text: 'hello"; rm -rf / #',
      voice: 'Samantha',
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(gatewayMocks.execFileCalls).toEqual([
      {
        file: 'say',
        args: ['-v', 'Samantha', 'hello"; rm -rf / #'],
      },
    ]);
  });
});
