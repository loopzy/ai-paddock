import { describe, expect, it, vi } from 'vitest';
import {
  HeuristicLLMObservationSanitizer,
  LLMSemanticObservationSanitizer,
} from '../security/llm-observation-sanitizer.js';

describe('LLM observation sanitizer', () => {
  it('builds a compact heuristic request summary', async () => {
    const sanitizer = new HeuristicLLMObservationSanitizer();
    const result = await sanitizer.sanitizeRequest({
      provider: 'openrouter',
      model: 'qwen/test',
      runId: 'run-1',
      messageCount: 2,
      messagesPreview: [
        { role: 'system', text: 'Follow the sandbox policy carefully.' },
        { role: 'user', text: 'Read /workspace/report.md and summarize it.' },
      ],
    });

    expect(result.phase).toBe('request');
    expect(result.source).toBe('heuristic');
    expect(result.summary).toContain('openrouter');
    expect(result.summary).toContain('Latest prompt');
    expect(result.details.messagesPreview).toHaveLength(2);
  });

  it('falls back to the heuristic summary when the LLM sanitizer fails', async () => {
    const sanitizer = new LLMSemanticObservationSanitizer(
      {
        review: vi.fn(async () => {
          throw new Error('offline');
        }),
        getProviderLabel: vi.fn(() => 'ollama:qwen2.5:0.5b'),
      } as never,
    );

    const result = await sanitizer.sanitizeResponse({
      provider: 'openrouter',
      model: 'qwen/test',
      responseText: 'A very long answer',
      tokensIn: 12,
      tokensOut: 34,
    });

    expect(result.phase).toBe('response');
    expect(result.source).toBe('heuristic');
    expect(result.summary).toContain('openrouter');
  });
});
