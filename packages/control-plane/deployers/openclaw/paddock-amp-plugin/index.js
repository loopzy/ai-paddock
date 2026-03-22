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

function contextPayload(ctx) {
  return {
    runId: ctx?.runId,
    toolCallId: ctx?.toolCallId,
    agentId: ctx?.agentId,
    sessionKey: ctx?.sessionKey,
  };
}

function normalizeHookEvent(event) {
  return event && typeof event === 'object' ? { ...event } : {};
}

function buildRiskHints(toolName, params) {
  const hints = [];
  if (['write', 'edit', 'apply_patch'].includes(toolName)) {
    hints.push('file-mutation');
  }
  if (['exec', 'process'].includes(toolName)) {
    hints.push('process-execution');
  }
  if (['browser', 'web_fetch', 'web_search'].includes(toolName)) {
    hints.push('browser-automation');
  }
  if (['web_fetch', 'web_search', 'browser', 'message', 'tts', 'nodes', 'canvas'].includes(toolName)) {
    hints.push('network-or-external-io');
  }
  const toolPath = typeof params?.path === 'string' ? params.path : '';
  if (toolPath.startsWith('/etc/')) {
    hints.push('system-path');
  }
  return hints;
}

function normalizeShellStyledPath(value) {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  const redirectMatch = trimmed.match(/^(?::>|>)\s+(.+)$/);
  if (redirectMatch) {
    return redirectMatch[1].trim();
  }
  const catRedirectMatch = trimmed.match(/^cat\s+>\s+(.+)$/i);
  if (catRedirectMatch) {
    return catRedirectMatch[1].trim();
  }
  return value;
}

function normalizeExecCommand(command) {
  if (typeof command !== 'string') {
    return command;
  }

  const trimmed = command.trim();
  const mkdirAfterRedirectMatch = trimmed.match(/^(?::>|>)\s+(.+?)\s*&&\s*mkdir\s+-p\s+(.+)$/i);
  if (mkdirAfterRedirectMatch) {
    const redirectedPath = mkdirAfterRedirectMatch[1].trim();
    const mkdirPath = mkdirAfterRedirectMatch[2].trim();
    if (redirectedPath === mkdirPath) {
      return `mkdir -p ${mkdirPath}`;
    }
  }

  return command;
}

function normalizeToolParams(toolName, params) {
  if (!params || typeof params !== 'object') {
    return params;
  }

  const normalized = { ...params };

  if (['read', 'write', 'edit', 'apply_patch'].includes(toolName)) {
    if (typeof normalized.path === 'string') {
      normalized.path = normalizeShellStyledPath(normalized.path);
    }
    if (typeof normalized.file_path === 'string') {
      normalized.file_path = normalizeShellStyledPath(normalized.file_path);
    }
  }

  if (toolName === 'exec' && typeof normalized.command === 'string') {
    normalized.command = normalizeExecCommand(normalized.command);
  }

  return normalized;
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

async function reportAmpEvent(config, log, eventType, payload, timeoutMs = 2000) {
  try {
    await postJson(
      `${config.sidecarUrl}/amp/event`,
      {
        toolName: eventType,
        result: JSON.stringify(payload),
      },
      timeoutMs,
    );
  } catch (error) {
    log('amp_event:report-failed', {
      eventType,
      error: String(error),
    });
  }
}

function buildLifecyclePayload(phase, event, ctx) {
  return {
    phase,
    ...contextPayload(ctx),
    ...normalizeHookEvent(event),
  };
}

function truncateString(value, maxChars = 300) {
  if (typeof value !== 'string') {
    return value;
  }
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}…`;
}

function summarizeMessage(message) {
  if (!message || typeof message !== 'object') {
    return undefined;
  }
  const role = typeof message.role === 'string' ? message.role : undefined;
  const content = Array.isArray(message.content) ? message.content : [];
  return {
    role,
    contentTypes: content
      .map((item) => (item && typeof item === 'object' && typeof item.type === 'string' ? item.type : undefined))
      .filter(Boolean),
  };
}

function messagePreview(message) {
  if (!message || typeof message !== 'object') {
    return undefined;
  }
  const role = typeof message.role === 'string' ? message.role : undefined;
  const text = extractMessageText(message);
  if (!role || !text) {
    return undefined;
  }
  return {
    role,
    text,
  };
}

function extractMessageText(value) {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (!value || typeof value !== 'object') {
    return '';
  }

  const content = Array.isArray(value.content) ? value.content : [];
  const textParts = content
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return '';
      }
      if (item.type === 'text' && typeof item.text === 'string') {
        return item.text;
      }
      return '';
    })
    .filter(Boolean);

  return textParts.join('\n').trim();
}

function extractLatestAssistantMessage(messages) {
  if (!Array.isArray(messages)) {
    return undefined;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object') {
      continue;
    }
    if (message.role !== 'assistant') {
      continue;
    }
    return message;
  }

  return undefined;
}

function messageDedupKey(ctx, text) {
  return `${ctx?.sessionKey ?? 'session'}:${ctx?.runId ?? 'run'}:${text}`;
}

async function reportTraceEvent(config, log, phase, event, ctx, timeoutMs = 2000) {
  const payload = buildLifecyclePayload(phase, event, ctx);
  await reportAmpEvent(config, log, 'amp.trace', payload, timeoutMs);
}

function buildMessagesPreview(systemPrompt, historyMessages, prompt) {
  const preview = [];
  if (typeof systemPrompt === 'string' && systemPrompt.trim()) {
    preview.push({ role: 'system', text: systemPrompt.trim() });
  }
  if (Array.isArray(historyMessages)) {
    for (const message of historyMessages) {
      const summarized = messagePreview(message);
      if (summarized) {
        preview.push(summarized);
      }
    }
  }
  if (typeof prompt === 'string' && prompt.trim()) {
    preview.push({ role: 'user', text: prompt.trim() });
  }
  return preview;
}

function buildNativeLlmRequestPayload(event, ctx) {
  const systemPrompt = typeof event?.systemPrompt === 'string' ? event.systemPrompt : undefined;
  const prompt = typeof event?.prompt === 'string' ? event.prompt : '';
  const historyMessages = Array.isArray(event?.historyMessages) ? event.historyMessages : [];
  const messagesPreview = buildMessagesPreview(systemPrompt, historyMessages, prompt);
  return {
    source: 'openclaw-native-hook',
    provider: typeof event?.provider === 'string' ? event.provider : 'unknown',
    model: typeof event?.model === 'string' ? event.model : 'unknown',
    runId: event?.runId ?? ctx?.runId,
    sessionId: event?.sessionId,
    sessionKey: ctx?.sessionKey,
    agentId: ctx?.agentId,
    messageCount: messagesPreview.length,
    messagesPreview,
    imagesCount: typeof event?.imagesCount === 'number' ? event.imagesCount : 0,
    request: {
      systemPrompt,
      prompt,
      historyMessages,
      imagesCount: typeof event?.imagesCount === 'number' ? event.imagesCount : 0,
    },
  };
}

function buildNativeLlmResponsePayload(event, ctx) {
  const assistantTexts = Array.isArray(event?.assistantTexts)
    ? event.assistantTexts.filter((value) => typeof value === 'string' && value.trim())
    : [];
  const responseText = assistantTexts.join('\n\n').trim() || extractMessageText(event?.lastAssistant);
  const usage = event?.usage && typeof event.usage === 'object' ? event.usage : undefined;
  return {
    source: 'openclaw-native-hook',
    provider: typeof event?.provider === 'string' ? event.provider : 'unknown',
    model: typeof event?.model === 'string' ? event.model : 'unknown',
    runId: event?.runId ?? ctx?.runId,
    sessionId: event?.sessionId,
    sessionKey: ctx?.sessionKey,
    agentId: ctx?.agentId,
    tokensIn: typeof usage?.input === 'number' ? usage.input : 0,
    tokensOut: typeof usage?.output === 'number' ? usage.output : 0,
    responseText,
    responsePreview: truncateString(responseText, 4000),
    response: {
      assistantTexts,
      lastAssistant: event?.lastAssistant,
      usage,
    },
  };
}

function sanitizeModelResolveOverride(value, fallbackProvider) {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const providerOverride =
    typeof value.providerOverride === 'string' && value.providerOverride.trim()
      ? value.providerOverride.trim()
      : fallbackProvider;
  const modelOverride =
    typeof value.modelOverride === 'string' && value.modelOverride.trim()
      ? value.modelOverride.trim()
      : undefined;

  if (!providerOverride && !modelOverride) {
    return undefined;
  }

  return {
    ...(providerOverride ? { providerOverride } : {}),
    ...(modelOverride ? { modelOverride } : {}),
  };
}

export default {
  id: 'paddock-amp',
  register(api) {
    const config = resolveRuntimeConfig(api);
    const log = createLogger(api, config.logFile);
    const correlationByToolCall = new Map();
    const reportedAgentMessages = new Set();
    const activeRunBySessionKey = new Map();

    function normalizeNonEmptyString(value) {
      return typeof value === 'string' && value.trim() ? value.trim() : undefined;
    }

    function rememberRunId(event, ctx) {
      const runId = normalizeNonEmptyString(ctx?.runId) ?? normalizeNonEmptyString(event?.runId);
      const sessionKey =
        normalizeNonEmptyString(ctx?.sessionKey) ?? normalizeNonEmptyString(event?.sessionKey);
      if (runId && sessionKey) {
        activeRunBySessionKey.set(sessionKey, runId);
      }
      return runId;
    }

    function resolveRunId(event, ctx) {
      const directRunId = normalizeNonEmptyString(ctx?.runId) ?? normalizeNonEmptyString(event?.runId);
      if (directRunId) {
        return directRunId;
      }
      const sessionKey =
        normalizeNonEmptyString(ctx?.sessionKey) ?? normalizeNonEmptyString(event?.sessionKey);
      if (!sessionKey) {
        return undefined;
      }
      return activeRunBySessionKey.get(sessionKey);
    }

    function extractMessageRole(event) {
      const role = normalizeNonEmptyString(event?.message?.role) ?? normalizeNonEmptyString(event?.role);
      return role?.toLowerCase();
    }

    async function reportAgentMessageOnce(event, ctx) {
      const resolvedRunId = resolveRunId(event, ctx);
      if (!resolvedRunId) {
        return;
      }
      const messageRole = extractMessageRole(event);
      if (messageRole && messageRole !== 'assistant') {
        return;
      }
      const messageText = extractMessageText(event?.message) || extractMessageText(event?.content);
      if (!messageText) {
        return;
      }

      const dedupeKey = messageDedupKey(ctx, messageText);
      if (reportedAgentMessages.has(dedupeKey)) {
        return;
      }
      reportedAgentMessages.add(dedupeKey);

      await reportAmpEvent(config, log, 'amp.agent.message', {
        text: truncateString(messageText, 4000),
        success: event?.success !== false,
        runId: resolvedRunId,
        agentId: ctx?.agentId,
        sessionKey: ctx?.sessionKey,
      });
    }

    log('plugin loaded', {
      sidecarUrl: config.sidecarUrl,
      workspaceRoot: config.workspaceRoot,
      logFile: config.logFile,
    });

    api.on('before_model_resolve', async (event, ctx) => {
      rememberRunId(event, ctx);
      const provider = typeof event?.provider === 'string' ? event.provider.trim() : '';
      const model = typeof event?.model === 'string' ? event.model.trim() : '';

      log('before_model_resolve:start', {
        runId: ctx?.runId,
        provider,
        model,
      });

      try {
        const result = await postJson(
          `${config.sidecarUrl}/amp/control`,
          {
            toolName: 'llm_prepare',
            args: {
              provider,
              model,
              runId: ctx?.runId,
              sessionKey: ctx?.sessionKey,
              agentId: ctx?.agentId,
            },
          },
          5000,
        );

        const override = sanitizeModelResolveOverride(result, provider);
        if (override) {
          log('before_model_resolve:override', {
            runId: ctx?.runId,
            providerOverride: override.providerOverride ?? null,
            modelOverride: override.modelOverride ?? null,
          });
        }
        return override;
      } catch (error) {
        log('before_model_resolve:failed', {
          runId: ctx?.runId,
          error: String(error),
        });
        return undefined;
      }
    });

    api.on(
      'before_tool_call',
      async (event, ctx) => {
        const rawParams = event?.params && typeof event.params === 'object' ? { ...event.params } : {};
        const toolName = typeof event?.toolName === 'string' ? event.toolName : 'unknown';
        const params = normalizeToolParams(toolName, rawParams);
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

    api.on('session_start', async (event, ctx) => {
      const payload = buildLifecyclePayload('openclaw.session_start', event, ctx);
      log('session_start', payload);
      await reportAmpEvent(config, log, 'amp.session.start', payload);
    });

    api.on('session_end', async (event, ctx) => {
      const payload = buildLifecyclePayload('openclaw.session_end', event, ctx);
      log('session_end', payload);
      const sessionKey = normalizeNonEmptyString(ctx?.sessionKey) ?? normalizeNonEmptyString(event?.sessionKey);
      if (sessionKey) {
        activeRunBySessionKey.delete(sessionKey);
      }
      await reportAmpEvent(config, log, 'amp.session.end', payload);
    });

    api.on('before_reset', async (event, ctx) => {
      const payload = buildLifecyclePayload('openclaw.before_reset', event, ctx);
      log('before_reset', payload);
      await reportTraceEvent(config, log, 'openclaw.before_reset', event, ctx);
    });

    api.on('before_compaction', async (event, ctx) => {
      const payload = buildLifecyclePayload('openclaw.before_compaction', event, ctx);
      log('before_compaction', payload);
      await reportTraceEvent(config, log, 'openclaw.before_compaction', event, ctx);
    });

    api.on('after_compaction', async (event, ctx) => {
      const payload = buildLifecyclePayload('openclaw.after_compaction', event, ctx);
      log('after_compaction', payload);
      await reportTraceEvent(config, log, 'openclaw.after_compaction', event, ctx);
    });

    api.on('message_received', async (event, ctx) => {
      const payload = buildLifecyclePayload(
        'openclaw.message_received',
        {
          ...normalizeHookEvent(event),
          content: truncateString(event?.content, 400),
        },
        ctx,
      );
      log('message_received', payload);
      await reportTraceEvent(config, log, 'openclaw.message_received', payload, ctx);
    });

    api.on('message_sending', async (event, ctx) => {
      const payload = buildLifecyclePayload(
        'openclaw.message_sending',
        {
          ...normalizeHookEvent(event),
          content: truncateString(event?.content, 400),
        },
        ctx,
      );
      log('message_sending', payload);
      await reportTraceEvent(config, log, 'openclaw.message_sending', payload, ctx);
    });

    api.on('message_sent', async (event, ctx) => {
      const payload = buildLifecyclePayload(
        'openclaw.message_sent',
        {
          ...normalizeHookEvent(event),
          content: truncateString(event?.content, 400),
        },
        ctx,
      );
      log('message_sent', payload);
      await reportAgentMessageOnce(event, ctx);
      await reportTraceEvent(config, log, 'openclaw.message_sent', payload, ctx);
    });

    api.on('agent_end', async (event, ctx) => {
      const finalAssistantMessage = extractLatestAssistantMessage(event?.messages);
      const payload = buildLifecyclePayload(
        'openclaw.agent_end',
        {
          success: event?.success !== false,
          error: event?.error,
          durationMs: event?.durationMs,
          messageCount: Array.isArray(event?.messages) ? event.messages.length : 0,
          finalAssistant: summarizeMessage(finalAssistantMessage),
        },
        ctx,
      );
      log('agent_end', payload);
      if (finalAssistantMessage) {
        await reportAgentMessageOnce(
          {
            message: finalAssistantMessage,
            success: event?.success !== false,
          },
          ctx,
        );
      }
      await reportTraceEvent(config, log, 'openclaw.agent_end', payload, ctx);
    });

    api.on('llm_input', async (event, ctx) => {
      rememberRunId(event, ctx);
      const payload = buildNativeLlmRequestPayload(event, ctx);
      log('llm_input', {
        runId: payload.runId,
        provider: payload.provider,
        model: payload.model,
        messageCount: payload.messageCount,
      });
      await reportAmpEvent(config, log, 'amp.llm.request', payload);
    });

    api.on('llm_output', async (event, ctx) => {
      rememberRunId(event, ctx);
      const payload = buildNativeLlmResponsePayload(event, ctx);
      log('llm_output', {
        runId: payload.runId,
        provider: payload.provider,
        model: payload.model,
        tokensIn: payload.tokensIn,
        tokensOut: payload.tokensOut,
      });
      await reportAmpEvent(config, log, 'amp.llm.response', payload);
    });

    api.on('subagent_spawning', async (event, ctx) => {
      const payload = buildLifecyclePayload('openclaw.subagent_spawning', event, ctx);
      log('subagent_spawning', payload);
      await reportAmpEvent(config, log, 'amp.session.start', payload);
    });

    api.on('subagent_spawned', async (event, ctx) => {
      const payload = buildLifecyclePayload('openclaw.subagent_spawned', event, ctx);
      log('subagent_spawned', payload);
      await reportAmpEvent(config, log, 'amp.session.start', payload);
    });

    api.on('subagent_ended', async (event, ctx) => {
      const payload = buildLifecyclePayload('openclaw.subagent_ended', event, ctx);
      log('subagent_ended', payload);
      await reportAmpEvent(config, log, 'amp.session.end', payload);
    });

    api.on('subagent_delivery_target', async (event, ctx) => {
      const payload = buildLifecyclePayload('openclaw.subagent_delivery_target', event, ctx);
      log('subagent_delivery_target', payload);
      await reportTraceEvent(config, log, 'openclaw.subagent_delivery_target', event, ctx);
    });

    api.on('gateway_start', async (event, ctx) => {
      const payload = buildLifecyclePayload('openclaw.gateway_start', event, ctx);
      log('gateway_start', payload);
      await reportTraceEvent(config, log, 'openclaw.gateway_start', event, ctx);
    });

    api.on('gateway_stop', async (event, ctx) => {
      const payload = buildLifecyclePayload('openclaw.gateway_stop', event, ctx);
      log('gateway_stop', payload);
      await reportTraceEvent(config, log, 'openclaw.gateway_stop', event, ctx);
    });

    api.on('tool_result_persist', (event, ctx) => {
      const payload = buildLifecyclePayload(
        'openclaw.tool_result_persist',
        {
          toolName: event?.toolName,
          toolCallId: event?.toolCallId,
          isSynthetic: event?.isSynthetic === true,
          message: summarizeMessage(event?.message),
        },
        ctx,
      );
      log('tool_result_persist', payload);
      void reportTraceEvent(config, log, 'openclaw.tool_result_persist', payload, ctx);
    });

    api.on('before_message_write', (event, ctx) => {
      const payload = buildLifecyclePayload(
        'openclaw.before_message_write',
        {
          blocked: false,
          message: summarizeMessage(event?.message),
          sessionKey: event?.sessionKey,
          agentId: event?.agentId,
        },
        ctx,
      );
      log('before_message_write', payload);
      void reportAgentMessageOnce(event, ctx);
      void reportTraceEvent(config, log, 'openclaw.before_message_write', payload, ctx);
    });
  },
};
