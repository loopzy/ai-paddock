import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

type ExecHook = (command: string) => ExecResult | undefined | Promise<ExecResult | undefined>;

function createMockDriver(execHook?: ExecHook): SandboxDriver {
  return {
    async createBox(_config?: SandboxConfig) {
      return 'vm-boundary-test';
    },
    async getInfo(vmId: string): Promise<VMInfo | null> {
      return { id: vmId, name: 'mock', status: 'running', created: new Date() };
    },
    async exec(_vmId: string, command: string): Promise<ExecResult> {
      const custom = execHook ? await execHook(command) : undefined;
      if (custom) return custom;
      if (command.includes('command -v node')) {
        return { stdout: '/usr/bin/node\n', stderr: '', exitCode: 0 };
      }
      if (command.includes('/amp/health') || command.includes('/api/health')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    async copyIn() {},
    async copyOut() {},
    async createSnapshot(vmId: string, label?: string): Promise<SandboxSnapshot> {
      return {
        id: 'snap-boundary-test',
        sessionId: vmId,
        seq: 1,
        label,
        createdAt: Date.now(),
        boxliteSnapshotId: 'box-snap-boundary-test',
      };
    },
    async restoreSnapshot() {},
    async destroyBox() {},
    async getMetrics() {
      return { cpuPercent: 3, memoryMiB: 128 };
    },
  };
}

async function createContext(execHook?: ExecHook) {
  process.env.PADDOCK_AGENT_BOOT_DELAY_MS = '0';
  process.env.PADDOCK_SIDECAR_BOOT_DELAY_MS = '0';

  const eventStore = new EventStore(':memory:');
  const llmConfigStore = new LLMConfigStore(eventStore.db);
  const driver = createMockDriver(execHook);
  const sessionManager = new SessionManager(eventStore, driver, eventStore.db, llmConfigStore);
  const snapshotManager = new SnapshotManager(eventStore.db);
  const hitlArbiter = new HITLArbiter(eventStore);
  const mcpGateway = new MCPGateway();
  const llmRelay = new LLMRelay();
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
    eventStore,
    sessionManager,
  };
}

async function createRunningSession(ctx: Awaited<ReturnType<typeof createContext>>) {
  const session = await ctx.sessionManager.create('openclaw');
  await ctx.sessionManager.start(session.id);
  return session;
}

describe('Control-plane boundary routes', () => {
  afterEach(async () => {
    // no-op: each test closes its own app/eventStore
  });

  it('lists only external MCP tools', async () => {
    const ctx = await createContext();

    try {
      const session = await createRunningSession(ctx);
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/sessions/${session.id}/mcp/tools`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      const names = body.tools.map((tool: { name: string }) => tool.name);

      expect(names).toEqual(
        expect.arrayContaining(['browser.open', 'clipboard.read', 'clipboard.write', 'tts.speak', 'applescript.run']),
      );
      expect(names).not.toContain('read');
      expect(names).not.toContain('exec');
      expect(names).not.toContain('sessions_list');
    } finally {
      await ctx.app.close();
      ctx.eventStore.close();
    }
  });

  it('rejects sandbox-local and control-plane-routed tools from the MCP boundary', async () => {
    const ctx = await createContext();

    try {
      const session = await createRunningSession(ctx);

      const localResponse = await ctx.app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/mcp/call`,
        payload: { toolName: 'read', args: { path: 'README.md' } },
      });
      expect(localResponse.statusCode).toBe(400);
      expect(localResponse.json().error).toContain('sandbox-local');

      const controlResponse = await ctx.app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/mcp/call`,
        payload: { toolName: 'sessions_list', args: {} },
      });
      expect(controlResponse.statusCode).toBe(400);
      expect(controlResponse.json().error).toContain('control-plane-routed');

      const webResponse = await ctx.app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/mcp/call`,
        payload: { toolName: 'web_fetch', args: { url: 'https://example.com' } },
      });
      expect(webResponse.statusCode).toBe(400);
      expect(webResponse.json().error).toContain('sandbox-local');
    } finally {
      await ctx.app.close();
      ctx.eventStore.close();
    }
  });

  it('routes sessions_list through /amp/control', async () => {
    const ctx = await createContext();

    try {
      const source = await createRunningSession(ctx);
      await createRunningSession(ctx);

      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/sessions/${source.id}/amp/control`,
        payload: { toolName: 'sessions_list', args: {} },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.sessions.length).toBeGreaterThanOrEqual(2);
      expect(body.sessions.some((session: { id: string }) => session.id === source.id)).toBe(true);
    } finally {
      await ctx.app.close();
      ctx.eventStore.close();
    }
  });

  it('relays local ollama behavior-review requests through the control plane', async () => {
    const originalFetch = global.fetch;
    process.env.PADDOCK_BEHAVIOR_LLM_BASE_URL = 'http://127.0.0.1:11434';
    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('http://127.0.0.1:11434/api/chat');
      expect(init?.method).toBe('POST');
      return new Response(JSON.stringify({ message: { content: '{"riskBoost":0,"triggered":[],"reason":"ok","confidence":0.9}' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const ctx = await createContext();

    try {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/behavior-llm/ollama/api/chat',
        payload: {
          model: 'qwen3:0.6b',
          messages: [{ role: 'user', content: 'test' }],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        message: { content: '{"riskBoost":0,"triggered":[],"reason":"ok","confidence":0.9}' },
      });
    } finally {
      global.fetch = originalFetch;
      await ctx.app.close();
      ctx.eventStore.close();
    }
  });

  it('returns session history and status through /amp/control', async () => {
    const ctx = await createContext();

    try {
      const session = await createRunningSession(ctx);
      ctx.eventStore.append(session.id, 'user.command', { command: 'hello' });
      ctx.eventStore.append(session.id, 'amp.thought' as any, { text: 'world' });

      const historyResponse = await ctx.app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/amp/control`,
        payload: { toolName: 'sessions_history', args: { sessionId: session.id, limit: 2 } },
      });
      expect(historyResponse.statusCode).toBe(200);
      const historyBody = historyResponse.json();
      expect(historyBody.events).toHaveLength(2);
      expect(historyBody.events.at(-1)?.type).toBe('amp.thought');

      const statusResponse = await ctx.app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/amp/control`,
        payload: { toolName: 'session_status', args: { sessionId: session.id } },
      });
      expect(statusResponse.statusCode).toBe(200);
      expect(statusResponse.json()).toMatchObject({
        session: {
          id: session.id,
          status: 'running',
        },
      });
    } finally {
      await ctx.app.close();
      ctx.eventStore.close();
    }
  });

  it('stores snapshot references on reported events', async () => {
    const ctx = await createContext();

    try {
      const session = await createRunningSession(ctx);

      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/events`,
        payload: {
          type: 'amp.tool.result',
          payload: { toolName: 'write', result: { ok: true } },
          correlationId: 'corr-snapshot-1',
          snapshotRef: 'snap-checkpoint-1',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        correlationId: 'corr-snapshot-1',
        snapshotRef: 'snap-checkpoint-1',
      });

      const correlated = ctx.eventStore.getCorrelatedEvents('corr-snapshot-1');
      expect(correlated).toHaveLength(1);
      expect(correlated[0]?.snapshotRef).toBe('snap-checkpoint-1');
    } finally {
      await ctx.app.close();
      ctx.eventStore.close();
    }
  });

  it('accepts bulk event writes and preserves correlation metadata', async () => {
    const ctx = await createContext();

    try {
      const session = await createRunningSession(ctx);

      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/events/bulk`,
        payload: {
          events: [
            {
              type: 'amp.session.start',
              payload: { phase: 'bootstrap', message: 'Bootstrapping OpenClaw' },
            },
            {
              type: 'amp.tool.result',
              payload: { toolName: 'write', result: { ok: true } },
              correlationId: 'corr-bulk-1',
              snapshotRef: 'snap-bulk-1',
            },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.events).toHaveLength(2);
      expect(body.events[1]).toMatchObject({
        correlationId: 'corr-bulk-1',
        snapshotRef: 'snap-bulk-1',
      });

      const correlated = ctx.eventStore.getCorrelatedEvents('corr-bulk-1');
      expect(correlated).toHaveLength(1);
      expect(correlated[0]?.snapshotRef).toBe('snap-bulk-1');
    } finally {
      await ctx.app.close();
      ctx.eventStore.close();
    }
  });

  it('routes cron jobs through /amp/control and executes manual runs inside the target sandbox', async () => {
    const ctx = await createContext();

    try {
      const session = await createRunningSession(ctx);
      ctx.eventStore.append(session.id, 'amp.agent.ready' as any, {
        agent: 'openclaw',
        version: 'test',
        capabilities: ['chat', 'tools'],
      });

      const addResponse = await ctx.app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/amp/control`,
        payload: {
          toolName: 'cron',
          args: {
            action: 'add',
            job: {
              sessionTarget: 'current',
              schedule: { kind: 'at', at: '2035-01-01T00:00:00.000Z' },
              payload: { kind: 'agentTurn', message: 'cron hello' },
            },
          },
        },
      });

      expect(addResponse.statusCode).toBe(200);
      const addBody = addResponse.json();
      expect(addBody.job.id).toBeTruthy();

      const statusResponse = await ctx.app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/amp/control`,
        payload: {
          toolName: 'cron',
          args: { action: 'status' },
        },
      });
      expect(statusResponse.statusCode).toBe(200);
      expect(statusResponse.json().jobCount).toBe(1);

      const runResponse = await ctx.app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/amp/control`,
        payload: {
          toolName: 'cron',
          args: { action: 'run', id: addBody.job.id, runMode: 'force' },
        },
      });
      expect(runResponse.statusCode).toBe(200);
      expect(runResponse.json()).toMatchObject({ ok: true, ran: true });

      const runsResponse = await ctx.app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/amp/control`,
        payload: {
          toolName: 'cron',
          args: { action: 'runs', id: addBody.job.id, limit: 10 },
        },
      });
      expect(runsResponse.statusCode).toBe(200);
      expect(runsResponse.json().runs[0]).toMatchObject({ status: 'succeeded' });

      expect(
        ctx.eventStore
          .getEvents(session.id)
          .some((event) => event.type === 'user.command' && event.payload.command === 'cron hello'),
      ).toBe(true);
    } finally {
      await ctx.app.close();
      ctx.eventStore.close();
    }
  });
});
