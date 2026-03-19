import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LLMReviewClient } from '../security/llm-review-client.js';

describe('LLMReviewClient', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls the Ollama chat endpoint with deterministic settings', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          message: { content: '{"riskBoost":0,"triggered":[],"reason":"ok","confidence":0.9}' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const client = new LLMReviewClient({
      provider: 'ollama',
      model: 'qwen2.5:0.5b',
      baseUrl: 'http://127.0.0.1:11434/',
      timeoutMs: 1234,
      maxTokens: 111,
    });

    const result = await client.review({
      systemPrompt: 'system prompt',
      userPrompt: 'user prompt',
    });

    expect(result).toContain('"riskBoost":0');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/chat',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          model: 'qwen2.5:0.5b',
          stream: false,
          format: 'json',
          options: {
            temperature: 0,
            num_predict: 111,
          },
          messages: [
            { role: 'system', content: 'system prompt' },
            { role: 'user', content: 'user prompt' },
          ],
        }),
      }),
    );
  });

  it('calls an OpenAI-compatible endpoint with auth headers', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"riskBoost":12,"triggered":["goal_drift"],"reason":"risk","confidence":0.7}',
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const client = new LLMReviewClient({
      provider: 'openai-compatible',
      model: 'gpt-4.1-mini',
      baseUrl: 'https://example.test/v1',
      apiKey: 'secret-key',
      maxTokens: 222,
    });

    const result = await client.review({
      systemPrompt: 'system prompt',
      userPrompt: 'user prompt',
    });

    expect(result).toContain('"riskBoost":12');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer secret-key',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('throws when the upstream response is not usable', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

    const client = new LLMReviewClient({
      provider: 'openai-compatible',
      model: 'gpt-4.1-mini',
      baseUrl: 'https://example.test/v1',
    });

    await expect(
      client.review({
        systemPrompt: 'system prompt',
        userPrompt: 'user prompt',
      }),
    ).rejects.toThrow('no choices');
  });
});
