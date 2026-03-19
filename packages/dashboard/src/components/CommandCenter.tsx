import { useMemo, useState } from 'react';
import { buildCommandRuns, type CommandEventLike, type CommandStep } from '../command-groups.js';

interface PendingApproval {
  id: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  reason: string;
  timestamp: number;
  riskScore?: number;
  triggeredRules?: string[];
}

function formatRelativeDuration(startedAt: number, finishedAt?: number): string {
  const deltaMs = Math.max(0, (finishedAt ?? Date.now()) - startedAt);
  if (deltaMs < 1000) return `${deltaMs}ms`;
  if (deltaMs < 60_000) return `${(deltaMs / 1000).toFixed(1)}s`;
  return `${(deltaMs / 60_000).toFixed(1)}m`;
}

function StatusPill({ status }: { status: 'running' | 'completed' | 'failed' | 'aborted' }) {
  const styles: Record<typeof status, string> = {
    running: 'bg-cyan-950 text-cyan-300 border-cyan-900',
    completed: 'bg-emerald-950 text-emerald-300 border-emerald-900',
    failed: 'bg-red-950 text-red-300 border-red-900',
    aborted: 'bg-yellow-950 text-yellow-300 border-yellow-900',
  };
  const labels: Record<typeof status, string> = {
    running: 'Running',
    completed: 'Completed',
    failed: 'Failed',
    aborted: 'Aborted',
  };

  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}

function StepTone({ status }: { status?: CommandStep['status'] }) {
  const styles =
    status === 'failed'
      ? 'bg-red-500'
      : status === 'blocked'
        ? 'bg-yellow-400'
        : status === 'running'
          ? 'bg-cyan-400'
          : 'bg-emerald-400';
  return <span className={`mt-1.5 h-2.5 w-2.5 rounded-full ${styles}`} />;
}

function StepTree({
  steps,
  depth = 0,
}: {
  steps: CommandStep[];
  depth?: number;
}) {
  return (
    <div className="space-y-2">
      {steps.map((step) => (
        <div key={step.id} className="rounded-2xl border border-gray-800 bg-gray-950/60">
          <div className="flex gap-3 px-4 py-3" style={{ marginLeft: depth * 20 }}>
            <StepTone status={step.status} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <div className="text-sm font-medium text-gray-100">{step.title}</div>
                <div className="text-[11px] text-gray-500">{new Date(step.timestamp).toLocaleTimeString()}</div>
              </div>
              {step.summary && (
                <div className="mt-1 whitespace-pre-wrap text-sm leading-6 text-gray-300">{step.summary}</div>
              )}
              {step.detail && (
                <pre className="mt-3 overflow-x-auto rounded-xl border border-gray-800 bg-gray-950 px-3 py-2 text-[11px] leading-5 text-gray-500">
                  {step.detail}
                </pre>
              )}
            </div>
          </div>
          {step.children.length > 0 && (
            <div className="border-t border-gray-800 px-3 py-3">
              <StepTree steps={step.children} depth={depth + 1} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ApprovalCard({
  request,
  onDecide,
}: {
  request: PendingApproval;
  onDecide?: (requestId: string, verdict: 'approved' | 'rejected') => Promise<void> | void;
}) {
  return (
    <div className="rounded-2xl border border-orange-900 bg-orange-950/20 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-sm font-semibold text-orange-300">Approval required</div>
        {typeof request.riskScore === 'number' && (
          <div className="rounded-full bg-orange-950 px-2 py-0.5 text-[11px] text-orange-300">Risk {request.riskScore}</div>
        )}
      </div>
      <div className="mt-2 text-sm text-gray-300">{request.toolName}</div>
      <div className="mt-1 text-xs text-gray-500">{request.reason}</div>
      <pre className="mt-3 overflow-x-auto rounded-xl border border-orange-900/40 bg-gray-950 px-3 py-2 text-[11px] leading-5 text-gray-500">
        {JSON.stringify(request.toolArgs, null, 2)}
      </pre>
      {onDecide && (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => void onDecide(request.id, 'approved')}
            className="rounded-lg bg-emerald-900 px-3 py-2 text-xs font-medium text-emerald-100 hover:bg-emerald-800"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => void onDecide(request.id, 'rejected')}
            className="rounded-lg bg-red-900 px-3 py-2 text-xs font-medium text-red-100 hover:bg-red-800"
          >
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

export function CommandCenter({
  events,
  onAbortCommand,
  abortingRunId,
  pendingApprovals = [],
  onHitlDecision,
}: {
  events: CommandEventLike[];
  onAbortCommand: (runId: string) => Promise<void> | void;
  abortingRunId: string | null;
  pendingApprovals?: PendingApproval[];
  onHitlDecision?: (requestId: string, verdict: 'approved' | 'rejected') => Promise<void> | void;
}) {
  const commandRuns = buildCommandRuns(events);
  const [expandedRunIds, setExpandedRunIds] = useState<string[]>([]);

  const visibleExpandedRunIds = useMemo(() => {
    if (expandedRunIds.length > 0) return expandedRunIds;
    return commandRuns.filter((run, index) => run.active || index === 0).map((run) => run.id);
  }, [commandRuns, expandedRunIds]);

  if (commandRuns.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto px-6 py-8">
        <div className="rounded-2xl border border-gray-800 bg-gray-950/70 p-6 text-sm text-gray-500">
          Commands will show up here as structured runs once you send something to the agent.
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-6 py-5">
      <div className="space-y-4">
        {commandRuns.map((run) => {
          const expanded = visibleExpandedRunIds.includes(run.id);
          const attachedApprovals = run.active ? pendingApprovals : [];
          return (
            <section key={run.id} className="rounded-3xl border border-gray-800 bg-gray-950/70 p-5 shadow-[0_0_0_1px_rgba(255,255,255,0.01)]">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill status={run.status} />
                    <span className="text-xs text-gray-500">
                      {new Date(run.startedAt).toLocaleTimeString()} · {formatRelativeDuration(run.startedAt, run.finishedAt)}
                    </span>
                    {run.runId && (
                      <code className="rounded bg-gray-900 px-2 py-0.5 text-[10px] text-gray-500">
                        {run.runId}
                      </code>
                    )}
                  </div>
                  <h3 className="mt-3 text-base font-semibold text-gray-100">{run.command}</h3>
                  {run.currentActivity && (
                    <div className="mt-2 text-sm text-cyan-300">Current activity: {run.currentActivity}</div>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {run.active && run.stopTargetRunId && (
                    <button
                      type="button"
                      onClick={() => void onAbortCommand(run.stopTargetRunId!)}
                      disabled={abortingRunId === run.stopTargetRunId}
                      className="rounded-lg border border-red-900 bg-red-950 px-3 py-2 text-xs font-medium text-red-300 hover:bg-red-900/70 disabled:cursor-not-allowed disabled:opacity-60"
                      aria-label="Stop command"
                    >
                      {abortingRunId === run.stopTargetRunId ? 'Stopping…' : 'Stop command'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedRunIds((current) =>
                        current.includes(run.id)
                          ? current.filter((id) => id !== run.id)
                          : [...current, run.id],
                      )
                    }
                    className="rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-xs font-medium text-gray-300 hover:border-gray-700 hover:text-white"
                  >
                    {expanded ? 'Hide details' : 'View details'}
                  </button>
                </div>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-4">
                <div className="rounded-xl border border-gray-800 bg-gray-900/70 px-3 py-2">
                  <div className="text-[11px] uppercase tracking-wide text-gray-500">Tools</div>
                  <div className="mt-1 text-sm text-gray-100">{run.toolsUsed}</div>
                  {run.toolNames.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {run.toolNames.map((toolName) => (
                        <span key={toolName} className="rounded-full bg-gray-800 px-2 py-0.5 text-[11px] text-gray-300">
                          {toolName}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="rounded-xl border border-gray-800 bg-gray-900/70 px-3 py-2">
                  <div className="text-[11px] uppercase tracking-wide text-gray-500">Policy</div>
                  <div className="mt-1 text-sm text-gray-100">{run.approvals} approved</div>
                  <div className="text-xs text-gray-500">{run.blockers} blocked</div>
                </div>
                <div className="rounded-xl border border-gray-800 bg-gray-900/70 px-3 py-2">
                  <div className="text-[11px] uppercase tracking-wide text-gray-500">LLM Turns</div>
                  <div className="mt-1 text-sm text-gray-100">{run.llmTurns}</div>
                </div>
                <div className="rounded-xl border border-gray-800 bg-gray-900/70 px-3 py-2">
                  <div className="text-[11px] uppercase tracking-wide text-gray-500">Raw Events</div>
                  <div className="mt-1 text-sm text-gray-100">{run.rawEventCount}</div>
                </div>
              </div>

              {run.responseText && (
                <div className="mt-4 rounded-xl border border-emerald-950 bg-emerald-950/30 p-4">
                  <div className="text-[11px] uppercase tracking-wide text-emerald-400">Agent Reply</div>
                  <div className="mt-2 whitespace-pre-wrap text-sm leading-6 text-emerald-100">{run.responseText}</div>
                </div>
              )}

              {run.latestError && run.status !== 'completed' && (
                <div className="mt-4 rounded-xl border border-red-950 bg-red-950/30 p-4">
                  <div className="text-[11px] uppercase tracking-wide text-red-400">Latest Error</div>
                  <div className="mt-2 text-sm leading-6 text-red-100">{run.latestError}</div>
                </div>
              )}

              {expanded && (
                <div className="mt-5 space-y-4">
                  {attachedApprovals.length > 0 && (
                    <div className="space-y-3">
                      <div className="text-[11px] uppercase tracking-wide text-gray-500">Awaiting approval</div>
                      {attachedApprovals.map((request) => (
                        <ApprovalCard key={request.id} request={request} onDecide={onHitlDecision} />
                      ))}
                    </div>
                  )}

                  {run.steps.length > 0 && (
                    <div>
                      <div className="text-[11px] uppercase tracking-wide text-gray-500">Execution tree</div>
                      <div className="mt-3">
                        <StepTree steps={run.steps} />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
