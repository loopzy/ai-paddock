export interface CommandEventLike {
  id: string;
  seq: number;
  type: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

export type CommandRunStatus = 'running' | 'completed' | 'failed' | 'aborted';
export type CommandTagTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface CommandTag {
  label: string;
  tone?: CommandTagTone;
}

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
  meta?: string;
  tags?: CommandTag[];
  summary?: string;
  detail?: string;
  body?: string;
  rawDetail?: string;
  rawLabel?: string;
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
  totalTokensIn: number;
  totalTokensOut: number;
  totalTokens: number;
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

function appendRawSection(current: string | undefined, label: string, value: unknown): string | undefined {
  const json = safeJson(value);
  if (!json) return current;
  const section = `${label}\n${json}`;
  return current ? `${current}\n\n${section}` : section;
}

function joinSections(...sections: Array<string | undefined>): string | undefined {
  const compact = sections.map((section) => section?.trim()).filter((section): section is string => Boolean(section));
  return compact.length > 0 ? compact.join('\n\n') : undefined;
}

function isStructuredText(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.startsWith('{') ||
    trimmed.startsWith('[') ||
    trimmed.includes('<<<EXTERNAL_UNTRUSTED_CONTENT') ||
    trimmed.includes('"provider"') ||
    trimmed.includes('"query"')
  );
}

function pickHumanBody(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (isStructuredText(value)) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function sanitizeQuotedQuery(value: string): string {
  let cleaned = value.trim();
  cleaned = cleaned.replace(/^[：:]+\s*/, '');
  cleaned = cleaned.replace(/^[`"'“”'']+/, '');
  cleaned = cleaned.replace(/[`"'“”'']+$/, '');
  cleaned = collapseWhitespace(cleaned);
  return cleaned;
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
  const metrics: string[] = [];
  if (typeof payload.tokensIn === 'number') metrics.push(`tokens in: ${payload.tokensIn}`);
  if (typeof payload.tokensOut === 'number') metrics.push(`tokens out: ${payload.tokensOut}`);
  if (typeof payload.durationMs === 'number') metrics.push(`duration: ${payload.durationMs}ms`);
  if (metrics.length > 0) {
    lines.push(metrics.join(' · '));
  }
  return lines.length > 0 ? lines.join('\n\n') : undefined;
}

function getTokenUsage(payload: Record<string, unknown>): {
  tokensIn?: number;
  tokensOut?: number;
  durationMs?: number;
} {
  return {
    tokensIn: typeof payload.tokensIn === 'number' ? payload.tokensIn : undefined,
    tokensOut: typeof payload.tokensOut === 'number' ? payload.tokensOut : undefined,
    durationMs: typeof payload.durationMs === 'number' ? payload.durationMs : undefined,
  };
}

function formatCompactCount(value: number): string {
  if (value >= 1000) {
    const compact = value / 1000;
    return compact >= 10 ? `${compact.toFixed(0)}k` : `${compact.toFixed(1)}k`;
  }
  return String(value);
}

function formatTokenMeta(payload: Record<string, unknown>): string | undefined {
  const { tokensIn, tokensOut, durationMs } = getTokenUsage(payload);
  const parts: string[] = [];
  if (tokensIn !== undefined) parts.push(`${formatCompactCount(tokensIn)} in`);
  if (tokensOut !== undefined) parts.push(`${formatCompactCount(tokensOut)} out`);
  if (durationMs !== undefined) parts.push(`${(durationMs / 1000).toFixed(durationMs >= 10_000 ? 0 : 1)}s`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function joinMetaParts(...parts: Array<string | undefined>): string | undefined {
  const compact = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
  return compact.length > 0 ? compact.join(' · ') : undefined;
}

function looksLikeToolCallPreview(value: string): boolean {
  return /\[tool\]/i.test(value);
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

function truncateText(value: string, limit = 220): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
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
    const url = getString(toolInput.url);
    if (url) return url;
    const query = getString(toolInput.query);
    if (query) return sanitizeQuotedQuery(query) || 'search query';
    return 'request';
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
  meta?: string,
  tags?: CommandTag[],
  summary?: string,
  detail?: string,
  body?: string,
  rawDetail?: string,
  rawLabel?: string,
  status?: CommandStep['status'],
): CommandStep {
  return {
    id: `${event.id}:${kind}`,
    eventId: event.id,
    kind,
    title,
    meta,
    tags,
    summary,
    detail,
    body,
    rawDetail,
    rawLabel,
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

    const lastAgentReply = [...blockEvents]
      .reverse()
      .find((event) => event.type === 'amp.agent.message');
    const lastTerminalLlmResponse = [...blockEvents]
      .reverse()
      .find((event) => {
        if (!['llm.response', 'amp.llm.response'].includes(event.type)) return false;
        const preview = getString(event.payload.responsePreview);
        return Boolean(preview && !looksLikeToolCallPreview(preview));
      });
    const responseText =
      getString(lastAgentReply?.payload.text) ??
      getString(lastTerminalLlmResponse?.payload.responseText) ??
      getString(lastTerminalLlmResponse?.payload.responsePreview) ??
      undefined;

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

    const lastCommandStatus = getString(
      [...blockEvents]
        .reverse()
        .find((event) => event.type === 'amp.command.status')
        ?.payload.status,
    );
    const aborted = lastCommandStatus === 'aborted';
    const failed =
      ['failed', 'error'].includes(lastCommandStatus ?? '') ||
      blockEvents.some((event) =>
        event.type === 'amp.agent.fatal' ||
        (event.type === 'session.status' && getString(event.payload.status) === 'error') ||
        event.type === 'amp.agent.error',
      );
    const completed =
      ['completed', 'complete', 'finished', 'done', 'succeeded'].includes(lastCommandStatus ?? '') ||
      Boolean(responseText);

    const status: CommandRunStatus = aborted
      ? 'aborted'
      : failed
        ? 'failed'
        : completed
          ? 'completed'
          : 'running';

    const steps: CommandStep[] = [];
    let currentLLMStep: CommandStep | null = null;
    let currentToolStep: CommandStep | null = null;

    for (const event of blockEvents) {
      const payload = event.payload;
      switch (event.type) {
        case 'llm.request':
        case 'amp.llm.request': {
          const provider = getString(payload.provider) ?? 'provider';
          const model = getString(payload.model) ?? 'model';
          const promptPreview = formatMessageTranscript(payload.messagesPreview);
          const step = createStep(
            event,
            'llm-request',
            model,
            provider,
            [],
            undefined,
            promptPreview,
            undefined,
            appendRawSection(undefined, 'Request payload', payload),
            'Request details',
            'running',
          );
          steps.push(step);
          currentLLMStep = step;
          currentToolStep = null;
          break;
        }
        case 'llm.response':
        case 'amp.llm.response': {
          const fullResponseText = getString(payload.responseText);
          const preview = getString(payload.responsePreview);
          const displayText = fullResponseText ?? preview;
          const metrics = formatTokenMeta(payload);
          const previewBody = displayText && !isStructuredText(displayText) ? displayText.trim() : undefined;
          if (currentLLMStep) {
            currentLLMStep.meta = joinMetaParts(currentLLMStep.meta, metrics);
            currentLLMStep.summary = previewBody ? undefined : summarizeLLMResponse(payload);
            currentLLMStep.detail = undefined;
            currentLLMStep.body = previewBody ?? currentLLMStep.body;
            currentLLMStep.rawDetail = appendRawSection(currentLLMStep.rawDetail, 'Response payload', payload);
            currentLLMStep.rawLabel = joinMetaParts('Step details', metrics);
            currentLLMStep.status = looksLikeToolCallPreview(previewBody ?? '') ? 'running' : 'completed';
          } else {
            const fallback = createStep(
              event,
              'llm-request',
              getString(payload.model) ?? 'model',
              joinMetaParts(getString(payload.provider) ?? 'provider', metrics),
              [],
              previewBody ? undefined : summarizeLLMResponse(payload),
              undefined,
              previewBody,
              appendRawSection(undefined, 'Response payload', payload),
              joinMetaParts('Step details', metrics),
              looksLikeToolCallPreview(previewBody ?? '') ? 'running' : 'completed',
            );
            steps.push(fallback);
            currentLLMStep = fallback;
          }
          break;
        }
        case 'amp.tool.intent': {
          const toolName = getString(payload.toolName) ?? 'tool';
          const toolInput =
            payload.toolInput && typeof payload.toolInput === 'object'
              ? (payload.toolInput as Record<string, unknown>)
              : {};
          const step = createStep(
            event,
            'tool-intent',
            toolName,
            undefined,
            [],
            summarizeToolInput(toolName, toolInput),
            formatToolInputDetail(toolInput),
            undefined,
            appendRawSection(undefined, 'Intent payload', payload),
            'Tool details',
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
          const verdictTone =
            verdict === 'approve' ? 'success' :
            verdict === 'reject' ? 'danger' :
            verdict === 'ask' ? 'warning' :
            'info';
          const riskTone =
            riskScore >= 60 ? 'danger' :
            riskScore >= 20 ? 'warning' :
            'neutral';
          const target = currentToolStep ?? currentLLMStep;
          if (target) {
            target.tags = [
              ...(target.tags ?? []),
              { label: verdict === 'ask' ? 'Needs approval' : verdict[0].toUpperCase() + verdict.slice(1), tone: verdictTone },
              { label: `Risk ${riskScore}`, tone: riskTone },
            ];
            target.detail = joinSections(target.detail, formatGateVerdictDetail(payload));
            target.rawDetail = appendRawSection(target.rawDetail, 'Gate verdict', payload);
            target.status = verdict === 'reject' || verdict === 'ask' ? 'blocked' : target.status;
          }
          break;
        }
        case 'amp.tool.result': {
          const textResult = extractToolResultText(payload.result);
          const target = currentToolStep ?? currentLLMStep;
          if (target) {
            target.tags = [
              ...(target.tags ?? []),
              { label: getString(payload.error) ? 'Failed' : 'Done', tone: getString(payload.error) ? 'danger' : 'success' },
            ];
            target.detail = joinSections(target.detail, formatToolResultDetail(payload));
            target.body = pickHumanBody(textResult) ?? target.body;
            target.rawDetail = appendRawSection(target.rawDetail, 'Result payload', payload.result ?? payload);
            target.status = getString(payload.error) ? 'failed' : 'completed';
          } else {
            const step = createStep(
              event,
              'tool-result',
              getString(payload.toolName) ?? 'tool',
              undefined,
              [{ label: getString(payload.error) ? 'Failed' : 'Done', tone: getString(payload.error) ? 'danger' : 'success' }],
              summarizeToolResult(event) ?? 'completed',
              formatToolResultDetail(payload),
              pickHumanBody(textResult),
              appendRawSection(undefined, 'Result payload', payload.result ?? payload),
              'Tool details',
              getString(payload.error) ? 'failed' : 'completed',
            );
            steps.push(step);
          }
          currentToolStep = null;
          break;
        }
        case 'amp.agent.message': {
          const text = getString(payload.text) ?? '';
          const step = createStep(
            event,
            'agent-message',
            'Answer',
            undefined,
            [],
            truncateText(text, 180),
            undefined,
            text,
            appendRawSection(undefined, 'Answer details', payload),
            'Answer details',
            'completed',
          );
          steps.push(step);
          currentLLMStep = null;
          currentToolStep = null;
          break;
        }
        case 'amp.agent.error':
        case 'amp.agent.fatal': {
          const message = getString(payload.message) ?? 'Unknown error';
          const tags: CommandTag[] = [
            { label: event.type === 'amp.agent.fatal' ? 'Stopped' : 'Issue', tone: event.type === 'amp.agent.fatal' ? 'danger' : 'warning' },
          ];
          const category = getString(payload.category);
          if (category) {
            tags.push({ label: category, tone: 'neutral' });
          }
          const step = createStep(
            event,
            'agent-error',
            event.type === 'amp.agent.fatal' ? 'Agent stopped' : 'Agent issue',
            undefined,
            tags,
            truncateText(message, 180),
            undefined,
            message,
            appendRawSection(undefined, 'Issue details', payload),
            'Issue details',
            'failed',
          );
          steps.push(step);
          currentLLMStep = null;
          currentToolStep = null;
          break;
        }
        case 'amp.command.status': {
          const statusLabel = getString(payload.status) ?? 'updated';
          if (['accepted', 'running'].includes(statusLabel)) break;
          const step = createStep(
            event,
            'command-status',
            `Command ${statusLabel}`,
            undefined,
            [{ label: statusLabel, tone: statusLabel === 'aborted' ? 'warning' : 'neutral' }],
            getString(payload.command),
            undefined,
            undefined,
            appendRawSection(undefined, 'Run details', payload),
            'Run details',
            statusLabel === 'aborted' ? 'blocked' : 'completed',
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
      totalTokensIn: blockEvents.reduce((sum, event) => {
        if (!['llm.response', 'amp.llm.response'].includes(event.type)) return sum;
        return sum + (typeof event.payload.tokensIn === 'number' ? event.payload.tokensIn : 0);
      }, 0),
      totalTokensOut: blockEvents.reduce((sum, event) => {
        if (!['llm.response', 'amp.llm.response'].includes(event.type)) return sum;
        return sum + (typeof event.payload.tokensOut === 'number' ? event.payload.tokensOut : 0);
      }, 0),
      totalTokens: blockEvents.reduce((sum, event) => {
        if (!['llm.response', 'amp.llm.response'].includes(event.type)) return sum;
        return (
          sum +
          (typeof event.payload.tokensIn === 'number' ? event.payload.tokensIn : 0) +
          (typeof event.payload.tokensOut === 'number' ? event.payload.tokensOut : 0)
        );
      }, 0),
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
