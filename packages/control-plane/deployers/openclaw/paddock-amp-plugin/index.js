import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_SIDECAR_URL = 'http://127.0.0.1:8801';
const DEFAULT_WORKSPACE_ROOT = '/workspace';
const DEFAULT_LOG_FILE = '/tmp/openclaw/paddock-amp-plugin.log';

function resolveRuntimeConfig(api) {
  const pluginConfig =
    api && api.pluginConfig && typeof api.pluginConfig === 'object' ? api.pluginConfig : {};
  return {
    sidecarUrl:
      typeof pluginConfig.sidecarUrl === 'string' && pluginConfig.sidecarUrl.trim()
        ? pluginConfig.sidecarUrl.trim()
        : DEFAULT_SIDECAR_URL,
    workspaceRoot:
      typeof pluginConfig.workspaceRoot === 'string' && pluginConfig.workspaceRoot.trim()
        ? pluginConfig.workspaceRoot.trim()
        : DEFAULT_WORKSPACE_ROOT,
    logFile:
      typeof pluginConfig.logFile === 'string' && pluginConfig.logFile.trim()
        ? pluginConfig.logFile.trim()
        : DEFAULT_LOG_FILE,
  };
}

function ensureLogDir(logFile) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
  } catch {
    // best-effort logging only
  }
}

function createLogger(api, logFile) {
  ensureLogDir(logFile);
  return (message, extra) => {
    const prefix = `[paddock-amp] ${message}`;
    const suffix =
      extra && typeof extra === 'object' && Object.keys(extra).length > 0
        ? ` ${JSON.stringify(extra)}`
        : '';
    const line = `${new Date().toISOString()} ${prefix}${suffix}\n`;
    try {
      fs.appendFileSync(logFile, line, 'utf8');
    } catch {
      // best-effort logging only
    }
    if (api?.logger?.info) {
      api.logger.info(`${prefix}${suffix}`);
    } else {
      console.log(`${prefix}${suffix}`);
    }
  };
}

async function postJson(url, body, timeoutMs) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function eventPayload(toolName, params, ctx) {
  return {
    toolName,
    toolInput: params,
    runId: ctx?.runId,
    toolCallId: ctx?.toolCallId,
    agentId: ctx?.agentId,
    sessionKey: ctx?.sessionKey,
  };
}

function buildRiskHints(toolName, params) {
  const hints = [];
  if (['write', 'edit', 'apply_patch'].includes(toolName)) {
    hints.push('file-mutation');
  }
  if (['exec', 'process'].includes(toolName)) {
    hints.push('process-execution');
  }
  if (toolName === 'browser') {
    hints.push('browser-automation');
  }
  const toolPath = typeof params?.path === 'string' ? params.path : '';
  if (toolPath.startsWith('/etc/')) {
    hints.push('system-path');
  }
  return hints;
}

function keyFor(ctx, toolName) {
  return `${ctx?.runId ?? 'run'}:${ctx?.toolCallId ?? toolName}`;
}

function serializeResultPayload(event) {
  if (typeof event?.error === 'string' && event.error) {
    return {
      error: event.error,
      durationMs: event.durationMs,
    };
  }
  return {
    result: event?.result,
    durationMs: event?.durationMs,
  };
}

export default {
  id: 'paddock-amp',
  register(api) {
    const config = resolveRuntimeConfig(api);
    const log = createLogger(api, config.logFile);
    const correlationByToolCall = new Map();

    log('plugin loaded', {
      sidecarUrl: config.sidecarUrl,
      workspaceRoot: config.workspaceRoot,
      logFile: config.logFile,
    });

    api.on(
      'before_tool_call',
      async (event, ctx) => {
        const params = event?.params && typeof event.params === 'object' ? { ...event.params } : {};
        const toolName = typeof event?.toolName === 'string' ? event.toolName : 'unknown';
        const correlationId = randomUUID();
        const key = keyFor(ctx, toolName);

        log('before_tool_call:start', {
          toolName,
          correlationId,
          runId: ctx?.runId,
          toolCallId: ctx?.toolCallId,
        });

        try {
          await postJson(
            `${config.sidecarUrl}/amp/event`,
            {
              toolName: 'amp.tool.intent',
              result: JSON.stringify({
                ...eventPayload(toolName, params, ctx),
                correlationId,
              }),
            },
            2000,
          );
        } catch (error) {
          log('before_tool_call:intent-report-failed', {
            toolName,
            correlationId,
            error: String(error),
          });
        }

        let verdict;
        try {
          verdict = await postJson(
            `${config.sidecarUrl}/amp/gate`,
            {
              correlationId,
              toolName,
              toolInput: params,
              session: {
                agentId: ctx?.agentId,
                sessionKey: ctx?.sessionKey,
                runId: ctx?.runId,
              },
              workspace: {
                root: config.workspaceRoot,
              },
              riskHints: buildRiskHints(toolName, params),
            },
            300000,
          );
        } catch (error) {
          log('before_tool_call:gate-failed', {
            toolName,
            correlationId,
            error: String(error),
          });
          return {
            block: true,
            blockReason: `Paddock AMP Gate unreachable: ${String(error)}`,
          };
        }

        log('before_tool_call:gate-verdict', {
          toolName,
          correlationId,
          verdict: verdict?.verdict ?? 'unknown',
          snapshotRef: verdict?.snapshotRef ?? null,
        });

        if (verdict?.verdict === 'reject' || verdict?.verdict === 'ask') {
          return {
            block: true,
            blockReason: typeof verdict?.reason === 'string' ? verdict.reason : 'Blocked by Paddock AMP Gate',
          };
        }

        correlationByToolCall.set(key, {
          correlationId,
          snapshotRef: typeof verdict?.snapshotRef === 'string' ? verdict.snapshotRef : undefined,
        });

        if (verdict?.verdict === 'modify' && verdict?.modifiedInput && typeof verdict.modifiedInput === 'object') {
          return { params: verdict.modifiedInput };
        }

        return { params };
      },
      { priority: 1000 },
    );

    api.on('after_tool_call', async (event, ctx) => {
      const toolName = typeof event?.toolName === 'string' ? event.toolName : 'unknown';
      const key = keyFor(ctx, toolName);
      const metadata = correlationByToolCall.get(key) ?? {};
      correlationByToolCall.delete(key);

      log('after_tool_call:start', {
        toolName,
        correlationId: metadata.correlationId ?? null,
        runId: ctx?.runId,
        toolCallId: ctx?.toolCallId,
        hadError: typeof event?.error === 'string' && Boolean(event.error),
      });

      try {
        await postJson(
          `${config.sidecarUrl}/amp/event`,
          {
            toolName,
            result: JSON.stringify(serializeResultPayload(event)),
            correlationId: metadata.correlationId,
            snapshotRef: metadata.snapshotRef,
            path: typeof event?.params?.path === 'string' ? event.params.path : undefined,
          },
          5000,
        );
        log('after_tool_call:reported', {
          toolName,
          correlationId: metadata.correlationId ?? null,
          snapshotRef: metadata.snapshotRef ?? null,
        });
      } catch (error) {
        log('after_tool_call:report-failed', {
          toolName,
          correlationId: metadata.correlationId ?? null,
          error: String(error),
        });
      }
    });
  },
};
