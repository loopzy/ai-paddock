import { appendFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EventReporter } from './reporter.js';

const execFileAsync = promisify(execFile);
const GATEWAY_COMMAND_TIMEOUT_MS = 30_000;

type GatewayCliResponse = {
  runId?: string;
  aborted?: boolean;
  status?: string;
  error?: unknown;
  message?: unknown;
  summary?: unknown;
};

export type AgentCommandEnvelope = {
  command: string;
  timestamp?: number;
  transport?: 'amp-command-file' | 'openclaw-gateway';
  sessionKey?: string;
};

export type GatewayCommandReceipt = {
  runId?: string;
};

export type GatewayAbortReceipt = {
  aborted: boolean;
};

export type GatewayCommandInvoker = (command: AgentCommandEnvelope) => Promise<GatewayCommandReceipt>;
export type GatewayAbortInvoker = (params: { sessionKey: string; runId?: string }) => Promise<GatewayAbortReceipt>;

export async function routeAgentCommand(params: {
  envelope: AgentCommandEnvelope;
  commandFile: string;
  reporter: EventReporter;
  gatewayInvoker?: GatewayCommandInvoker;
}): Promise<void> {
  const transport = params.envelope.transport ?? 'amp-command-file';
  let receipt: GatewayCommandReceipt | undefined;

  if (transport === 'openclaw-gateway') {
    if (!params.gatewayInvoker) {
      throw new Error('OpenClaw gateway transport is not configured in this Sidecar');
    }
    receipt = await params.gatewayInvoker(params.envelope);
  } else {
    const entry = {
      command: params.envelope.command,
      timestamp: params.envelope.timestamp ?? Date.now(),
    };
    appendFileSync(params.commandFile, JSON.stringify(entry) + '\n');
  }

  const runId = typeof receipt?.runId === 'string' && receipt.runId.trim() ? receipt.runId.trim() : undefined;
  const eventPayload = {
    command: params.envelope.command,
    transport,
    runId,
    sessionKey: params.envelope.sessionKey,
  };
  await params.reporter.report('amp.user.command' as any, eventPayload);
  await params.reporter.report('amp.command.status' as any, {
    ...eventPayload,
    status: 'accepted',
  });
}

export async function abortAgentCommand(params: {
  transport?: 'amp-command-file' | 'openclaw-gateway';
  sessionKey?: string;
  runId?: string;
  reporter: EventReporter;
  gatewayAborter?: GatewayAbortInvoker;
}): Promise<GatewayAbortReceipt> {
  const transport = params.transport ?? 'amp-command-file';
  if (transport !== 'openclaw-gateway') {
    throw new Error('The current agent transport does not support aborting commands');
  }
  if (!params.gatewayAborter) {
    throw new Error('OpenClaw gateway abort transport is not configured in this Sidecar');
  }
  if (!params.sessionKey?.trim()) {
    throw new Error('OpenClaw gateway abort requires a sessionKey');
  }

  const result = await params.gatewayAborter({
    sessionKey: params.sessionKey.trim(),
    runId: params.runId?.trim() || undefined,
  });

  await params.reporter.report('amp.command.status' as any, {
    status: result.aborted ? 'aborted' : 'abort-requested',
    runId: params.runId?.trim() || undefined,
    sessionKey: params.sessionKey.trim(),
  });

  return result;
}

function createGatewayCli() {
  const nodeBinary = process.env.PADDOCK_OPENCLAW_NODE ?? 'node';
  const openclawEntrypoint =
    process.env.PADDOCK_OPENCLAW_ENTRYPOINT ?? '/opt/paddock/openclaw-runtime/openclaw.mjs';
  const gatewayPort = process.env.PADDOCK_OPENCLAW_GATEWAY_PORT ?? '18789';
  const openclawStateDir = process.env.OPENCLAW_STATE_DIR ?? '/workspace/.openclaw';
  const openclawConfigPath = process.env.OPENCLAW_CONFIG_PATH ?? `${openclawStateDir}/openclaw.json`;

  const gatewayEnv = {
    ...process.env,
    NO_PROXY: process.env.NO_PROXY ?? '127.0.0.1,localhost',
    OPENCLAW_SKIP_CHANNELS: process.env.OPENCLAW_SKIP_CHANNELS ?? '1',
    OPENCLAW_STATE_DIR: openclawStateDir,
    OPENCLAW_CONFIG_PATH: openclawConfigPath,
    OPENCLAW_GATEWAY_PORT: gatewayPort,
  };

  const parseGatewayCliResponse = (stdout: string): GatewayCliResponse => {
    const trimmed = stdout.trim();
    if (!trimmed) {
      return {};
    }

    try {
      return JSON.parse(trimmed) as GatewayCliResponse;
    } catch (error) {
      throw new Error(`OpenClaw gateway CLI returned invalid JSON: ${String(error)}`);
    }
  };

  const callGateway = async (method: string, params: Record<string, unknown>, timeoutMs: number) => {
    const argv = [
      openclawEntrypoint,
      'gateway',
      'call',
      method,
      '--json',
      '--timeout',
      String(timeoutMs),
      '--port',
      gatewayPort,
      '--params',
      JSON.stringify(params),
    ];

    console.log(
      `[openclaw-gateway] invoking ${method} port=${gatewayPort} params=${JSON.stringify(params)}`,
    );

    try {
      const { stdout, stderr } = await execFileAsync(nodeBinary, argv, { env: gatewayEnv });
      if (stderr.trim()) {
        console.log(`[openclaw-gateway] ${method} stderr=${stderr.trim()}`);
      }
      console.log(`[openclaw-gateway] ${method} raw-response=${stdout.trim()}`);
      return parseGatewayCliResponse(stdout);
    } catch (error) {
      const execError = error as Error & { stdout?: string; stderr?: string };
      const stdout = execError.stdout?.trim();
      const stderr = execError.stderr?.trim();
      console.error(
        `[openclaw-gateway] ${method} failed: ${execError.message}${stdout ? ` | stdout=${stdout}` : ''}${stderr ? ` | stderr=${stderr}` : ''}`,
      );
      throw error;
    }
  };

  return { callGateway };
}

export function createOpenClawGatewayInvoker(): GatewayCommandInvoker {
  const { callGateway } = createGatewayCli();

  return async (command) => {
    const sessionKey = command.sessionKey?.trim();
    if (!sessionKey) {
      throw new Error('OpenClaw gateway transport requires a sessionKey');
    }

    console.log(
      `[openclaw-gateway] dispatching command sessionKey=${sessionKey} chars=${command.command.length}`,
    );
    const sendResponse = await callGateway(
      'chat.send',
      {
        sessionKey,
        message: command.command,
        idempotencyKey: `paddock-${Date.now()}`,
      },
      GATEWAY_COMMAND_TIMEOUT_MS,
    );

    const runId = typeof sendResponse.runId === 'string' ? sendResponse.runId.trim() : '';
    if (!runId) {
      throw new Error('OpenClaw chat.send did not return a runId');
    }

    console.log(`[openclaw-gateway] chat.send accepted runId=${runId}`);

    return { runId };
  };
}

export function createOpenClawGatewayAborter(): GatewayAbortInvoker {
  const { callGateway } = createGatewayCli();

  return async ({ sessionKey, runId }) => {
    const abortResponse = await callGateway(
      'chat.abort',
      runId ? { sessionKey, runId } : { sessionKey },
      GATEWAY_COMMAND_TIMEOUT_MS,
    );

    return {
      aborted: abortResponse.aborted !== false,
    };
  };
}
