import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type HookHandler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown> | unknown;

describe('paddock-amp-plugin', () => {
  const fetchMock = vi.fn();
  const handlers = new Map<string, HookHandler>();

  beforeEach(() => {
    handlers.clear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ ok: true }),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function createApi() {
    return {
      pluginConfig: {
        sidecarUrl: 'http://127.0.0.1:8801',
        workspaceRoot: '/workspace',
        logFile: '/tmp/openclaw/paddock-amp-plugin.test.log',
      },
      logger: {
        info: vi.fn(),
      },
      on: vi.fn((hookName: string, handler: HookHandler) => {
        handlers.set(hookName, handler);
      }),
    };
  }

  async function loadPlugin() {
    const module = await import('../../deployers/openclaw/paddock-amp-plugin/index.js');
    return module.default;
  }

  it('reports OpenClaw session and subagent lifecycle hooks to AMP', async () => {
    const plugin = await loadPlugin();
    const api = createApi();
    plugin.register(api);

    const sessionStart = handlers.get('session_start');
    const subagentSpawning = handlers.get('subagent_spawning');
    const subagentSpawned = handlers.get('subagent_spawned');
    const subagentEnded = handlers.get('subagent_ended');
    const sessionEnd = handlers.get('session_end');

    expect(sessionStart).toBeTypeOf('function');
    expect(subagentSpawning).toBeTypeOf('function');
    expect(subagentSpawned).toBeTypeOf('function');
    expect(subagentEnded).toBeTypeOf('function');
    expect(sessionEnd).toBeTypeOf('function');

    await sessionStart?.(
      { sessionKey: 'paddock:test', agentId: 'main' },
      { sessionKey: 'paddock:test', agentId: 'main' },
    );
    await subagentSpawning?.(
      { runtime: 'subagent', targetAgentId: 'researcher' },
      { sessionKey: 'paddock:test', agentId: 'main', runId: 'run-1' },
    );
    await subagentSpawned?.(
      { childSessionKey: 'paddock:test:child', runtime: 'subagent' },
      { sessionKey: 'paddock:test', agentId: 'main', runId: 'run-1' },
    );
    await subagentEnded?.(
      { childSessionKey: 'paddock:test:child', status: 'ok' },
      { sessionKey: 'paddock:test', agentId: 'main', runId: 'run-1' },
    );
    await sessionEnd?.(
      { sessionKey: 'paddock:test', reason: 'completed' },
      { sessionKey: 'paddock:test', agentId: 'main' },
    );

    const ampEventCalls = fetchMock.mock.calls
      .filter(([url]) => String(url).includes('/amp/event'))
      .map(([, init]) => JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')) as {
        toolName: string;
        result: string;
      });

    expect(ampEventCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolName: 'amp.session.start' }),
        expect.objectContaining({ toolName: 'amp.session.end' }),
      ]),
    );

    const lifecyclePayloads = ampEventCalls.map((entry) => ({
      type: entry.toolName,
      payload: JSON.parse(entry.result) as Record<string, unknown>,
    }));

    expect(lifecyclePayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'amp.session.start',
          payload: expect.objectContaining({
            phase: 'openclaw.session_start',
            sessionKey: 'paddock:test',
          }),
        }),
        expect.objectContaining({
          type: 'amp.session.start',
          payload: expect.objectContaining({
            phase: 'openclaw.subagent_spawning',
            runId: 'run-1',
          }),
        }),
        expect.objectContaining({
          type: 'amp.session.start',
          payload: expect.objectContaining({
            phase: 'openclaw.subagent_spawned',
            childSessionKey: 'paddock:test:child',
          }),
        }),
        expect.objectContaining({
          type: 'amp.session.end',
          payload: expect.objectContaining({
            phase: 'openclaw.subagent_ended',
            childSessionKey: 'paddock:test:child',
          }),
        }),
        expect.objectContaining({
          type: 'amp.session.end',
          payload: expect.objectContaining({
            phase: 'openclaw.session_end',
            reason: 'completed',
          }),
        }),
      ]),
    );
  });

  it('reports reset, message, gateway, transcript hooks, and assistant replies', async () => {
    const plugin = await loadPlugin();
    const api = createApi();
    plugin.register(api);

    const beforeReset = handlers.get('before_reset');
    const messageReceived = handlers.get('message_received');
    const messageSending = handlers.get('message_sending');
    const messageSent = handlers.get('message_sent');
    const subagentDeliveryTarget = handlers.get('subagent_delivery_target');
    const gatewayStart = handlers.get('gateway_start');
    const gatewayStop = handlers.get('gateway_stop');
    const toolResultPersist = handlers.get('tool_result_persist');
    const beforeMessageWrite = handlers.get('before_message_write');

    expect(beforeReset).toBeTypeOf('function');
    expect(messageReceived).toBeTypeOf('function');
    expect(messageSending).toBeTypeOf('function');
    expect(messageSent).toBeTypeOf('function');
    expect(subagentDeliveryTarget).toBeTypeOf('function');
    expect(gatewayStart).toBeTypeOf('function');
    expect(gatewayStop).toBeTypeOf('function');
    expect(toolResultPersist).toBeTypeOf('function');
    expect(beforeMessageWrite).toBeTypeOf('function');

    await beforeReset?.(
      { reason: 'reset', sessionFile: '/workspace/.openclaw/session.jsonl' },
      { sessionKey: 'paddock:test', agentId: 'main', runId: 'run-reset' },
    );
    await messageReceived?.(
      { from: 'user', content: 'hello paddock' },
      { channelId: 'internal', accountId: 'acct-1' },
    );
    await messageSending?.(
      { to: 'user', content: 'working on it' },
      { channelId: 'internal', accountId: 'acct-1' },
    );
    await messageSent?.(
      {
        to: 'user',
        content: 'done',
        success: true,
        message: { role: 'assistant', content: [{ type: 'text', text: '明天有 4 场 NBA 比赛。' }] },
      },
      { channelId: 'internal', accountId: 'acct-1', runId: 'run-msg', agentId: 'main', sessionKey: 'paddock:test' },
    );
    await subagentDeliveryTarget?.(
      { childSessionKey: 'child-1', requesterSessionKey: 'paddock:test', expectsCompletionMessage: true },
      { childSessionKey: 'child-1', requesterSessionKey: 'paddock:test', runId: 'run-child' },
    );
    await gatewayStart?.({ port: 18789 }, { port: 18789 });
    await gatewayStop?.({ reason: 'shutdown' }, { port: 18789 });
    toolResultPersist?.(
      {
        toolName: 'web_fetch',
        toolCallId: 'tool-1',
        isSynthetic: false,
        message: { role: 'tool', content: [{ type: 'text', text: 'ok' }] },
      },
      { sessionKey: 'paddock:test', agentId: 'main', toolName: 'web_fetch', toolCallId: 'tool-1' },
    );
    beforeMessageWrite?.(
      {
        message: { role: 'assistant', content: [{ type: 'text', text: 'trace me' }] },
        sessionKey: 'paddock:test',
        agentId: 'main',
      },
      { sessionKey: 'paddock:test', agentId: 'main' },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    const ampEventCalls = fetchMock.mock.calls
      .filter(([url]) => String(url).includes('/amp/event'))
      .map(([, init]) => JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')) as {
        toolName: string;
        result: string;
      });
    const traceCalls = ampEventCalls
      .filter((entry) => entry.toolName === 'amp.trace')
      .map((entry) => JSON.parse(entry.result) as Record<string, unknown>);
    const agentMessages = ampEventCalls
      .filter((entry) => entry.toolName === 'amp.agent.message')
      .map((entry) => JSON.parse(entry.result) as Record<string, unknown>);

    expect(traceCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'openclaw.before_reset', reason: 'reset' }),
        expect.objectContaining({ phase: 'openclaw.message_received', content: 'hello paddock' }),
        expect.objectContaining({ phase: 'openclaw.message_sending', content: 'working on it' }),
        expect.objectContaining({ phase: 'openclaw.message_sent', content: 'done', success: true }),
        expect.objectContaining({ phase: 'openclaw.subagent_delivery_target', childSessionKey: 'child-1' }),
        expect.objectContaining({ phase: 'openclaw.gateway_start', port: 18789 }),
        expect.objectContaining({ phase: 'openclaw.gateway_stop', reason: 'shutdown' }),
        expect.objectContaining({ phase: 'openclaw.tool_result_persist', toolName: 'web_fetch' }),
        expect.objectContaining({
          phase: 'openclaw.before_message_write',
          message: expect.objectContaining({ role: 'assistant' }),
        }),
      ]),
    );
    expect(agentMessages).toEqual([
      expect.objectContaining({
        text: '明天有 4 场 NBA 比赛。',
        success: true,
        runId: 'run-msg',
        agentId: 'main',
        sessionKey: 'paddock:test',
      }),
    ]);
  });
});
