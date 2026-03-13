import { describe, expect, it } from 'vitest';
import { getAgentLifecycleState, getCommandInputState, getDeployStageStatus, hasSessionError, isAgentDeploying, isAgentReady, isSandboxReady } from './ui-state.js';

function event(type: string, payload: Record<string, unknown>) {
  return {
    id: `${type}-${JSON.stringify(payload)}`,
    type,
    payload,
  };
}

describe('dashboard user-facing state', () => {
  it('keeps the command box disabled while the sandbox is still starting', () => {
    const events = [
      event('amp.session.start', { phase: 'vm.init' }),
      event('amp.session.start', { phase: 'sidecar.start' }),
    ];

    expect(isSandboxReady(events)).toBe(false);
    expect(getCommandInputState(events)).toEqual({
      disabled: true,
      hint: 'Sandbox is still starting.',
    });
  });

  it('keeps the command box disabled until the agent reports readiness', () => {
    const events = [
      event('amp.session.start', { phase: 'sandbox_ready' }),
    ];

    expect(isSandboxReady(events)).toBe(true);
    expect(isAgentReady(events)).toBe(false);
    expect(getCommandInputState(events)).toEqual({
      disabled: true,
      hint: 'Wait for the agent to report AMP readiness before sending commands.',
    });
  });

  it('re-disables the command box after a ready agent later disconnects', () => {
    const events = [
      event('amp.session.start', { phase: 'sandbox_ready' }),
      event('amp.agent.ready', { agent: 'openclaw' }),
      event('amp.agent.fatal', { code: 'ERR_NO_API_KEY' }),
    ];

    expect(getAgentLifecycleState(events)).toBe('offline');
    expect(isAgentReady(events)).toBe(false);
    expect(getCommandInputState(events)).toEqual({
      disabled: true,
      hint: 'Agent disconnected. Redeploy it or inspect the error timeline before sending commands.',
    });
  });

  it('marks the command box enabled only when sandbox and agent are both healthy', () => {
    const events = [
      event('amp.session.start', { phase: 'sandbox_ready' }),
      event('amp.agent.ready', { agent: 'openclaw' }),
    ];

    expect(isAgentReady(events)).toBe(true);
    expect(getCommandInputState(events)).toEqual({
      disabled: false,
      hint: '',
    });
  });

  it('surfaces failed sessions even if the sandbox already emitted progress', () => {
    const events = [
      event('amp.session.start', { phase: 'sandbox_ready' }),
      event('session.status', { status: 'error', error: 'Sidecar failed' }),
    ];

    expect(hasSessionError(events)).toBe(true);
    expect(getCommandInputState(events)).toEqual({
      disabled: true,
      hint: 'Session failed. Check the error log above before sending more commands.',
    });
  });

  it('treats agent deployment as in progress only before readiness or terminal failure', () => {
    const deployingEvents = [
      event('amp.session.start', { phase: 'sandbox_ready' }),
      event('amp.session.start', { phase: 'agent.copy_adapter' }),
      event('amp.session.start', { phase: 'agent.starting' }),
    ];
    const doneEvents = [...deployingEvents, event('amp.agent.ready', { agent: 'openclaw' })];
    const failedEvents = [...deployingEvents, event('session.status', { status: 'error' })];

    expect(isAgentDeploying(deployingEvents)).toBe(true);
    expect(isAgentDeploying(doneEvents)).toBe(false);
    expect(isAgentDeploying(failedEvents)).toBe(false);
  });

  it('marks deploy stages as error when a later error interrupts the current stage', () => {
    const steps = [
      event('amp.session.start', { phase: 'sidecar.copy' }),
      event('amp.session.start', { phase: 'sidecar.start' }),
    ];

    expect(getDeployStageStatus(steps, ['sidecar.copy', 'sidecar.start', 'sidecar.verify'], true)).toBe('error');
    expect(getDeployStageStatus([...steps, event('amp.session.start', { phase: 'sandbox_ready' })], ['sidecar.copy', 'sidecar.start', 'sidecar.verify', 'sandbox_ready'], true)).toBe('done');
  });
});
