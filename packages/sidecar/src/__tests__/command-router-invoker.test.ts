import { afterEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.fn(
  (
    file: string,
    args: string[],
    options: Record<string, unknown>,
    callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
  ) => {
    if (args.includes('chat.send')) {
      callback(null, {
        stdout: JSON.stringify({ runId: 'paddock-run-1', status: 'started' }),
        stderr: '',
      });
      return;
    }

    callback(null, { stdout: '', stderr: '' });
  },
);

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

describe('createOpenClawGatewayInvoker', () => {
  afterEach(() => {
    execFileMock.mockClear();
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_CONFIG_PATH;
    delete process.env.PADDOCK_OPENCLAW_GATEWAY_PORT;
  });

  it('uses chat.send with the workspace-scoped OpenClaw config env and returns the started run id', async () => {
    const { createOpenClawGatewayInvoker } = await import('../command-router.js');
    const invoke = createOpenClawGatewayInvoker();

    const result = await invoke({
      command: 'hello from dashboard',
      transport: 'openclaw-gateway',
      sessionKey: 'paddock:test-session',
    });
    expect(result).toEqual({ runId: 'paddock-run-1' });

    expect(execFileMock).toHaveBeenCalledTimes(1);

    const [, sendArgs, sendOptions] = execFileMock.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(sendArgs).toContain('chat.send');
    const sendParamsIndex = sendArgs.indexOf('--params');
    expect(sendParamsIndex).toBeGreaterThan(-1);
    const sendPayload = JSON.parse(sendArgs[sendParamsIndex + 1] ?? '{}');
    expect(sendPayload).toEqual(
      expect.objectContaining({
        sessionKey: 'paddock:test-session',
        message: 'hello from dashboard',
      }),
    );
    expect(String(sendPayload.idempotencyKey ?? '')).toContain('paddock-');
    expect(sendOptions.env.OPENCLAW_STATE_DIR).toBe('/workspace/.openclaw');
    expect(sendOptions.env.OPENCLAW_CONFIG_PATH).toBe('/workspace/.openclaw/openclaw.json');
    expect(sendOptions.env.OPENCLAW_GATEWAY_PORT).toBe('18789');
  });
});
