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

  it('captures final assistant replies from before_message_write and deduplicates repeated hook emissions', async () => {
    const plugin = await loadPlugin();
    const api = createApi();
    plugin.register(api);

    const beforeMessageWrite = handlers.get('before_message_write');
    const messageSent = handlers.get('message_sent');

    expect(beforeMessageWrite).toBeTypeOf('function');
    expect(messageSent).toBeTypeOf('function');

    beforeMessageWrite?.(
      {
        message: { role: 'assistant', content: [{ type: 'text', text: '上海明天多云，18 到 24 度。' }] },
        sessionKey: 'paddock:test',
        agentId: 'main',
      },
      { sessionKey: 'paddock:test', agentId: 'main', runId: 'run-weather' },
    );

    await messageSent?.(
      {
        success: true,
        message: { role: 'assistant', content: [{ type: 'text', text: '上海明天多云，18 到 24 度。' }] },
      },
      { sessionKey: 'paddock:test', agentId: 'main', runId: 'run-weather' },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    const agentMessages = fetchMock.mock.calls
      .filter(([url]) => String(url).includes('/amp/event'))
      .map(([, init]) => JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')) as {
        toolName: string;
        result: string;
      })
      .filter((entry) => entry.toolName === 'amp.agent.message')
      .map((entry) => JSON.parse(entry.result) as Record<string, unknown>);

    expect(agentMessages).toEqual([
      expect.objectContaining({
        text: '上海明天多云，18 到 24 度。',
        runId: 'run-weather',
        agentId: 'main',
        sessionKey: 'paddock:test',
      }),
    ]);
  });

  it('captures the final assistant reply from agent_end when message hooks have no runId', async () => {
    const plugin = await loadPlugin();
    const api = createApi();
    plugin.register(api);

    const beforeMessageWrite = handlers.get('before_message_write');
    const messageSent = handlers.get('message_sent');
    const agentEnd = handlers.get('agent_end');

    expect(beforeMessageWrite).toBeTypeOf('function');
    expect(messageSent).toBeTypeOf('function');
    expect(agentEnd).toBeTypeOf('function');

    beforeMessageWrite?.(
      {
        message: { role: 'assistant', content: [{ type: 'text', text: '北京今天晴，最高 12 度。' }] },
        sessionKey: 'paddock:test',
        agentId: 'main',
      },
      { sessionKey: 'paddock:test', agentId: 'main' },
    );

    await messageSent?.(
      {
        success: true,
        message: { role: 'assistant', content: [{ type: 'text', text: '北京今天晴，最高 12 度。' }] },
      },
      { sessionKey: 'paddock:test', agentId: 'main' },
    );

    await agentEnd?.(
      {
        success: true,
        messages: [
          { role: 'user', content: [{ type: 'text', text: '今天天气怎么样' }] },
          { role: 'assistant', content: [{ type: 'text', text: '北京今天晴，最高 12 度。' }] },
        ],
      },
      { sessionKey: 'paddock:test', agentId: 'main', runId: 'run-weather-final' },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    const ampEventCalls = fetchMock.mock.calls
      .filter(([url]) => String(url).includes('/amp/event'))
      .map(([, init]) => JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')) as {
        toolName: string;
        result: string;
      });

    const agentMessages = ampEventCalls
      .filter((entry) => entry.toolName === 'amp.agent.message')
      .map((entry) => JSON.parse(entry.result) as Record<string, unknown>);
    const traceCalls = ampEventCalls
      .filter((entry) => entry.toolName === 'amp.trace')
      .map((entry) => JSON.parse(entry.result) as Record<string, unknown>);

    expect(agentMessages).toEqual([
      expect.objectContaining({
        text: '北京今天晴，最高 12 度。',
        runId: 'run-weather-final',
        agentId: 'main',
        sessionKey: 'paddock:test',
      }),
    ]);
    expect(traceCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: 'openclaw.agent_end',
          runId: 'run-weather-final',
          success: true,
        }),
      ]),
    );
  });

  it('reports native structured llm_input and llm_output events to AMP', async () => {
    const plugin = await loadPlugin();
    const api = createApi();
    plugin.register(api);

    const llmInput = handlers.get('llm_input');
    const llmOutput = handlers.get('llm_output');

    expect(llmInput).toBeTypeOf('function');
    expect(llmOutput).toBeTypeOf('function');

    await llmInput?.(
      {
        runId: 'run-llm-1',
        sessionId: 'oc-session-1',
        provider: 'openrouter',
        model: 'minimax/minimax-m2.7',
        systemPrompt: 'You are a careful sandboxed agent.',
        prompt: '请帮我总结一下今天的新闻',
        historyMessages: [
          { role: 'user', content: [{ type: 'text', text: '先记住我关注国际新闻。' }] },
          { role: 'assistant', content: [{ type: 'text', text: '好的，我会重点关注国际新闻。' }] },
        ],
        imagesCount: 1,
      },
      {
        sessionKey: 'paddock:test',
        agentId: 'main',
      },
    );

    await llmOutput?.(
      {
        runId: 'run-llm-1',
        sessionId: 'oc-session-1',
        provider: 'openrouter',
        model: 'minimax/minimax-m2.7',
        assistantTexts: ['这是今天的新闻摘要。'],
        lastAssistant: { role: 'assistant', content: [{ type: 'text', text: '这是今天的新闻摘要。' }] },
        usage: {
          input: 1234,
          output: 56,
          total: 1290,
        },
      },
      {
        sessionKey: 'paddock:test',
        agentId: 'main',
      },
    );

    const ampEventCalls = fetchMock.mock.calls
      .filter(([url]) => String(url).includes('/amp/event'))
      .map(([, init]) => JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')) as {
        toolName: string;
        result: string;
      });

    const llmRequest = ampEventCalls
      .filter((entry) => entry.toolName === 'amp.llm.request')
      .map((entry) => JSON.parse(entry.result) as Record<string, unknown>);
    const llmResponse = ampEventCalls
      .filter((entry) => entry.toolName === 'amp.llm.response')
      .map((entry) => JSON.parse(entry.result) as Record<string, unknown>);

    expect(llmRequest).toEqual([
      expect.objectContaining({
        source: 'openclaw-native-hook',
        provider: 'openrouter',
        model: 'minimax/minimax-m2.7',
        runId: 'run-llm-1',
        sessionId: 'oc-session-1',
        sessionKey: 'paddock:test',
        agentId: 'main',
        imagesCount: 1,
        messageCount: 4,
        messagesPreview: [
          { role: 'system', text: 'You are a careful sandboxed agent.' },
          { role: 'user', text: '先记住我关注国际新闻。' },
          { role: 'assistant', text: '好的，我会重点关注国际新闻。' },
          { role: 'user', text: '请帮我总结一下今天的新闻' },
        ],
        request: expect.objectContaining({
          systemPrompt: 'You are a careful sandboxed agent.',
          prompt: '请帮我总结一下今天的新闻',
        }),
      }),
    ]);

    expect(llmResponse).toEqual([
      expect.objectContaining({
        source: 'openclaw-native-hook',
        provider: 'openrouter',
        model: 'minimax/minimax-m2.7',
        runId: 'run-llm-1',
        sessionId: 'oc-session-1',
        sessionKey: 'paddock:test',
        agentId: 'main',
        tokensIn: 1234,
        tokensOut: 56,
        responseText: '这是今天的新闻摘要。',
        responsePreview: '这是今天的新闻摘要。',
        response: expect.objectContaining({
          assistantTexts: ['这是今天的新闻摘要。'],
        }),
      }),
    ]);
  });

  it('uses before_model_resolve to fetch host-side model overrides without exposing keys', async () => {
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/amp/control')) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              providerOverride: 'openrouter',
              modelOverride: 'qwen/qwen3.5-flash-02-23',
            }),
        };
      }
      return {
        ok: true,
        text: async () => JSON.stringify({ ok: true }),
      };
    });

    const plugin = await loadPlugin();
    const api = createApi();
    plugin.register(api);

    const beforeModelResolve = handlers.get('before_model_resolve');
    expect(beforeModelResolve).toBeTypeOf('function');

    const result = await beforeModelResolve?.(
      {
        provider: 'openrouter',
        model: 'minimax/minimax-m2.7',
      },
      {
        sessionKey: 'paddock:test',
        agentId: 'main',
        runId: 'run-llm-prepare',
      },
    );

    expect(result).toEqual({
      providerOverride: 'openrouter',
      modelOverride: 'qwen/qwen3.5-flash-02-23',
    });

    const controlCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/amp/control'));
    expect(controlCall).toBeTruthy();
    expect(JSON.parse(String((controlCall?.[1] as RequestInit | undefined)?.body ?? '{}'))).toEqual({
      toolName: 'llm_prepare',
      args: {
        provider: 'openrouter',
        model: 'minimax/minimax-m2.7',
        runId: 'run-llm-prepare',
        sessionKey: 'paddock:test',
        agentId: 'main',
      },
    });
  });

  it('normalizes shell-style write paths before reporting intent and continuing execution', async () => {
    const plugin = await loadPlugin();
    const api = createApi();
    plugin.register(api);

    const beforeToolCall = handlers.get('before_tool_call');
    expect(beforeToolCall).toBeTypeOf('function');

    const result = await beforeToolCall?.(
      {
        toolName: 'write',
        params: {
          path: ':> /workspace/paddock_probe/report.md',
          content: 'hello',
        },
      },
      {
        runId: 'run-write-normalize',
        toolCallId: 'tool-write-1',
        agentId: 'main',
        sessionKey: 'paddock:test',
      },
    );

    expect(result).toEqual({
      params: {
        path: '/workspace/paddock_probe/report.md',
        content: 'hello',
      },
    });

    const intentCall = fetchMock.mock.calls
      .filter(([url]) => String(url).includes('/amp/event'))
      .map(([, init]) => JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')) as {
        toolName: string;
        result: string;
      })
      .find((entry) => entry.toolName === 'amp.tool.intent');

    expect(intentCall).toBeTruthy();
    expect(JSON.parse(String(intentCall?.result))).toMatchObject({
      toolName: 'write',
      toolInput: {
        path: '/workspace/paddock_probe/report.md',
        content: 'hello',
      },
    });
  });

  it('normalizes contradictory exec redirection-plus-mkdir commands into mkdir -p', async () => {
    const plugin = await loadPlugin();
    const api = createApi();
    plugin.register(api);

    const beforeToolCall = handlers.get('before_tool_call');
    expect(beforeToolCall).toBeTypeOf('function');

    const result = await beforeToolCall?.(
      {
        toolName: 'exec',
        params: {
          command: ':> /workspace/paddock_probe && mkdir -p /workspace/paddock_probe',
        },
      },
      {
        runId: 'run-exec-normalize',
        toolCallId: 'tool-exec-1',
        agentId: 'main',
        sessionKey: 'paddock:test',
      },
    );

    expect(result).toEqual({
      params: {
        command: 'mkdir -p /workspace/paddock_probe',
      },
    });
  });
});
