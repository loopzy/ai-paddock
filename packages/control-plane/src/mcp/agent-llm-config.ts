import type { LLMConfigStore } from '../config/llm-config-store.js';

export type AgentLLMProvider = 'anthropic' | 'openai' | 'openrouter';

export interface AgentLLMConfig {
  provider: string;
  model: string;
}

export interface AgentLLMCredentialField {
  envKey: string;
  label: string;
  description: string;
}

export interface AgentLLMModelPreset {
  id: string;
  label: string;
  description: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: Array<'text' | 'image'>;
}

export interface AgentLLMProviderPreset {
  id: AgentLLMProvider;
  label: string;
  description: string;
  envKeys: string[];
  credentialFields: AgentLLMCredentialField[];
  docsUrl: string;
  baseUrlEnvKey?: string;
  defaultModel: string;
  models: AgentLLMModelPreset[];
}

export const AGENT_LLM_PROVIDER_PRESETS: AgentLLMProviderPreset[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    description: 'Direct Anthropic Messages API via the Sidecar proxy.',
    envKeys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    credentialFields: [
      {
        envKey: 'ANTHROPIC_API_KEY',
        label: 'Anthropic API Key',
        description: 'Recommended for direct Anthropic Messages API access.',
      },
      {
        envKey: 'ANTHROPIC_AUTH_TOKEN',
        label: 'Anthropic Auth Token',
        description: 'Optional Claude Code-compatible token when an API key is unavailable.',
      },
    ],
    docsUrl: 'https://console.anthropic.com/settings/keys',
    baseUrlEnvKey: 'ANTHROPIC_BASE_URL',
    defaultModel: 'claude-3-5-haiku-latest',
    models: [
      {
        id: 'claude-3-5-haiku-latest',
        label: 'Claude 3.5 Haiku',
        description: 'Fast, inexpensive default for the compatibility runner.',
        contextWindow: 200000,
        maxTokens: 8192,
        input: ['text', 'image'],
      },
      {
        id: 'claude-3-5-sonnet-latest',
        label: 'Claude 3.5 Sonnet',
        description: 'Higher-quality Anthropic preset for stronger reasoning.',
        contextWindow: 200000,
        maxTokens: 8192,
        input: ['text', 'image'],
      },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'OpenAI-compatible chat completions via the Sidecar proxy.',
    envKeys: ['OPENAI_API_KEY'],
    credentialFields: [
      {
        envKey: 'OPENAI_API_KEY',
        label: 'OpenAI API Key',
        description: 'Standard OpenAI platform key used for Chat Completions.',
      },
    ],
    docsUrl: 'https://platform.openai.com/api-keys',
    baseUrlEnvKey: 'OPENAI_BASE_URL',
    defaultModel: 'gpt-4o-mini',
    models: [
      {
        id: 'gpt-4o-mini',
        label: 'GPT-4o mini',
        description: 'Fast and cost-effective default OpenAI preset.',
        contextWindow: 128000,
        maxTokens: 16384,
        input: ['text', 'image'],
      },
      {
        id: 'gpt-4o',
        label: 'GPT-4o',
        description: 'Stronger OpenAI preset for richer outputs.',
        contextWindow: 128000,
        maxTokens: 16384,
        input: ['text', 'image'],
      },
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'OpenAI-compatible gateway with multiple upstream model providers.',
    envKeys: ['OPENROUTER_API_KEY'],
    credentialFields: [
      {
        envKey: 'OPENROUTER_API_KEY',
        label: 'OpenRouter API Key',
        description: 'Gateway key that unlocks multiple upstream model providers.',
      },
    ],
    docsUrl: 'https://openrouter.ai/settings/keys',
    baseUrlEnvKey: 'OPENROUTER_BASE_URL',
    defaultModel: 'moonshotai/kimi-k2',
    models: [
      {
        id: 'qwen/qwen-2.5-72b-instruct',
        label: 'Qwen 2.5 72B Instruct',
        description: 'Balanced default that we verified works in this environment.',
        contextWindow: 32768,
        maxTokens: 8192,
        input: ['text'],
      },
      {
        id: 'deepseek/deepseek-chat',
        label: 'DeepSeek Chat',
        description: 'Solid general-purpose reasoning and coding preset.',
        contextWindow: 65536,
        maxTokens: 8192,
        input: ['text'],
      },
      {
        id: 'moonshotai/kimi-k2',
        label: 'Kimi K2',
        description: 'Large-context OpenRouter preset for exploratory sessions.',
        contextWindow: 262144,
        maxTokens: 8192,
        input: ['text'],
      },
      {
        id: 'meta-llama/llama-3.1-8b-instruct',
        label: 'Llama 3.1 8B Instruct',
        description: 'Smaller open model preset that is often broadly available.',
        contextWindow: 131072,
        maxTokens: 4096,
        input: ['text'],
      },
    ],
  },
];

function getProviderPreset(provider: string): AgentLLMProviderPreset | undefined {
  return AGENT_LLM_PROVIDER_PRESETS.find((candidate) => candidate.id === provider);
}

export function getAgentProviderPreset(provider: string): AgentLLMProviderPreset | undefined {
  return getProviderPreset(provider);
}

function normalizeModelId(model: string): string {
  const trimmed = model.trim();
  const normalized = trimmed.toLowerCase();
  return normalized.startsWith('openrouter/') ? normalized.slice('openrouter/'.length) : normalized;
}

export function getAgentModelPreset(config: AgentLLMConfig): AgentLLMModelPreset | undefined {
  const provider = getProviderPreset(config.provider);
  if (!provider) {
    return undefined;
  }

  const normalizedSelected = normalizeModelId(config.model);
  return provider.models.find((candidate) => normalizeModelId(candidate.id) === normalizedSelected);
}

export function getAgentModelRuntimeProfile(config: AgentLLMConfig): {
  contextWindow: number;
  maxTokens: number;
  input: Array<'text' | 'image'>;
} {
  const provider = getProviderPreset(config.provider);
  const preset = getAgentModelPreset(config);
  const defaultInput: Array<'text' | 'image'> =
    provider?.id === 'openrouter' || provider?.id === 'openai' ? ['text', 'image'] : ['text'];

  return {
    contextWindow: preset?.contextWindow ?? (provider?.id === 'openrouter' ? 32768 : 200000),
    maxTokens: preset?.maxTokens ?? 8192,
    input: preset?.input ?? defaultInput,
  };
}

export function getConfiguredAgentProviders(env: NodeJS.ProcessEnv = process.env, configStore?: LLMConfigStore): AgentLLMProvider[] {
  return AGENT_LLM_PROVIDER_PRESETS
    .filter((provider) => {
      // Check database first
      if (configStore) {
        const dbConfig = configStore.get(provider.id);
        if (dbConfig?.apiKey) return true;
      }
      // Fallback to environment variables
      return provider.envKeys.some((key) => Boolean(env[key]));
    })
    .map((provider) => provider.id);
}

export function getDefaultAgentLLMConfig(env: NodeJS.ProcessEnv = process.env, configStore?: LLMConfigStore): AgentLLMConfig {
  const explicitProvider = env.PADDOCK_LLM_PROVIDER?.trim().toLowerCase();
  const explicitModel = env.PADDOCK_AGENT_MODEL?.trim();

  let preset = getProviderPreset(explicitProvider ?? '');

  if (!preset) {
    // Check database for configured providers
    if (configStore) {
      const dbConfigs = configStore.list();
      if (dbConfigs.length > 0) {
        preset = getProviderPreset(dbConfigs[0].provider);
      }
    }
  }

  if (!preset) {
    // Fallback to environment variables
    preset = AGENT_LLM_PROVIDER_PRESETS.find((provider) => provider.envKeys.some((key) => Boolean(env[key])));
  }

  if (!preset) {
    preset = AGENT_LLM_PROVIDER_PRESETS[0];
  }

  return {
    provider: preset.id,
    model: explicitModel || preset.defaultModel,
  };
}

export function resolveAgentLLMConfig(
  selection: { provider?: string; model?: string } | undefined,
  env: NodeJS.ProcessEnv = process.env,
  configStore?: LLMConfigStore,
): AgentLLMConfig {
  const defaults = getDefaultAgentLLMConfig(env, configStore);
  const provider = (selection?.provider ?? defaults.provider).trim().toLowerCase();
  const preset = getProviderPreset(provider);
  if (!preset) {
    throw new Error(`Unsupported LLM provider: ${provider}`);
  }

  return {
    provider: preset.id,
    model: selection?.model?.trim() || defaults.model || preset.defaultModel,
  };
}
