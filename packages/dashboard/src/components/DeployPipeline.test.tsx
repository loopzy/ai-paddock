import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DeployPipeline } from './DeployPipeline.js';

function event(id: string, type: string, payload: Record<string, unknown>, timestamp: number) {
  return {
    id,
    timestamp,
    type,
    payload,
  };
}

describe('DeployPipeline', () => {
  it('renders sidecar progress and the final session error message', () => {
    const html = renderToStaticMarkup(
      <DeployPipeline
        events={[
          event('e1', 'amp.session.start', { phase: 'vm.init', message: 'Initializing VM...' }, 1),
          event('e2', 'amp.session.start', { phase: 'vm.ready', message: 'VM created successfully' }, 2),
          event('e3', 'amp.session.start', { phase: 'sidecar.start', message: 'Starting Sidecar process...' }, 3),
          event('e4', 'session.status', { status: 'error', error: 'Failed to start sandbox: Sidecar AMP Gate is not accepting connections' }, 4),
        ]}
      />
    );

    expect(html).toContain('Initialize VM');
    expect(html).toContain('Deploy Sidecar');
    expect(html).toContain('Starting Sidecar process...');
    expect(html).toContain('Failed to start sandbox: Sidecar AMP Gate is not accepting connections');
  });

  it('renders the agent stage once the agent journey starts', () => {
    const html = renderToStaticMarkup(
      <DeployPipeline
        events={[
          event('e1', 'amp.session.start', { phase: 'sandbox_ready', message: 'Sandbox ready' }, 1),
          event('e2', 'amp.session.start', { phase: 'agent.node', message: 'Preparing Node.js runtime (22.16.0)...' }, 2),
          event('e3', 'amp.session.start', { phase: 'agent.copy_adapter', message: 'Copying AMP adapter...' }, 3),
          event('e4', 'amp.session.start', { phase: 'agent_ready', message: 'OpenClaw connected to Paddock' }, 4),
        ]}
      />
    );

    expect(html).toContain('Deploy Agent');
    expect(html).toContain('Preparing Node.js runtime (22.16.0)...');
    expect(html).toContain('Copying AMP adapter...');
    expect(html).toContain('OpenClaw connected to Paddock');
  });
});
