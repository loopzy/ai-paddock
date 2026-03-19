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
    timestamp: 1_700_000_002_500,
    type: 'amp.tool.intent',
    payload: { toolName: 'browser', toolInput: { action: 'open', url: 'https://www.hupu.com' }, runId: 'run-1' },
  },
  {
    id: 'evt-5',
    sessionId: 'sess-1',
    seq: 5,
    timestamp: 1_700_000_003_000,
    type: 'amp.agent.message',
    payload: { text: '明天有多场比赛。', runId: 'run-1' },
  },
];

describe('CommandCenter', () => {
  it('renders command-centric cards instead of raw JSON blobs', () => {
    render(<CommandCenter events={sampleEvents} onAbortCommand={vi.fn()} abortingRunId={null} />);

    expect(screen.getByText('打开虎扑并总结明天的赛程')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('browser')).toBeInTheDocument();
    expect(screen.getAllByText('明天有多场比赛。').length).toBeGreaterThan(0);
    expect(screen.queryByText(/"toolName":/)).not.toBeInTheDocument();
  });

  it('shows an expandable execution tree with llm and tool details', async () => {
    render(<CommandCenter events={sampleEvents} onAbortCommand={vi.fn()} abortingRunId={null} />);

    expect(await screen.findByText(/Execution tree/i)).toBeInTheDocument();
    expect(screen.getByText(/LLM turn · openrouter \/ moonshotai\/kimi-k2/i)).toBeInTheDocument();
    expect(screen.getAllByText(/打开虎扑并总结明天的赛程/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Tool · browser/)).toBeInTheDocument();
    expect(screen.getByText(/open https:\/\/www.hupu.com/)).toBeInTheDocument();
  });

  it('shows a stop button for active commands and routes the selected run id back to the caller', async () => {
    const user = userEvent.setup();
    const onAbortCommand = vi.fn(async () => undefined);
    render(
      <CommandCenter
        events={[
          sampleEvents[0],
          sampleEvents[1],
          sampleEvents[2],
        ]}
        onAbortCommand={onAbortCommand}
        abortingRunId={null}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Stop command' }));

    expect(onAbortCommand).toHaveBeenCalledWith('run-1');
  });
});
