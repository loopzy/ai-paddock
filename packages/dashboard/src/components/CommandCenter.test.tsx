// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CommandCenter } from './CommandCenter.js';

const sampleEvents = [
  {
    id: 'evt-1',
    sessionId: 'sess-1',
    seq: 1,
    timestamp: 1_700_000_000_000,
    type: 'user.command',
    payload: { command: '打开虎扑并总结明天的赛程' },
  },
  {
    id: 'evt-2',
    sessionId: 'sess-1',
    seq: 2,
    timestamp: 1_700_000_001_000,
    type: 'amp.user.command',
    payload: { command: '打开虎扑并总结明天的赛程', runId: 'run-1' },
  },
  {
    id: 'evt-3',
    sessionId: 'sess-1',
    seq: 3,
    timestamp: 1_700_000_002_000,
    type: 'llm.request',
    payload: {
      provider: 'openrouter',
      model: 'moonshotai/kimi-k2',
      messagesPreview: [{ role: 'user', text: '打开虎扑并总结明天的赛程' }],
    },
  },
  {
    id: 'evt-4',
    sessionId: 'sess-1',
    seq: 4,
    timestamp: 1_700_000_002_250,
    type: 'llm.response',
    payload: {
      provider: 'openrouter',
      model: 'moonshotai/kimi-k2',
      tokensIn: 1200,
      tokensOut: 80,
      durationMs: 4200,
      responsePreview: '我先去看看虎扑上的信息。\n\n[tool] browser',
    },
  },
  {
    id: 'evt-4b',
    sessionId: 'sess-1',
    seq: 5,
    timestamp: 1_700_000_002_500,
    type: 'amp.tool.intent',
    payload: { toolName: 'browser', toolInput: { action: 'open', url: 'https://www.hupu.com' }, runId: 'run-1' },
  },
  {
    id: 'evt-5',
    sessionId: 'sess-1',
    seq: 6,
    timestamp: 1_700_000_002_500,
    type: 'amp.agent.message',
    payload: { text: '## 赛程总结\n\n- 明天有多场比赛。', runId: 'run-1' },
  },
];

const pendingAgentEvents = [
  {
    id: 'evt-p1',
    sessionId: 'sess-1',
    seq: 1,
    timestamp: 1_700_000_000_000,
    type: 'user.command',
    payload: { command: '给我一句总结' },
  },
  {
    id: 'evt-p2',
    sessionId: 'sess-1',
    seq: 2,
    timestamp: 1_700_000_001_000,
    type: 'amp.user.command',
    payload: { command: '给我一句总结', runId: 'run-2' },
  },
  {
    id: 'evt-p3',
    sessionId: 'sess-1',
    seq: 3,
    timestamp: 1_700_000_002_000,
    type: 'llm.request',
    payload: {
      provider: 'openrouter',
      model: 'moonshotai/kimi-k2',
      messagesPreview: [{ role: 'user', text: '给我一句总结' }],
    },
  },
  {
    id: 'evt-p4',
    sessionId: 'sess-1',
    seq: 4,
    timestamp: 1_700_000_003_000,
    type: 'amp.command.status',
    payload: { status: 'accepted', runId: 'run-2' },
  },
];

describe('CommandCenter', () => {
  it('renders command-centric cards instead of raw JSON blobs', () => {
    render(<CommandCenter events={sampleEvents} onAbortCommand={vi.fn()} abortingRunId={null} />);

    expect(screen.getByText('打开虎扑并总结明天的赛程')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('browser')).toBeInTheDocument();
    expect(screen.getAllByText('赛程总结').length).toBeGreaterThan(0);
    expect(screen.queryByText(/"toolName":/)).not.toBeInTheDocument();
  });

  it('shows an expandable execution tree with llm and tool details', async () => {
    render(<CommandCenter events={sampleEvents} onAbortCommand={vi.fn()} abortingRunId={null} />);

    expect(await screen.findByText(/Execution tree/i)).toBeInTheDocument();
    expect(screen.getByText('moonshotai/kimi-k2')).toBeInTheDocument();
    expect(screen.getByText(/openrouter · 1.2k in · 80 out/i)).toBeInTheDocument();
    expect(screen.getAllByText(/打开虎扑并总结明天的赛程/).length).toBeGreaterThan(0);
    expect(screen.getByText('browser')).toBeInTheDocument();
    expect(screen.getByText(/open https:\/\/www.hupu.com/)).toBeInTheDocument();
    expect(screen.queryByText(/Context/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/"action": "open"/)).not.toBeInTheDocument();
  });

  it('lets the user hide a default-expanded execution tree', async () => {
    const user = userEvent.setup();
    render(<CommandCenter events={sampleEvents} onAbortCommand={vi.fn()} abortingRunId={null} />);

    expect(await screen.findByText(/Execution tree/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /hide details/i }));

    expect(screen.queryByText(/Execution tree/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /view details/i })).toBeInTheDocument();
  });

  it('keeps raw payload hidden by default and reveals it on demand', async () => {
    const user = userEvent.setup();
    render(<CommandCenter events={sampleEvents} onAbortCommand={vi.fn()} abortingRunId={null} />);

    expect(screen.queryByText(/"action": "open"/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /show tool payload/i }));

    expect(screen.getByText(/"action": "open"/)).toBeInTheDocument();
  });

  it('shows a stop button for active commands and routes the selected run id back to the caller', async () => {
    const user = userEvent.setup();
    const onAbortCommand = vi.fn(async () => undefined);
    render(
      <CommandCenter
        events={pendingAgentEvents}
        onAbortCommand={onAbortCommand}
        abortingRunId={null}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Stop command' }));

    expect(onAbortCommand).toHaveBeenCalledWith('run-2');
  });

  it('renders agent replies as markdown instead of plain raw text', () => {
    render(<CommandCenter events={sampleEvents} onAbortCommand={vi.fn()} abortingRunId={null} />);

    expect(screen.getAllByText('赛程总结').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('list').length).toBeGreaterThan(0);
    expect(screen.getAllByText('明天有多场比赛。').length).toBeGreaterThan(0);
  });

  it('collapses long card content by default and expands it on demand', async () => {
    const user = userEvent.setup();
    const longReply = `${'这是一段很长的回复。'.repeat(80)}\n\n- 第一条\n- 第二条`;

    render(
      <CommandCenter
        events={[
          {
            id: 'evt-l1',
            sessionId: 'sess-1',
            seq: 1,
            timestamp: 1_700_000_000_000,
            type: 'user.command',
            payload: { command: '给我一篇很长的说明' },
          },
          {
            id: 'evt-l2',
            sessionId: 'sess-1',
            seq: 2,
            timestamp: 1_700_000_001_000,
            type: 'amp.user.command',
            payload: { command: '给我一篇很长的说明', runId: 'run-long' },
          },
          {
            id: 'evt-l3',
            sessionId: 'sess-1',
            seq: 3,
            timestamp: 1_700_000_002_000,
            type: 'amp.agent.message',
            payload: { text: longReply, runId: 'run-long' },
          },
        ]}
        onAbortCommand={vi.fn()}
        abortingRunId={null}
      />,
    );

    expect(screen.getAllByRole('button', { name: /expand full reply/i }).length).toBeGreaterThan(0);

    await user.click(screen.getAllByRole('button', { name: /expand full reply/i })[0]!);

    expect(screen.getAllByRole('button', { name: /collapse full reply/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByText('第一条').length).toBeGreaterThan(0);
  });

  it('expands long llm replies to reveal the full response text', async () => {
    const user = userEvent.setup();
    const hiddenTail = '这是完整回复最后一段，只会在展开后出现。';
    const longPreview = `${'前文内容。'.repeat(120)}${hiddenTail}`;

    render(
      <CommandCenter
        events={[
          {
            id: 'evt-r1',
            sessionId: 'sess-1',
            seq: 1,
            timestamp: 1_700_000_000_000,
            type: 'user.command',
            payload: { command: '给我完整长回复' },
          },
          {
            id: 'evt-r2',
            sessionId: 'sess-1',
            seq: 2,
            timestamp: 1_700_000_001_000,
            type: 'amp.user.command',
            payload: { command: '给我完整长回复', runId: 'run-reply' },
          },
          {
            id: 'evt-r3',
            sessionId: 'sess-1',
            seq: 3,
            timestamp: 1_700_000_002_000,
            type: 'llm.request',
            payload: {
              provider: 'openrouter',
              model: 'moonshotai/kimi-k2',
              messagesPreview: [{ role: 'user', text: '给我完整长回复' }],
            },
          },
          {
            id: 'evt-r4',
            sessionId: 'sess-1',
            seq: 4,
            timestamp: 1_700_000_003_000,
            type: 'llm.response',
            payload: {
              provider: 'openrouter',
              model: 'moonshotai/kimi-k2',
              tokensIn: 1000,
              tokensOut: 500,
              durationMs: 4200,
              responsePreview: longPreview,
            },
          },
        ]}
        onAbortCommand={vi.fn()}
        abortingRunId={null}
      />,
    );

    expect(screen.queryByText(hiddenTail)).not.toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: /expand full reply/i })[0]!);

    expect(screen.getByText((content) => content.includes(hiddenTail))).toBeInTheDocument();
  });
});
