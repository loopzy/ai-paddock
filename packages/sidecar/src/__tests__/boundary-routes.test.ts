import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAmpGateRequestHandler } from '../index.js';
import { ControlPlaneClient } from '../control-plane-client.js';

class ReporterStub {
  events: Array<{ type: string; payload: Record<string, unknown>; opts?: Record<string, unknown> }> = [];

  async report(type: string, payload: Record<string, unknown>, opts?: Record<string, unknown>) {
    this.events.push({ type, payload, opts });
    return true;
  }
}

async function invokeHandler(
  handler: ReturnType<typeof createAmpGateRequestHandler>,
  params: { method: string; url: string; body?: string },
) {
  const req = Readable.from(params.body ? [Buffer.from(params.body)] : []) as Readable & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = params.method;
  req.url = params.url;
  req.headers = params.body ? { 'content-type': 'application/json' } : {};

  const responseState: { statusCode: number; headers: Record<string, string>; body: string } = {
    statusCode: 200,
    headers: {},
    body: '',
  };

  await new Promise<void>((resolve, reject) => {
    const res = {
      writeHead(statusCode: number, headers?: Record<string, string>) {
        responseState.statusCode = statusCode;
        responseState.headers = headers ?? {};
        return this;
      },
      end(chunk?: string) {
        if (chunk) {
          responseState.body += chunk;
        }
        resolve();
      },
    };

    Promise.resolve(handler(req as any, res as any)).catch(reject);
  });

  return responseState;
}

describe('Sidecar boundary routes', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('proxies MCP discovery and calls to the control plane', async () => {
    const reporter = new ReporterStub();
    const handler = createAmpGateRequestHandler({
      sessionId: 'session-sidecar-test',
      controlPlaneClient: new ControlPlaneClient(['http://control.test']),
      commandFile: '/tmp/paddock-boundary-test.jsonl',
      policyGate: { evaluate: vi.fn(), onToolResult: vi.fn() } as any,
      reporter: reporter as any,
      agentMonitor: { reportReady: vi.fn(), reportError: vi.fn(), reportExit: vi.fn(), start: vi.fn(), stop: vi.fn() } as any,
    });

    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === 'http://control.test/api/sessions/session-sidecar-test/mcp/tools') {
        expect(init?.method).toBe('GET');
        return new Response(JSON.stringify({ tools: [{ name: 'browser.open' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(input) === 'http://control.test/api/sessions/session-sidecar-test/mcp/call') {
        expect(init?.method).toBe('POST');
        expect(init?.body).toBe(JSON.stringify({ toolName: 'browser.open', args: { url: 'https://example.com' } }));
        return new Response(JSON.stringify({ exitCode: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const toolsResponse = await invokeHandler(handler, {
      method: 'GET',
      url: '/mcp/tools',
    });
    expect(toolsResponse.statusCode).toBe(200);
    expect(JSON.parse(toolsResponse.body)).toEqual({ tools: [{ name: 'browser.open' }] });

    const callResponse = await invokeHandler(handler, {
      method: 'POST',
      url: '/mcp/call',
      body: JSON.stringify({ toolName: 'browser.open', args: { url: 'https://example.com' } }),
    });
    expect(callResponse.statusCode).toBe(200);
    expect(JSON.parse(callResponse.body)).toEqual({ exitCode: 0 });
  });

  it('proxies amp/control requests and records sandbox-local tool results as amp.tool.result', async () => {
    const reporter = new ReporterStub();
    const onToolResult = vi.fn();
    const handler = createAmpGateRequestHandler({
      sessionId: 'session-sidecar-test',
      controlPlaneClient: new ControlPlaneClient(['http://control.test']),
      commandFile: '/tmp/paddock-boundary-test.jsonl',
      policyGate: { evaluate: vi.fn(), onToolResult } as any,
      reporter: reporter as any,
      agentMonitor: { reportReady: vi.fn(), reportError: vi.fn(), reportExit: vi.fn(), start: vi.fn(), stop: vi.fn() } as any,
    });

    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === 'http://control.test/api/sessions/session-sidecar-test/amp/control') {
        expect(init?.method).toBe('POST');
        return new Response(JSON.stringify({ sessions: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const controlResponse = await invokeHandler(handler, {
      method: 'POST',
      url: '/amp/control',
      body: JSON.stringify({ toolName: 'sessions_list', args: {} }),
    });
    expect(controlResponse.statusCode).toBe(200);
    expect(JSON.parse(controlResponse.body)).toEqual({ sessions: [] });

    const eventResponse = await invokeHandler(handler, {
      method: 'POST',
      url: '/amp/event',
      body: JSON.stringify({
        toolName: 'read',
        result: JSON.stringify({ content: 'hello' }),
        path: '/workspace/README.md',
        correlationId: 'corr-1',
        snapshotRef: 'snap-checkpoint-1',
      }),
    });
    expect(eventResponse.statusCode).toBe(200);
    expect(onToolResult).toHaveBeenCalledWith('read', JSON.stringify({ content: 'hello' }), {
      path: '/workspace/README.md',
    });
    expect(reporter.events).toContainEqual({
      type: 'amp.tool.result',
      payload: {
        toolName: 'read',
        result: { content: 'hello' },
        path: '/workspace/README.md',
      },
      opts: { correlationId: 'corr-1', snapshotRef: 'snap-checkpoint-1' },
    });
  });

  it('creates a checkpoint for rollbackable tool intents before approving them', async () => {
    const reporter = new ReporterStub();
    const handler = createAmpGateRequestHandler({
      sessionId: 'session-sidecar-test',
      controlPlaneClient: new ControlPlaneClient(['http://control.test']),
      commandFile: '/tmp/paddock-boundary-test.jsonl',
      policyGate: {
        evaluate: vi.fn(() => ({
          verdict: 'approve',
          riskScore: 12,
          triggeredRules: [],
        })),
        onToolResult: vi.fn(),
      } as any,
      reporter: reporter as any,
      agentMonitor: { reportReady: vi.fn(), reportError: vi.fn(), reportExit: vi.fn(), start: vi.fn(), stop: vi.fn() } as any,
    });

    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === 'http://control.test/api/sessions/session-sidecar-test/snapshots') {
        expect(init?.method).toBe('POST');
        const payload = JSON.parse(String(init?.body));
        expect(payload.label).toContain('checkpoint:write');
        return new Response(JSON.stringify({ id: 'snap-checkpoint-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const gateResponse = await invokeHandler(handler, {
      method: 'POST',
      url: '/amp/gate',
      body: JSON.stringify({
        correlationId: 'corr-write-1',
        toolName: 'write',
        toolInput: { path: 'notes.txt', content: 'hello' },
      }),
    });

    expect(gateResponse.statusCode).toBe(200);
    expect(JSON.parse(gateResponse.body)).toMatchObject({
      verdict: 'approve',
      snapshotRef: 'snap-checkpoint-1',
    });
    expect(reporter.events).toContainEqual({
      type: 'amp.gate.verdict',
      payload: {
        correlationId: 'corr-write-1',
        toolName: 'write',
        verdict: 'approve',
        riskScore: 12,
        triggeredRules: [],
        behaviorFlags: undefined,
        snapshotRef: 'snap-checkpoint-1',
      },
      opts: { correlationId: 'corr-write-1', snapshotRef: 'snap-checkpoint-1' },
    });
  });
});
