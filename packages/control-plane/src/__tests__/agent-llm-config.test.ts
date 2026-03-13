import { describe, expect, it } from 'vitest';
import { getConfiguredAgentProviders, getDefaultAgentLLMConfig, resolveAgentLLMConfig } from '../mcp/agent-llm-config.js';

describe('agent-llm-config', () => {
  it('prefers an explicitly configured provider and model', () => {
    const config = getDefaultAgentLLMConfig({
      PADDOCK_LLM_PROVIDER: 'openrouter',
      PADDOCK_AGENT_MODEL: 'deepseek/deepseek-chat',
    } as NodeJS.ProcessEnv);

    expect(config).toEqual({
      provider: 'openrouter',
      model: 'deepseek/deepseek-chat',
    });
  });

  it('falls back to the first configured host provider', () => {
    const config = getDefaultAgentLLMConfig({
      OPENROUTER_API_KEY: 'or-key',
    } as NodeJS.ProcessEnv);

    expect(config).toEqual({
      provider: 'openrouter',
      model: 'moonshotai/kimi-k2',
    });
  });

  it('lists configured providers from host env', () => {
    expect(getConfiguredAgentProviders({
      ANTHROPIC_AUTH_TOKEN: 'anthropic-token',
      OPENROUTER_API_KEY: 'openrouter-key',
    } as NodeJS.ProcessEnv)).toEqual(['anthropic', 'openrouter']);
  });

  it('resolves a custom model for a supported provider', () => {
    expect(resolveAgentLLMConfig({
      provider: 'openrouter',
      model: 'moonshotai/kimi-k2',
    })).toEqual({
      provider: 'openrouter',
      model: 'moonshotai/kimi-k2',
    });
  });

  it('rejects unknown providers', () => {
    expect(() => resolveAgentLLMConfig({
      provider: 'not-real',
      model: 'anything',
    })).toThrow('Unsupported LLM provider');
  });
});
