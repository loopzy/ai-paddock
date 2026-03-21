import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { afterEach, describe, expect, it } from 'vitest';
import { EventStore } from '../events/event-store.js';
import { SessionManager } from '../session/session-manager.js';
import { SnapshotManager } from '../snapshot/snapshot-manager.js';
import { HITLArbiter } from '../hitl/arbiter.js';
import { MCPGateway } from '../mcp/gateway.js';
import { LLMRelay } from '../mcp/llm-relay.js';
import { ResourceGateway } from '../boundary/resource-gateway.js';
import { LLMConfigStore } from '../config/llm-config-store.js';
import { registerRoutes } from '../api/routes.js';
import type { ExecResult, SandboxConfig, SandboxDriver, SandboxSnapshot, VMInfo } from '@paddock/types';

type DriverCall = { method: string; args: unknown[] };
type ExecHook = (command: string) => ExecResult | undefined | Promise<ExecResult | undefined>;

function createMockDriver(execHook?: ExecHook): SandboxDriver & { calls: DriverCall[] } {
  const calls: DriverCall[] = [];

  return {
    calls,
    async createBox(config?: SandboxConfig) {
      calls.push({ method: 'createBox', args: [config] });
      return 'vm-route-test';
    },
    async getInfo(vmId: string): Promise<VMInfo | null> {
      calls.push({ method: 'getInfo', args: [vmId] });
      return { id: vmId, name: 'mock', status: 'running', created: new Date() };
    },
    async exec(vmId: string, command: string): Promise<ExecResult> {
      calls.push({ method: 'exec', args: [vmId, command] });
      const custom = execHook ? await execHook(command) : undefined;
      if (custom) return custom;

      if (command.includes('command -v node')) {
        return { stdout: '/usr/bin/node\n', stderr: '', exitCode: 0 };
      }
      if (command.includes('/amp/command')) {
        return { stdout: '{"ok":true}', stderr: '', exitCode: 0 };
      }

      return { stdout: '', stderr: '', exitCode: 0 };
    },
    async copyIn(vmId: string, hostPath: string, vmPath: string) {
      calls.push({ method: 'copyIn', args: [vmId, hostPath, vmPath] });
    },
    async copyOut(vmId: string, vmPath: string, hostPath: string) {
      calls.push({ method: 'copyOut', args: [vmId, vmPath, hostPath] });
    },
    async createSnapshot(vmId: string, label?: string): Promise<SandboxSnapshot> {
      calls.push({ method: 'createSnapshot', args: [vmId, label] });
      return { id: 'snap-1', sessionId: vmId, seq: 1, label, createdAt: Date.now(), boxliteSnapshotId: 'box-snap-1' };
    },
    async restoreSnapshot(vmId: string, snapshotId: string) {
      calls.push({ method: 'restoreSnapshot', args: [vmId, snapshotId] });
    },
    async destroyBox(vmId: string) {
      calls.push({ method: 'destroyBox', args: [vmId] });
    },
    async getMetrics(vmId: string) {
      calls.push({ method: 'getMetrics', args: [vmId] });
      return { cpuPercent: 5, memoryMiB: 128 };
    },
  };
}

async function waitFor<T>(check: () => T | undefined, timeoutMs = 1500): Promise<T> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const value = check();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Timed out waiting after ${timeoutMs}ms`);
}

async function openSessionSocket(app: FastifyInstance, sessionId: string) {
  return app.injectWS(`/ws/sessions/${sessionId}`);
}

function closeSessionSocket(socket: { terminate?: () => void; close?: () => void } | null) {
  socket?.terminate?.();
  socket?.close?.();
}

async function createRouteTestContext(execHook?: ExecHook) {
  process.env.PADDOCK_AGENT_BOOT_DELAY_MS = '0';
  process.env.PADDOCK_SIDECAR_BOOT_DELAY_MS = '0';

  const eventStore = new EventStore(':memory:');
  const driver = createMockDriver(execHook);
  const sessionManager = new SessionManager(eventStore, driver, eventStore.db);
  const snapshotManager = new SnapshotManager(eventStore.db);
  const hitlArbiter = new HITLArbiter(eventStore);
  const mcpGateway = new MCPGateway();
  const llmConfigStore = new LLMConfigStore(eventStore.db);
  const llmRelay = new LLMRelay(llmConfigStore);
  const resourceGateway = new ResourceGateway(llmRelay, mcpGateway, hitlArbiter, eventStore);
  const app = Fastify({ logger: false });

  await app.register(websocket);
  registerRoutes(app, {
    eventStore,
    sessionManager,
    snapshotManager,
    sandboxDriver: driver,
    hitlArbiter,
    mcpGateway,
    llmRelay,
    resourceGateway,
    llmConfigStore,
  });
  await app.ready();

  return {
    app,
    driver,
    eventStore,
    sessionManager,
  };
}

async function createRunningSession(ctx: Awaited<ReturnType<typeof createRouteTestContext>>) {
  const session = await ctx.sessionManager.create('none');
  await ctx.sessionManager.start(session.id);
  return session;
}

describe('Control Plane user journeys', () => {
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const originalAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const originalFetch = global.fetch;

  afterEach(() => {
    if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    if (originalAnthropicAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = originalAnthropicAuthToken;
    if (originalAnthropicBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = originalAnthropicBaseUrl;
    if (originalOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
    global.fetch = originalFetch;
  });

  it('exposes provider presets and default agent config through /api/health', async () => {
    process.env.OPENROUTER_API_KEY = 'or-test';
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;

    const ctx = await createRouteTestContext();

    try {
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/api/health',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.agentDefaults).toEqual({
        provider: 'openrouter',
        model: 'moonshotai/kimi-k2',
      });
      expect(body.llmCatalog.providers.some((provider: any) => provider.id === 'openrouter' && provider.configured === true)).toBe(true);
      expect(body.llmCatalog.providers.some((provider: any) => provider.id === 'anthropic' && provider.configured === false)).toBe(true);
    } finally {
      await ctx.app.close();
      ctx.eventStore.close();
    }
  });

  it('persists dashboard model overrides and reuses them as agent defaults', async () => {
    const ctx = await createRouteTestContext();

    try {
      const createResponse = await ctx.app.inject({
        method: 'POST',
        url: '/api/llm-config',
        payload: {
          provider: 'openrouter',
          apiKey: 'or-test',
          baseUrl: 'https://openrouter.ai/api/v1',
          model: 'deepseek/deepseek-chat',
        },
      });

      expect(createResponse.statusCode).toBe(200);

      const updateResponse = await ctx.app.inject({
        method: 'POST',
        url: '/api/llm-config',
        payload: {
          provider: 'openrouter',
          model: 'moonshotai/kimi-k2',
        },
      });

      expect(updateResponse.statusCode).toBe(200);

      const listResponse = await ctx.app.inject({
        method: 'GET',
        url: '/api/llm-config',
      });
      expect(listResponse.statusCode).toBe(200);
      expect(listResponse.json().providers).toEqual([
        expect.objectContaining({
          provider: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          model: 'moonshotai/kimi-k2',
        }),
      ]);

      const healthResponse = await ctx.app.inject({
        method: 'GET',
        url: '/api/health',
      });
      expect(healthResponse.statusCode).toBe(200);
      expect(healthResponse.json().agentDefaults).toEqual({
        provider: 'openrouter',
        model: 'moonshotai/kimi-k2',
      });
    } finally {
      await ctx.app.close();
      ctx.eventStore.close();
    }
  });

  it('applies updated dashboard API keys to llm relay requests without restarting the app', async () => {
    const ctx = await createRouteTestContext();
    const seenAuthHeaders: string[] = [];
    const seenModels: string[] = [];
    const originalFetch = global.fetch;

    global.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      seenAuthHeaders.push(headers?.authorization ?? '');
      const parsed = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
      seenModels.push(parsed.model ?? '');
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const createResponse = await ctx.app.inject({
        method: 'POST',
        url: '/api/llm-config',
        payload: {
          provider: 'openrouter',
          apiKey: 'first-key',
          model: 'moonshotai/kimi-k2',
        },
      });
      expect(createResponse.statusCode).toBe(200);

      const firstRelayResponse = await ctx.app.inject({
        method: 'POST',
        url: '/api/llm/proxy',
        payload: {
          provider: 'openrouter',
          method: 'POST',
          path: '/chat/completions',
          headers: { 'content-type': 'application/json' },
          body: '{"model":"moonshotai/kimi-k2","messages":[]}',
        },
      });
      expect(firstRelayResponse.statusCode).toBe(200);

      const updateResponse = await ctx.app.inject({
        method: 'POST',
        url: '/api/llm-config',
        payload: {
          provider: 'openrouter',
          apiKey: 'second-key',
          model: 'qwen/qwen3.5-flash-02-23',
        },
      });
      expect(updateResponse.statusCode).toBe(200);

      const secondRelayResponse = await ctx.app.inject({
        method: 'POST',
        url: '/api/llm/proxy',
        payload: {
          provider: 'openrouter',
          method: 'POST',
          path: '/chat/completions',
          headers: { 'content-type': 'application/json' },
          body: '{"model":"moonshotai/kimi-k2","messages":[]}',
        },
      });
      expect(secondRelayResponse.statusCode).toBe(200);

      expect(seenAuthHeaders).toEqual([
        'Bearer first-key',
        'Bearer second-key',
      ]);
      expect(seenModels).toEqual([
        'moonshotai/kimi-k2',
        'qwen/qwen3.5-flash-02-23',
      ]);
    } finally {
      global.fetch = originalFetch;
      await ctx.app.close();
      ctx.eventStore.close();
    }
  });

  it('blocks Dashboard commands until an agent reports AMP readiness', async () => {
    const ctx = await createRouteTestContext();
    let socket: Awaited<ReturnType<typeof openSessionSocket>> | null = null;

    try {
      const session = await createRunningSession(ctx);
      socket = await openSessionSocket(ctx.app, session.id);
      socket.send(JSON.stringify({ type: 'user.command', command: 'hello' }));

      const errorEvent = await waitFor(() => {
        return ctx.eventStore.getEvents(session.id).find((event) =>
          event.type === 'amp.agent.error' && event.payload.code === 'ERR_AGENT_NOT_READY'
        );
      });

      expect(errorEvent.payload.message).toContain('No connected agent');
      expect(ctx.driver.calls.some((call) => call.method === 'exec' && String(call.args[1]).includes('/amp/command'))).toBe(false);
    } finally {
      await closeSessionSocket(socket);
      await ctx.app.close();
      ctx.eventStore.close();
    }
  });

  it('reconciles stale running sessions in /api/sessions and supports deleting old sessions', async () => {
    const ctx = await createRouteTestContext();

    try {
      const session = await ctx.sessionManager.create('none');
      const runtimeSession = ctx.sessionManager.get(session.id);
      if (runtimeSession) {
        runtimeSession.status = 'running';
        runtimeSession.vmId = 'vm-route-test';
      }
      ctx.eventStore.db
        .prepare('UPDATE sessions SET status = ?, vm_id = ?, updated_at = ? WHERE id = ?')
        .run('running', 'vm-route-test', Date.now(), session.id);

      const driver = ctx.driver as SandboxDriver & { getInfo: (vmId: string) => Promise<VMInfo | null> };
      driver.getInfo = async () => null;

      const listResponse = await ctx.app.inject({
        method: 'GET',
        url: '/api/sessions',
      });

      expect(listResponse.statusCode).toBe(200);
      expect(listResponse.json()).toEqual([
        expect.objectContaining({
          id: session.id,
          status: 'terminated',
        }),
      ]);

      const deleteResponse = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${session.id}`,
      });

      expect(deleteResponse.statusCode).toBe(200);
      expect(deleteResponse.json()).toEqual({ deleted: true });

      const sessionsAfterDelete = await ctx.app.inject({
        method: 'GET',
        url: '/api/sessions',
      });
      expect(sessionsAfterDelete.json()).toEqual([]);
    } finally {
      await ctx.app.close();
      ctx.eventStore.close();
    }
  });

  it('forwards Dashboard commands into the VM only after the agent is ready', async () => {
    const ctx = await createRouteTestContext();
    let socket: Awaited<ReturnType<typeof openSessionSocket>> | null = null;

    try {
      const session = await createRunningSession(ctx);
      const runtimeSession = ctx.sessionManager.get(session.id);
      if (runtimeSession) {
        runtimeSession.agentTransport = 'openclaw-gateway';
        runtimeSession.agentSessionKey = `paddock:${session.id}`;
      }
      ctx.eventStore.append(session.id, 'amp.agent.ready' as any, {
        agent: 'openclaw',
        version: 'test',
        capabilities: ['chat'],
      });

      socket = await openSessionSocket(ctx.app, session.id);
      socket.send(JSON.stringify({ type: 'user.command', command: 'hello from dashboard' }));

      const forwardCall = await waitFor(() => {
        return ctx.driver.calls.find((call) =>
          call.method === 'exec' && String(call.args[1]).includes('/amp/command')
        );
      });

      const shellCommand = String(forwardCall.args[1]);
      expect(shellCommand).toContain('NO_PROXY=127.0.0.1,localhost');
      expect(shellCommand).toContain('http://127.0.0.1:8801/amp/command');
      const encodedPayload = shellCommand.match(/echo '([^']+)' \| base64 -d/)?.[1];
      expect(encodedPayload).toBeTruthy();
      const decodedPayload = Buffer.from(encodedPayload!, 'base64').toString('utf8');
      expect(decodedPayload).toContain('"transport":"openclaw-gateway"');
      expect(decodedPayload).toContain(`"sessionKey":"paddock:${session.id}"`);

      const errorEvents = ctx.eventStore.getEvents(session.id).filter((event) => event.type === 'amp.agent.error');
      expect(errorEvents).toHaveLength(0);
    } finally {
      await closeSessionSocket(socket);
      await ctx.app.close();
      ctx.eventStore.close();
    }
  });

  it('stops forwarding commands again after the agent exits or turns fatal', async () => {
    const ctx = await createRouteTestContext();
    let socket: Awaited<ReturnType<typeof openSessionSocket>> | null = null;

    try {
      const session = await createRunningSession(ctx);
      ctx.eventStore.append(session.id, 'amp.agent.ready' as any, {
        agent: 'openclaw',
        version: 'test',
        capabilities: ['chat'],
      });
      ctx.eventStore.append(session.id, 'amp.agent.fatal' as any, {
        agent: 'openclaw',
        code: 'ERR_AGENT_CRASHED',
        message: 'agent died',
      });

      socket = await openSessionSocket(ctx.app, session.id);
      socket.send(JSON.stringify({ type: 'user.command', command: 'hello again' }));

      await waitFor(() => {
        return ctx.eventStore.getEvents(session.id).find((event) =>
          event.type === 'amp.agent.error' && event.payload.code === 'ERR_AGENT_NOT_READY'
        );
      });

      expect(ctx.driver.calls.some((call) => call.method === 'exec' && String(call.args[1]).includes('/amp/command'))).toBe(false);
    } finally {
      await closeSessionSocket(socket);
      await ctx.app.close();
      ctx.eventStore.close();
    }
  });

  it('aborts an active OpenClaw command through the sidecar command abort endpoint', async () => {
    const ctx = await createRouteTestContext((command) => {
      if (command.includes('/amp/command/abort')) {
        return { stdout: '{"ok":true,"aborted":true}', stderr: '', exitCode: 0 };
      }
      return undefined;
    });

    try {
      const session = await createRunningSession(ctx);
      const runtimeSession = ctx.sessionManager.get(session.id);
      if (runtimeSession) {
        runtimeSession.agentTransport = 'openclaw-gateway';
        runtimeSession.agentSessionKey = `paddock:${session.id}`;
      }

      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/commands/abort`,
        payload: { runId: 'run-1' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, aborted: true, runId: 'run-1' });

      const abortCall = ctx.driver.calls.find((call) =>
        call.method === 'exec' && String(call.args[1]).includes('/amp/command/abort')
      );
      expect(abortCall).toBeTruthy();

      const shellCommand = String(abortCall?.args[1]);
      const encodedPayload = shellCommand.match(/echo '([^']+)' \| base64 -d/)?.[1];
      expect(encodedPayload).toBeTruthy();
      const decodedPayload = Buffer.from(encodedPayload!, 'base64').toString('utf8');
      expect(decodedPayload).toContain(`"sessionKey":"paddock:${session.id}"`);
      expect(decodedPayload).toContain('"runId":"run-1"');
    } finally {
      await ctx.app.close();
      ctx.eventStore.close();
    }
  });

  it('records an auth error on the session when the host has no Anthropic key', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;

    const ctx = await createRouteTestContext();

    try {
      const session = await createRunningSession(ctx);
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/llm/proxy',
        payload: {
          provider: 'anthropic',
          method: 'POST',
          path: '/v1/messages',
          headers: {},
          body: '{}',
          sessionId: session.id,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe(500);

      const errorEvent = await waitFor(() => {
        return ctx.eventStore.getEvents(session.id).find((event) =>
          event.type === 'amp.agent.error' && event.payload.code === 'ERR_NO_API_KEY'
        );
      });

      expect(errorEvent.payload.category).toBe('auth');
      expect(errorEvent.payload.message).toContain('API key not configured');
    } finally {
      await ctx.app.close();
      ctx.eventStore.close();
    }
  });

  it('classifies wrapped upstream 429 responses as rate limits', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://claude.example.test';
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
    delete process.env.ANTHROPIC_API_KEY;

    global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === 'https://claude.example.test/v1/messages') {
        expect(init?.headers).toMatchObject({ 'x-api-key': 'test-token' });
        return new Response(JSON.stringify({ code: 429, msg: '请求过于频繁，请稍后再试' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    };

    const ctx = await createRouteTestContext();

    try {
      const session = await createRunningSession(ctx);
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/llm/proxy',
        payload: {
          provider: 'anthropic',
          method: 'POST',
          path: '/v1/messages',
          headers: {},
          body: '{}',
          sessionId: session.id,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe(503);

      const errorEvent = await waitFor(() => {
        return ctx.eventStore.getEvents(session.id).find((event) =>
          event.type === 'amp.agent.error' && event.payload.code === 'ERR_RATE_LIMIT'
        );
      });

      expect(errorEvent.payload.category).toBe('resource');
      expect(errorEvent.payload.message).toContain('请求过于频繁');
    } finally {
      await ctx.app.close();
      ctx.eventStore.close();
    }
  });
});
