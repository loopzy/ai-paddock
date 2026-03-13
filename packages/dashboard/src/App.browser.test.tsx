// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';

vi.mock('./components/HITLModal.js', () => ({
  HITLModal: () => null,
}));

vi.mock('./components/VMPanel.js', () => ({
  VMPanel: () => null,
}));

type MockResponseBody = Record<string, unknown> | Array<unknown>;

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  static reset() {
    MockWebSocket.instances = [];
  }

  readyState = 1;
  sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.onopen?.(new Event('open'));
    });
  }

  send(data: string) {
    this.sent.push(String(data));
  }

  close() {
    this.readyState = 3;
    this.onclose?.(new Event('close'));
  }

  emit(event: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
  }
}

function jsonResponse(body: MockResponseBody, ok = true, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('App browser journey', () => {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<ReturnType<typeof jsonResponse>>>();

  beforeEach(() => {
    cleanup();
    MockWebSocket.reset();
    fetchMock.mockReset();

    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === '/api/sessions' && method === 'GET') {
        return jsonResponse([]);
      }
      if (url === '/api/health' && method === 'GET') {
        return jsonResponse({
          warnings: [],
          agentDefaults: {
            provider: 'openrouter',
            model: 'moonshotai/kimi-k2',
          },
          llmCatalog: {
            providers: [
              {
                id: 'anthropic',
                label: 'Anthropic',
                description: 'Direct Anthropic Messages API.',
                envKeys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
                defaultModel: 'claude-3-5-haiku-latest',
                configured: false,
                models: [
                  {
                    id: 'claude-3-5-haiku-latest',
                    label: 'Claude 3.5 Haiku',
                    description: 'Fast Anthropic preset.',
                  },
                ],
              },
              {
                id: 'openrouter',
                label: 'OpenRouter',
                description: 'OpenAI-compatible gateway.',
                envKeys: ['OPENROUTER_API_KEY'],
                defaultModel: 'moonshotai/kimi-k2',
                configured: true,
                models: [
                  {
                    id: 'moonshotai/kimi-k2',
                    label: 'Kimi K2',
                    description: 'Large-context preset.',
                  },
                  {
                    id: 'deepseek/deepseek-chat',
                    label: 'DeepSeek Chat',
                    description: 'Alternate preset.',
                  },
                ],
              },
            ],
          },
        });
      }
      if (url === '/api/sessions' && method === 'POST') {
        return jsonResponse({
          id: 'sess-1',
          status: 'created',
          agentType: 'none',
          sandboxType: 'simple-box',
          createdAt: 1,
        });
      }
      if (url === '/api/sessions/sess-1/events' && method === 'GET') {
        return jsonResponse([]);
      }
      if (url === '/api/sessions/sess-1/deploy-agent' && method === 'POST') {
        expect(init?.body).toBe(JSON.stringify({
          agentType: 'openclaw',
        }));
        return jsonResponse({ deploying: true, agentType: 'openclaw' });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('lets the user create a sandbox, waits for readiness, sends commands, and disables input again after a fatal error', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Create Sandbox' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/sessions', expect.objectContaining({ method: 'POST' }));
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    const socket = MockWebSocket.instances[0];

    await act(async () => {
      socket.emit({
        id: 'evt-1',
        sessionId: 'sess-1',
        seq: 1,
        timestamp: Date.now(),
        type: 'amp.session.start',
        payload: { phase: 'sandbox_ready', message: 'Sandbox ready' },
      });
    });

    expect(await screen.findByText('No agent running.')).toBeInTheDocument();
    expect(
      screen.getByText(/Will use: openrouter \/ moonshotai\/kimi-k2\./),
    ).toBeInTheDocument();

    const inputBeforeReady = await screen.findByRole('textbox');
    expect(inputBeforeReady).toBeDisabled();
    expect(screen.getByText('Wait for the agent to report AMP readiness before sending commands.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Deploy Agent' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/sessions/sess-1/deploy-agent', expect.objectContaining({ method: 'POST' }));
    });

    await act(async () => {
      socket.emit({
        id: 'evt-2',
        sessionId: 'sess-1',
        seq: 2,
        timestamp: Date.now(),
        type: 'amp.agent.ready',
        payload: { agent: 'openclaw', version: 'test', capabilities: ['chat'] },
      });
      socket.emit({
        id: 'evt-3',
        sessionId: 'sess-1',
        seq: 3,
        timestamp: Date.now(),
        type: 'amp.session.start',
        payload: { phase: 'agent_ready', message: 'OpenClaw connected to Paddock' },
      });
    });

    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());

    await user.type(screen.getByRole('textbox'), 'hello');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(socket.sent).toContain(JSON.stringify({ type: 'user.command', command: 'hello' }));

    await act(async () => {
      socket.emit({
        id: 'evt-4',
        sessionId: 'sess-1',
        seq: 4,
        timestamp: Date.now(),
        type: 'amp.agent.error',
        payload: {
          category: 'auth',
          code: 'ERR_NO_API_KEY',
          message: 'API key not configured.',
          recoverable: false,
        },
      });
      socket.emit({
        id: 'evt-5',
        sessionId: 'sess-1',
        seq: 5,
        timestamp: Date.now(),
        type: 'amp.agent.fatal',
        payload: {
          category: 'auth',
          code: 'ERR_NO_API_KEY',
          message: 'API key not configured.',
          recoverable: false,
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByRole('textbox')).toBeDisabled();
      expect(screen.getByText('Agent disconnected.')).toBeInTheDocument();
      expect(screen.getByText('Agent disconnected. Redeploy it or inspect the error timeline before sending commands.')).toBeInTheDocument();
      expect(screen.getByText('ERR_NO_API_KEY')).toBeInTheDocument();
    });
  });
});
