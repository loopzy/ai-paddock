export type LLMReviewProvider = 'ollama' | 'openai-compatible';

export interface LLMReviewClientConfig {
  provider: LLMReviewProvider;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  temperature?: number;
  maxTokens?: number;
}

export interface LLMReviewRequest {
  systemPrompt: string;
  userPrompt: string;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function resolveOpenAICompatibleUrl(baseUrl: string): string {
  const trimmed = trimTrailingSlash(baseUrl);
  if (trimmed.endsWith('/chat/completions')) {
    return trimmed;
  }
  return `${trimmed}/chat/completions`;
}

function parseJsonResponse(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`LLM review endpoint returned invalid JSON: ${String(error)}`);
  }
}

function extractOpenAICompatibleContent(payload: Record<string, unknown>): string {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== 'object') {
    throw new Error('LLM review endpoint returned no choices');
  }

  const message = (firstChoice as { message?: unknown }).message;
  if (!message || typeof message !== 'object') {
    throw new Error('LLM review endpoint returned no message payload');
  }

  const content = (message as { content?: unknown }).content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('LLM review endpoint returned empty message content');
  }

  return content;
}

function extractOllamaContent(payload: Record<string, unknown>): string {
  const message = payload.message;
  if (!message || typeof message !== 'object') {
    throw new Error('Ollama review endpoint returned no message payload');
  }

  const content = (message as { content?: unknown }).content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('Ollama review endpoint returned empty message content');
  }

  return content;
}

export class LLMReviewClient {
  private readonly config: Required<Pick<LLMReviewClientConfig, 'provider' | 'model' | 'timeoutMs' | 'temperature' | 'maxTokens'>> &
    Pick<LLMReviewClientConfig, 'baseUrl' | 'apiKey'>;

  constructor(config: LLMReviewClientConfig) {
    const defaultTimeoutMs = config.provider === 'ollama' ? 30_000 : 8_000;
    this.config = {
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs ?? defaultTimeoutMs,
      temperature: config.temperature ?? 0,
      maxTokens: config.maxTokens ?? 300,
    };
  }

  getProviderLabel(): string {
    return `${this.config.provider}:${this.config.model}`;
  }

  async review(request: LLMReviewRequest): Promise<string> {
    if (this.config.provider === 'ollama') {
      return this.reviewWithOllama(request);
    }
    return this.reviewWithOpenAICompatible(request);
  }

  private async reviewWithOllama(request: LLMReviewRequest): Promise<string> {
    const baseUrl = trimTrailingSlash(this.config.baseUrl ?? 'http://127.0.0.1:11434');
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model,
        stream: false,
        format: 'json',
        options: {
          temperature: this.config.temperature,
          num_predict: this.config.maxTokens,
        },
        messages: [
          { role: 'system', content: request.systemPrompt },
          { role: 'user', content: request.userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Ollama review request failed with status ${response.status}`);
    }

    const payload = parseJsonResponse(await response.text());
    return extractOllamaContent(payload);
  }

  private async reviewWithOpenAICompatible(request: LLMReviewRequest): Promise<string> {
    const baseUrl = this.config.baseUrl ?? 'https://api.openai.com/v1';
    const response = await fetch(resolveOpenAICompatibleUrl(baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.config.model,
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: request.systemPrompt },
          { role: 'user', content: request.userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`OpenAI-compatible review request failed with status ${response.status}`);
    }

    const payload = parseJsonResponse(await response.text());
    return extractOpenAICompatibleContent(payload);
  }
}
