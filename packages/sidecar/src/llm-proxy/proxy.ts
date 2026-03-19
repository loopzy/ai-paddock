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

    if (secretsFound > 0) {
      await this.reporter.report('llm.request', {
        provider,
        model: extractModel(maskedBody),
        messageCount: extractMessageCount(maskedBody),
        toolCount: extractToolCount(maskedBody),
        messagesPreview: extractMessagesPreview(maskedBody),
        vault: { secretsMasked: secretsFound, categories },
      });
    } else {
      await this.reportLLMRequest(provider, maskedBody);
    }

    // Forward to Control Plane
    const startTime = Date.now();
    try {
      const upstream = await this.fetchControlPlane({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, method: req.method, path: apiPath, headers: filterHeaders(req.headers), body: maskedBody, sessionId: this.sessionId }),
      });

      const result = await upstream.json() as { status: number; headers: Record<string, string>; body: string };
      const durationMs = Date.now() - startTime;

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
      await this.reportLLMResponse(provider, result.body, durationMs, result.headers['content-type']);
      const restoredBody = this.vault.unmask(result.body);
      res.writeHead(result.status, result.headers);
      res.end(restoredBody);
    } catch (err) {
      console.error('LLM Proxy forward error:', err);
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

  private async reportLLMResponse(provider: string, body: string, durationMs: number, contentType = '') {
    const summary = parseLLMResponseBody(body, contentType);
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

function parseLLMResponseBody(body: string, contentType = ''): LLMResponseSummary | null {
  const trimmed = body.trim();
  if (!trimmed) return null;

  const asJson = parseJsonLLMResponse(body);
  if (asJson) return asJson;

  if (contentType.toLowerCase().includes('text/event-stream') || trimmed.startsWith('data:')) {
    return parseSseLLMResponse(body);
  }

  return null;
}

function parseJsonLLMResponse(body: string): LLMResponseSummary | null {
  try {
    const parsed = JSON.parse(body) as Record<string, any>;
    const usage = parsed.usage ?? {};
    const content = extractResponseContent(parsed);
    return {
      model: typeof parsed.model === 'string' ? parsed.model : 'unknown',
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

function parseSseLLMResponse(body: string): LLMResponseSummary | null {
  const lines = body.split(/\r?\n/);
  let model = 'unknown';
  let tokensIn = 0;
  let tokensOut = 0;
  const content: unknown[] = [];
  let chunkCount = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;

    const payload = line.slice('data:'.length).trim();
    if (!payload || payload === '[DONE]') continue;

    try {
      const parsed = JSON.parse(payload) as Record<string, any>;
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

function extractTextPreview(content: unknown): string {
  if (typeof content === 'string') {
    return truncatePreview(content.trim());
  }
  if (Array.isArray(content)) {
    const text = content
      .map((item) => {
        if (!item || typeof item !== 'object') return '';
        const block = item as Record<string, unknown>;
        if (block.type === 'text' && typeof block.text === 'string') {
          return block.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
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
  const parts = content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const record = block as Record<string, unknown>;
      if (record.type === 'text' && typeof record.text === 'string') {
        return record.text;
      }
      if (record.type === 'tool_use' && typeof record.name === 'string') {
        return `[tool] ${record.name}`;
      }
      if (record.type === 'function' && record.function && typeof record.function === 'object') {
        const fn = record.function as Record<string, unknown>;
        return typeof fn.name === 'string' ? `[tool] ${fn.name}` : '';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
  return parts ? truncatePreview(parts, 400) : '';
}
