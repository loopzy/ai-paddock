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
    running: 'bg-sky-100 text-sky-700 border-sky-200',
    completed: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    failed: 'bg-rose-100 text-rose-700 border-rose-200',
    aborted: 'bg-amber-100 text-amber-700 border-amber-200',
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
      ? 'bg-rose-500'
      : status === 'blocked'
        ? 'bg-amber-500'
        : status === 'running'
          ? 'bg-sky-500'
          : 'bg-emerald-400';
  return <span className={`mt-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-white ${styles}`} />;
}

function StepTree({
  steps,
  depth = 0,
}: {
  steps: CommandStep[];
  depth?: number;
}) {
  return (
    <div className={`space-y-4 ${depth > 0 ? 'border-l border-stone-200 pl-5' : ''}`}>
      {steps.map((step) => (
        <div key={step.id} className="relative">
          {depth > 0 && <span className="absolute -left-5 top-4 h-px w-4 bg-stone-200" />}
          <div className="flex gap-3">
            <StepTone status={step.status} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <div className="text-sm font-medium text-stone-900">{step.title}</div>
                <div className="text-[11px] text-stone-500">{new Date(step.timestamp).toLocaleTimeString()}</div>
              </div>
              {step.summary && (
                <div className="mt-1 whitespace-pre-wrap text-sm leading-6 text-stone-700">{step.summary}</div>
              )}
              {step.detail && (
                <div className="mt-3 whitespace-pre-wrap rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-[12px] leading-6 text-stone-600">
                  {step.detail}
                </div>
              )}
            </div>
          </div>
          {step.children.length > 0 && (
            <div className="mt-4">
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
    <div className="rounded-3xl border border-amber-200 bg-amber-50 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-sm font-semibold text-amber-800">Approval required</div>
        {typeof request.riskScore === 'number' && (
          <div className="rounded-full bg-white px-2 py-0.5 text-[11px] text-amber-700">Risk {request.riskScore}</div>
        )}
      </div>
      <div className="mt-2 text-sm text-stone-800">{request.toolName}</div>
      <div className="mt-1 text-xs text-stone-500">{request.reason}</div>
      <pre className="mt-3 overflow-x-auto rounded-2xl border border-amber-200 bg-white px-3 py-2 text-[11px] leading-5 text-stone-600">
        {JSON.stringify(request.toolArgs, null, 2)}
      </pre>
      {onDecide && (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => void onDecide(request.id, 'approved')}
            className="rounded-2xl bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-700"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => void onDecide(request.id, 'rejected')}
            className="rounded-2xl bg-rose-600 px-3 py-2 text-xs font-medium text-white hover:bg-rose-700"
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
        <div className="rounded-[28px] border border-stone-200 bg-white/80 p-6 text-sm text-stone-500 shadow-[0_12px_32px_rgba(80,60,30,0.06)]">
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
            <section key={run.id} className="rounded-[30px] border border-stone-200 bg-white/90 p-5 shadow-[0_18px_48px_rgba(80,60,30,0.08)]">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill status={run.status} />
                    <span className="text-xs text-stone-500">
                      {new Date(run.startedAt).toLocaleTimeString()} · {formatRelativeDuration(run.startedAt, run.finishedAt)}
                    </span>
                    {run.runId && (
                      <code className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] text-stone-500">
                        {run.runId}
                      </code>
                    )}
                  </div>
                  <h3 className="mt-3 text-base font-semibold text-stone-900">{run.command}</h3>
                  {run.currentActivity && (
                    <div className="mt-2 text-sm text-amber-700">Current activity: {run.currentActivity}</div>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {run.active && run.stopTargetRunId && (
                    <button
                      type="button"
                      onClick={() => void onAbortCommand(run.stopTargetRunId!)}
                      disabled={abortingRunId === run.stopTargetRunId}
                      className="rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
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
                    className="rounded-2xl border border-stone-200 bg-white px-3 py-2 text-xs font-medium text-stone-600 hover:border-stone-300 hover:text-stone-900"
                  >
                    {expanded ? 'Hide details' : 'View details'}
                  </button>
                </div>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-4">
                <div className="rounded-2xl border border-stone-200 bg-stone-50 px-3 py-3">
                  <div className="text-[11px] uppercase tracking-wide text-stone-500">Tools</div>
                  <div className="mt-1 text-sm text-stone-900">{run.toolsUsed}</div>
                  {run.toolNames.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {run.toolNames.map((toolName) => (
                        <span key={toolName} className="rounded-full bg-white px-2 py-0.5 text-[11px] text-stone-600 ring-1 ring-stone-200">
                          {toolName}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="rounded-2xl border border-stone-200 bg-stone-50 px-3 py-3">
                  <div className="text-[11px] uppercase tracking-wide text-stone-500">Policy</div>
                  <div className="mt-1 text-sm text-stone-900">{run.approvals} approved</div>
                  <div className="text-xs text-stone-500">{run.blockers} blocked</div>
                </div>
                <div className="rounded-2xl border border-stone-200 bg-stone-50 px-3 py-3">
                  <div className="text-[11px] uppercase tracking-wide text-stone-500">LLM Turns</div>
                  <div className="mt-1 text-sm text-stone-900">{run.llmTurns}</div>
                </div>
                <div className="rounded-2xl border border-stone-200 bg-stone-50 px-3 py-3">
                  <div className="text-[11px] uppercase tracking-wide text-stone-500">Raw Events</div>
                  <div className="mt-1 text-sm text-stone-900">{run.rawEventCount}</div>
                </div>
              </div>

              {run.responseText && (
                <div className="mt-4 rounded-[24px] border border-emerald-200 bg-emerald-50 p-4">
                  <div className="text-[11px] uppercase tracking-wide text-emerald-700">Agent Reply</div>
                  <div className="mt-2 whitespace-pre-wrap text-sm leading-6 text-emerald-900">{run.responseText}</div>
                </div>
              )}

              {run.latestError && run.status !== 'completed' && (
                <div className="mt-4 rounded-[24px] border border-rose-200 bg-rose-50 p-4">
                  <div className="text-[11px] uppercase tracking-wide text-rose-700">Latest Error</div>
                  <div className="mt-2 text-sm leading-6 text-rose-900">{run.latestError}</div>
                </div>
              )}

              {expanded && (
                <div className="mt-5 space-y-4">
                  {attachedApprovals.length > 0 && (
                    <div className="space-y-3">
                      <div className="text-[11px] uppercase tracking-wide text-stone-500">Awaiting approval</div>
                      {attachedApprovals.map((request) => (
                        <ApprovalCard key={request.id} request={request} onDecide={onHitlDecision} />
                      ))}
                    </div>
                  )}

                  {run.steps.length > 0 && (
                    <div>
                      <div className="text-[11px] uppercase tracking-wide text-stone-500">Execution tree</div>
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
