/**
 * LLM Relay — host-side proxy that injects API keys and forwards to real LLM APIs.
 *
 * API keys are stored on the host via environment variables and NEVER sent to the VM.
 * The Sidecar's LLM Proxy sends requests here, we inject the key, forward to the
 * real API, and return the response.
 */

import type { LLMConfigStore } from '../config/llm-config-store.js';

const PROVIDER_CONFIG: Record<string, { baseUrl: string; authHeader: string; envKeys: string[]; baseUrlEnvKey?: string }> = {
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    authHeader: 'x-api-key',
    envKeys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    baseUrlEnvKey: 'ANTHROPIC_BASE_URL',
  },
  openai: {
    baseUrl: 'https://api.openai.com',
    authHeader: 'authorization',
    envKeys: ['OPENAI_API_KEY'],
    baseUrlEnvKey: 'OPENAI_BASE_URL',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai',
    authHeader: 'authorization',
    envKeys: ['OPENROUTER_API_KEY'],
    baseUrlEnvKey: 'OPENROUTER_BASE_URL',
  },
  google: {
    baseUrl: 'https://generativelanguage.googleapis.com',
    authHeader: 'x-goog-api-key',
    envKeys: ['GOOGLE_API_KEY'],
    baseUrlEnvKey: 'GOOGLE_BASE_URL',
  },
};

const STRIPPED_FORWARD_HEADERS = new Set([
  'host',
  'connection',
  'proxy-connection',
  'transfer-encoding',
  'content-length',
]);

function enableNodeProxyFromEnv() {
  const hasProxy = Boolean(
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy
  );

  if (hasProxy && process.env.NODE_USE_ENV_PROXY === undefined) {
    process.env.NODE_USE_ENV_PROXY = '1';
  }
}

function normalizeProviderPath(provider: string, path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  if (provider === 'openrouter') {
    return normalizedPath.startsWith('/api/') ? normalizedPath : `/api/v1${normalizedPath}`;
  }

  if (provider === 'openai') {
    return normalizedPath.startsWith('/v1/') ? normalizedPath : `/v1${normalizedPath}`;
  }

  return normalizedPath;
}

export interface LLMProxyRequest {
  provider: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  sessionId?: string;
}

export interface LLMProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  effectiveBody?: string;
  effectiveModel?: string;
}

export class LLMRelay {
  private configStore: LLMConfigStore | null;

  constructor(configStore?: LLMConfigStore) {
    this.configStore = configStore || null;
    enableNodeProxyFromEnv();
  }

  private getApiKey(config: { envKeys: string[] }, provider: string): string | undefined {
    // 1. Check database first (runtime configuration)
    if (this.configStore) {
      const apiKey = this.configStore.getApiKey(provider);
      console.log(`[LLMRelay] getApiKey for ${provider}: DB returned ${apiKey ? 'key found (length=' + apiKey.length + ')' : 'null'}`);
      if (apiKey) return apiKey;
    } else {
      console.log(`[LLMRelay] getApiKey for ${provider}: configStore is null`);
    }

    // 2. Fallback to environment variables
    const envKey = config.envKeys.map((key) => process.env[key]).find((value) => !!value);
    console.log(`[LLMRelay] getApiKey for ${provider}: ENV returned ${envKey ? 'key found' : 'null'}`);
    return envKey;
  }

  private getBaseUrl(config: { baseUrl: string; baseUrlEnvKey?: string }, provider: string): string {
    // 1. Check database first
    if (this.configStore) {
      const baseUrl = this.configStore.getBaseUrl(provider);
      if (baseUrl) return baseUrl.replace(/\/+$/, '');
    }

    // 2. Check environment variable
    const override = config.baseUrlEnvKey ? process.env[config.baseUrlEnvKey]?.trim() : '';
    return (override || config.baseUrl).replace(/\/+$/, '');
  }

  private rewriteRequestBody(
    provider: string,
    headers: Record<string, string>,
    body: string,
  ): { body: string; effectiveModel?: string } {
    const configuredModel = this.configStore?.getModel(provider);
    if (!configuredModel) {
      return { body, effectiveModel: this.extractModelFromBody(body) };
    }

    const contentTypeHeader = Object.entries(headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? '';
    const looksLikeJson = contentTypeHeader.toLowerCase().includes('application/json') || body.trim().startsWith('{');
    if (!looksLikeJson) {
      return { body, effectiveModel: this.extractModelFromBody(body) };
    }

    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { body, effectiveModel: this.extractModelFromBody(body) };
      }

      parsed.model = configuredModel;
      return {
        body: JSON.stringify(parsed),
        effectiveModel: configuredModel,
      };
    } catch {
      return { body, effectiveModel: this.extractModelFromBody(body) };
    }
  }

  private extractModelFromBody(body: string): string | undefined {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      return typeof parsed.model === 'string' && parsed.model ? parsed.model : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Forward a request to the real LLM API with injected credentials.
   */
  async forward(req: LLMProxyRequest): Promise<LLMProxyResponse> {
    const config = PROVIDER_CONFIG[req.provider];
    if (!config) {
      return {
        status: 400,
        headers: {},
        body: JSON.stringify({ error: `Unknown provider: ${req.provider}` }),
      };
    }

    const apiKey = this.getApiKey(config, req.provider);
    if (!apiKey) {
      return {
        status: 500,
        headers: {},
        body: JSON.stringify({
          error: `API key not configured for ${req.provider}. Configure via the dashboard (⚙️ API Keys button) or set environment variables (${config.envKeys.join(', ')}).`,
        }),
      };
    }

    // Build auth header value
    const authValue = config.authHeader === 'authorization' ? `Bearer ${apiKey}` : apiKey;
    const rewritten = this.rewriteRequestBody(req.provider, req.headers, req.body);

    // Forward to real API
    const normalizedPath = normalizeProviderPath(req.provider, req.path);
    const targetUrl = `${this.getBaseUrl(config, req.provider)}${normalizedPath}`;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (STRIPPED_FORWARD_HEADERS.has(key.toLowerCase())) continue;
      headers[key] = value;
    }
    headers[config.authHeader] = authValue;

    try {
      const response = await fetch(targetUrl, {
        method: req.method,
        headers,
        body: req.method !== 'GET' && req.method !== 'HEAD' ? rewritten.body : undefined,
      });

      const body = await response.text();
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        // The body has already been decoded into text, so encoded/length-specific
        // transport headers would become stale if we forwarded them as-is.
        if (k !== 'transfer-encoding' && k !== 'connection' && k !== 'content-encoding' && k !== 'content-length') {
          responseHeaders[k] = v;
        }
      });

      return {
        status: response.status,
        headers: responseHeaders,
        body,
        effectiveBody: rewritten.body,
        effectiveModel: rewritten.effectiveModel,
      };
    } catch (err) {
      return {
        status: 502,
        headers: {},
        body: JSON.stringify({ error: `Failed to reach ${req.provider} API: ${err}` }),
        effectiveBody: rewritten.body,
        effectiveModel: rewritten.effectiveModel,
      };
    }
  }

  /**
   * Check which providers have API keys configured.
   */
  getConfiguredProviders(): string[] {
    return Object.entries(PROVIDER_CONFIG)
      .filter(([provider, config]) => !!this.getApiKey(config, provider))
      .map(([name]) => name);
  }
}
