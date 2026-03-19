import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LLMProxy } from '../llm-proxy/proxy.js';
import { ControlPlaneClient } from '../control-plane-client.js';

class ReporterStub {
  events: Array<{ type: string; payload: Record<string, unknown> }> = [];

  async report(type: string, payload: Record<string, unknown>) {
    this.events.push({ type, payload });
    return true;
  }
}

describe('LLMProxy', () => {
  const originalFetch = global.fetch;
  const originalRetryAttempts = process.env.PADDOCK_LLM_PROXY_FETCH_ATTEMPTS;
  const originalRetryDelayMs = process.env.PADDOCK_LLM_PROXY_RETRY_DELAY_MS;

  beforeEach(() => {
    process.env.PADDOCK_LLM_PROXY_FETCH_ATTEMPTS = '3';
    process.env.PADDOCK_LLM_PROXY_RETRY_DELAY_MS = '0';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalRetryAttempts === undefined) delete process.env.PADDOCK_LLM_PROXY_FETCH_ATTEMPTS;
    else process.env.PADDOCK_LLM_PROXY_FETCH_ATTEMPTS = originalRetryAttempts;
    if (originalRetryDelayMs === undefined) delete process.env.PADDOCK_LLM_PROXY_RETRY_DELAY_MS;
    else process.env.PADDOCK_LLM_PROXY_RETRY_DELAY_MS = originalRetryDelayMs;
  });

  it('classifies wrapped upstream 429 responses as rate limits', async () => {
    const reporter = new ReporterStub();
    const proxyPort = 39870 + Math.floor(Math.random() * 1000);
    const proxy = new LLMProxy(proxyPort, reporter as any, new ControlPlaneClient(['http://control.test']), 'session-sidecar-test');

    global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === 'http://control.test/api/llm/proxy') {
        expect(init?.method).toBe('POST');
        return new Response(JSON.stringify({
          status: 503,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: 429, msg: '请求过于频繁，请稍后再试' }),
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return originalFetch(input, init);
    };

    await proxy.start();

    try {
      const response = await originalFetch(`http://127.0.0.1:${proxyPort}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-3-5-haiku-latest',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.code).toBe(429);

      const errorEvent = reporter.events.find((event) => event.type === 'amp.agent.error');
      expect(errorEvent?.payload.category).toBe('resource');
      expect(errorEvent?.payload.code).toBe('ERR_RATE_LIMIT');
      expect(String(errorEvent?.payload.message)).toContain('请求过于频繁');
    } finally {
      proxy.stop();
    }
  });

  it('reports llm.response for streamed OpenRouter responses', async () => {
    const reporter = new ReporterStub();
    const proxyPort = 40870 + Math.floor(Math.random() * 1000);
    const proxy = new LLMProxy(proxyPort, reporter as any, new ControlPlaneClient(['http://control.test']), 'session-sidecar-test');

    global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === 'http://control.test/api/llm/proxy') {
        expect(init?.method).toBe('POST');
        return new Response(JSON.stringify({
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: [
            'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"qwen/qwen-2.5-72b-instruct","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
            '',
            'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"qwen/qwen-2.5-72b-instruct","choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":321,"completion_tokens":45}}',
            '',
            'data: [DONE]',
            '',
          ].join('\n'),
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return originalFetch(input, init);
    };

    await proxy.start();

    try {
      const response = await originalFetch(`http://127.0.0.1:${proxyPort}/openrouter/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen/qwen-2.5-72b-instruct',
          messages: [{ role: 'user', content: 'hello' }],
          stream: true,
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('data:');

      const responseEvent = reporter.events.find((event) => event.type === 'llm.response');
      const requestEvent = reporter.events.find((event) => event.type === 'llm.request');
      expect(requestEvent?.payload.messagesPreview).toEqual([
        {
          role: 'user',
          text: 'hello',
        },
      ]);
      expect(responseEvent?.payload.provider).toBe('openrouter');
      expect(responseEvent?.payload.model).toBe('qwen/qwen-2.5-72b-instruct');
      expect(responseEvent?.payload.tokensIn).toBe(321);
      expect(responseEvent?.payload.tokensOut).toBe(45);
      expect(responseEvent?.payload.streamed).toBe(true);
      expect(responseEvent?.payload.chunkCount).toBe(2);
      expect(responseEvent?.payload.responsePreview).toContain('done');
    } finally {
      proxy.stop();
    }
  });

  it('merges streamed text chunks into a single readable response preview', async () => {
    const reporter = new ReporterStub();
    const proxyPort = 44870 + Math.floor(Math.random() * 1000);
    const proxy = new LLMProxy(proxyPort, reporter as any, new ControlPlaneClient(['http://control.test']), 'session-sidecar-test');

    global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === 'http://control.test/api/llm/proxy') {
        expect(init?.method).toBe('POST');
        return new Response(JSON.stringify({
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: [
            'data: {"id":"chatcmpl-3","object":"chat.completion.chunk","model":"moonshotai/kimi-k2","choices":[{"index":0,"delta":{"content":"我"},"finish_reason":null}]}',
            '',
            'data: {"id":"chatcmpl-3","object":"chat.completion.chunk","model":"moonshotai/kimi-k2","choices":[{"index":0,"delta":{"content":"找到了一些"},"finish_reason":null}]}',
            '',
            'data: {"id":"chatcmpl-3","object":"chat.completion.chunk","model":"moonshotai/kimi-k2","choices":[{"index":0,"delta":{"content":"中文网站。"},"finish_reason":"stop"}],"usage":{"prompt_tokens":210,"completion_tokens":18}}',
            '',
            'data: [DONE]',
            '',
          ].join('\n'),
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return originalFetch(input, init);
    };

    await proxy.start();

    try {
      const response = await originalFetch(`http://127.0.0.1:${proxyPort}/openrouter/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'moonshotai/kimi-k2',
          messages: [{ role: 'user', content: '推荐一些中文娱乐网站' }],
          stream: true,
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('data:');

      const responseEvent = reporter.events.find((event) => event.type === 'llm.response');
      expect(responseEvent?.payload.responsePreview).toBe('我找到了一些中文网站。');
      expect(String(responseEvent?.payload.responsePreview)).not.toContain('\n');
    } finally {
      proxy.stop();
    }
  });

  it('does not emit transport errors for streamed partial tool call arguments', async () => {
    const reporter = new ReporterStub();
    const proxyPort = 41870 + Math.floor(Math.random() * 1000);
    const proxy = new LLMProxy(proxyPort, reporter as any, new ControlPlaneClient(['http://control.test']), 'session-sidecar-test');

    global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === 'http://control.test/api/llm/proxy') {
        expect(init?.method).toBe('POST');
        return new Response(JSON.stringify({
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: [
            'data: {"id":"chatcmpl-2","object":"chat.completion.chunk","model":"qwen/qwen-2.5-72b-instruct","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"write","arguments":"{\\"file_path\\":\\"/workspace/out.txt\\","}}]},"finish_reason":null}]}',
            '',
            'data: {"id":"chatcmpl-2","object":"chat.completion.chunk","model":"qwen/qwen-2.5-72b-instruct","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"content\\":\\"hello\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":100,"completion_tokens":12}}',
            '',
            'data: [DONE]',
            '',
          ].join('\n'),
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return originalFetch(input, init);
    };

    await proxy.start();

    try {
      const response = await originalFetch(`http://127.0.0.1:${proxyPort}/openrouter/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen/qwen-2.5-72b-instruct',
          messages: [{ role: 'user', content: 'hello' }],
          stream: true,
        }),
      });

      expect(response.status).toBe(200);
      expect(reporter.events.find((event) => event.type === 'llm.response')).toBeTruthy();
      expect(reporter.events.find((event) => event.type === 'amp.agent.error')).toBeUndefined();
    } finally {
      proxy.stop();
    }
  });

  it('retries transient control-plane fetch failures without emitting amp.agent.error', async () => {
    const reporter = new ReporterStub();
    const proxyPort = 42870 + Math.floor(Math.random() * 1000);
    const proxy = new LLMProxy(proxyPort, reporter as any, new ControlPlaneClient(['http://control.test']), 'session-sidecar-test');
    let upstreamCalls = 0;

    global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === 'http://control.test/api/llm/proxy') {
        upstreamCalls += 1;
        if (upstreamCalls < 3) {
          throw new TypeError('fetch failed');
        }
        expect(init?.method).toBe('POST');
        return new Response(JSON.stringify({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: 'chatcmpl-retry',
            object: 'chat.completion',
            model: 'moonshotai/kimi-k2',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'done' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 3 },
          }),
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return originalFetch(input, init);
    };

    await proxy.start();

    try {
      const response = await originalFetch(`http://127.0.0.1:${proxyPort}/openrouter/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'moonshotai/kimi-k2',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('chat.completion');
      expect(upstreamCalls).toBe(3);
      expect(reporter.events.find((event) => event.type === 'amp.agent.error')).toBeUndefined();
      expect(reporter.events.find((event) => event.type === 'llm.response')).toBeTruthy();
    } finally {
      proxy.stop();
    }
  });

  it('emits amp.agent.error after exhausting control-plane fetch retries', async () => {
    const reporter = new ReporterStub();
    const proxyPort = 43870 + Math.floor(Math.random() * 1000);
    const proxy = new LLMProxy(proxyPort, reporter as any, new ControlPlaneClient(['http://control.test']), 'session-sidecar-test');
    let upstreamCalls = 0;

    global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === 'http://control.test/api/llm/proxy') {
        upstreamCalls += 1;
        throw new TypeError('fetch failed');
      }
      return originalFetch(input, init);
    };

    await proxy.start();

    try {
      const response = await originalFetch(`http://127.0.0.1:${proxyPort}/openrouter/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'moonshotai/kimi-k2',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });

      expect(response.status).toBe(502);
      expect(upstreamCalls).toBe(3);
      const errorEvent = reporter.events.find((event) => event.type === 'amp.agent.error');
      expect(errorEvent?.payload.code).toBe('ERR_LLM_UNREACHABLE');
      expect(errorEvent?.payload.recoverable).toBe(true);
    } finally {
      proxy.stop();
    }
  });
});
