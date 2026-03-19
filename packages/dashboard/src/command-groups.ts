export interface CommandEventLike {
  id: string;
  seq: number;
  type: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

export type CommandRunStatus = 'running' | 'completed' | 'failed' | 'aborted';
export type CommandStepKind =
  | 'llm-request'
  | 'llm-response'
  | 'tool-intent'
  | 'gate-verdict'
  | 'tool-result'
  | 'agent-message'
  | 'agent-error'
  | 'command-status'
  | 'system';

export interface CommandStep {
  id: string;
  eventId: string;
  kind: CommandStepKind;
  title: string;
  summary?: string;
  detail?: string;
  timestamp: number;
  status?: 'running' | 'completed' | 'failed' | 'blocked';
  children: CommandStep[];
}

export interface CommandRun {
  id: string;
  command: string;
  runId?: string;
  status: CommandRunStatus;
  startedAt: number;
  finishedAt?: number;
  responseText?: string;
  latestError?: string;
  toolNames: string[];
  toolsUsed: number;
  approvals: number;
  blockers: number;
  llmTurns: number;
  rawEvents: CommandEventLike[];
  rawEventCount: number;
  hasRawLogs: boolean;
  active: boolean;
  stopTargetRunId?: string;
  stepSummaries: string[];
  currentActivity?: string;
  steps: CommandStep[];
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getRunId(event: CommandEventLike): string | undefined {
  return getString((event.payload as { runId?: unknown }).runId);
}

function safeJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function formatKeyValueLines(value: unknown, indent = 0): string[] {
  if (value === null || value === undefined) return [];
  const prefix = '  '.repeat(indent);
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (item && typeof item === 'object') {
        return [`${prefix}-`].concat(formatKeyValueLines(item, indent + 1));
      }
      return [`${prefix}- ${String(item)}`];
    });
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => {
      if (nested && typeof nested === 'object') {
        return [`${prefix}${key}:`].concat(formatKeyValueLines(nested, indent + 1));
      }
      return [`${prefix}${key}: ${String(nested)}`];
    });
  }
  return [`${prefix}${String(value)}`];
}

function formatMessageTranscript(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  const sections = messages
    .map((message) => {
      if (!message || typeof message !== 'object') return '';
      const record = message as Record<string, unknown>;
      const role = getString(record.role) ?? 'unknown';
      const text = getString(record.text);
      if (!text) return '';
      return `${role.toUpperCase()}\n${text}`;
    })
    .filter(Boolean);
  return sections.length > 0 ? sections.join('\n\n') : undefined;
}

function formatLlmResponseDetail(payload: Record<string, unknown>): string | undefined {
  const lines: string[] = [];
  const preview = getString(payload.responsePreview);
  if (preview) {
    lines.push(collapseWhitespace(preview));
  }
  const metrics: string[] = [];
  if (typeof payload.tokensIn === 'number') metrics.push(`tokens in: ${payload.tokensIn}`);
  if (typeof payload.tokensOut === 'number') metrics.push(`tokens out: ${payload.tokensOut}`);
  if (typeof payload.durationMs === 'number') metrics.push(`duration: ${payload.durationMs}ms`);
  if (metrics.length > 0) {
    lines.push(metrics.join(' · '));
  }
  return lines.length > 0 ? lines.join('\n\n') : undefined;
}

function formatToolInputDetail(toolInput: Record<string, unknown>): string | undefined {
  const lines = formatKeyValueLines(toolInput);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function formatGateVerdictDetail(payload: Record<string, unknown>): string | undefined {
  const lines: string[] = [];
  if (typeof payload.riskScore === 'number') lines.push(`Risk score: ${payload.riskScore}`);
  if (Array.isArray(payload.triggeredRules) && payload.triggeredRules.length > 0) {
    lines.push(`Triggered rules: ${(payload.triggeredRules as string[]).join(', ')}`);
  }
  const behaviorReview = payload.behaviorReview && typeof payload.behaviorReview === 'object'
    ? (payload.behaviorReview as Record<string, unknown>)
    : undefined;
  if (behaviorReview) {
    const source = getString(behaviorReview.source);
    const reason = getString(behaviorReview.reason);
    const boost = typeof behaviorReview.riskBoost === 'number' ? behaviorReview.riskBoost : undefined;
    if (source) {
      lines.push(`Behavior review: ${source}${boost !== undefined ? ` (+${boost})` : ''}`);
    }
    if (reason) {
      lines.push(`Review reason: ${reason}`);
    }
  }
  return lines.length > 0 ? lines.join('\n\n') : undefined;
}

function formatToolResultDetail(payload: Record<string, unknown>): string | undefined {
  const lines: string[] = [];
  const error = getString(payload.error);
  if (error) {
    lines.push(`Error: ${error}`);
  }
  if (typeof payload.durationMs === 'number') {
    lines.push(`Duration: ${payload.durationMs}ms`);
  }
  const text = extractToolResultText(payload.result);
  if (text) {
    lines.push(text);
  }
  const resultRoot =
    payload.result && typeof payload.result === 'object'
      ? (payload.result as Record<string, unknown>)
      : undefined;
  const details =
    resultRoot?.result && typeof resultRoot.result === 'object'
      ? ((resultRoot.result as Record<string, unknown>).details as unknown)
      : undefined;
  if (details && typeof details === 'object') {
    const summaryFields = Object.fromEntries(
      Object.entries(details as Record<string, unknown>).filter(([key]) => !['content', 'citations'].includes(key)),
    );
    const detailLines = formatKeyValueLines(summaryFields);
    if (detailLines.length > 0) {
      lines.push(detailLines.join('\n'));
    }
  }
  return lines.length > 0 ? lines.join('\n\n') : undefined;
}

function summarizeToolInput(toolName: string, toolInput: Record<string, unknown>): string {
  if (toolName === 'browser') {
    const action = getString(toolInput.action) ?? 'act';
    const url = getString(toolInput.url);
    if (url) return `${action} ${url}`;
    const request = toolInput.request && typeof toolInput.request === 'object' ? (toolInput.request as Record<string, unknown>) : undefined;
    if (request) {
      const ref = getString(request.ref);
      const kind = getString(request.kind) ?? 'act';
      if (ref) return `${kind} ${ref}`;
      return kind;
    }
    const targetId = getString(toolInput.targetId);
    if (targetId) return `${action} target ${targetId}`;
    return action;
  }

  if (toolName === 'exec' || toolName === 'process') {
    const command = getString(toolInput.command);
    return command ? command.slice(0, 100) : 'command';
  }

  if (toolName === 'web_fetch' || toolName === 'web_search') {
    return getString(toolInput.url) ?? getString(toolInput.query) ?? 'request';
  }

  if (toolName === 'write' || toolName === 'edit' || toolName === 'read' || toolName === 'apply_patch') {
    return getString(toolInput.path) ?? 'workspace file';
  }

  return Object.entries(toolInput)
    .slice(0, 2)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
}

function extractToolResultText(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const root = result as { content?: unknown[]; result?: { content?: unknown[] } };
  const content = Array.isArray(root.content)
    ? root.content
    : Array.isArray(root.result?.content)
      ? root.result?.content
      : [];
  const firstText = content.find((item) => item && typeof item === 'object' && (item as { type?: unknown }).type === 'text') as
    | { text?: unknown }
    | undefined;
  return getString(firstText?.text);
}

function summarizeToolResult(event: CommandEventLike): string | null {
  const payload = event.payload;
  const toolName = getString(payload.toolName) ?? 'tool';
  const error = getString(payload.error);
  if (error) return `${toolName} failed: ${error}`;

  const text = extractToolResultText(payload.result);
  if (text) return `${toolName}: ${text.slice(0, 120)}`;
  return `${toolName} completed`;
}

function summarizeLLMRequest(payload: Record<string, unknown>): string {
  const provider = getString(payload.provider) ?? 'unknown';
  const model = getString(payload.model) ?? 'unknown';
  const previews = Array.isArray(payload.messagesPreview) ? payload.messagesPreview as Array<Record<string, unknown>> : [];
  const lastPreview = previews[previews.length - 1];
  const previewText = getString(lastPreview?.text);
  if (previewText) {
    return `${provider} / ${model} · ${previewText.slice(0, 140)}`;
  }
  return `${provider} / ${model}`;
}

function summarizeLLMResponse(payload: Record<string, unknown>): string {
  const preview = getString(payload.responsePreview);
  if (preview) return collapseWhitespace(preview).slice(0, 160);
  const tokensOut = typeof payload.tokensOut === 'number' ? payload.tokensOut : undefined;
  if (tokensOut !== undefined) return `${tokensOut} output tokens`;
  return 'Response received';
}

function summarizeStep(event: CommandEventLike): string | null {
  const payload = event.payload;
  switch (event.type) {
    case 'llm.request':
    case 'amp.llm.request':
      return `LLM: ${summarizeLLMRequest(payload)}`;
    case 'llm.response':
    case 'amp.llm.response':
      return `LLM response: ${summarizeLLMResponse(payload)}`;
    case 'amp.tool.intent': {
      const toolName = getString(payload.toolName) ?? 'tool';
      const toolInput =
        payload.toolInput && typeof payload.toolInput === 'object'
          ? (payload.toolInput as Record<string, unknown>)
          : {};
      return `${toolName}: ${summarizeToolInput(toolName, toolInput)}`;
    }
    case 'amp.tool.result':
      return summarizeToolResult(event);
    case 'amp.gate.verdict': {
      const verdict = getString(payload.verdict) ?? 'approve';
      const riskScore = typeof payload.riskScore === 'number' ? payload.riskScore : 0;
      const behaviorSource = getString((payload.behaviorReview as Record<string, unknown> | undefined)?.source);
      const behaviorRisk = typeof (payload.behaviorReview as Record<string, unknown> | undefined)?.riskBoost === 'number'
        ? ((payload.behaviorReview as Record<string, unknown>).riskBoost as number)
        : 0;
      return `Policy ${verdict} · risk ${riskScore}${behaviorSource ? ` · ${behaviorSource} +${behaviorRisk}` : ''}`;
    }
    case 'amp.agent.message':
      return `Reply: ${(getString(payload.text) ?? '').slice(0, 120)}`;
    case 'amp.agent.error':
      return `Agent error: ${getString(payload.message) ?? 'Unknown error'}`;
    case 'amp.agent.fatal':
      return `Fatal: ${getString(payload.message) ?? 'Agent crashed'}`;
    case 'amp.command.status':
      return `Command ${getString(payload.status) ?? 'updated'}`;
    case 'amp.session.start':
      return getString(payload.message) ?? null;
    default:
      return null;
  }
}

function buildAnchorEvents(events: CommandEventLike[]): CommandEventLike[] {
  const anchors = events.filter(
    (event) =>
      event.type === 'user.command' ||
      (event.type === 'amp.user.command' &&
        !events.some((candidate) => candidate.seq < event.seq && candidate.type === 'user.command')),
  );

  if (anchors.length > 0) return anchors;
  return events.filter((event) => event.type === 'amp.user.command');
}

function createStep(
  event: CommandEventLike,
  kind: CommandStepKind,
  title: string,
  summary?: string,
  detail?: string,
  status?: CommandStep['status'],
): CommandStep {
  return {
    id: `${event.id}:${kind}`,
    eventId: event.id,
    kind,
    title,
    summary,
    detail,
    timestamp: event.timestamp,
    status,
    children: [],
  };
}

function flattenStepSummaries(steps: CommandStep[]): string[] {
  const output: string[] = [];

  function visit(step: CommandStep) {
    const line = step.summary ? `${step.title} · ${step.summary}` : step.title;
    output.push(line);
    for (const child of step.children) {
      visit(child);
    }
  }

  for (const step of steps) {
    visit(step);
    if (output.length >= 10) break;
  }

  return output.slice(0, 10);
}

function currentActivityFromEvents(blockEvents: CommandEventLike[]): string | undefined {
  const lastInteresting = [...blockEvents]
    .reverse()
    .find((event) =>
      ['llm.request', 'llm.response', 'amp.tool.intent', 'amp.tool.result', 'amp.gate.verdict', 'amp.command.status', 'amp.agent.message', 'amp.agent.error', 'amp.agent.fatal'].includes(event.type),
    );
  return lastInteresting ? summarizeStep(lastInteresting) ?? undefined : undefined;
}

function addChildStep(parent: CommandStep | null, step: CommandStep, roots: CommandStep[]) {
  if (parent) {
    parent.children.push(step);
    return;
  }
  roots.push(step);
}

export function buildCommandRuns(events: CommandEventLike[]): CommandRun[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const anchors = buildAnchorEvents(sorted);
  if (anchors.length === 0) return [];

  const runs: CommandRun[] = [];

  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index];
    const nextAnchor = anchors[index + 1];
    const blockEvents = sorted.filter((event) => event.seq >= anchor.seq && (!nextAnchor || event.seq < nextAnchor.seq));
    const command =
      getString(anchor.payload.command) ??
      getString(blockEvents.find((event) => event.type === 'amp.user.command')?.payload.command) ??
      'Untitled command';
    const runId =
      getString(blockEvents.find((event) => event.type === 'amp.user.command')?.payload.runId) ??
      getString(blockEvents.find((event) => getRunId(event))?.payload.runId);

    const responseText =
      getString(
        [...blockEvents]
          .reverse()
          .find((event) => event.type === 'amp.agent.message')
          ?.payload.text,
      ) ?? undefined;

    const latestError =
      getString(
        [...blockEvents]
          .reverse()
          .find((event) => event.type === 'amp.agent.fatal' || event.type === 'amp.agent.error')
          ?.payload.message,
      ) ??
      getString(
        [...blockEvents]
          .reverse()
          .find((event) => event.type === 'amp.tool.result' && getString(event.payload.error))
          ?.payload.error,
      );

    const toolNames = [...new Set(
      blockEvents
        .filter((event) => event.type === 'amp.tool.intent')
        .map((event) => getString(event.payload.toolName))
        .filter((value): value is string => Boolean(value)),
    )];

    const aborted = blockEvents.some(
      (event) => event.type === 'amp.command.status' && getString(event.payload.status) === 'aborted',
    );
    const failed = blockEvents.some((event) =>
      event.type === 'amp.agent.fatal' ||
      (event.type === 'session.status' && getString(event.payload.status) === 'error') ||
      event.type === 'amp.agent.error',
    );

    const status: CommandRunStatus = responseText
      ? 'completed'
      : aborted
        ? 'aborted'
        : failed
          ? 'failed'
          : 'running';

    const steps: CommandStep[] = [];
    let currentLLMStep: CommandStep | null = null;
    let currentToolStep: CommandStep | null = null;

    for (const event of blockEvents) {
      const payload = event.payload;
      switch (event.type) {
        case 'llm.request':
        case 'amp.llm.request': {
          const step = createStep(
            event,
            'llm-request',
            `LLM turn · ${getString(payload.provider) ?? 'provider'} / ${getString(payload.model) ?? 'model'}`,
            summarizeLLMRequest(payload),
            formatMessageTranscript(payload.messagesPreview),
            'running',
          );
          steps.push(step);
          currentLLMStep = step;
          currentToolStep = null;
          break;
        }
        case 'llm.response':
        case 'amp.llm.response': {
          const step = createStep(
            event,
            'llm-response',
            'LLM response',
            summarizeLLMResponse(payload),
            formatLlmResponseDetail(payload),
            'completed',
          );
          addChildStep(currentLLMStep, step, steps);
          break;
        }
        case 'amp.tool.intent': {
          const toolName = getString(payload.toolName) ?? 'tool';
          const toolInput = payload.toolInput && typeof payload.toolInput === 'object'
            ? (payload.toolInput as Record<string, unknown>)
            : {};
          const step = createStep(
            event,
            'tool-intent',
            `Tool · ${toolName}`,
            summarizeToolInput(toolName, toolInput),
            formatToolInputDetail(toolInput),
            'running',
          );
          addChildStep(currentLLMStep, step, steps);
          currentToolStep = step;
          break;
        }
        case 'amp.gate.verdict': {
          const verdict = getString(payload.verdict) ?? 'approve';
          const riskScore = typeof payload.riskScore === 'number' ? payload.riskScore : 0;
          const behaviorReview =
            payload.behaviorReview && typeof payload.behaviorReview === 'object'
              ? (payload.behaviorReview as Record<string, unknown>)
              : undefined;
          const behaviorSource = getString(behaviorReview?.source);
          const behaviorRisk = typeof behaviorReview?.riskBoost === 'number' ? behaviorReview.riskBoost : undefined;
          const step = createStep(
            event,
            'gate-verdict',
            `Policy · ${verdict}`,
            `Risk ${riskScore}${behaviorSource ? ` · ${behaviorSource}${behaviorRisk !== undefined ? ` +${behaviorRisk}` : ''}` : ''}${Array.isArray(payload.triggeredRules) && payload.triggeredRules.length > 0 ? ` · ${(payload.triggeredRules as string[]).join(', ')}` : ''}`,
            formatGateVerdictDetail(payload),
            verdict === 'reject' ? 'blocked' : verdict === 'ask' ? 'blocked' : 'completed',
          );
          addChildStep(currentToolStep ?? currentLLMStep, step, steps);
          break;
        }
        case 'amp.tool.result': {
          const step = createStep(
            event,
            'tool-result',
            `Result · ${getString(payload.toolName) ?? 'tool'}`,
            summarizeToolResult(event) ?? 'completed',
            formatToolResultDetail(payload),
            getString(payload.error) ? 'failed' : 'completed',
          );
          addChildStep(currentToolStep ?? currentLLMStep, step, steps);
          currentToolStep = null;
          break;
        }
        case 'amp.agent.message': {
          const text = getString(payload.text) ?? '';
          const step = createStep(
            event,
            'agent-message',
            'Final reply',
            text.slice(0, 180),
            text,
            'completed',
          );
          steps.push(step);
          currentLLMStep = null;
          currentToolStep = null;
          break;
        }
        case 'amp.agent.error':
        case 'amp.agent.fatal': {
          const step = createStep(
            event,
            'agent-error',
            event.type === 'amp.agent.fatal' ? 'Fatal error' : 'Agent error',
            getString(payload.message) ?? 'Unknown error',
            safeJson(payload),
            'failed',
          );
          steps.push(step);
          currentLLMStep = null;
          currentToolStep = null;
          break;
        }
        case 'amp.command.status': {
          const step = createStep(
            event,
            'command-status',
            `Command ${getString(payload.status) ?? 'updated'}`,
            getString(payload.command),
            safeJson(payload),
            getString(payload.status) === 'aborted' ? 'blocked' : 'completed',
          );
          steps.push(step);
          break;
        }
        case 'amp.session.start': {
          const message = getString(payload.message);
          if (!message) break;
          const step = createStep(
            event,
            'system',
            'System',
            message,
            safeJson(payload),
            'completed',
          );
          steps.push(step);
          break;
        }
        default:
          break;
      }
    }

    const finishedAt = status === 'running' ? undefined : blockEvents[blockEvents.length - 1]?.timestamp;

    runs.push({
      id: `${anchor.id}:${runId ?? anchor.seq}`,
      command,
      runId,
      status,
      startedAt: anchor.timestamp,
      finishedAt,
      responseText,
      latestError,
      toolNames,
      toolsUsed: blockEvents.filter((event) => event.type === 'amp.tool.intent').length,
      approvals: blockEvents.filter(
        (event) => event.type === 'amp.gate.verdict' && getString(event.payload.verdict) === 'approve',
      ).length,
      blockers: blockEvents.filter(
        (event) =>
          event.type === 'amp.gate.verdict' &&
          ['reject', 'ask'].includes(getString(event.payload.verdict) ?? ''),
      ).length,
      llmTurns: blockEvents.filter((event) => event.type === 'llm.request' || event.type === 'amp.llm.request').length,
      rawEvents: blockEvents,
      rawEventCount: blockEvents.length,
      hasRawLogs: blockEvents.length > 0,
      active: status === 'running',
      stopTargetRunId: runId,
      stepSummaries: flattenStepSummaries(steps),
      currentActivity: currentActivityFromEvents(blockEvents),
      steps,
    });
  }

  return runs;
}
