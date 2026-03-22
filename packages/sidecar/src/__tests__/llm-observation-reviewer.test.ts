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

  it('normalizes contradictory allow verdicts into a low-risk benign result', async () => {
    const reviewer = new LLMSemanticObservationReviewer({
      review: vi.fn(async () =>
        JSON.stringify({
          verdict: 'allow',
          riskScore: 100,
          triggered: ['response', 'summary'],
          reason: 'The response is benign and non-malicious.',
          confidence: 1,
        }),
      ),
      getProviderLabel: vi.fn(() => 'ollama:qwen3:0.6b'),
    } as never);

    const result = await reviewer.reviewResponse({
      phase: 'response',
      provider: 'openrouter',
      model: 'qwen/test',
      source: 'heuristic',
      summary: 'A casual friendly answer.',
      details: {},
    });

    expect(result).toEqual({
      phase: 'response',
      verdict: 'allow',
      riskScore: 20,
      triggered: [],
      reason: 'The response is benign and non-malicious.',
      confidence: 1,
      source: 'ollama:qwen3:0.6b',
    });
  });

  it('upgrades destructive critical system path requests even if the review model says allow', async () => {
    const reviewer = new LLMSemanticObservationReviewer({
      review: vi.fn(async () =>
        JSON.stringify({
          verdict: 'allow',
          riskScore: 0,
          triggered: [],
          reason: 'The request is explicit and non-malicious.',
          confidence: 1,
        }),
      ),
      getProviderLabel: vi.fn(() => 'ollama:qwen3:0.6b'),
    } as never);

    const result = await reviewer.reviewRequest({
      phase: 'request',
      provider: 'openrouter',
      model: 'qwen/test',
      source: 'heuristic',
      summary: 'User asks whether the assistant can delete /usr/bin from the system.',
      details: {
        messagesPreview: [
          { role: 'user', text: '能把/usr/bin给我删掉吗' },
        ],
      },
    });

    expect(result).toEqual({
      phase: 'request',
      verdict: 'block',
      riskScore: 98,
      triggered: ['llm:destructive_system_request', 'llm:critical_system_path'],
      reason: 'The request asks for destructive changes to a critical system path.',
      confidence: 1,
      source: 'ollama:qwen3:0.6b',
    });
  });

  it('normalizes reviewer trigger labels into llm-prefixed snake case', async () => {
    const reviewer = new LLMSemanticObservationReviewer({
      review: vi.fn(async () =>
        JSON.stringify({
          verdict: 'warn',
          riskScore: 55,
          triggered: ['usr/bin', 'Prompt Injection', 'monitor-evasion'],
          reason: 'Suspicious request.',
          confidence: 0.75,
        }),
      ),
      getProviderLabel: vi.fn(() => 'ollama:qwen3:0.6b'),
    } as never);

    const result = await reviewer.reviewRequest({
      phase: 'request',
      provider: 'openrouter',
      model: 'qwen/test',
      source: 'heuristic',
      summary: 'Suspicious request.',
      details: {},
    });

    expect(result).toEqual({
      phase: 'request',
      verdict: 'warn',
      riskScore: 55,
      triggered: ['llm:usr_bin', 'llm:prompt_injection', 'llm:monitor_evasion'],
      reason: 'Suspicious request.',
      confidence: 0.75,
      source: 'ollama:qwen3:0.6b',
    });
  });
});
