export interface DashboardEventLike {
  id?: string;
  type: string;
  payload: Record<string, unknown>;
  timestamp?: number;
}

export type AgentLifecycleState = 'not_ready' | 'ready' | 'offline';
export type DeployStageStatus = 'done' | 'active' | 'pending' | 'error';

export function hasSessionError(events: DashboardEventLike[]): boolean {
  return events.some((event) => event.type === 'session.status' && event.payload.status === 'error');
}

export function isSandboxReady(events: DashboardEventLike[]): boolean {
  return events.some((event) => event.type === 'amp.session.start' && event.payload.phase === 'sandbox_ready');
}

export function getAgentLifecycleState(events: DashboardEventLike[]): AgentLifecycleState {
  let readySeen = false;
  let terminalSeenAfterReady = false;

  for (const event of events) {
    if (event.type === 'amp.agent.ready') {
      readySeen = true;
      terminalSeenAfterReady = false;
      continue;
    }

    if (readySeen && (event.type === 'amp.agent.fatal' || event.type === 'amp.agent.exit')) {
      terminalSeenAfterReady = true;
    }
  }

  if (readySeen && !terminalSeenAfterReady) return 'ready';
  if (readySeen && terminalSeenAfterReady) return 'offline';
  return 'not_ready';
}

export function isAgentReady(events: DashboardEventLike[]): boolean {
  return getAgentLifecycleState(events) === 'ready';
}

export function isAgentDeploying(events: DashboardEventLike[]): boolean {
  return getAgentLifecycleState(events) !== 'ready'
    && !hasSessionError(events)
    && events.some(
      (event) => event.type === 'amp.session.start' && String(event.payload.phase ?? '').startsWith('agent.')
    );
}

export function getCommandInputState(events: DashboardEventLike[]): { disabled: boolean; hint: string } {
  if (hasSessionError(events)) {
    return {
      disabled: true,
      hint: 'Session failed. Check the error log above before sending more commands.',
    };
  }

  if (!isSandboxReady(events)) {
    return {
      disabled: true,
      hint: 'Sandbox is still starting.',
    };
  }

  const agentState = getAgentLifecycleState(events);
  if (agentState === 'offline') {
    return {
      disabled: true,
      hint: 'Agent disconnected. Redeploy it or inspect the error timeline before sending commands.',
    };
  }

  if (agentState !== 'ready') {
    return {
      disabled: true,
      hint: 'Wait for the agent to report AMP readiness before sending commands.',
    };
  }

  return { disabled: false, hint: '' };
}

export function getDeployStageStatus(
  steps: DashboardEventLike[],
  stagePhases: string[],
  hasError: boolean,
): DeployStageStatus {
  const stageEvents = steps.filter((event) => stagePhases.includes(String(event.payload.phase ?? '')));
  if (stageEvents.length === 0) return 'pending';

  const donePhases = new Set(['vm.ready', 'sandbox_ready', 'agent_ready']);
  if (stageEvents.some((event) => donePhases.has(String(event.payload.phase ?? '')))) return 'done';
  if (hasError) return 'error';
  return 'active';
}
