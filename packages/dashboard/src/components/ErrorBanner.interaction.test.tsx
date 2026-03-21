// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ErrorBanner } from './ErrorBanner.js';

function event(id: string, type: string, payload: Record<string, unknown>) {
  return {
    id,
    sessionId: 'sess-1',
    seq: 1,
    timestamp: Date.now(),
    type,
    payload,
  };
}

describe('ErrorBanner interactions', () => {
  it('expands long error text on demand', async () => {
    const user = userEvent.setup();
    const hiddenTail = '这是顶部错误条里的最后一段。';
    const longMessage = `${'错误上下文。'.repeat(80)}${hiddenTail}`;

    render(
      <ErrorBanner
        events={[
          event('err-long', 'amp.agent.fatal', {
            category: 'runtime',
            code: 'ERR_LONG_FATAL',
            message: longMessage,
            recoverable: false,
          }),
        ]}
      />,
    );

    expect(screen.queryByText(hiddenTail)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /expand full error/i }));

    expect(screen.getByText((content) => content.includes(hiddenTail))).toBeInTheDocument();
  });
});
