import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { LLMProxy } from './llm-proxy/proxy.js';
import { FSWatcher } from './fs-watcher/watcher.js';
import { EventReporter } from './reporter.js';
import { ControlPlaneClient, parseControlPlaneUrls } from './control-plane-client.js';
import { PolicyGate } from './security/policy-gate.js';
import { createBehaviorAnalyzerFromEnv, getBehaviorLLMConfigFromEnv } from './security/behavior-analyzer-factory.js';
import { AgentMonitor } from './agent-monitor.js';
import { abortAgentCommand, createOpenClawGatewayAborter, createOpenClawGatewayInvoker, routeAgentCommand } from './command-router.js';
import type { AMPGateRequest, AMPGateVerdict, AMPAgentError } from '@paddock/types';
import { SensitiveDataVault } from './vault/sensitive-data-vault.js';
import { HeuristicLLMObservationSanitizer, type LLMObservationSanitizer } from './security/llm-observation-sanitizer.js';
import type { LLMObservationReviewer } from './security/llm-observation-reviewer.js';
import { createLLMObservationReviewerFromEnv, createLLMObservationSanitizerFromEnv } from './security/llm-observation-factory.js';

const COMMAND_FILE = process.env.PADDOCK_COMMAND_FILE ?? '/tmp/paddock-commands.jsonl';

const CONTROL_PLANE_URL = process.env.PADDOCK_CONTROL_URL ?? '';
const CONTROL_PLANE_URL_CANDIDATES = process.env.PADDOCK_CONTROL_URL_CANDIDATES ?? '';
const SESSION_ID = process.env.PADDOCK_SESSION_ID ?? '';
const WATCH_DIR = process.env.PADDOCK_WATCH_DIR ?? '/workspace';
const PROXY_PORT = Number(process.env.PADDOCK_PROXY_PORT ?? 8800);
const GATE_PORT = Number(process.env.PADDOCK_GATE_PORT ?? 8801);

async function main() {
  if (!SESSION_ID) {
    console.error('PADDOCK_SESSION_ID is required');
    process.exit(1);
  }

  const controlPlaneClient = new ControlPlaneClient(parseControlPlaneUrls(CONTROL_PLANE_URL, CONTROL_PLANE_URL_CANDIDATES));
  const controlPlaneUrl = await controlPlaneClient.resolveReachable();
  console.log(`Resolved control plane URL: ${controlPlaneUrl}`);
  const behaviorLLMConfig = getBehaviorLLMConfigFromEnv();
  if (behaviorLLMConfig) {
    console.log(
      `Behavior review LLM enabled: provider=${behaviorLLMConfig.provider} model=${behaviorLLMConfig.model} baseUrl=${behaviorLLMConfig.baseUrl ?? '(default)'} timeoutMs=${behaviorLLMConfig.timeoutMs}`,
    );
  } else {
    console.log('Behavior review LLM disabled');
  }

  const reporter = new EventReporter(controlPlaneClient, SESSION_ID);
  const policyGate = new PolicyGate({
    workspace: WATCH_DIR,
    behaviorAnalyzer: createBehaviorAnalyzerFromEnv(),
  });
  const llmObservationSanitizer = createLLMObservationSanitizerFromEnv();
  const llmObservationReviewer = createLLMObservationReviewerFromEnv();

  // LLM Proxy
  const llmProxy = new LLMProxy(PROXY_PORT, reporter, controlPlaneClient, SESSION_ID);
  await llmProxy.start();
  console.log(`LLM Proxy listening on :${PROXY_PORT}`);

  // FS Watcher
  const fsWatcher = new FSWatcher(WATCH_DIR, reporter);
  fsWatcher.start();
  console.log(`FS Watcher monitoring ${WATCH_DIR}`);

  // Agent Monitor
  const agentName = process.env.PADDOCK_AGENT_NAME ?? 'unknown';
  const agentProcessPattern = process.env.PADDOCK_AGENT_PROCESS ?? 'openclaw';
  const agentMonitor = new AgentMonitor(reporter, agentName, agentProcessPattern);

  // AMP Gate server (port 8801)
  const gateServer = createAmpGateServer({
    sessionId: SESSION_ID,
    controlPlaneClient,
    commandFile: COMMAND_FILE,
    policyGate,
    reporter,
    agentMonitor,
    llmObservationSanitizer,
    llmObservationReviewer,
  });

  gateServer.on('error', (err) => {
    console.error('AMP Gate failed:', err);
    process.exit(1);
  });

  gateServer.listen(GATE_PORT, '127.0.0.1', () => {
    console.log(`AMP Gate listening on :${GATE_PORT}`);
  });

  process.on('SIGTERM', () => {
    agentMonitor.stop();
    llmProxy.stop();
    fsWatcher.stop();
    gateServer.close();
    process.exit(0);
  });
}

function collectBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

type AmpGateServerDeps = {
  sessionId: string;
  controlPlaneClient: ControlPlaneClient;
  commandFile?: string;
  policyGate: PolicyGate;
  reporter: EventReporter;
  agentMonitor: AgentMonitor;
  ampEventVault?: SensitiveDataVault;
  llmObservationSanitizer?: LLMObservationSanitizer | null;
  llmObservationReviewer?: LLMObservationReviewer | null;
};

const ROLLBACKABLE_LOCAL_TOOLS = new Set(['write', 'edit', 'apply_patch']);
const HIGH_RISK_EXEC_PATTERN =
  /\b(apt(?:-get)?|apk|dnf|yum|pip3?|npm|pnpm|yarn)\s+(?:install|add|remove|uninstall|upgrade|update)\b|(?:^|\s)rm\s+-rf?\b|(?:^|\s)git\s+(?:clean|reset)\b/i;
const OBSERVATIONAL_AMP_EVENTS = new Set(['amp.llm.request', 'amp.llm.response']);
const FALLBACK_LLM_OBSERVATION_SANITIZER = new HeuristicLLMObservationSanitizer();

export function createAmpGateServer(deps: AmpGateServerDeps) {
  return createServer(createAmpGateRequestHandler(deps));
}

function mergeVaultSummary(
  payload: Record<string, unknown>,
  secretsFound: number,
  categories: string[],
): Record<string, unknown> {
  const existingVault =
    payload.vault && typeof payload.vault === 'object'
      ? (payload.vault as Record<string, unknown>)
      : undefined;
  const existingCategories = Array.isArray(existingVault?.categories)
    ? existingVault.categories.filter((value): value is string => typeof value === 'string')
    : [];
  const existingSecretsMasked =
    typeof existingVault?.secretsMasked === 'number' ? existingVault.secretsMasked : 0;

  return {
    ...payload,
    vault: {
      ...(existingVault ?? {}),
      secretsMasked: existingSecretsMasked + secretsFound,
      categories: Array.from(new Set([...existingCategories, ...categories])),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

type ObservationMaskResult = {
  value: unknown;
  secretsFound: number;
  categories: string[];
};

function maskObservationValue(value: unknown, vault: SensitiveDataVault): ObservationMaskResult {
  if (typeof value === 'string') {
    const masked = vault.mask(value);
    return {
      value: masked.masked,
      secretsFound: masked.secretsFound,
      categories: masked.categories,
    };
  }

  if (Array.isArray(value)) {
    let secretsFound = 0;
    const categories = new Set<string>();
    const items = value.map((item) => {
      const masked = maskObservationValue(item, vault);
      secretsFound += masked.secretsFound;
      for (const category of masked.categories) categories.add(category);
      return masked.value;
    });
    return {
      value: items,
      secretsFound,
      categories: Array.from(categories),
    };
  }

  if (isRecord(value)) {
    let secretsFound = 0;
    const categories = new Set<string>();
    const entries = Object.entries(value).map(([key, entryValue]) => {
      const masked = maskObservationValue(entryValue, vault);
      secretsFound += masked.secretsFound;
      for (const category of masked.categories) categories.add(category);
      return [key, masked.value] as const;
    });
    return {
      value: Object.fromEntries(entries),
      secretsFound,
      categories: Array.from(categories),
    };
  }

  return {
    value,
    secretsFound: 0,
    categories: [],
  };
}

function prepareObservationalPayload(
  rawResult: string,
  vault: SensitiveDataVault,
): { payload: Record<string, unknown>; maskedRaw?: ReturnType<SensitiveDataVault['mask']> } {
  try {
    const parsed = JSON.parse(rawResult) as unknown;
    if (isRecord(parsed)) {
      const masked = maskObservationValue(parsed, vault);
      let payload = masked.value as Record<string, unknown>;
      if (masked.secretsFound > 0) {
        payload = mergeVaultSummary(payload, masked.secretsFound, masked.categories);
      }
      return { payload };
    }
  } catch {
    // Fall back to raw-string masking below.
  }

  const maskedRaw = vault.mask(rawResult);
  const payload =
    maskedRaw.secretsFound > 0
      ? mergeVaultSummary({ result: maskedRaw.masked }, maskedRaw.secretsFound, maskedRaw.categories)
      : { result: maskedRaw.masked };
  return { payload, maskedRaw };
}

export function createAmpGateRequestHandler(deps: AmpGateServerDeps) {
  const ampEventVault = deps.ampEventVault ?? new SensitiveDataVault();
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'POST' && req.url === '/amp/gate') {
      await handleGateRequest(req, res, deps.policyGate, deps.reporter, deps.controlPlaneClient, deps.sessionId);
    } else if (req.method === 'POST' && req.url === '/amp/event') {
      await handleEventReport(
        req,
        res,
        deps.policyGate,
        deps.reporter,
        ampEventVault,
        deps.llmObservationSanitizer ?? null,
        deps.llmObservationReviewer ?? null,
      );
    } else if (req.method === 'GET' && req.url === '/amp/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessionId: deps.sessionId }));
    } else if (req.method === 'POST' && req.url === '/amp/agent/ready') {
      await handleAgentReady(req, res, deps.agentMonitor);
    } else if (req.method === 'POST' && req.url === '/amp/agent/error') {
      await handleAgentError(req, res, deps.agentMonitor);
    } else if (req.method === 'POST' && req.url === '/amp/agent/exit') {
      await handleAgentExit(req, res, deps.agentMonitor);
    } else if (req.method === 'POST' && req.url === '/amp/command') {
      await handleCommand(req, res, deps.reporter, deps.commandFile ?? COMMAND_FILE);
    } else if (req.method === 'POST' && req.url === '/amp/command/abort') {
      await handleCommandAbort(req, res, deps.reporter);
    } else if (req.method === 'POST' && req.url === '/amp/control') {
      await proxyToControlPlane(req, res, deps.controlPlaneClient, `/api/sessions/${deps.sessionId}/amp/control`);
    } else if (req.method === 'GET' && req.url === '/mcp/tools') {
      await proxyToControlPlane(req, res, deps.controlPlaneClient, `/api/sessions/${deps.sessionId}/mcp/tools`);
    } else if (req.method === 'POST' && req.url === '/mcp/call') {
      await proxyToControlPlane(req, res, deps.controlPlaneClient, `/api/sessions/${deps.sessionId}/mcp/call`);
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  };
}

/**
 * POST /amp/gate — synchronous tool call approval.
 * Blocks until verdict is returned (may wait for HITL).
 */
async function handleGateRequest(req: IncomingMessage, res: ServerResponse, gate: PolicyGate, reporter: EventReporter, controlPlaneClient: ControlPlaneClient, sessionId: string) {
  try {
    const body = JSON.parse(await collectBody(req)) as AMPGateRequest;
    const verdict = await gate.evaluate(body);

    // If verdict is 'ask', forward to Control Plane for HITL
    if (verdict.verdict === 'ask') {
      try {
        const hitlResp = await controlPlaneClient.fetch(`/api/sessions/${sessionId}/hitl/gate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ correlationId: body.correlationId, toolName: body.toolName, toolInput: body.toolInput, riskScore: verdict.riskScore, triggeredRules: verdict.triggeredRules }),
          signal: AbortSignal.timeout(300000), // 5 min timeout
        });
        const hitlDecision = await hitlResp.json() as { verdict: string; modifiedArgs?: Record<string, unknown> };
        if (hitlDecision.verdict === 'approved') {
          verdict.verdict = 'approve';
        } else if (hitlDecision.verdict === 'modified') {
          if (hitlDecision.modifiedArgs && typeof hitlDecision.modifiedArgs === 'object') {
            verdict.verdict = 'modify';
            verdict.modifiedInput = hitlDecision.modifiedArgs;
          } else {
            verdict.verdict = 'reject';
            verdict.reason = 'HITL returned a modified verdict without updated arguments';
          }
        } else {
          verdict.verdict = 'reject';
        }
      } catch {
        verdict.verdict = 'reject';
        verdict.reason = 'HITL timeout or error';
      }
    }

    if (verdict.verdict !== 'reject') {
      try {
        const snapshotRef = await createCheckpointIfNeeded(controlPlaneClient, sessionId, body);
        if (snapshotRef) {
          verdict.snapshotRef = snapshotRef;
        }
      } catch (err) {
        verdict.verdict = 'reject';
        verdict.reason = `Failed to create rollback checkpoint: ${String(err)}`;
      }
    }

    // Report the final verdict, including any checkpoint metadata.
    await reporter.report(
      'amp.gate.verdict' as any,
      {
        correlationId: body.correlationId,
        toolName: body.toolName,
        verdict: verdict.verdict,
        riskScore: verdict.riskScore,
        triggeredRules: verdict.triggeredRules,
        behaviorFlags: verdict.behaviorFlags,
        behaviorReview: verdict.behaviorReview,
        riskBreakdown: verdict.riskBreakdown,
        llmReview: verdict.llmReview,
        modifiedInput: verdict.modifiedInput,
        snapshotRef: verdict.snapshotRef,
      },
      {
        correlationId: body.correlationId,
        snapshotRef: verdict.snapshotRef,
      },
    );
    console.log(
      `[amp.gate] tool=${body.toolName} verdict=${verdict.verdict} risk=${verdict.riskScore} rules=${verdict.triggeredRules.join('|') || 'none'} behaviorSource=${verdict.behaviorReview?.source ?? 'none'} behaviorRisk=${verdict.behaviorReview?.riskBoost ?? 0} trustPenalty=${verdict.riskBreakdown?.trustPenalty ?? 0}`,
    );

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(verdict));
  } catch (err) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: String(err) }));
  }
}

/**
 * POST /amp/event — receive tool result events for taint tracking.
 */
async function handleEventReport(
  req: IncomingMessage,
  res: ServerResponse,
  gate: PolicyGate,
  reporter: EventReporter,
  ampEventVault: SensitiveDataVault,
  llmObservationSanitizer: LLMObservationSanitizer | null,
  llmObservationReviewer: LLMObservationReviewer | null,
) {
  try {
    const body = JSON.parse(await collectBody(req)) as {
      toolName: string;
      result: string;
      path?: string;
      correlationId?: string;
      snapshotRef?: string;
    };
    const shouldSanitizeObservationalEvent = OBSERVATIONAL_AMP_EVENTS.has(body.toolName);
    const observationalPayload = shouldSanitizeObservationalEvent
      ? prepareObservationalPayload(body.result, ampEventVault)
      : undefined;
    const sanitizedResult = observationalPayload?.maskedRaw;
    const effectiveResult = sanitizedResult?.masked ?? body.result;

    if (!shouldSanitizeObservationalEvent) {
      gate.onToolResult(body.toolName, effectiveResult, { path: body.path });
    }
    if (body.toolName.startsWith('amp.')) {
      let payload: Record<string, unknown> = observationalPayload?.payload ?? { result: effectiveResult };
      if (!observationalPayload) {
        try {
          payload = JSON.parse(effectiveResult);
        } catch {
          // leave raw string payload
        }
      }
      if (body.toolName === 'amp.llm.request' || body.toolName === 'amp.llm.response') {
        const sanitizer = llmObservationSanitizer ?? FALLBACK_LLM_OBSERVATION_SANITIZER;
        const observation =
          body.toolName === 'amp.llm.request'
            ? await sanitizer.sanitizeRequest(payload)
            : await sanitizer.sanitizeResponse(payload);
        payload = {
          ...payload,
          reviewSanitization: {
            source: observation.source,
            summary: observation.summary,
          },
        };

        const review =
          llmObservationReviewer == null
            ? null
            : body.toolName === 'amp.llm.request'
              ? await llmObservationReviewer.reviewRequest(observation)
              : await llmObservationReviewer.reviewResponse(observation);

        if (review && typeof (gate as { onLLMReview?: unknown }).onLLMReview === 'function') {
          gate.onLLMReview({
            phase: review.phase,
            verdict: review.verdict,
            riskScore: review.riskScore,
            triggered: review.triggered,
            reason: review.reason,
            confidence: review.confidence,
            source: review.source,
            summary: observation.summary,
          });
        }

        await reporter.report(
          body.toolName as any,
          payload,
          body.correlationId || body.snapshotRef
            ? { correlationId: body.correlationId, snapshotRef: body.snapshotRef }
            : undefined,
        );

        await reporter.report(
          'amp.llm.review' as any,
          {
            phase: observation.phase,
            provider: observation.provider,
            model: observation.model,
            runId: observation.runId,
            sessionId: observation.sessionId,
            sessionKey: observation.sessionKey,
            agentId: observation.agentId,
            sanitizer: {
              source: observation.source,
              summary: observation.summary,
              details: observation.details,
            },
            review: review ?? undefined,
          },
          body.correlationId || body.snapshotRef
            ? { correlationId: body.correlationId, snapshotRef: body.snapshotRef }
            : undefined,
        );
      } else {
        await reporter.report(
          body.toolName as any,
          payload,
          body.correlationId || body.snapshotRef
            ? { correlationId: body.correlationId, snapshotRef: body.snapshotRef }
            : undefined,
        );
      }
    } else {
      let resultPayload: unknown = effectiveResult;
      try {
        resultPayload = JSON.parse(effectiveResult);
      } catch {
        // leave string result as-is
      }
      await reporter.report(
        'amp.tool.result' as any,
        {
          toolName: body.toolName,
          result: resultPayload,
          path: body.path,
        },
        body.correlationId || body.snapshotRef
          ? { correlationId: body.correlationId, snapshotRef: body.snapshotRef }
          : undefined,
      );
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: String(err) }));
  }
}

/**
 * POST /amp/agent/ready — agent reports it's ready.
 */
async function handleAgentReady(req: IncomingMessage, res: ServerResponse, monitor: AgentMonitor) {
  try {
    const body = JSON.parse(await collectBody(req)) as { version?: string; capabilities?: string[] };
    const ok = await monitor.reportReady(body.version, body.capabilities);
    if (!ok) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to forward amp.agent.ready to control plane' }));
      return;
    }
    monitor.start();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: String(err) }));
  }
}

/**
 * POST /amp/agent/error — agent reports a categorized error.
 */
async function handleAgentError(req: IncomingMessage, res: ServerResponse, monitor: AgentMonitor) {
  try {
    const body = JSON.parse(await collectBody(req)) as AMPAgentError;
    const ok = await monitor.reportError(body);
    if (!ok) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to forward amp.agent.error to control plane' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: String(err) }));
  }
}

/**
 * POST /amp/agent/exit — agent reports it's exiting.
 */
async function handleAgentExit(req: IncomingMessage, res: ServerResponse, monitor: AgentMonitor) {
  try {
    const body = JSON.parse(await collectBody(req)) as { exitCode: number; reason: 'normal' | 'crash' | 'killed' | 'oom' };
    const ok = await monitor.reportExit(body.exitCode, body.reason);
    if (!ok) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to forward amp.agent.exit to control plane' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: String(err) }));
  }
}

/**
 * POST /amp/command — receive a user command from the Control Plane.
 * Writes the command to a JSONL file that the AMP adapter polls.
 */
async function handleCommand(req: IncomingMessage, res: ServerResponse, reporter: EventReporter, commandFile: string) {
  try {
    const body = JSON.parse(await collectBody(req)) as {
      command: string;
      timestamp?: number;
      transport?: 'amp-command-file' | 'openclaw-gateway';
      sessionKey?: string;
    };
    await routeAgentCommand({
      envelope: body,
      commandFile,
      reporter,
      gatewayInvoker: createOpenClawGatewayInvoker(),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: String(err) }));
  }
}

async function handleCommandAbort(req: IncomingMessage, res: ServerResponse, reporter: EventReporter) {
  try {
    const body = JSON.parse(await collectBody(req)) as {
      transport?: 'amp-command-file' | 'openclaw-gateway';
      sessionKey?: string;
      runId?: string;
    };
    const result = await abortAgentCommand({
      transport: body.transport ?? 'openclaw-gateway',
      sessionKey: body.sessionKey,
      runId: body.runId,
      reporter,
      gatewayAborter: createOpenClawGatewayAborter(),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, aborted: result.aborted, runId: body.runId ?? null }));
  } catch (err) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: String(err) }));
  }
}

async function proxyToControlPlane(req: IncomingMessage, res: ServerResponse, controlPlaneClient: ControlPlaneClient, targetPath: string) {
  try {
    const body = req.method === 'GET' ? undefined : await collectBody(req);
    const response = await controlPlaneClient.fetch(targetPath, {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const text = await response.text();
    res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') ?? 'application/json' });
    res.end(text);
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Failed to reach control plane: ${String(err)}` }));
  }
}

function requiresCheckpoint(toolName: string, toolInput: Record<string, unknown>): boolean {
  const normalized = toolName.trim().toLowerCase();
  if (ROLLBACKABLE_LOCAL_TOOLS.has(normalized)) {
    return true;
  }
  if (normalized !== 'exec') {
    return false;
  }

  const command = typeof toolInput.command === 'string' ? toolInput.command : '';
  return HIGH_RISK_EXEC_PATTERN.test(command);
}

async function createCheckpointIfNeeded(
  controlPlaneClient: ControlPlaneClient,
  sessionId: string,
  request: AMPGateRequest,
): Promise<string | undefined> {
  if (!requiresCheckpoint(request.toolName, request.toolInput)) {
    return undefined;
  }

  const response = await controlPlaneClient.fetch(`/api/sessions/${sessionId}/snapshots`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      label: `checkpoint:${request.toolName}:${request.correlationId}`,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`snapshot request failed with HTTP ${response.status}: ${text}`);
  }

  const body = (await response.json()) as { id?: unknown };
  if (typeof body.id !== 'string' || body.id.length === 0) {
    throw new Error('snapshot endpoint did not return an id');
  }

  return body.id;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Sidecar failed to start:', err);
    process.exit(1);
  });
}
