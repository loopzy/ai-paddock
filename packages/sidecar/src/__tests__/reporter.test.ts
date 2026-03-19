import { describe, expect, it, vi } from 'vitest';
import { EventReporter } from '../reporter.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('EventReporter', () => {
  it('batches bulkable reports to avoid event storms', async () => {
    const first = deferred<Response>();
    const fetch = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(new Response(null, { status: 200 }));
    const reporter = new EventReporter({ fetch } as any, 'session-test');

    const firstReport = reporter.report('fs.change', { path: '/workspace/one.txt' });
    const secondReport = reporter.report('fs.change', { path: '/workspace/two.txt' });

    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/sessions/session-test/events/bulk');
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      events: [
        { type: 'fs.change', payload: { path: '/workspace/one.txt' } },
        { type: 'fs.change', payload: { path: '/workspace/two.txt' } },
      ],
    });

    first.resolve(new Response(null, { status: 200 }));
    await firstReport;
    await secondReport;

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries transient network failures before giving up', async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error('connect timeout'))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const reporter = new EventReporter({ fetch } as any, 'session-test');

    await expect(reporter.report('llm.request', { provider: 'openrouter' })).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/sessions/session-test/events');
  });

  it('falls back to per-event delivery when a bulk write keeps failing', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const reporter = new EventReporter({ fetch } as any, 'session-test');

    await expect(
      Promise.all([
        reporter.report('fs.change', { path: '/workspace/one.txt' }),
        reporter.report('fs.change', { path: '/workspace/two.txt' }),
      ]),
    ).resolves.toEqual([true, true]);

    expect(fetch.mock.calls[0]?.[0]).toBe('/api/sessions/session-test/events/bulk');
    expect(fetch.mock.calls[3]?.[0]).toBe('/api/sessions/session-test/events');
    expect(fetch.mock.calls[4]?.[0]).toBe('/api/sessions/session-test/events');
  });
});
