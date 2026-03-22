import type { FastifyInstance } from 'fastify';
import type { EventStore } from '../events/event-store.js';
import type { SessionManager } from '../session/session-manager.js';
import type { SnapshotManager } from '../snapshot/snapshot-manager.js';
import { CronManager } from '../cron/cron-manager.js';
import type { SandboxDriver, SandboxSnapshot } from '@paddock/types';
import type { HITLArbiter } from '../hitl/arbiter.js';
import type { MCPGateway } from '../mcp/gateway.js';
import type { LLMRelay, LLMProxyRequest } from '../mcp/llm-relay.js';
import type { ResourceGateway } from '../boundary/resource-gateway.js';
import type { LLMConfigStore } from '../config/llm-config-store.js';
import type { EventType, SandboxType, ResourceRequest } from '../types.js';
import { AGENT_LLM_PROVIDER_PRESETS, getConfiguredAgentProviders, getDefaultAgentLLMConfig, resolveAgentLLMConfig } from '../mcp/agent-llm-config.js';
import { classifyOpenClawToolBoundary } from '../agents/openclaw-operation-profile.js';

function classifyToolBoundary(toolName: string): 'sandbox-local' | 'control-plane-routed' | 'mcp-external' | 'disabled' {
  return classifyOpenClawToolBoundary(toolName);
}

function parseLLMProxyError(result: { status: number; body: string }) {
  let message = `LLM request failed with status ${result.status}`;
  let statusHint = result.status;

  try {
    const errBody = JSON.parse(result.body) as Record<string, unknown>;
    if (typeof errBody.error === 'string') {
      message = errBody.error;
    } else if (
      errBody.error &&
      typeof errBody.error === 'object' &&
      typeof (errBody.error as { message?: unknown }).message === 'string'
    ) {
      message = String((errBody.error as { message: string }).message);
    } else if (typeof errBody.message === 'string') {
      message = errBody.message;
    } else if (typeof errBody.msg === 'string') {
      message = errBody.msg;
    }

    if (typeof errBody.code === 'number') {
      statusHint = errBody.code;
    } else if (
      errBody.error &&
      typeof errBody.error === 'object' &&
      typeof (errBody.error as { code?: unknown }).code === 'number'
    ) {
      statusHint = Number((errBody.error as { code: number }).code);
    }
  } catch {
    // fall back to default message/status
  }

  const messageLower = message.toLowerCase();
  if (messageLower.includes('api key not configured') || messageLower.includes('api_key') || statusHint === 401) {
    return {
      category: 'auth',
      code: 'ERR_NO_API_KEY',
      message: 'LLM API key not configured. Click the ⚙️ API Keys button in the dashboard header to configure, or set environment variables (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.).'
    };
  }
  if (statusHint === 429 || messageLower.includes('rate limit')) {
    return { category: 'resource', code: 'ERR_RATE_LIMIT', message };
  }
  if (result.status === 502 || result.status === 503 || result.status === 504) {
    return { category: 'network', code: 'ERR_LLM_UNAVAILABLE', message };
  }
  return { category: 'runtime', code: 'ERR_LLM_UPSTREAM', message };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function getBehaviorLLMOllamaTarget(): string {
  return trimTrailingSlash(process.env.PADDOCK_BEHAVIOR_LLM_BASE_URL?.trim() || 'http://127.0.0.1:11434');
}

interface Deps {
  eventStore: EventStore;
  sessionManager: SessionManager;
  snapshotManager: SnapshotManager;
  sandboxDriver: SandboxDriver;
  hitlArbiter: HITLArbiter;
  mcpGateway: MCPGateway;
  llmRelay: LLMRelay;
  resourceGateway: ResourceGateway;
  llmConfigStore: LLMConfigStore;
}

export function registerRoutes(app: FastifyInstance, deps: Deps) {
  const { eventStore, sessionManager, snapshotManager, sandboxDriver, hitlArbiter, mcpGateway, llmRelay, resourceGateway, llmConfigStore } = deps;
  const cronManager = new CronManager(eventStore.db, async (job, run) => {
    const ownerSession = sessionManager.get(job.ownerSessionId);
    if (!ownerSession) {
      throw new Error(`Owner session not found: ${job.ownerSessionId}`);
    }

    const targetSession = await resolveCronTargetSession(job.ownerSessionId, job.sessionTarget);
    const payload = job.payload.kind === 'systemEvent' ? job.payload.text : job.payload.message;
    if (!isAgentReady(targetSession.id)) {
      throw new Error(`Target session agent is not ready: ${targetSession.id}`);
    }

    eventStore.append(targetSession.id, 'user.command', {
      command: payload,
      sourceSessionId: job.ownerSessionId,
      via: 'cron',
      cronJobId: job.id,
      cronRunId: run.id,
    });
    await forwardCommandToVM(targetSession.id, payload);
    return { delivered: true, targetSessionId: targetSession.id };
  });
  cronManager.start();
  app.addHook('onClose', async () => {
    cronManager.stop();
  });

  // ─── Health / Config Check ───
  app.get('/api/health', async () => {
    const providers = llmRelay.getConfiguredProviders();
    const envHints: Record<string, string> = {
      ANTHROPIC_API_KEY: 'https://console.anthropic.com/settings/keys',
      OPENAI_API_KEY: 'https://platform.openai.com/api-keys',
      OPENROUTER_API_KEY: 'https://openrouter.ai/settings/keys',
    };
    const missingKeys = Object.keys(envHints).filter(k => !process.env[k]);
    const configuredAgentProviders = new Set(getConfiguredAgentProviders(process.env, llmConfigStore));
    const defaultAgentConfig = getDefaultAgentLLMConfig(process.env, llmConfigStore);
    return {
      ok: true,
      llmProviders: providers,
      agentDefaults: defaultAgentConfig,
      llmCatalog: {
        providers: AGENT_LLM_PROVIDER_PRESETS.map((provider) => ({
          ...provider,
          configured: configuredAgentProviders.has(provider.id),
        })),
      },
      warnings: [
        ...(providers.length === 0 && configuredAgentProviders.size === 0 ? [{
          type: 'no_llm_keys' as const,
          message: 'No LLM API keys configured. Agent will not be able to call LLMs.',
          hint: `Click ⚙️ API Keys in the dashboard header to configure, or set environment variables: ${missingKeys.join(', ')}`,
          envHints: Object.fromEntries(missingKeys.map(k => [k, envHints[k] ?? ''])),
        }] : []),
      ],
    };
  });

  // ─── LLM Provider Configuration ───
  app.get('/api/llm-config', async () => {
    return { providers: llmConfigStore.list() };
  });

  app.post<{ Body: { provider: string; apiKey?: string; baseUrl?: string | null; model?: string | null } }>('/api/llm-config', async (req, reply) => {
    const { provider, apiKey, baseUrl, model } = req.body;
    if (!provider?.trim()) {
      reply.code(400);
      return { error: 'provider is required' };
    }
    const existing = llmConfigStore.get(provider);
    if (!existing && !apiKey?.trim()) {
      reply.code(400);
      return { error: 'apiKey is required when creating a provider configuration' };
    }
    llmConfigStore.upsert(provider, { apiKey, baseUrl, model });
    return { ok: true, provider, model: model ?? existing?.model ?? null };
  });

  app.delete<{ Params: { provider: string } }>('/api/llm-config/:provider', async (req) => {
    llmConfigStore.delete(req.params.provider);
    return { ok: true };
  });

  app.post('/api/behavior-llm/ollama/api/chat', async (req, reply) => {
    const targetUrl = `${getBehaviorLLMOllamaTarget()}/api/chat`;
    console.log(`[behavior-llm-relay] forwarding ollama review request to ${targetUrl}`);
    const upstream = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body ?? {}),
      signal: AbortSignal.timeout(35_000),
    });

    const responseBody = await upstream.text();
    reply.code(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType) {
      reply.header('content-type', contentType);
    }
    return responseBody;
  });

  // ─── Sessions ───
  app.post<{ Body: { agentType: string; sandboxType?: SandboxType; autoStart?: boolean } }>('/api/sessions', async (req) => {
    const session = await sessionManager.create(req.body.agentType, req.body.sandboxType);
    if (req.body.autoStart !== false) {
      // Async: create VM + deploy sidecar (not agent)
      sessionManager.start(session.id).catch(err => {
        app.log.error({ err, sessionId: session.id }, 'Failed to auto-start session');
      });
    }
    return session;
  });

  app.get('/api/sessions', async () => sessionManager.listWithRuntimeStatus());

  app.get<{ Params: { sessionId: string } }>('/api/sessions/:sessionId', async (req) => {
    return sessionManager.get(req.params.sessionId) ?? { error: 'Session not found' };
  });

  app.post<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/start', async (req) => {
    await sessionManager.start(req.params.sessionId);
    return { started: true };
  });

  app.post<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/stop', async (req) => {
    await sessionManager.stop(req.params.sessionId);
    return { stopped: true };
  });

  app.delete<{ Params: { sessionId: string } }>('/api/sessions/:sessionId', async (req, reply) => {
    const removed = await sessionManager.remove(req.params.sessionId);
    if (!removed) {
      reply.code(404);
      return { error: 'Session not found' };
    }
    return { deleted: true };
  });

  app.post<{ Params: { sessionId: string }; Body: { agentType: string; llmProvider?: string; llmModel?: string } }>('/api/sessions/:sessionId/deploy-agent', async (req) => {
    const { sessionId } = req.params;
    const { agentType, llmProvider, llmModel } = req.body;
    const agentConfig = resolveAgentLLMConfig(
      llmProvider || llmModel ? { provider: llmProvider, model: llmModel } : undefined,
      process.env,
      llmConfigStore,
    );
    // Async: agent deployment is long-running, progress via WebSocket events
    sessionManager.deployAgent(sessionId, agentType, agentConfig).catch(err => {
      app.log.error({ err, sessionId, agentType }, 'Failed to deploy agent');
      if ((err as Error).message.includes('Session') || (err as Error).message.includes('Unknown agent type')) {
        eventStore.append(sessionId, 'amp.agent.fatal' as EventType, {
          agent: agentType,
          code: 'ERR_AGENT_DEPLOY',
          message: (err as Error).message,
          recoverable: false,
        });
      }
    });
    return { deploying: true, agentType, agentConfig };
  });

  // ─── Events ───
  app.get<{ Params: { sessionId: string }; Querystring: { since?: string; types?: string; limit?: string; correlationId?: string } }>('/api/sessions/:sessionId/events', async (req) => {
    const { sessionId } = req.params;
    if (req.query.correlationId) {
      return eventStore.getCorrelatedEvents(req.query.correlationId);
    }
    const since = req.query.since ? Number(req.query.since) : undefined;
    const types = req.query.types?.split(',') as EventType[] | undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    return eventStore.getEvents(sessionId, { since, types, limit });
  });

  app.post<{ Params: { sessionId: string }; Body: { type: EventType; payload: Record<string, unknown>; correlationId?: string; causedBy?: string; snapshotRef?: string } }>('/api/sessions/:sessionId/events', async (req) => {
    const { sessionId } = req.params;
    const { type, payload, correlationId, causedBy, snapshotRef } = req.body;
    const event = eventStore.append(sessionId, type, payload, { correlationId, causedBy, snapshotRef });
    return event;
  });

  app.post<{
    Params: { sessionId: string };
    Body: {
      events: Array<{
        type: EventType;
        payload: Record<string, unknown>;
        correlationId?: string;
        causedBy?: string;
        snapshotRef?: string;
      }>;
    };
  }>('/api/sessions/:sessionId/events/bulk', async (req, reply) => {
    const { sessionId } = req.params;
    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    if (events.length === 0) {
      reply.code(400);
      return { error: 'events must be a non-empty array' };
    }

    const appended = eventStore.appendMany(
      sessionId,
      events.map((event) => ({
        type: event.type,
        payload: event.payload,
        correlationId: event.correlationId,
        causedBy: event.causedBy,
        snapshotRef: event.snapshotRef,
      })),
    );
    return { events: appended };
  });

  // ─── Integrity verification ───
  app.get<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/integrity', async (req) => {
    return eventStore.verifyIntegrity(req.params.sessionId);
  });

  // ─── Rollback ───
  app.post<{ Params: { sessionId: string }; Body: { toSeq: number } }>('/api/sessions/:sessionId/rollback', async (req) => {
    const { sessionId } = req.params;
    const { toSeq } = req.body;
    const rolledBack = eventStore.markRolledBack(sessionId, toSeq);
    eventStore.append(sessionId, 'snapshot.restored', { toSeq, rolledBackCount: rolledBack });
    return { rolledBack, toSeq };
  });

  // ─── Snapshots ───
  app.get<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/snapshots', async (req) => {
    return snapshotManager.list(req.params.sessionId);
  });

  app.post<{ Params: { sessionId: string }; Body: { label?: string; mode?: 'live' | 'stopped' } }>('/api/sessions/:sessionId/snapshots', async (req) => {
    const { sessionId } = req.params;
    const session = sessionManager.get(sessionId);
    if (!session?.vmId) return { error: 'Session not running' };
    const events = eventStore.getEvents(sessionId);
    const seq = events.length > 0 ? events[events.length - 1].seq : 0;
    const driver = sessionManager.getDriverForSession(sessionId) as SandboxDriver & {
      createConsistentSnapshot?: (vmId: string, label?: string) => Promise<SandboxSnapshot>;
    };
    const mode = req.body.mode === 'stopped' ? 'stopped' : 'live';
    const boxSnapshot = mode === 'stopped' && 'createConsistentSnapshot' in driver && typeof driver.createConsistentSnapshot === 'function'
      ? await driver.createConsistentSnapshot(session.vmId, req.body.label)
      : await driver.createSnapshot(session.vmId, req.body.label);
    const snapshot = snapshotManager.create(
      sessionId,
      seq,
      boxSnapshot.boxliteSnapshotId,
      req.body.label,
      {
        sizeBytes: boxSnapshot.sizeBytes,
        containerDiskBytes: boxSnapshot.containerDiskBytes,
      },
      boxSnapshot.consistencyMode ?? mode,
    );
    eventStore.append(sessionId, 'snapshot.created', {
      snapshotId: snapshot.id,
      seq,
      label: req.body.label,
      sizeBytes: snapshot.sizeBytes,
      containerDiskBytes: snapshot.containerDiskBytes,
      consistencyMode: snapshot.consistencyMode,
    });
    return snapshot;
  });

  app.post<{ Params: { sessionId: string; snapshotId: string } }>('/api/sessions/:sessionId/snapshots/:snapshotId/restore', async (req) => {
    const { sessionId, snapshotId } = req.params;
    const snapshot = snapshotManager.get(snapshotId);
    if (!snapshot) return { error: 'Snapshot not found' };
    const session = sessionManager.get(sessionId);
    if (!session?.vmId) return { error: 'Session not running' };
    const driver = sessionManager.getDriverForSession(sessionId);
    await driver.restoreSnapshot(session.vmId, snapshot.boxliteSnapshotId);
    const rolledBack = eventStore.markRolledBack(sessionId, snapshot.seq);
    eventStore.append(sessionId, 'snapshot.restored', { snapshotId, seq: snapshot.seq, rolledBackCount: rolledBack });
    return { restored: true, rolledBackCount: rolledBack };
  });

  // ─── HITL ───
  app.get<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/hitl/pending', async (req) => {
    return hitlArbiter.getPendingRequests(req.params.sessionId);
  });

  app.post<{ Params: { sessionId: string }; Body: { requestId: string; verdict: 'approved' | 'rejected' | 'modified'; modifiedArgs?: Record<string, unknown> } }>('/api/sessions/:sessionId/hitl', async (req) => {
    hitlArbiter.decide(req.body.requestId, req.body.verdict, req.body.modifiedArgs);
    return { decided: true };
  });

  // HITL gate endpoint (called by Sidecar for security engine 'ask' verdicts)
  app.post<{ Params: { sessionId: string }; Body: { correlationId: string; toolName: string; toolInput: Record<string, unknown>; riskScore: number; triggeredRules: string[] } }>('/api/sessions/:sessionId/hitl/gate', async (req) => {
    const { sessionId } = req.params;
    const { toolName, toolInput, riskScore, triggeredRules } = req.body;
    const decision = await hitlArbiter.requestApproval(sessionId, toolName, toolInput, `Security engine risk score: ${riskScore}. Rules: ${triggeredRules.join(', ')}`);
    return { verdict: decision.verdict };
  });

  // ─── Kill Switch ───
  app.post<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/kill', async (req) => {
    await sessionManager.stop(req.params.sessionId);
    return { killed: true };
  });

  app.post<{ Params: { sessionId: string }; Body: { runId?: string } }>('/api/sessions/:sessionId/commands/abort', async (req, reply) => {
    const { sessionId } = req.params;
    const session = sessionManager.get(sessionId);
    if (!session) {
      reply.code(404);
      return { error: 'Session not found' };
    }
    if (!session.vmId) {
      reply.code(409);
      return { error: 'Session has no running VM' };
    }
    if (session.agentTransport !== 'openclaw-gateway' || !session.agentSessionKey) {
      reply.code(409);
      return { error: 'The current agent transport does not support command abort' };
    }

    const result = await abortCommandInVM(sessionId, req.body.runId);
    eventStore.append(sessionId, 'amp.command.status' as EventType, {
      status: result.aborted ? 'aborted' : 'abort-requested',
      runId: req.body.runId,
      sessionKey: session.agentSessionKey,
      source: 'dashboard',
    });
    return {
      ok: true,
      aborted: result.aborted,
      runId: req.body.runId ?? null,
    };
  });

  // ─── MCP Gateway (legacy) ───
  app.get<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/mcp/tools', async (req) => {
    const session = sessionManager.get(req.params.sessionId);
    if (!session) {
      return { error: 'Session not found' };
    }
    return { tools: mcpGateway.listTools() };
  });

  app.post<{ Params: { sessionId: string }; Body: { tool?: string; toolName?: string; args: string | string[] | Record<string, unknown> } }>('/api/sessions/:sessionId/mcp/call', async (req, reply) => {
    const { sessionId } = req.params;
    const tool = req.body.toolName ?? req.body.tool ?? '';
    const { args } = req.body;
    const boundary = classifyToolBoundary(tool);
    if (boundary === 'sandbox-local' || boundary === 'control-plane-routed' || boundary === 'disabled') {
      reply.code(400);
      return { error: `Tool "${tool}" is ${boundary} and cannot be called via the MCP boundary.` };
    }
    if (hitlArbiter.requiresApproval(`host.${tool}`)) {
      const decision = await hitlArbiter.requestApproval(sessionId, `host.${tool}`, { args }, 'Host-side tool call requires approval');
      if (decision.verdict === 'rejected') return { stderr: 'Tool call rejected by user', exitCode: 1 };
    }
    const result = await mcpGateway.callTool(tool, args);
    eventStore.append(sessionId, 'tool.result', { toolName: `host.${tool}`, result });
    return result;
  });

  // ─── AMP Control Boundary ───
  app.post<{ Params: { sessionId: string }; Body: { toolName: string; args?: Record<string, unknown> } }>('/api/sessions/:sessionId/amp/control', async (req, reply) => {
    const { sessionId } = req.params;
    const session = sessionManager.get(sessionId);
    if (!session) {
      reply.code(404);
      return { error: 'Session not found' };
    }

    const toolName = req.body.toolName?.trim() ?? '';
    const args = req.body.args ?? {};

    if (classifyToolBoundary(toolName) !== 'control-plane-routed') {
      reply.code(400);
      return { error: `Tool "${toolName}" is not routed through amp/control.` };
    }

    switch (toolName) {
      case 'sessions_list':
        return {
          sessions: sessionManager.list().map((entry) => ({
            id: entry.id,
            status: entry.status,
            agentType: entry.agentType,
            sandboxType: entry.sandboxType,
            vmId: entry.vmId,
            updatedAt: entry.updatedAt,
            agentReady: isAgentReady(entry.id),
          })),
        };
      case 'sessions_history': {
        const targetSessionId = typeof args.sessionId === 'string' ? args.sessionId : sessionId;
        const limit = typeof args.limit === 'number' ? args.limit : 50;
        if (!sessionManager.get(targetSessionId)) {
          reply.code(404);
          return { error: 'Target session not found' };
        }
        const history = eventStore.getEvents(targetSessionId);
        return {
          sessionId: targetSessionId,
          events: limit > 0 ? history.slice(-limit) : history,
        };
      }
      case 'session_status': {
        const targetSessionId = typeof args.sessionId === 'string' ? args.sessionId : sessionId;
        const target = sessionManager.get(targetSessionId);
        if (!target) {
          reply.code(404);
          return { error: 'Target session not found' };
        }
        return {
          session: {
            id: target.id,
            status: target.status,
            agentType: target.agentType,
            sandboxType: target.sandboxType,
            vmId: target.vmId,
            updatedAt: target.updatedAt,
            agentReady: isAgentReady(target.id),
          },
        };
      }
      case 'sessions_send': {
        const targetSessionId =
          typeof args.sessionId === 'string'
            ? args.sessionId
            : typeof args.targetSessionId === 'string'
              ? args.targetSessionId
              : '';
        const message = typeof args.message === 'string' ? args.message : '';
        if (!targetSessionId || !message) {
          reply.code(400);
          return { error: 'sessions_send requires target sessionId and message' };
        }
        if (!isAgentReady(targetSessionId)) {
          reply.code(409);
          return { error: 'Target session agent is not ready' };
        }
        eventStore.append(targetSessionId, 'user.command', { command: message, sourceSessionId: sessionId });
        await forwardCommandToVM(targetSessionId, message);
        return { ok: true, targetSessionId };
      }
      case 'sessions_spawn': {
        const sandboxType = (typeof args.sandboxType === 'string' ? args.sandboxType : session.sandboxType) as SandboxType;
        const agentType = typeof args.agentType === 'string' ? args.agentType : 'openclaw';
        const autoStart = args.autoStart !== false;
        const autoDeploy = args.autoDeploy !== false;
        const spawned = await sessionManager.create(agentType, sandboxType);
        eventStore.append(sessionId, 'amp.session.start' as EventType, {
          phase: 'amp.control.spawn',
          childSessionId: spawned.id,
          childAgentType: agentType,
        });
        if (autoStart) {
          await sessionManager.start(spawned.id);
        }
        if (autoStart && autoDeploy && agentType === 'openclaw') {
          await sessionManager.deployAgent(spawned.id, 'openclaw', (session as any).agentConfig);
        }
        return { session: spawned };
      }
      case 'sessions_yield':
        return {
          status: 'yielded',
          message: typeof args.message === 'string' ? args.message : 'Turn yielded.',
        };
      case 'subagents': {
        const spawnedEvents = eventStore
          .getEvents(sessionId, { types: ['amp.session.start' as EventType] })
          .filter((event) => event.payload.phase === 'amp.control.spawn');
        const childSessions = spawnedEvents
          .map((event) => String(event.payload.childSessionId ?? ''))
          .filter(Boolean)
          .map((childSessionId) => sessionManager.get(childSessionId))
          .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

        const action = typeof args.action === 'string' ? args.action : 'list';
        if (action === 'list') {
          return {
            sessions: childSessions.map((entry) => ({
              id: entry.id,
              status: entry.status,
              agentType: entry.agentType,
              sandboxType: entry.sandboxType,
              agentReady: isAgentReady(entry.id),
            })),
          };
        }
        if (action === 'kill') {
          const targetSessionId = typeof args.sessionId === 'string' ? args.sessionId : '';
          if (!targetSessionId) {
            reply.code(400);
            return { error: 'subagents kill requires sessionId' };
          }
          await sessionManager.stop(targetSessionId);
          return { ok: true, sessionId: targetSessionId };
        }
        if (action === 'steer') {
          const targetSessionId = typeof args.sessionId === 'string' ? args.sessionId : '';
          const message = typeof args.message === 'string' ? args.message : '';
          if (!targetSessionId || !message) {
            reply.code(400);
            return { error: 'subagents steer requires sessionId and message' };
          }
          eventStore.append(targetSessionId, 'user.command', { command: message, sourceSessionId: sessionId });
          await forwardCommandToVM(targetSessionId, message);
          return { ok: true, sessionId: targetSessionId };
        }
        reply.code(400);
        return { error: `Unsupported subagents action: ${action}` };
      }
      case 'llm_prepare': {
        const provider = typeof args.provider === 'string' ? args.provider.trim().toLowerCase() : '';
        const currentModel = typeof args.model === 'string' ? args.model.trim() : '';
        const storedModel = provider ? llmConfigStore.getModel(provider) : null;

        if (!provider) {
          return {
            modelOverride: currentModel || undefined,
            source: storedModel ? 'llm-config-store' : 'request',
          };
        }

        return {
          providerOverride: provider,
          modelOverride: storedModel || currentModel || undefined,
          source: storedModel ? 'llm-config-store' : 'request',
        };
      }
      case 'rollback': {
        if (typeof args.snapshotId === 'string') {
          const snapshot = snapshotManager.get(args.snapshotId);
          if (!snapshot) {
            reply.code(404);
            return { error: 'Snapshot not found' };
          }
          if (!session.vmId) {
            reply.code(409);
            return { error: 'Session not running' };
          }
          const driver = sessionManager.getDriverForSession(sessionId);
          await driver.restoreSnapshot(session.vmId, snapshot.boxliteSnapshotId);
          const rolledBack = eventStore.markRolledBack(sessionId, snapshot.seq);
          eventStore.append(sessionId, 'snapshot.restored', { snapshotId: snapshot.id, seq: snapshot.seq, rolledBackCount: rolledBack });
          return { restored: true, snapshotId: snapshot.id, rolledBackCount: rolledBack };
        }
        if (typeof args.toSeq !== 'number') {
          reply.code(400);
          return { error: 'rollback requires snapshotId or toSeq' };
        }
        const rolledBack = eventStore.markRolledBack(sessionId, args.toSeq);
        eventStore.append(sessionId, 'snapshot.restored', { toSeq: args.toSeq, rolledBackCount: rolledBack });
        return { restored: true, toSeq: args.toSeq, rolledBackCount: rolledBack };
      }
      case 'cron': {
        const action = typeof args.action === 'string' ? args.action : 'status';
        if (action === 'status') {
          return cronManager.status();
        }
        if (action === 'list') {
          return {
            jobs: await cronManager.list({
              includeDisabled: Boolean(args.includeDisabled),
            }),
          };
        }
        if (action === 'add') {
          const source =
            typeof args.job === 'object' && args.job !== null
              ? (args.job as Record<string, unknown>)
              : args;
          const job = await cronManager.add(sessionId, source);
          eventStore.append(sessionId, 'amp.session.start' as EventType, {
            phase: 'amp.control.cron.add',
            jobId: job.id,
            sessionTarget: job.sessionTarget,
          });
          return { job };
        }
        if (action === 'update') {
          const jobId =
            typeof args.jobId === 'string'
              ? args.jobId
              : typeof args.id === 'string'
                ? args.id
                : '';
          if (!jobId || typeof args.patch !== 'object' || !args.patch) {
            reply.code(400);
            return { error: 'cron update requires jobId/id and patch' };
          }
          const job = await cronManager.update(jobId, args.patch as Record<string, unknown>);
          return { job };
        }
        if (action === 'remove') {
          const jobId =
            typeof args.jobId === 'string'
              ? args.jobId
              : typeof args.id === 'string'
                ? args.id
                : '';
          if (!jobId) {
            reply.code(400);
            return { error: 'cron remove requires jobId/id' };
          }
          return cronManager.remove(jobId);
        }
        if (action === 'run') {
          const jobId =
            typeof args.jobId === 'string'
              ? args.jobId
              : typeof args.id === 'string'
                ? args.id
                : '';
          const mode = args.runMode === 'due' ? 'due' : 'force';
          if (!jobId) {
            reply.code(400);
            return { error: 'cron run requires jobId/id' };
          }
          return cronManager.run(jobId, mode);
        }
        if (action === 'runs') {
          const jobId =
            typeof args.jobId === 'string'
              ? args.jobId
              : typeof args.id === 'string'
                ? args.id
                : '';
          const limit = typeof args.limit === 'number' ? args.limit : 50;
          if (!jobId) {
            reply.code(400);
            return { error: 'cron runs requires jobId/id' };
          }
          return { runs: await cronManager.runs(jobId, limit) };
        }
        if (action === 'wake') {
          const mode = args.mode === 'now' ? 'now' : 'next-heartbeat';
          return cronManager.wake(mode);
        }
        reply.code(400);
        return { error: `Unsupported cron action: ${action}` };
      }
      default:
        reply.code(400);
        return { error: `Unsupported control tool: ${toolName}` };
    }
  });

  // ─── Resource Boundary Gateway (unified) ───
  app.post<{ Body: ResourceRequest }>('/api/boundary/request', async (req) => {
    return resourceGateway.handle(req.body);
  });

  // ─── LLM Relay ───
  app.post<{ Body: LLMProxyRequest }>('/api/llm/proxy', async (req) => {
    const result = await llmRelay.forward(req.body);

    // Detect LLM errors and report as amp.agent.error
    if (result.status >= 400) {
      const error = parseLLMProxyError(result);

      const errorPayload = {
        agent: 'llm-relay',
        category: error.category,
        code: error.code,
        message: error.message,
        recoverable: error.category !== 'auth',
        context: { provider: req.body.provider, status: result.status },
      };

      // Write to specific session if provided, otherwise broadcast to all running sessions
      if (req.body.sessionId) {
        eventStore.append(req.body.sessionId, 'amp.agent.error' as EventType, errorPayload);
      } else {
        const runningSessions = sessionManager.list().filter(s => s.status === 'running');
        for (const s of runningSessions) {
          eventStore.append(s.id, 'amp.agent.error' as EventType, errorPayload);
        }
      }
    }

    return result;
  });

  app.get('/api/llm/providers', async () => {
    return { providers: llmRelay.getConfiguredProviders() };
  });

  // ─── WebSocket ───
  const wsClients = new Map<string, Set<unknown>>();

  function broadcastToSession(sessionId: string, data: unknown) {
    const clients = wsClients.get(sessionId);
    if (!clients) return;
    const json = JSON.stringify(data);
    for (const ws of clients) {
      const socket = ws as { readyState: number; send: (data: string) => void };
      if (socket.readyState === 1) socket.send(json);
    }
  }

  // Subscribe to ALL events from EventStore and broadcast via WebSocket
  eventStore.onEvent((event) => broadcastToSession(event.sessionId, event));

  app.get('/ws/sessions/:sessionId', { websocket: true }, (socket, req) => {
    const sessionId = (req.params as { sessionId: string }).sessionId;
    if (!wsClients.has(sessionId)) wsClients.set(sessionId, new Set());
    wsClients.get(sessionId)!.add(socket);
    socket.on('close', () => { wsClients.get(sessionId)?.delete(socket); });
    socket.on('message', (raw: unknown) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'user.command') {
          eventStore.append(sessionId, 'user.command', { command: msg.command });
          if (!isAgentReady(sessionId)) {
            eventStore.append(sessionId, 'amp.agent.error' as EventType, {
              agent: 'openclaw',
              category: 'runtime',
              code: 'ERR_AGENT_NOT_READY',
              message: 'No connected agent has reported AMP readiness yet. Dashboard commands stay disabled until the agent calls /amp/agent/ready.',
              recoverable: true,
            });
            return;
          }
          // Forward command to the Sidecar inside the VM
          forwardCommandToVM(sessionId, msg.command).catch((err) => {
            const error = err as Error;
            eventStore.append(sessionId, 'amp.agent.error' as EventType, {
              agent: 'openclaw',
              category: 'network',
              code: 'ERR_COMMAND_FORWARD_FAILED',
              message: error.message,
              recoverable: true,
            });
          });
        }
      } catch { /* ignore */ }
    });
  });

  // ─── Terminal WebSocket (SimpleBox) ───
  app.get('/ws/sessions/:sessionId/terminal', { websocket: true }, (socket, req) => {
    const sessionId = (req.params as { sessionId: string }).sessionId;
    const session = sessionManager.get(sessionId);
    if (!session?.vmId) {
      (socket as any).close();
      return;
    }
    const driver = sessionManager.getDriverForSession(sessionId);
    const vmId = session.vmId;

    socket.on('message', async (raw: unknown) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'exec' && typeof msg.command === 'string') {
          const result = await driver.exec(vmId, msg.command);
          const ws = socket as { readyState: number; send: (data: string) => void };
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'output', stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }));
          }
        }
      } catch { /* ignore */ }
    });
  });

  // ─── Session GUI Ports ───
  app.get<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/gui-ports', async (req) => {
    const session = sessionManager.get(req.params.sessionId);
    if (!session) return { error: 'Session not found' };
    return { guiPorts: session.guiPorts ?? null };
  });

  // ─── Forward user commands to Sidecar inside VM ───
  async function forwardCommandToVM(sessionId: string, command: string): Promise<void> {
    await postToSidecar(sessionId, '/amp/command', {
      command,
      timestamp: Date.now(),
      transport: sessionManager.get(sessionId)?.agentTransport,
      sessionKey: sessionManager.get(sessionId)?.agentSessionKey,
    });
  }

  async function abortCommandInVM(sessionId: string, runId?: string): Promise<{ aborted: boolean }> {
    const session = sessionManager.get(sessionId);
    if (!session?.agentSessionKey) {
      throw new Error(`Session ${sessionId} has no active agent session key`);
    }

    const result = await postToSidecar(sessionId, '/amp/command/abort', {
      transport: session.agentTransport,
      sessionKey: session.agentSessionKey,
      runId,
    });
    return {
      aborted: result.aborted !== false,
    };
  }

  async function postToSidecar(sessionId: string, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const session = sessionManager.get(sessionId);
    if (!session?.vmId) {
      throw new Error(`Session ${sessionId} has no running VM`);
    }
    const driver = sessionManager.getDriverForSession(sessionId);
    const payload = JSON.stringify(body);
    const b64 = Buffer.from(payload).toString('base64');
    const cmd = `echo '${b64}' | base64 -d | NO_PROXY=127.0.0.1,localhost curl --noproxy "*" -fsS -X POST http://127.0.0.1:8801${path} -H 'Content-Type: application/json' -d @-`;
    console.log(`[forwardCommandToVM] Executing in VM ${session.vmId}: ${cmd.substring(0, 100)}...`);
    const result = await driver.exec(session.vmId, cmd);
    console.log(`[forwardCommandToVM] Result: exitCode=${result.exitCode}, stdout="${result.stdout}", stderr="${result.stderr}"`);
    if (result.exitCode !== 0) {
      const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join(' | ');
      throw new Error(`Failed to forward command into VM${detail ? `: ${detail}` : ''}`);
    }

    const stdout = result.stdout.trim();
    if (!stdout) {
      return { ok: true };
    }

    try {
      return JSON.parse(stdout) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`Sidecar returned invalid JSON: ${String(error)}`);
    }
  }

  function isAgentReady(sessionId: string): boolean {
    const events = eventStore.getEvents(sessionId, {
      types: ['amp.agent.ready', 'amp.agent.exit', 'amp.agent.fatal'],
    });
    let readySeq = -1;
    let terminalSeq = -1;
    for (const event of events) {
      if (event.type === 'amp.agent.ready') readySeq = event.seq;
      if (event.type === 'amp.agent.exit' || event.type === 'amp.agent.fatal') terminalSeq = event.seq;
    }
    return readySeq > terminalSeq;
  }

  async function resolveCronTargetSession(ownerSessionId: string, sessionTarget: string) {
    if (sessionTarget === 'current' || sessionTarget === 'main') {
      const session = sessionManager.get(ownerSessionId);
      if (!session) {
        throw new Error(`Owner session not found: ${ownerSessionId}`);
      }
      return session;
    }

    if (sessionTarget === 'isolated') {
      const ownerSession = sessionManager.get(ownerSessionId);
      if (!ownerSession) {
        throw new Error(`Owner session not found: ${ownerSessionId}`);
      }
      const spawned = await sessionManager.create(ownerSession.agentType, ownerSession.sandboxType);
      await sessionManager.start(spawned.id);
      if (ownerSession.agentType === 'openclaw') {
        await sessionManager.deployAgent(spawned.id, 'openclaw');
      }
      const target = sessionManager.get(spawned.id);
      if (!target) {
        throw new Error(`Failed to create isolated cron session for ${ownerSessionId}`);
      }
      return target;
    }

    if (sessionTarget.startsWith('session:')) {
      const targetSessionId = sessionTarget.slice('session:'.length);
      const session = sessionManager.get(targetSessionId);
      if (!session) {
        throw new Error(`Target session not found: ${targetSessionId}`);
      }
      return session;
    }

    const fallback = sessionManager.get(ownerSessionId);
    if (!fallback) {
      throw new Error(`Owner session not found: ${ownerSessionId}`);
    }
    return fallback;
  }
}
