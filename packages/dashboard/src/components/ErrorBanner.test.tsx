import { renderToStaticMarkup } from 'react-dom/server';
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

describe('ErrorBanner', () => {
  it('renders an auth hint for missing API keys', () => {
    const html = renderToStaticMarkup(
      <ErrorBanner
        events={[
          event('err-1', 'amp.agent.error', {
            category: 'auth',
            code: 'ERR_NO_API_KEY',
            message: 'API key not configured.',
            recoverable: false,
          }),
        ]}
      />
    );

    expect(html).toContain('ERROR');
    expect(html).toContain('ERR_NO_API_KEY');
    expect(html).toContain('Hint: Check your environment variables');
  });

  it('shows the latest fatal event and counts older errors', () => {
    const html = renderToStaticMarkup(
      <ErrorBanner
        events={[
          event('err-1', 'amp.agent.error', {
            category: 'network',
            code: 'ERR_AGENT_REQUEST_FAILED',
            message: 'temporary network issue',
            recoverable: true,
          }),
          event('err-2', 'amp.agent.fatal', {
            category: 'auth',
            code: 'ERR_NO_API_KEY',
            message: 'API key not configured.',
            recoverable: false,
          }),
        ]}
      />
    );

    expect(html).toContain('FATAL');
    expect(html).toContain('API key not configured.');
    expect(html).toContain('1 more error');
  });
});
