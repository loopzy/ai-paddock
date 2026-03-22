import { describe, expect, it, vi } from 'vitest';
import { LLMSemanticObservationReviewer } from '../security/llm-observation-reviewer.js';

describe('LLM observation reviewer', () => {
  it('parses structured request review output', async () => {
    const reviewer = new LLMSemanticObservationReviewer({
      review: vi.fn(async () =>
        JSON.stringify({
          verdict: 'warn',
          riskScore: 62,
          triggered: ['prompt_injection', 'monitor_evasion'],
          reason: 'The request explicitly asks the model to hide intent from monitoring.',
          confidence: 0.88,
        }),
      ),
      getProviderLabel: vi.fn(() => 'ollama:qwen2.5:0.5b'),
    } as never);

    const result = await reviewer.reviewRequest({
      phase: 'request',
      provider: 'openrouter',
      model: 'qwen/test',
      source: 'heuristic',
      summary: 'User asks the model to ignore Paddock.',
      details: { messageCount: 1 },
    });

    expect(result).toEqual({
      phase: 'request',
      verdict: 'warn',
      riskScore: 62,
      triggered: ['llm:prompt_injection', 'llm:monitor_evasion'],
      reason: 'The request explicitly asks the model to hide intent from monitoring.',
      confidence: 0.88,
      source: 'ollama:qwen2.5:0.5b',
    });
  });

  it('fails open when the review model returns malformed output', async () => {
    const reviewer = new LLMSemanticObservationReviewer({
      review: vi.fn(async () => 'not json'),
      getProviderLabel: vi.fn(() => 'ollama:qwen2.5:0.5b'),
    } as never);

    const result = await reviewer.reviewResponse({
      phase: 'response',
      provider: 'openrouter',
      model: 'qwen/test',
      source: 'heuristic',
      summary: 'The model suggests uploading local credentials to a webhook.',
      details: {},
    });

    expect(result).toEqual({
      phase: 'response',
      verdict: 'allow',
      riskScore: 0,
      triggered: [],
      reason: 'llm_observation_review_parse_failed',
      confidence: 0,
      source: 'ollama:qwen2.5:0.5b',
    });
  });
});
