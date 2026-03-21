import { describe, it, expect } from 'vitest';
import { EventStore } from '../events/event-store.js';
import { LLMConfigStore } from '../config/llm-config-store.js';
import { LLMRelay } from '../mcp/llm-relay.js';

describe('LLMRelay', () => {
  describe('getConfiguredProviders', () => {
    it('should return empty array when no keys configured', () => {
      // Save and clear env
      const saved = { ...process.env };
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.GOOGLE_API_KEY;

      try {
        const relay = new LLMRelay();
        expect(relay.getConfiguredProviders()).toEqual([]);
      } finally {
        Object.assign(process.env, saved);
      }
    });

    it('should detect configured providers', () => {
      const saved = { ...process.env };
      process.env.ANTHROPIC_API_KEY = 'test-key';
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      process.env.OPENAI_API_KEY = 'test-key';
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.GOOGLE_API_KEY;

      try {
        const relay = new LLMRelay();
        const providers = relay.getConfiguredProviders();
        expect(providers).toContain('anthropic');
        expect(providers).toContain('openai');
        expect(providers).not.toContain('openrouter');
        expect(providers).not.toContain('google');
      } finally {
        Object.assign(process.env, saved);
      }
    });

    it('enables Node env proxy support when proxy variables are present', () => {
      const savedNodeUseEnvProxy = process.env.NODE_USE_ENV_PROXY;
      const savedHttpsProxy = process.env.HTTPS_PROXY;
      const savedLowerHttpsProxy = process.env.https_proxy;

      delete process.env.NODE_USE_ENV_PROXY;
      process.env.https_proxy = 'http://127.0.0.1:7890';
      delete process.env.HTTPS_PROXY;

      try {
        new LLMRelay();
        expect(process.env.NODE_USE_ENV_PROXY).toBe('1');
      } finally {
        if (savedNodeUseEnvProxy === undefined) delete process.env.NODE_USE_ENV_PROXY;
        else process.env.NODE_USE_ENV_PROXY = savedNodeUseEnvProxy;
        if (savedHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
        else process.env.HTTPS_PROXY = savedHttpsProxy;
        if (savedLowerHttpsProxy === undefined) delete process.env.https_proxy;
        else process.env.https_proxy = savedLowerHttpsProxy;
      }
    });
  });

  describe('forward', () => {
    it('should return 400 for unknown provider', async () => {
      const relay = new LLMRelay();
      const result = await relay.forward({
        provider: 'unknown-provider',
        method: 'POST',
        path: '/v1/messages',
        headers: {},
        body: '{}',
      });
      expect(result.status).toBe(400);
      expect(result.body).toContain('Unknown provider');
    });

    it('should return 500 when API key not configured', async () => {
      const saved = process.env.ANTHROPIC_API_KEY;
      const savedAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;

      const relay = new LLMRelay();
      const result = await relay.forward({
        provider: 'anthropic',
        method: 'POST',
        path: '/v1/messages',
        headers: {},
        body: '{}',
      });
      expect(result.status).toBe(500);
      expect(result.body).toContain('API key not configured');

      if (saved) process.env.ANTHROPIC_API_KEY = saved;
      if (savedAuthToken) process.env.ANTHROPIC_AUTH_TOKEN = savedAuthToken;
    });

    it('should honor ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN overrides', async () => {
      const savedApiKey = process.env.ANTHROPIC_API_KEY;
      const savedAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
      const savedBaseUrl = process.env.ANTHROPIC_BASE_URL;
      const originalFetch = global.fetch;

      process.env.ANTHROPIC_BASE_URL = 'https://claude.example.test/';
      delete process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_AUTH_TOKEN = 'proxy-token';

      global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe('https://claude.example.test/v1/messages');
        expect(init?.headers).toMatchObject({ 'x-api-key': 'proxy-token' });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      try {
        const relay = new LLMRelay();
        const result = await relay.forward({
          provider: 'anthropic',
          method: 'POST',
          path: '/v1/messages',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });

        expect(result.status).toBe(200);
        expect(result.body).toContain('"ok":true');
      } finally {
        global.fetch = originalFetch;
        if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = savedApiKey;
        if (savedAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
        else process.env.ANTHROPIC_AUTH_TOKEN = savedAuthToken;
        if (savedBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
        else process.env.ANTHROPIC_BASE_URL = savedBaseUrl;
      }
    });

    it('strips transport headers like content-length before forwarding', async () => {
      const saved = process.env.OPENROUTER_API_KEY;
      const originalFetch = global.fetch;
      process.env.OPENROUTER_API_KEY = 'test-openrouter-key';

      global.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
        expect(init?.headers).not.toMatchObject({
          'content-length': '999',
          host: '127.0.0.1:8800',
        });
        expect(init?.headers).toMatchObject({
          authorization: 'Bearer test-openrouter-key',
          'content-type': 'application/json',
        });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      try {
        const relay = new LLMRelay();
        const result = await relay.forward({
          provider: 'openrouter',
          method: 'POST',
          path: '/api/v1/chat/completions',
          headers: {
            'content-type': 'application/json',
            'content-length': '999',
            host: '127.0.0.1:8800',
          },
          body: '{"hello":"world"}',
        });

        expect(result.status).toBe(200);
      } finally {
        global.fetch = originalFetch;
        if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
        else process.env.OPENROUTER_API_KEY = saved;
      }
    });

    it('normalizes OpenRouter OpenAI-compatible paths onto /api/v1', async () => {
      const saved = process.env.OPENROUTER_API_KEY;
      const originalFetch = global.fetch;
      process.env.OPENROUTER_API_KEY = 'test-openrouter-key';

      global.fetch = async (input: string | URL | Request) => {
        expect(String(input)).toBe('https://openrouter.ai/api/v1/chat/completions');
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      try {
        const relay = new LLMRelay();
        const result = await relay.forward({
          provider: 'openrouter',
          method: 'POST',
          path: '/chat/completions',
          headers: { 'content-type': 'application/json' },
          body: '{"hello":"world"}',
        });

        expect(result.status).toBe(200);
      } finally {
        global.fetch = originalFetch;
        if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
        else process.env.OPENROUTER_API_KEY = saved;
      }
    });

    it('normalizes OpenAI-compatible paths onto /v1 for OpenAI', async () => {
      const saved = process.env.OPENAI_API_KEY;
      const originalFetch = global.fetch;
      process.env.OPENAI_API_KEY = 'test-openai-key';

      global.fetch = async (input: string | URL | Request) => {
        expect(String(input)).toBe('https://api.openai.com/v1/chat/completions');
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      try {
        const relay = new LLMRelay();
        const result = await relay.forward({
          provider: 'openai',
          method: 'POST',
          path: '/chat/completions',
          headers: { 'content-type': 'application/json' },
          body: '{"hello":"world"}',
        });

        expect(result.status).toBe(200);
      } finally {
        global.fetch = originalFetch;
        if (saved === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = saved;
      }
    });

    it('drops stale content-encoding headers after decoding upstream text', async () => {
      const saved = process.env.OPENROUTER_API_KEY;
      const originalFetch = global.fetch;
      process.env.OPENROUTER_API_KEY = 'test-openrouter-key';

      global.fetch = async () => {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-encoding': 'gzip',
            'content-length': '123',
          },
        });
      };

      try {
        const relay = new LLMRelay();
        const result = await relay.forward({
          provider: 'openrouter',
          method: 'POST',
          path: '/api/v1/chat/completions',
          headers: { 'content-type': 'application/json' },
          body: '{"hello":"world"}',
        });

        expect(result.status).toBe(200);
        expect(result.headers['content-encoding']).toBeUndefined();
        expect(result.headers['content-length']).toBeUndefined();
        expect(result.headers['content-type']).toBe('application/json');
      } finally {
        global.fetch = originalFetch;
        if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
        else process.env.OPENROUTER_API_KEY = saved;
      }
    });

    it('reads updated API keys from the host config store on each request', async () => {
      const eventStore = new EventStore(':memory:');
      const configStore = new LLMConfigStore(eventStore.db);
      const originalFetch = global.fetch;
      const seenAuthHeaders: string[] = [];
      const seenModels: string[] = [];

      global.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string> | undefined;
        seenAuthHeaders.push(headers?.authorization ?? '');
        const parsed = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
        seenModels.push(parsed.model ?? '');
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      try {
        configStore.upsert('openrouter', {
          apiKey: 'first-key',
          baseUrl: 'https://openrouter.ai/api/v1',
          model: 'moonshotai/kimi-k2',
        });

        const relay = new LLMRelay(configStore);
        await relay.forward({
          provider: 'openrouter',
          method: 'POST',
          path: '/chat/completions',
          headers: { 'content-type': 'application/json' },
          body: '{"model":"moonshotai/kimi-k2","messages":[]}',
        });

        configStore.upsert('openrouter', {
          apiKey: 'second-key',
          model: 'qwen/qwen3.5-flash-02-23',
        });

        await relay.forward({
          provider: 'openrouter',
          method: 'POST',
          path: '/chat/completions',
          headers: { 'content-type': 'application/json' },
          body: '{"model":"moonshotai/kimi-k2","messages":[]}',
        });

        expect(seenAuthHeaders).toEqual([
          'Bearer first-key',
          'Bearer second-key',
        ]);
        expect(seenModels).toEqual([
          'moonshotai/kimi-k2',
          'qwen/qwen3.5-flash-02-23',
        ]);
      } finally {
        global.fetch = originalFetch;
        eventStore.close();
      }
    });
  });
});
