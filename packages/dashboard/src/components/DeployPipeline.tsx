import { useRef, useEffect } from 'react';
import { getDeployStageStatus } from '../ui-state.js';

interface PaddockEvent {
  id: string;
  timestamp: number;
  type: string;
  payload: Record<string, unknown>;
}

interface DeployStage {
  label: string;
  phases: string[];
  icon: 'init' | 'sidecar' | 'agent';
}

const STAGES: DeployStage[] = [
  { label: 'Initialize VM', phases: ['vm.init', 'vm.image', 'vm.ready'], icon: 'init' },
  { label: 'Deploy Sidecar', phases: ['sidecar', 'sidecar.copy', 'sidecar.node', 'sidecar.shims', 'sidecar.start', 'sidecar.verify', 'env', 'sandbox_ready'], icon: 'sidecar' },
  {
    label: 'Deploy Agent',
    phases: [
      'agent.node',
      'agent.copy_adapter',
      'agent.copy_runtime',
      'agent.copy_source',
      'agent.install_pnpm',
      'agent.install_deps',
      'agent.build_source',
      'agent.install_python',
      'agent.install_browser',
      'agent.browser',
      'agent.install_adapter',
      'agent.starting',
      'agent.verify',
      'agent.browser_prewarm',
      'agent_ready',
    ],
    icon: 'agent',
  },
];

function StatusIcon({ status }: { status: 'done' | 'active' | 'pending' | 'error' }) {
  switch (status) {
    case 'done': return <span className="text-emerald-600 text-sm">&#10003;</span>;
    case 'active': return <span className="text-amber-600 text-sm animate-pulse">&#9679;</span>;
    case 'error': return <span className="text-rose-600 text-sm">&#10007;</span>;
    default: return <span className="text-stone-400 text-sm">&#9675;</span>;
  }
}

export function DeployPipeline({ events }: { events: PaddockEvent[] }) {
  const steps = events.filter(e => e.type === 'amp.session.start');
  const hasError = events.some(e => e.type === 'session.status' && e.payload.status === 'error');
  const errorEvent = events.find(e => e.type === 'session.status' && e.payload.status === 'error');
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [steps.length]);

  return (
    <div className="space-y-0 text-left max-h-64 overflow-y-auto px-1">
      {STAGES.map((stage, si) => {
        const status = getDeployStageStatus(steps, stage.phases, hasError);
        const stageSteps = steps.filter(e => stage.phases.includes(e.payload.phase as string));
        return (
            <div key={stage.label}>
            <div className="flex items-center gap-2 py-1">
              <StatusIcon status={status} />
              <span className={`text-xs font-medium ${status === 'done' ? 'text-emerald-700' : status === 'active' ? 'text-amber-700' : status === 'error' ? 'text-rose-700' : 'text-stone-500'}`}>
                {stage.label}
              </span>
            </div>
            {stageSteps.length > 0 && (
              <div className="ml-5 border-l border-stone-200 pl-3 space-y-0.5 mb-1">
                {stageSteps.map(e => {
                  const elapsed = stageSteps.indexOf(e) > 0
                    ? `${((e.timestamp - stageSteps[stageSteps.indexOf(e) - 1].timestamp) / 1000).toFixed(1)}s`
                    : '';
                  return (
                    <div key={e.id} className="flex items-center gap-2 text-[11px] py-0.5">
                      <span className="text-stone-500">{e.payload.message as string}</span>
                      {elapsed && <span className="text-stone-400">{elapsed}</span>}
                    </div>
                  );
                })}
              </div>
            )}
            {si < STAGES.length - 1 && status !== 'pending' && (
              <div className="ml-[7px] h-2 border-l border-stone-200" />
            )}
          </div>
        );
      })}
      {errorEvent && (
        <div className="flex items-center gap-2 text-xs py-1 mt-1">
          <span className="text-rose-600 font-bold">!!</span>
          <span className="text-rose-700">{errorEvent.payload.error as string}</span>
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}
