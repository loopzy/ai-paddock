import { describe, expect, it } from 'vitest';
import {
  buildOpenClawRuntimeConfig,
  getOpenClawProviderProxyBaseUrl,
  toOpenClawModelRef,
} from '../agents/openclaw-config.js';

describe('openclaw-config', () => {
  it('maps OpenRouter presets to OpenClaw model refs', () => {
    expect(toOpenClawModelRef({ provider: 'openrouter', model: 'qwen/qwen-2.5-72b-instruct' })).toBe(
      'openrouter/qwen/qwen-2.5-72b-instruct',
    );
    expect(toOpenClawModelRef({ provider: 'openrouter', model: 'openrouter/moonshotai/kimi-k2' })).toBe(
      'openrouter/moonshotai/kimi-k2',
    );
  });

  it('maps direct providers to provider/model refs', () => {
    expect(toOpenClawModelRef({ provider: 'anthropic', model: 'claude-3-5-haiku-latest' })).toBe(
      'anthropic/claude-3-5-haiku-latest',
    );
    expect(toOpenClawModelRef({ provider: 'openai', model: 'openai/gpt-4o-mini' })).toBe('openai/gpt-4o-mini');
  });

  it('builds a gateway config that pins the OpenClaw default model and provider proxy', () => {
    const config = buildOpenClawRuntimeConfig({
      llm: { provider: 'openrouter', model: 'qwen/qwen-2.5-72b-instruct' },
      gatewayPort: 18789,
      browserEnabled: true,
      browserHeadless: true,
      browserExecutablePath: '/usr/bin/chromium',
    });

    expect(config.gateway).toEqual({
      mode: 'local',
      port: 18789,
      bind: 'loopback',
      auth: { mode: 'none' },
    });
    expect(config.browser).toEqual({
      enabled: true,
      headless: true,
      noSandbox: true,
      executablePath: '/usr/bin/chromium',
    });
    expect(config.plugins).toEqual({
      load: {
        paths: ['/opt/paddock/openclaw/paddock-amp-plugin'],
      },
      allow: ['paddock-amp'],
      entries: {
        'paddock-amp': {
          enabled: true,
          config: {
            sidecarUrl: 'http://127.0.0.1:8801',
            workspaceRoot: '/workspace',
            logFile: '/tmp/openclaw/paddock-amp-plugin.log',
          },
        },
      },
    });
    expect(config.agents.defaults.workspace).toBe('/workspace');
    expect(config.agents.defaults.sandbox).toEqual({
      mode: 'off',
    });
    expect(config.agents.defaults.model.primary).toBe('openrouter/qwen/qwen-2.5-72b-instruct');
    expect(config.agents.defaults.contextTokens).toBe(32768);
    expect(config.agents.defaults.compaction).toEqual({
      reserveTokens: 4096,
      reserveTokensFloor: 4096,
    });
    expect(config.agents.defaults.models).toEqual({
      'openrouter/qwen/qwen-2.5-72b-instruct': {
        params: {
          maxTokens: 8192,
          parallelToolCalls: false,
        },
      },
    });
    expect(config.models.providers.openrouter).toEqual({
      baseUrl: 'http://127.0.0.1:8800/openrouter/api/v1',
      models: [
        {
          id: 'openrouter/qwen/qwen-2.5-72b-instruct',
          name: 'openrouter/qwen/qwen-2.5-72b-instruct',
          reasoning: false,
          input: ['text'],
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          contextWindow: 32768,
          maxTokens: 8192,
        },
      ],
    });
    expect(config.tools).toEqual({
      web: {
        search: {
          enabled: true,
          provider: 'perplexity',
          perplexity: {
            baseUrl: 'http://127.0.0.1:8800/openrouter/api/v1',
            model: 'perplexity/sonar-pro',
          },
        },
      },
    });
  });

  it('uses model-specific context metadata for larger OpenRouter presets', () => {
    const config = buildOpenClawRuntimeConfig({
      llm: { provider: 'openrouter', model: 'moonshotai/kimi-k2' },
      browserEnabled: true,
    });

    expect(config.agents.defaults.model.primary).toBe('openrouter/moonshotai/kimi-k2');
    expect(config.agents.defaults.contextTokens).toBe(262144);
    expect(config.models.providers.openrouter.models[0]).toMatchObject({
      id: 'openrouter/moonshotai/kimi-k2',
      contextWindow: 262144,
      maxTokens: 8192,
    });
    expect(config.agents.defaults.models).toEqual({
      'openrouter/moonshotai/kimi-k2': {
        params: {
          maxTokens: 8192,
          parallelToolCalls: false,
        },
      },
    });
  });

  it('uses provider-specific Sidecar proxy routes', () => {
    expect(getOpenClawProviderProxyBaseUrl('anthropic')).toBe('http://127.0.0.1:8800/anthropic');
    expect(getOpenClawProviderProxyBaseUrl('openrouter')).toBe('http://127.0.0.1:8800/openrouter/api/v1');
    expect(getOpenClawProviderProxyBaseUrl('openai', 'http://127.0.0.1:9900')).toBe(
      'http://127.0.0.1:9900/openai/v1',
    );
  });
});
