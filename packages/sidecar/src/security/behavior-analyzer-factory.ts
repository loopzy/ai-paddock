import type { BehaviorAnalyzerProvider } from '@paddock/types';
import { BehaviorAnalyzer } from './behavior-analyzer.js';
import { CompositeBehaviorAnalyzer } from './composite-behavior-analyzer.js';
import { LLMBehaviorAnalyzer } from './llm-behavior-analyzer.js';
import { LLMReviewClient, type LLMReviewClientConfig, type LLMReviewProvider } from './llm-review-client.js';

function isEnabled(value: string | undefined): boolean {
  return typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function getBehaviorLLMConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LLMReviewClientConfig | null {
  if (!isEnabled(env.PADDOCK_BEHAVIOR_LLM_ENABLED)) {
    return null;
  }

  const provider = (env.PADDOCK_BEHAVIOR_LLM_PROVIDER?.trim().toLowerCase() ??
    'ollama') as LLMReviewProvider;
  if (provider !== 'ollama' && provider !== 'openai-compatible') {
    throw new Error(`Unsupported PADDOCK_BEHAVIOR_LLM_PROVIDER: ${provider}`);
  }

  const defaultTimeoutMs = provider === 'ollama' ? 30_000 : 8_000;

  const model = env.PADDOCK_BEHAVIOR_LLM_MODEL?.trim();
  if (!model) {
    throw new Error('PADDOCK_BEHAVIOR_LLM_MODEL is required when PADDOCK_BEHAVIOR_LLM_ENABLED is set');
  }

  return {
    provider,
    model,
    baseUrl: env.PADDOCK_BEHAVIOR_LLM_BASE_URL?.trim() || undefined,
    apiKey: env.PADDOCK_BEHAVIOR_LLM_API_KEY?.trim() || undefined,
    timeoutMs: parseNumber(env.PADDOCK_BEHAVIOR_LLM_TIMEOUT_MS, defaultTimeoutMs),
    temperature: parseNumber(env.PADDOCK_BEHAVIOR_LLM_TEMPERATURE, 0),
    maxTokens: parseNumber(env.PADDOCK_BEHAVIOR_LLM_MAX_TOKENS, 300),
  };
}

export function createBehaviorAnalyzerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BehaviorAnalyzerProvider {
  const baseAnalyzer = new BehaviorAnalyzer();
  const llmConfig = getBehaviorLLMConfigFromEnv(env);
  if (!llmConfig) {
    return baseAnalyzer;
  }

  const llmAnalyzer = new LLMBehaviorAnalyzer(new LLMReviewClient(llmConfig), {
    maxWindow: parseNumber(env.PADDOCK_BEHAVIOR_LLM_MAX_WINDOW, 8),
    maxRiskBoost: parseNumber(env.PADDOCK_BEHAVIOR_LLM_MAX_RISK_BOOST, 40),
  });

  return new CompositeBehaviorAnalyzer([baseAnalyzer, llmAnalyzer]);
}
