import { describe, expect, it } from 'vitest';
import { createBehaviorAnalyzerFromEnv, getBehaviorLLMConfigFromEnv } from '../security/behavior-analyzer-factory.js';
import { BehaviorAnalyzer } from '../security/behavior-analyzer.js';
import { CompositeBehaviorAnalyzer } from '../security/composite-behavior-analyzer.js';

describe('behavior-analyzer-factory', () => {
  it('returns null when llm review is disabled', () => {
    expect(getBehaviorLLMConfigFromEnv({})).toBeNull();
  });

  it('parses ollama configuration from environment', () => {
    const config = getBehaviorLLMConfigFromEnv({
      PADDOCK_BEHAVIOR_LLM_ENABLED: '1',
      PADDOCK_BEHAVIOR_LLM_PROVIDER: 'ollama',
      PADDOCK_BEHAVIOR_LLM_MODEL: 'qwen2.5:0.5b',
      PADDOCK_BEHAVIOR_LLM_BASE_URL: 'http://127.0.0.1:11434',
      PADDOCK_BEHAVIOR_LLM_TIMEOUT_MS: '5000',
    });

    expect(config).toEqual({
      provider: 'ollama',
      model: 'qwen2.5:0.5b',
      baseUrl: 'http://127.0.0.1:11434',
      apiKey: undefined,
      timeoutMs: 5000,
      temperature: 0,
      maxTokens: 300,
    });
  });

  it('uses a longer default timeout for local ollama review', () => {
    const config = getBehaviorLLMConfigFromEnv({
      PADDOCK_BEHAVIOR_LLM_ENABLED: '1',
      PADDOCK_BEHAVIOR_LLM_PROVIDER: 'ollama',
      PADDOCK_BEHAVIOR_LLM_MODEL: 'qwen2.5:0.5b',
    });

    expect(config?.timeoutMs).toBe(30000);
  });

  it('returns the default analyzer when llm review is off', () => {
    const analyzer = createBehaviorAnalyzerFromEnv({});
    expect(analyzer).toBeInstanceOf(BehaviorAnalyzer);
  });

  it('returns a composite analyzer when llm review is enabled', () => {
    const analyzer = createBehaviorAnalyzerFromEnv({
      PADDOCK_BEHAVIOR_LLM_ENABLED: 'true',
      PADDOCK_BEHAVIOR_LLM_PROVIDER: 'ollama',
      PADDOCK_BEHAVIOR_LLM_MODEL: 'qwen2.5:0.5b',
    });
    expect(analyzer).toBeInstanceOf(CompositeBehaviorAnalyzer);
  });
});
