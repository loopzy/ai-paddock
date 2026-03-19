// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act } from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';

vi.mock('./components/HITLModal.js', () => ({
  HITLModal: () => null,
}));

vi.mock('./components/VMPanel.js', () => ({
  VMPanel: ({ sessionId }: { sessionId: string }) => <div>VM Panel {sessionId}</div>,
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
        return jsonResponse([
          {
            id: 'sess-1',
            status: 'running',
            displayStatus: 'ready',
            agentType: 'openclaw',
            sandboxType: 'computer-box',
            createdAt: 2,
          },
          {
            id: 'sess-2',
            status: 'running',
            displayStatus: 'starting',
            agentType: 'none',
            sandboxType: 'simple-box',
            createdAt: 1,
          },
          {
            id: 'sess-3',
            status: 'terminated',
            agentType: 'openclaw',
            sandboxType: 'simple-box',
            createdAt: 0,
          },
        ]);
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
                ],
              },
            ],
          },
        });
      }
      if (url === '/api/sessions' && method === 'POST') {
        return jsonResponse({
          id: 'sess-new',
          status: 'created',
          agentType: 'none',
          sandboxType: 'simple-box',
          createdAt: 3,
        });
      }
      if ((url === '/api/sessions/sess-1/events' || url === '/api/sessions/sess-2/events' || url === '/api/sessions/sess-new/events') && method === 'GET') {
        return jsonResponse([]);
      }
      if ((url === '/api/sessions/sess-1/hitl/pending' || url === '/api/sessions/sess-2/hitl/pending' || url === '/api/sessions/sess-new/hitl/pending') && method === 'GET') {
        return jsonResponse([]);
      }
      if (url === '/api/sessions/sess-1/deploy-agent' && method === 'POST') {
        return jsonResponse({ deploying: true, agentType: 'openclaw' });
      }
      if (url === '/api/sessions/sess-1/commands/abort' && method === 'POST') {
        expect(init?.body).toBe(JSON.stringify({ runId: 'run-2' }));
        return jsonResponse({ ok: true, aborted: true, runId: 'run-2' });
      }
      if (url === '/api/sessions/sess-1/kill' && method === 'POST') {
        return jsonResponse({ killed: true });
      }
      if (url === '/api/llm-config' && method === 'GET') {
        return jsonResponse({
          providers: [
            {
              provider: 'openrouter',
              apiKey: '***',
              baseUrl: 'https://openrouter.ai/api/v1',
              enabled: true,
            },
          ],
        });
      }
      if (url === '/api/llm-config' && method === 'POST') {
        return jsonResponse({ ok: true });
      }
      if (url === '/api/llm-config/openrouter' && method === 'DELETE') {
        return jsonResponse({ deleted: true });
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

  it('keeps sandbox creation and session switching available even after entering a session', async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole('button', { name: /Create sandbox/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sess-1/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sess-2/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /sess-1/i }));

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
      expect(screen.getAllByText('Session 1').length).toBeGreaterThan(0);
    });

    expect(screen.getByRole('button', { name: /Create sandbox/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sess-2/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /sess-2/i }));

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2);
      expect(screen.getAllByText('Session 2').length).toBeGreaterThan(0);
    });

    await user.click(screen.getByRole('button', { name: /Create sandbox/i }));
    const dialog = screen.getByRole('dialog', { name: /Create sandbox/i });
    await user.click(within(dialog).getByRole('button', { name: /^Create sandbox$/i }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/sessions', expect.objectContaining({ method: 'POST' }));
    });

    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('Starting')).toBeInTheDocument();
  });

  it('supports collapsing the sidebar and hides terminated sessions from the list', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: /Collapse sidebar/i }));
    expect(screen.getByRole('button', { name: /Expand sidebar/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Expand sidebar/i }));
    expect(screen.queryByRole('button', { name: /Archived sessions/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sess-3/i })).not.toBeInTheDocument();
  });

  it('lets the user edit an existing llm provider configuration from the modal', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: /API Keys/i }));
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const baseUrlInput = screen.getByDisplayValue('https://openrouter.ai/api/v1');
    await user.clear(baseUrlInput);
    await user.type(baseUrlInput, 'https://openrouter.ai/api/v2');
    const apiKeyInput = screen.getByPlaceholderText(/leave empty to keep the current key/i);
    await user.type(apiKeyInput, 'sk-test');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      const saveCall = fetchMock.mock.calls.find(
        ([url, init]) => url === '/api/llm-config' && init?.method === 'POST',
      );
      expect(saveCall).toBeTruthy();
      expect(JSON.parse(String(saveCall?.[1]?.body))).toEqual({
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v2',
        apiKey: 'sk-test',
      });
    });
  });

  it('renders a command-first monitor, preserves a raw logs tab, and lets the user stop a running command', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: /sess-1/i }));

    await waitFor(() => {
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
    });

    await act(async () => {
      socket.emit({
        id: 'evt-3',
        sessionId: 'sess-1',
        seq: 3,
        timestamp: Date.now(),
        type: 'user.command',
        payload: { command: '先帮我看看虎扑首页' },
      });
      socket.emit({
        id: 'evt-4',
        sessionId: 'sess-1',
        seq: 4,
        timestamp: Date.now(),
        type: 'amp.user.command',
        payload: { command: '先帮我看看虎扑首页', runId: 'run-1' },
      });
      socket.emit({
        id: 'evt-5',
        sessionId: 'sess-1',
        seq: 5,
        timestamp: Date.now(),
        type: 'llm.request',
        payload: {
          provider: 'openrouter',
          model: 'moonshotai/kimi-k2',
          messagesPreview: [{ role: 'user', text: '先帮我看看虎扑首页' }],
        },
      });
      socket.emit({
        id: 'evt-6',
        sessionId: 'sess-1',
        seq: 6,
        timestamp: Date.now(),
        type: 'amp.tool.intent',
        payload: { toolName: 'browser', toolInput: { action: 'open', url: 'https://www.hupu.com' }, runId: 'run-1' },
      });
      socket.emit({
        id: 'evt-7',
        sessionId: 'sess-1',
        seq: 7,
        timestamp: Date.now(),
        type: 'amp.agent.message',
        payload: { text: '虎扑首页已经打开。', runId: 'run-1' },
      });
      socket.emit({
        id: 'evt-8',
        sessionId: 'sess-1',
        seq: 8,
        timestamp: Date.now(),
        type: 'user.command',
        payload: { command: '这个命令还在跑' },
      });
      socket.emit({
        id: 'evt-9',
        sessionId: 'sess-1',
        seq: 9,
        timestamp: Date.now(),
        type: 'amp.user.command',
        payload: { command: '这个命令还在跑', runId: 'run-2' },
      });
      socket.emit({
        id: 'evt-10',
        sessionId: 'sess-1',
        seq: 10,
        timestamp: Date.now(),
        type: 'amp.tool.intent',
        payload: { toolName: 'exec', toolInput: { command: 'sleep 1000' }, runId: 'run-2' },
      });
    });

    expect(await screen.findByText('这个命令还在跑')).toBeInTheDocument();
    expect(screen.getAllByText('虎扑首页已经打开。').length).toBeGreaterThan(0);
    expect(screen.queryByText(/"toolName":/)).not.toBeInTheDocument();

    expect((await screen.findAllByText(/Execution tree/i)).length).toBeGreaterThan(0);
    expect(screen.getByText('moonshotai/kimi-k2')).toBeInTheDocument();
    expect(screen.getByText('openrouter')).toBeInTheDocument();
    expect(screen.getAllByText(/先帮我看看虎扑首页/).length).toBeGreaterThan(0);
    expect(screen.getByText('browser')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Raw Logs' }));
    await waitFor(() => {
      expect(screen.getAllByText('amp.tool.intent').length).toBeGreaterThan(0);
    });

    await user.click(screen.getByRole('button', { name: 'Commands' }));
    await user.click(screen.getByRole('button', { name: 'Stop command' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/sessions/sess-1/commands/abort', expect.objectContaining({ method: 'POST' }));
    });
  });
});
