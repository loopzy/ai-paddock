import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { EventReporter } from '../reporter.js';
import { SensitiveDataVault } from '../vault/sensitive-data-vault.js';
import { ControlPlaneClient } from '../control-plane-client.js';

/**
 * LLM Proxy — reverse proxy between Agent and Control Plane.
 *
 * Security layers:
 *   1. Adversarial instruction detection — scans agent messages for bypass attempts
 *   2. Sensitive Data Vault — masks secrets before they reach the LLM
 *   3. API Key isolation — keys stay on host, never enter VM
 *
 * Note: Intent declaration is now handled at the agent layer, not here.
 */

const PROVIDER_PATHS: Record<string, string> = {
  '/anthropic': 'anthropic',
  '/openai': 'openai',
  '/openrouter': 'openrouter',
  '/google': 'google',
};

function getRetryAttempts(): number {
  const parsed = Number(process.env.PADDOCK_LLM_PROXY_FETCH_ATTEMPTS ?? 3);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 3;
}

function getRetryDelayMs(): number {
  const parsed = Number(process.env.PADDOCK_LLM_PROXY_RETRY_DELAY_MS ?? 250);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 250;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Adversarial instruction detection ──
const ADVERSARIAL_PATTERNS = [
  /ignore.*paddock/i,
  /don't.*declare.*intent/i,
  /hide.*from.*monitor/i,
  /always.*say.*routine/i,
  /pretend.*you.*are/i,
  /disregard.*system.*prompt/i,
  /override.*instructions/i,
];

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
    // keep defaults for non-JSON errors
  }

  const messageLower = message.toLowerCase();
  if (messageLower.includes('api key not configured') || messageLower.includes('api_key') || statusHint === 401) {
    return { category: 'auth', code: 'ERR_NO_API_KEY', message };
  }
  if (statusHint === 429 || messageLower.includes('rate limit')) {
    return { category: 'resource', code: 'ERR_RATE_LIMIT', message };
  }
  if (result.status === 502 || result.status === 503 || result.status === 504) {
    return { category: 'network', code: 'ERR_LLM_UNAVAILABLE', message };
  }
  return { category: 'runtime', code: 'ERR_LLM_UPSTREAM', message };
}

export class LLMProxy {
  private port: number;
  private reporter: EventReporter;
  private controlPlaneClient: ControlPlaneClient;
  private sessionId: string;
  private vault: SensitiveDataVault;
  private server: ReturnType<typeof createServer> | null = null;

  constructor(port: number, reporter: EventReporter, controlPlaneClient: ControlPlaneClient, sessionId = '') {
    this.port = port;
    this.reporter = reporter;
    this.controlPlaneClient = controlPlaneClient;
    this.sessionId = sessionId;
    this.vault = new SensitiveDataVault();
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handleRequest(req, res));
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, '127.0.0.1', () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
  }

  stop() { this.server?.close(); }

  private async fetchControlPlane(init: RequestInit): Promise<Response> {
    const attempts = getRetryAttempts();
    const baseDelayMs = getRetryDelayMs();
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.controlPlaneClient.fetch('/api/llm/proxy', init);
      } catch (error) {
        lastError = error;
        if (attempt >= attempts) {
          throw error;
        }
        await sleep(baseDelayMs * attempt);
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Control plane fetch failed');
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse) {
    const rawUrl = req.url ?? '/';
    let provider = 'unknown';
    let apiPath = rawUrl;
    for (const [prefix, name] of Object.entries(PROVIDER_PATHS)) {
      if (rawUrl.startsWith(prefix)) {
        provider = name;
        apiPath = rawUrl.slice(prefix.length) || '/';
        break;
      }
    }

    const reqBody = await collectBody(req);

    // ── Adversarial detection on agent messages ──
    this.scanForAdversarial(reqBody);

    // ── Vault: mask sensitive data ──
    const { masked: maskedBody, secretsFound, categories } = this.vault.mask(reqBody);

    // Forward to Control Plane
    const startTime = Date.now();
    try {
      const upstream = await this.fetchControlPlane({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, method: req.method, path: apiPath, headers: filterHeaders(req.headers), body: maskedBody, sessionId: this.sessionId }),
      });

      const result = await upstream.json() as {
        status: number;
        headers: Record<string, string>;
        body: string;
        effectiveBody?: string;
        effectiveModel?: string;
      };
      const durationMs = Date.now() - startTime;
      const effectiveBody = typeof result.effectiveBody === 'string' && result.effectiveBody ? result.effectiveBody : maskedBody;

      await this.reportForwardedLLMRequest(provider, effectiveBody, secretsFound, categories);

      // ── Detect upstream error (missing API key, provider down, etc.) ──
      if (result.status >= 400) {
        const error = parseLLMProxyError(result);

        await this.reporter.report('amp.agent.error' as any, {
          agent: 'sidecar-llm-proxy',
          category: error.category,
          code: error.code,
          message: error.message,
          recoverable: error.category !== 'auth',
          context: { provider, status: result.status, durationMs },
        });

        res.writeHead(result.status, result.headers);
        res.end(result.body);
        return;
      }

      // Report LLM response and restore masked secrets
      await this.reportLLMResponse(
        provider,
        result.body,
        durationMs,
        result.headers['content-type'],
        result.effectiveModel || extractModel(effectiveBody),
      );
      const restoredBody = this.vault.unmask(result.body);
      res.writeHead(result.status, result.headers);
      res.end(restoredBody);
    } catch (err) {
      console.error('LLM Proxy forward error:', err);
      await this.reportForwardedLLMRequest(provider, maskedBody, secretsFound, categories);
      await this.reporter.report('amp.agent.error' as any, {
        agent: 'sidecar-llm-proxy',
        category: 'network',
        code: 'ERR_LLM_UNREACHABLE',
        message: `Failed to reach control plane: ${err}`,
        recoverable: true,
        context: { provider },
      });
      res.writeHead(502);
      res.end('Bad Gateway');
    }
  }

  /** Scan agent messages for adversarial instructions. */
  private async scanForAdversarial(body: string): Promise<void> {
    try {
      const parsed = JSON.parse(body);
      const messages = parsed.messages ?? [];
      for (const msg of messages) {
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        for (const pattern of ADVERSARIAL_PATTERNS) {
          if (pattern.test(text)) {
            await this.reporter.report('amp.gate.verdict', {
              type: 'adversarial_detection', pattern: pattern.source, message_role: msg.role,
            });
            break;
          }
        }
      }
    } catch { /* non-JSON, skip */ }
  }

  private async reportLLMRequest(provider: string, body: string) {
    try {
      const parsed = JSON.parse(body);
      await this.reporter.report('llm.request', {
        provider,
        model: parsed.model ?? 'unknown',
        messageCount: parsed.messages?.length ?? 0,
        toolCount: parsed.tools?.length ?? 0,
        messagesPreview: extractMessagesPreview(body),
      });
    } catch { /* skip */ }
  }

  private async reportForwardedLLMRequest(
    provider: string,
    body: string,
    secretsFound: number,
    categories: string[],
  ) {
    if (secretsFound > 0) {
      await this.reporter.report('llm.request', {
        provider,
        model: extractModel(body),
        messageCount: extractMessageCount(body),
        toolCount: extractToolCount(body),
        messagesPreview: extractMessagesPreview(body),
        vault: { secretsMasked: secretsFound, categories },
      });
      return;
    }

    await this.reportLLMRequest(provider, body);
  }

  private async reportLLMResponse(provider: string, body: string, durationMs: number, contentType = '', requestModel = 'unknown') {
    const summary = parseLLMResponseBody(body, contentType, requestModel);
    if (!summary) return;

    await this.reporter.report('llm.response', {
      provider,
      model: summary.model,
      tokensIn: summary.tokensIn,
      tokensOut: summary.tokensOut,
      durationMs,
      streamed: summary.streamed,
      chunkCount: summary.chunkCount,
      responsePreview: extractResponsePreview(summary.content),
    });

    if (!summary.streamed && summary.content.length > 0) {
      await this.extractIntents(summary.content);
    }
  }

  private async extractIntents(content: unknown[]) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'thinking' && typeof b.thinking === 'string') {
        await this.reporter.report('agent.thought', { text: b.thinking });
      }
      if (b.type === 'tool_use') {
        await this.reporter.report('tool.intent', { toolName: b.name, toolInput: b.input, toolUseId: b.id });
      }
      if (b.type === 'function' && typeof b.function === 'object') {
        const fn = b.function as Record<string, unknown>;
        const toolInput =
          typeof fn.arguments === 'string'
            ? safeParseJson(fn.arguments) ?? fn.arguments
            : fn.arguments;
        await this.reporter.report('tool.intent', {
          toolName: fn.name,
          toolInput,
          toolUseId: b.id,
        });
      }
    }
  }
}

function safeParseJson(input: string): unknown | null {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

interface LLMResponseSummary {
  model: string;
  tokensIn: number;
  tokensOut: number;
  content: unknown[];
  streamed: boolean;
  chunkCount: number;
}

function parseLLMResponseBody(body: string, contentType = '', fallbackModel = 'unknown'): LLMResponseSummary | null {
  const trimmed = body.trim();
  if (!trimmed) return null;

  const asJson = parseJsonLLMResponse(body, fallbackModel);
  if (asJson) return asJson;

  if (contentType.toLowerCase().includes('text/event-stream') || trimmed.startsWith('data:')) {
    return parseSseLLMResponse(body, fallbackModel);
  }

  return null;
}

function parseJsonLLMResponse(body: string, fallbackModel = 'unknown'): LLMResponseSummary | null {
  try {
    const parsed = JSON.parse(body) as Record<string, any>;
    const usage = parsed.usage ?? {};
    const content = extractResponseContent(parsed);
    return {
      model: typeof parsed.model === 'string' && parsed.model ? parsed.model : fallbackModel,
      tokensIn: Number(usage.input_tokens ?? usage.prompt_tokens ?? 0),
      tokensOut: Number(usage.output_tokens ?? usage.completion_tokens ?? 0),
      content,
      streamed: false,
      chunkCount: 1,
    };
  } catch {
    return null;
  }
}

function parseSseLLMResponse(body: string, fallbackModel = 'unknown'): LLMResponseSummary | null {
  const lines = body.split(/\r?\n/);
  let model = fallbackModel;
  let tokensIn = 0;
  let tokensOut = 0;
  const content: unknown[] = [];
  let chunkCount = 0;
  const responseFunctionCalls = new Map<string, { id: string; name?: string; arguments: string[] }>();
  const seenContentKinds = new Set<'text' | 'reasoning' | 'tool'>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;

    const payload = line.slice('data:'.length).trim();
    if (!payload || payload === '[DONE]') continue;

    try {
      const parsed = JSON.parse(payload) as Record<string, any>;
      if (applyResponsesSseEvent(parsed, {
        setModel: (value) => { model = value; },
        setUsage: (input, output) => {
          tokensIn = input;
          tokensOut = output;
        },
        pushContent: (items) => {
          content.push(...items);
          for (const item of items) {
            const kind = detectContentKind(item);
            if (kind) {
              seenContentKinds.add(kind);
            }
          }
        },
        incrementChunk: () => { chunkCount += 1; },
        functionCalls: responseFunctionCalls,
        hasContentKind: (kind) => seenContentKinds.has(kind),
      })) {
        continue;
      }

      chunkCount += 1;
      if (typeof parsed.model === 'string' && parsed.model) {
        model = parsed.model;
      }
      const usage = parsed.usage ?? {};
      tokensIn = Number(usage.input_tokens ?? usage.prompt_tokens ?? tokensIn ?? 0);
      tokensOut = Number(usage.output_tokens ?? usage.completion_tokens ?? tokensOut ?? 0);
      content.push(...extractResponseContent(parsed));
    } catch {
      // Ignore malformed SSE chunks and keep scanning the stream.
    }
  }

  if (chunkCount === 0) return null;

  return {
    model,
    tokensIn,
    tokensOut,
    content,
    streamed: true,
    chunkCount,
  };
}

function applyResponsesSseEvent(
  parsed: Record<string, any>,
  state: {
    setModel: (value: string) => void;
    setUsage: (tokensIn: number, tokensOut: number) => void;
    pushContent: (items: unknown[]) => void;
    incrementChunk: () => void;
    functionCalls: Map<string, { id: string; name?: string; arguments: string[] }>;
    hasContentKind: (kind: 'text' | 'reasoning' | 'tool') => boolean;
  },
): boolean {
  const eventType = typeof parsed.type === 'string' ? parsed.type : '';
  if (!eventType.startsWith('response.')) {
    return false;
  }

  state.incrementChunk();

  const response = parsed.response && typeof parsed.response === 'object'
    ? (parsed.response as Record<string, any>)
    : undefined;
  if (typeof response?.model === 'string' && response.model) {
    state.setModel(response.model);
  }

  const usage = response?.usage;
  if (usage && typeof usage === 'object') {
    state.setUsage(
      Number(usage.input_tokens ?? usage.prompt_tokens ?? 0),
      Number(usage.output_tokens ?? usage.completion_tokens ?? 0),
    );
  }

  if (eventType === 'response.output_text.delta' && typeof parsed.delta === 'string' && parsed.delta) {
    state.pushContent([{ type: 'text', text: parsed.delta }]);
    return true;
  }

  if (eventType === 'response.output_text.done' && typeof parsed.text === 'string' && parsed.text) {
    if (state.hasContentKind('text')) {
      return true;
    }
    state.pushContent([{ type: 'text', text: parsed.text }]);
    return true;
  }

  if (eventType === 'response.reasoning_text.delta' && typeof parsed.delta === 'string' && parsed.delta) {
    state.pushContent([{ type: 'reasoning', text: parsed.delta }]);
    return true;
  }

  if (eventType === 'response.reasoning_text.done' && typeof parsed.text === 'string' && parsed.text) {
    if (state.hasContentKind('reasoning')) {
      return true;
    }
    state.pushContent([{ type: 'reasoning', text: parsed.text }]);
    return true;
  }

  if (eventType === 'response.content_part.added' || eventType === 'response.content_part.done') {
    const part = parsed.part && typeof parsed.part === 'object' ? (parsed.part as Record<string, any>) : undefined;
    if (part) {
      const extracted = filterMissingContentKinds(extractResponsesPart(part), state.hasContentKind);
      if (extracted.length > 0) {
        state.pushContent(extracted);
      }
    }
    return true;
  }

  if (eventType === 'response.output_item.added') {
    const item = parsed.item && typeof parsed.item === 'object' ? (parsed.item as Record<string, any>) : undefined;
    if (item?.type === 'function_call' && typeof item.id === 'string') {
      state.functionCalls.set(item.id, {
        id: item.id,
        name: typeof item.name === 'string' ? item.name : undefined,
        arguments: typeof item.arguments === 'string' && item.arguments ? [item.arguments] : [],
      });
    }
    if (item) {
      const extracted = filterMissingContentKinds(extractResponsesOutput([item]), state.hasContentKind);
      if (extracted.length > 0) {
        state.pushContent(extracted);
      }
    }
    return true;
  }

  if (eventType === 'response.output_item.done') {
    const item = parsed.item && typeof parsed.item === 'object' ? (parsed.item as Record<string, any>) : undefined;
    if (item?.type === 'function_call' && typeof item.id === 'string') {
      const existing = state.functionCalls.get(item.id) ?? {
        id: item.id,
        arguments: [],
      };
      if (typeof item.name === 'string' && item.name) {
        existing.name = item.name;
      }
      if (typeof item.arguments === 'string' && item.arguments) {
        existing.arguments = [item.arguments];
      }
      state.functionCalls.set(item.id, existing);
    }
    if (item) {
      const extracted = filterMissingContentKinds(extractResponsesOutput([item]), state.hasContentKind);
      if (extracted.length > 0) {
        state.pushContent(extracted);
      }
    }
    return true;
  }

  if (eventType === 'response.function_call_arguments.delta' && typeof parsed.item_id === 'string' && typeof parsed.delta === 'string') {
    const entry = state.functionCalls.get(parsed.item_id) ?? {
      id: parsed.item_id,
      arguments: [],
    };
    entry.arguments.push(parsed.delta);
    state.functionCalls.set(parsed.item_id, entry);
    return true;
  }

  if (eventType === 'response.function_call_arguments.done' && typeof parsed.item_id === 'string') {
    const entry = state.functionCalls.get(parsed.item_id);
    const name =
      typeof parsed.name === 'string'
        ? parsed.name
        : entry?.name;
    if (name) {
      state.pushContent([{
        type: 'function',
        id: parsed.item_id,
        function: {
          name,
          arguments: (entry?.arguments ?? []).join(''),
        },
      }]);
    }
    return true;
  }

  if (eventType === 'response.completed' && Array.isArray(response?.output)) {
    const extracted = filterMissingContentKinds(extractResponsesOutput(response.output), state.hasContentKind);
    if (extracted.length > 0) {
      state.pushContent(extracted);
    }
    return true;
  }

  return true;
}

function extractResponsesPart(part: Record<string, any>): unknown[] {
  if ((part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string' && part.text) {
    return [{ type: 'text', text: part.text }];
  }
  if ((part.type === 'reasoning_text' || part.type === 'reasoning') && typeof part.text === 'string' && part.text) {
    return [{ type: 'reasoning', text: part.text }];
  }
  return [];
}

function detectContentKind(item: unknown): 'text' | 'reasoning' | 'tool' | null {
  if (!item || typeof item !== 'object') return null;
  const record = item as Record<string, unknown>;
  if (record.type === 'text') return 'text';
  if (record.type === 'reasoning') return 'reasoning';
  if (record.type === 'tool_use' || record.type === 'function') return 'tool';
  return null;
}

function filterMissingContentKinds(
  items: unknown[],
  hasContentKind: (kind: 'text' | 'reasoning' | 'tool') => boolean,
): unknown[] {
  return items.filter((item) => {
    const kind = detectContentKind(item);
    return !kind || !hasContentKind(kind);
  });
}

function extractResponsesOutput(output: unknown[]): unknown[] {
  const collected: unknown[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, any>;

    if (record.type === 'message' && Array.isArray(record.content)) {
      for (const part of record.content) {
        if (!part || typeof part !== 'object') continue;
        const block = part as Record<string, any>;
        if ((block.type === 'output_text' || block.type === 'text') && typeof block.text === 'string' && block.text) {
          collected.push({ type: 'text', text: block.text });
        }
        if ((block.type === 'reasoning_text' || block.type === 'reasoning') && typeof block.text === 'string' && block.text) {
          collected.push({ type: 'reasoning', text: block.text });
        }
      }
    }

    if (record.type === 'reasoning') {
      if (Array.isArray(record.summary)) {
        for (const part of record.summary) {
          if (part && typeof part === 'object' && typeof (part as Record<string, any>).text === 'string') {
            collected.push({ type: 'reasoning', text: (part as Record<string, any>).text });
          }
        }
      }
      if (Array.isArray(record.content)) {
        for (const part of record.content) {
          if (part && typeof part === 'object' && typeof (part as Record<string, any>).text === 'string') {
            collected.push({ type: 'reasoning', text: (part as Record<string, any>).text });
          }
        }
      }
    }

    if (record.type === 'function_call' && typeof record.name === 'string') {
      collected.push({
        type: 'function',
        id: typeof record.id === 'string' ? record.id : undefined,
        function: {
          name: record.name,
          arguments: typeof record.arguments === 'string' ? record.arguments : '',
        },
      });
    }
  }
  return collected;
}

function extractResponseContent(parsed: Record<string, any>): unknown[] {
  if (Array.isArray(parsed.content)) {
    return parsed.content;
  }

  const choice = parsed.choices?.[0];
  if (!choice || typeof choice !== 'object') {
    return [];
  }

  const message = choice.message;
  if (message && typeof message === 'object') {
    const collected: unknown[] = [];
    if (Array.isArray(message.tool_calls)) {
      collected.push(...message.tool_calls);
    }
    if (typeof message.content === 'string' && message.content.trim()) {
      collected.push({ type: 'text', text: message.content });
    } else if (Array.isArray(message.content)) {
      collected.push(...message.content);
    }
    return collected;
  }

  const delta = choice.delta;
  if (delta && typeof delta === 'object') {
    const collected: unknown[] = [];
    if (Array.isArray(delta.tool_calls)) {
      collected.push(...delta.tool_calls);
    }
    if (typeof delta.content === 'string' && delta.content.trim()) {
      collected.push({ type: 'text', text: delta.content });
    }
    return collected;
  }

  return [];
}

function collectBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

function filterHeaders(headers: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (
      k === 'host' ||
      k === 'proxy-connection' ||
      k === 'authorization' ||
      k === 'x-api-key' ||
      k === 'content-length' ||
      k === 'transfer-encoding' ||
      k === 'connection'
    ) continue;
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function extractModel(body: string): string {
  try { return JSON.parse(body).model ?? 'unknown'; } catch { return 'unknown'; }
}
function extractMessageCount(body: string): number {
  try { return JSON.parse(body).messages?.length ?? 0; } catch { return 0; }
}
function extractToolCount(body: string): number {
  try { return JSON.parse(body).tools?.length ?? 0; } catch { return 0; }
}

function truncatePreview(value: string, maxChars = 280): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...`;
}

function mergeTextFragments(fragments: string[]): string {
  return fragments
    .join('')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractTextPreview(content: unknown): string {
  if (typeof content === 'string') {
    return truncatePreview(content.trim());
  }
  if (Array.isArray(content)) {
    const text = mergeTextFragments(
      content
        .map((item) => {
          if (!item || typeof item !== 'object') return '';
          const block = item as Record<string, unknown>;
          if (block.type === 'text' && typeof block.text === 'string') {
            return block.text;
          }
          return '';
        })
        .filter(Boolean),
    );
    return text ? truncatePreview(text) : '';
  }
  if (content && typeof content === 'object') {
    const record = content as Record<string, unknown>;
    if (typeof record.text === 'string') {
      return truncatePreview(record.text.trim());
    }
  }
  return '';
}

function extractMessagesPreview(body: string): Array<{ role: string; text: string }> {
  try {
    const parsed = JSON.parse(body) as { messages?: Array<{ role?: unknown; content?: unknown }> };
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    return messages
      .slice(-3)
      .map((message) => {
        const role = typeof message.role === 'string' ? message.role : 'unknown';
        const text = extractTextPreview(message.content);
        return text ? { role, text } : null;
      })
      .filter((value): value is { role: string; text: string } => Boolean(value));
  } catch {
    return [];
  }
}

function extractResponsePreview(content: unknown[]): string {
  const parts: string[] = [];
  const textBuffer: string[] = [];
  const reasoningBuffer: string[] = [];

  const flushTextBuffer = () => {
    const merged = mergeTextFragments(textBuffer);
    if (merged) {
      parts.push(merged);
    }
    textBuffer.length = 0;
  };

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string') {
      textBuffer.push(record.text);
      continue;
    }
    if (record.type === 'reasoning' && typeof record.text === 'string') {
      reasoningBuffer.push(record.text);
      continue;
    }

    flushTextBuffer();

    if (record.type === 'tool_use' && typeof record.name === 'string') {
      parts.push(`[tool] ${record.name}`);
      continue;
    }
    if (record.type === 'function' && record.function && typeof record.function === 'object') {
      const fn = record.function as Record<string, unknown>;
      if (typeof fn.name === 'string') {
        parts.push(`[tool] ${fn.name}`);
      }
    }
  }

  flushTextBuffer();

  const preview = parts.join('\n').trim();
  if (preview) {
    return truncatePreview(preview, 400);
  }

  const reasoningPreview = mergeTextFragments(reasoningBuffer).trim();
  return reasoningPreview ? truncatePreview(`[reasoning] ${reasoningPreview}`, 400) : '';
}
