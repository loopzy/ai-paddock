import type { AgentLLMConfig } from '../mcp/agent-llm-config.js';
import { getAgentModelRuntimeProfile } from '../mcp/agent-llm-config.js';

export interface OpenClawRuntimeConfig {
  gateway: {
    mode: 'local';
    port: number;
    bind: 'loopback';
    auth: { mode: 'none' };
  };
  browser: {
    enabled: boolean;
    headless?: boolean;
    noSandbox?: boolean;
    executablePath?: string;
  };
  plugins: {
    load: {
      paths: string[];
    };
    allow: string[];
    entries: {
      'paddock-amp': {
        enabled: true;
        config: {
          sidecarUrl: string;
          workspaceRoot: string;
          logFile: string;
        };
      };
    };
  };
  agents: {
    defaults: {
      workspace: string;
      sandbox: {
        mode: 'off';
      };
      contextTokens?: number;
      model: {
        primary: string;
      };
      models: Record<
        string,
        {
          params?: {
            maxTokens: number;
            parallelToolCalls: boolean;
          };
        }
      >;
      compaction?: {
        reserveTokens: number;
        reserveTokensFloor: number;
      };
    };
  };
  models: {
    providers: Record<
      string,
      {
        baseUrl: string;
        models: Array<{
          id: string;
          name: string;
          reasoning: boolean;
          input: Array<'text' | 'image'>;
          cost: {
            input: number;
            output: number;
            cacheRead: number;
            cacheWrite: number;
          };
          contextWindow: number;
          maxTokens: number;
        }>;
      }
    >;
  };
  tools?: {
    web?: {
      search?: {
        enabled?: boolean;
        provider?: 'perplexity';
        perplexity?: {
          baseUrl?: string;
          model?: string;
        };
      };
    };
  };
}

function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

function normalizeModel(model: string): string {
  return model.trim();
}

export function toOpenClawModelRef(config: AgentLLMConfig): string {
  const provider = normalizeProvider(config.provider);
  const model = normalizeModel(config.model);

  if (provider === 'openrouter') {
    return model.startsWith('openrouter/') ? model : `openrouter/${model}`;
  }

  return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
}

export function getOpenClawProviderProxyBaseUrl(provider: string, proxyBaseUrl = 'http://127.0.0.1:8800'): string {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedProxyBaseUrl = proxyBaseUrl.replace(/\/+$/, '');

  if (normalizedProvider === 'openrouter') {
    return `${normalizedProxyBaseUrl}/openrouter/api/v1`;
  }

  if (normalizedProvider === 'openai') {
    return `${normalizedProxyBaseUrl}/openai/v1`;
  }

  return `${normalizedProxyBaseUrl}/${normalizedProvider}`;
}

export function buildOpenClawRuntimeConfig(params: {
  llm: AgentLLMConfig;
  availableProviders?: AgentLLMConfig[];
  gatewayPort?: number;
  browserEnabled?: boolean;
  browserHeadless?: boolean;
  browserExecutablePath?: string;
  proxyBaseUrl?: string;
}): OpenClawRuntimeConfig {
  const provider = normalizeProvider(params.llm.provider);
  const modelRef = toOpenClawModelRef(params.llm);
  const gatewayPort = params.gatewayPort ?? 18789;
  const runtimeProfile = getAgentModelRuntimeProfile(params.llm);
  const reserveTokens = Math.max(1024, Math.min(4096, runtimeProfile.maxTokens));
  const configuredProviders = new Map<string, AgentLLMConfig>();
  configuredProviders.set(provider, params.llm);
  for (const candidate of params.availableProviders ?? []) {
    const normalizedProvider = normalizeProvider(candidate.provider);
    if (!normalizedProvider || configuredProviders.has(normalizedProvider)) {
      continue;
    }
    configuredProviders.set(normalizedProvider, candidate);
  }

  const providerEntries = Object.fromEntries(
    Array.from(configuredProviders.values()).map((candidate) => {
      const candidateProvider = normalizeProvider(candidate.provider);
      const candidateModelRef = toOpenClawModelRef(candidate);
      const candidateRuntimeProfile = getAgentModelRuntimeProfile(candidate);
      return [
        candidateProvider,
        {
          baseUrl: getOpenClawProviderProxyBaseUrl(candidateProvider, params.proxyBaseUrl),
          models: [
            {
              id: candidateModelRef,
              name: candidateModelRef,
              reasoning: false,
              input: candidateRuntimeProfile.input,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
              },
              contextWindow: candidateRuntimeProfile.contextWindow,
              maxTokens: candidateRuntimeProfile.maxTokens,
            },
          ],
        },
      ];
    }),
  );

  return {
    gateway: {
      mode: 'local',
      port: gatewayPort,
      bind: 'loopback',
      auth: { mode: 'none' },
    },
    browser: {
      enabled: params.browserEnabled ?? true,
      headless: params.browserHeadless,
      noSandbox: true,
      ...(params.browserExecutablePath ? { executablePath: params.browserExecutablePath } : {}),
    },
    plugins: {
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
    },
    agents: {
      defaults: {
        workspace: '/workspace',
        sandbox: {
          mode: 'off',
        },
        contextTokens: runtimeProfile.contextWindow,
        model: {
          primary: modelRef,
        },
        // Leave the allowlist open so host-side llm_prepare overrides can
        // switch providers/models without forcing a VM redeploy.
        models: {},
        compaction: {
          reserveTokens,
          reserveTokensFloor: reserveTokens,
        },
      },
    },
    models: {
      providers: providerEntries,
    },
    tools: {
      web: {
        search: {
          enabled: true,
          provider: 'perplexity',
          perplexity: {
            // Route OpenClaw's web_search through Paddock's OpenRouter relay so
            // search keeps working inside the VM without exposing host secrets.
            baseUrl: getOpenClawProviderProxyBaseUrl('openrouter', params.proxyBaseUrl),
            model: 'perplexity/sonar-pro',
          },
        },
      },
    },
  };
}
