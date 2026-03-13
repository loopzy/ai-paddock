import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { LLMProxy } from './llm-proxy/proxy.js';
import { FSWatcher } from './fs-watcher/watcher.js';
import { EventReporter } from './reporter.js';
import { ControlPlaneClient, parseControlPlaneUrls } from './control-plane-client.js';
import { PolicyGate } from './security/policy-gate.js';
import { AgentMonitor } from './agent-monitor.js';
import { createOpenClawGatewayInvoker, routeAgentCommand } from './command-router.js';
import type { AMPGateRequest, AMPGateVerdict, AMPAgentError } from '@paddock/types';

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

  const reporter = new EventReporter(controlPlaneClient, SESSION_ID);
  const policyGate = new PolicyGate(WATCH_DIR);

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
};

const ROLLBACKABLE_LOCAL_TOOLS = new Set(['write', 'edit', 'apply_patch']);
const HIGH_RISK_EXEC_PATTERN =
  /\b(apt(?:-get)?|apk|dnf|yum|pip3?|npm|pnpm|yarn)\s+(?:install|add|remove|uninstall|upgrade|update)\b|(?:^|\s)rm\s+-rf?\b|(?:^|\s)git\s+(?:clean|reset)\b/i;

export function createAmpGateServer(deps: AmpGateServerDeps) {
  return createServer(createAmpGateRequestHandler(deps));
}

export function createAmpGateRequestHandler(deps: AmpGateServerDeps) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'POST' && req.url === '/amp/gate') {
      await handleGateRequest(req, res, deps.policyGate, deps.reporter, deps.controlPlaneClient, deps.sessionId);
    } else if (req.method === 'POST' && req.url === '/amp/event') {
      await handleEventReport(req, res, deps.policyGate, deps.reporter);
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
    const verdict = gate.evaluate(body);

    // If verdict is 'ask', forward to Control Plane for HITL
    if (verdict.verdict === 'ask') {
      try {
        const hitlResp = await controlPlaneClient.fetch(`/api/sessions/${sessionId}/hitl/gate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ correlationId: body.correlationId, toolName: body.toolName, toolInput: body.toolInput, riskScore: verdict.riskScore, triggeredRules: verdict.triggeredRules }),
          signal: AbortSignal.timeout(300000), // 5 min timeout
        });
        const hitlDecision = await hitlResp.json() as { verdict: string };
        verdict.verdict = hitlDecision.verdict === 'approved' ? 'approve' : 'reject';
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
        snapshotRef: verdict.snapshotRef,
      },
      {
        correlationId: body.correlationId,
        snapshotRef: verdict.snapshotRef,
      },
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
async function handleEventReport(req: IncomingMessage, res: ServerResponse, gate: PolicyGate, reporter: EventReporter) {
  try {
    const body = JSON.parse(await collectBody(req)) as {
      toolName: string;
      result: string;
      path?: string;
      correlationId?: string;
      snapshotRef?: string;
    };
    gate.onToolResult(body.toolName, body.result, { path: body.path });
    if (body.toolName.startsWith('amp.')) {
      let payload: Record<string, unknown> = { result: body.result };
      try {
        payload = JSON.parse(body.result);
      } catch {
        // leave raw string payload
      }
      await reporter.report(
        body.toolName as any,
        payload,
        body.correlationId || body.snapshotRef
          ? { correlationId: body.correlationId, snapshotRef: body.snapshotRef }
          : undefined,
      );
    } else {
      let resultPayload: unknown = body.result;
      try {
        resultPayload = JSON.parse(body.result);
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
