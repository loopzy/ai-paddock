import { getBehaviorLLMConfigFromEnv } from './behavior-analyzer-factory.js';
import { LLMReviewClient, type LLMReviewClientConfig, type LLMReviewProvider } from './llm-review-client.js';
import {
  HeuristicLLMObservationSanitizer,
  LLMSemanticObservationSanitizer,
  type LLMObservationSanitizer,
} from './llm-observation-sanitizer.js';
import {
  LLMSemanticObservationReviewer,
  type LLMObservationReviewer,
} from './llm-observation-reviewer.js';

function isEnabled(value: string | undefined): boolean {
  return typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseScopedLLMConfig(prefix: string, env: NodeJS.ProcessEnv): LLMReviewClientConfig | null {
  if (!isEnabled(env[`${prefix}_ENABLED`])) {
    return null;
  }

  const provider = (env[`${prefix}_PROVIDER`]?.trim().toLowerCase() ?? 'ollama') as LLMReviewProvider;
  if (provider !== 'ollama' && provider !== 'openai-compatible') {
    throw new Error(`Unsupported ${prefix}_PROVIDER: ${provider}`);
  }

  const model = env[`${prefix}_MODEL`]?.trim();
  if (!model) {
    throw new Error(`${prefix}_MODEL is required when ${prefix}_ENABLED is set`);
  }

  const defaultTimeoutMs = provider === 'ollama' ? 30_000 : 8_000;

  return {
    provider,
    model,
    baseUrl: env[`${prefix}_BASE_URL`]?.trim() || undefined,
    apiKey: env[`${prefix}_API_KEY`]?.trim() || undefined,
    timeoutMs: parseNumber(env[`${prefix}_TIMEOUT_MS`], defaultTimeoutMs),
    temperature: parseNumber(env[`${prefix}_TEMPERATURE`], 0),
    maxTokens: parseNumber(env[`${prefix}_MAX_TOKENS`], 300),
  };
}

function resolveObservationLLMConfig(prefix: string, env: NodeJS.ProcessEnv): LLMReviewClientConfig | null {
  const scoped = parseScopedLLMConfig(prefix, env);
  if (scoped) {
    return scoped;
  }
  return getBehaviorLLMConfigFromEnv(env);
}

export function createLLMObservationSanitizerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LLMObservationSanitizer | null {
  const config = resolveObservationLLMConfig('PADDOCK_LLM_SANITIZER', env);
  if (!config) {
    return null;
  }
  return new LLMSemanticObservationSanitizer(new LLMReviewClient(config), new HeuristicLLMObservationSanitizer());
}

export function createLLMObservationReviewerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LLMObservationReviewer | null {
  const config = resolveObservationLLMConfig('PADDOCK_LLM_AUDIT', env);
  if (!config) {
    return null;
  }
  return new LLMSemanticObservationReviewer(new LLMReviewClient(config));
}
