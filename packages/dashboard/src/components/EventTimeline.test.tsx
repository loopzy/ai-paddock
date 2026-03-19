// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { EventTimeline } from './EventTimeline.js';

const sampleEvents = [
  {
    id: 'evt-1',
    sessionId: 'sess-1',
    seq: 1,
    timestamp: 1_700_000_000_000,
    type: 'amp.tool.intent',
    payload: {
      toolName: 'browser',
      toolInput: { action: 'open', url: 'https://www.hupu.com' },
    },
  },
  {
    id: 'evt-2',
    sessionId: 'sess-1',
    seq: 2,
    timestamp: 1_700_000_001_000,
    type: 'amp.agent.message',
    payload: {
      text: '虎扑首页已经打开，接下来可以继续查看赛程。',
    },
  },
];

describe('EventTimeline', () => {
  it('shows one-line raw json by default', () => {
    render(<EventTimeline events={sampleEvents} sessionId="sess-1" />);

    expect(screen.getByText(/"toolName":"browser"/)).toBeInTheDocument();
    expect(screen.queryByText(/"toolName": "browser"/)).not.toBeInTheDocument();
  });

  it('reveals raw payload only when expanded', async () => {
    const user = userEvent.setup();
    render(<EventTimeline events={sampleEvents} sessionId="sess-1" />);

    const buttons = screen.getAllByRole('button', { name: /expand payload/i });
    await user.click(buttons[0]);

    expect(screen.getByText(/"toolName": "browser"/)).toBeInTheDocument();
    expect(screen.getByText(/"url": "https:\/\/www.hupu.com"/)).toBeInTheDocument();
  });
});
