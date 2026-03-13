import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventReporter } from '../reporter.js';
import { routeAgentCommand } from '../command-router.js';

function createReporter() {
  return {
    report: vi.fn(async () => undefined),
  } as unknown as EventReporter & { report: ReturnType<typeof vi.fn> };
}

describe('routeAgentCommand', () => {
  const tempPaths: string[] = [];

  afterEach(() => {
    while (tempPaths.length > 0) {
      const tempPath = tempPaths.pop();
      if (tempPath) rmSync(tempPath, { force: true });
    }
  });

  it('writes amp-command-file transports to JSONL', async () => {
    const commandFile = join(tmpdir(), `paddock-sidecar-command-${Date.now()}.jsonl`);
    tempPaths.push(commandFile);
    const reporter = createReporter();

    await routeAgentCommand({
      envelope: { command: 'hello sandbox', transport: 'amp-command-file' },
      commandFile,
      reporter,
    });

    expect(existsSync(commandFile)).toBe(true);
    const content = readFileSync(commandFile, 'utf8').trim();
    expect(JSON.parse(content).command).toBe('hello sandbox');
    expect(reporter.report).toHaveBeenCalledWith('amp.user.command', { command: 'hello sandbox' });
  });

  it('routes openclaw-gateway transports to the provided invoker', async () => {
    const commandFile = join(tmpdir(), `paddock-sidecar-command-${Date.now()}.jsonl`);
    tempPaths.push(commandFile);
    const reporter = createReporter();
    const gatewayInvoker = vi.fn(async () => ({ runId: 'paddock-run-1' }));

    await routeAgentCommand({
      envelope: {
        command: 'hello openclaw',
        transport: 'openclaw-gateway',
        sessionKey: 'paddock:test-session',
      },
      commandFile,
      reporter,
      gatewayInvoker,
    });

    expect(gatewayInvoker).toHaveBeenCalledWith({
      command: 'hello openclaw',
      transport: 'openclaw-gateway',
      sessionKey: 'paddock:test-session',
    });
    expect(existsSync(commandFile)).toBe(false);
    expect(reporter.report).toHaveBeenCalledWith('amp.user.command', { command: 'hello openclaw' });
  });

  it('fails clearly when openclaw-gateway transport is requested without an invoker', async () => {
    const commandFile = join(tmpdir(), `paddock-sidecar-command-${Date.now()}.jsonl`);
    tempPaths.push(commandFile);
    const reporter = createReporter();

    await expect(
      routeAgentCommand({
        envelope: {
          command: 'hello openclaw',
          transport: 'openclaw-gateway',
          sessionKey: 'paddock:test-session',
        },
        commandFile,
        reporter,
      }),
    ).rejects.toThrow('OpenClaw gateway transport is not configured');
  });
});
