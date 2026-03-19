import { useMemo, useState } from 'react';
import { buildCommandRuns, type CommandEventLike, type CommandStep, type CommandTag } from '../command-groups.js';
import { MarkdownContent } from './MarkdownContent.js';

interface PendingApproval {
  id: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  reason: string;
  timestamp: number;
  riskScore?: number;
  triggeredRules?: string[];
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function formatRelativeDuration(startedAt: number, finishedAt?: number): string {
  const deltaMs = Math.max(0, (finishedAt ?? Date.now()) - startedAt);
  if (deltaMs < 1000) return `${deltaMs}ms`;
  if (deltaMs < 60_000) return `${(deltaMs / 1000).toFixed(1)}s`;
  return `${(deltaMs / 60_000).toFixed(1)}m`;
}

function formatCompactCount(value: number): string {
  if (value >= 1000) {
    const compact = value / 1000;
    return compact >= 10 ? `${compact.toFixed(0)}k` : `${compact.toFixed(1)}k`;
  }
  return String(value);
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

function StepKindPill({ kind }: { kind: CommandStep['kind'] }) {
  const tone: Record<CommandStep['kind'], string> = {
    'llm-request': 'bg-sky-100 text-sky-700 border-sky-200',
    'tool-intent': 'bg-violet-100 text-violet-700 border-violet-200',
    'llm-response': 'bg-blue-100 text-blue-700 border-blue-200',
    'gate-verdict': 'bg-amber-100 text-amber-700 border-amber-200',
    'tool-result': 'bg-emerald-100 text-emerald-700 border-emerald-200',
    'agent-message': 'bg-emerald-100 text-emerald-700 border-emerald-200',
    'agent-error': 'bg-rose-100 text-rose-700 border-rose-200',
    'command-status': 'bg-stone-100 text-stone-700 border-stone-200',
    system: 'bg-stone-100 text-stone-700 border-stone-200',
  };
  const label: Record<CommandStep['kind'], string> = {
    'llm-request': 'LLM turn',
    'llm-response': 'LLM reply',
    'tool-intent': 'Tool',
    'gate-verdict': 'Policy',
    'tool-result': 'Result',
    'agent-message': 'Reply',
    'agent-error': 'Error',
    'command-status': 'Status',
    system: 'System',
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${tone[kind]}`}>
      {label[kind]}
    </span>
  );
}

function TagPill({ tag }: { tag: CommandTag }) {
  const tone = tag.tone ?? 'neutral';
  const styles: Record<NonNullable<CommandTag['tone']>, string> = {
    neutral: 'bg-stone-100 text-stone-600 border-stone-200',
    info: 'bg-sky-100 text-sky-700 border-sky-200',
    success: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    warning: 'bg-amber-100 text-amber-700 border-amber-200',
    danger: 'bg-rose-100 text-rose-700 border-rose-200',
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${styles[tone]}`}>
      {tag.label}
    </span>
  );
}

function ExpandableRaw({
  label = 'Raw content',
  content,
  meta,
}: {
  label?: string;
  content?: string;
  meta?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!content) return null;
  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="rounded-full border border-stone-200 bg-white px-3 py-1 text-[11px] font-medium text-stone-500 transition hover:border-stone-300 hover:text-stone-900"
        >
          {open ? `Hide ${label}` : `Show ${label}`}
        </button>
        {meta && <div className="text-[11px] text-stone-500">{meta}</div>}
      </div>
      {open && (
        <pre className="mt-3 overflow-x-auto rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-[11px] leading-5 text-stone-600">
          {content}
        </pre>
      )}
    </div>
  );
}

function ExpandableMarkdown({
  content,
  previewChars = 420,
}: {
  content: string;
  previewChars?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const trimmed = content.trim();
  const shouldCollapse = trimmed.length > previewChars;
  const preview = shouldCollapse ? `${trimmed.slice(0, previewChars).trimEnd()}…` : trimmed;

  return (
    <div>
      <MarkdownContent content={expanded || !shouldCollapse ? trimmed : preview} />
      {shouldCollapse && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="rounded-full border border-stone-200 bg-white px-3 py-1 text-[11px] font-medium text-stone-500 transition hover:border-stone-300 hover:text-stone-900"
          >
            {expanded ? 'Collapse full reply' : 'Expand full reply'}
          </button>
        </div>
      )}
    </div>
  );
}

function StepCard({ step, depth }: { step: CommandStep; depth: number }) {
  const showSummary = Boolean(step.summary && (!step.body || collapseWhitespace(step.summary) !== collapseWhitespace(step.body)));
  const showDetail =
    Boolean(step.detail) &&
    step.kind !== 'llm-request' &&
    step.kind !== 'agent-message' &&
    (!step.body || collapseWhitespace(step.detail!) !== collapseWhitespace(step.body));
  const titleClass = depth === 0 ? 'text-sm' : 'text-[13px]';
  const summaryClass = depth === 0 ? 'text-sm leading-6' : 'text-[13px] leading-6';
  return (
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-2">
        <StepKindPill kind={step.kind} />
        <div className={`${titleClass} font-medium text-stone-900`}>{step.title}</div>
        {step.meta && <div className="text-[11px] text-stone-500">{step.meta}</div>}
        <div className="text-[11px] text-stone-500">{new Date(step.timestamp).toLocaleTimeString()}</div>
      </div>
      {step.tags && step.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {step.tags.map((tag, index) => (
            <TagPill key={`${tag.label}-${index}`} tag={tag} />
          ))}
        </div>
      )}
      {showSummary && step.summary && (
        <div className={`mt-2 whitespace-pre-wrap ${summaryClass} text-stone-700`}>{step.summary}</div>
      )}
      {step.body && (
        <div className="mt-3 whitespace-pre-wrap rounded-[22px] border border-stone-200 bg-white px-4 py-3 text-sm leading-7 text-stone-900 shadow-[0_6px_18px_rgba(80,60,30,0.05)]">
          <ExpandableMarkdown content={step.body} />
        </div>
      )}
      {showDetail && step.detail && (
        <div className="mt-3 rounded-[20px] border border-stone-200 bg-stone-50 px-4 py-3 text-[12px] leading-6 text-stone-600">
          <div className="whitespace-pre-wrap">{step.detail}</div>
        </div>
      )}
      <ExpandableRaw label={step.rawLabel ?? 'Raw content'} content={step.rawDetail} />
    </div>
  );
}

function StepTree({
  steps,
  depth = 0,
}: {
  steps: CommandStep[];
  depth?: number;
}) {
  return (
    <div className={`space-y-4 ${depth === 0 ? 'border-l border-dashed border-stone-200 pl-5' : 'border-l border-dashed border-stone-200 pl-5'}`}>
      {steps.map((step) => (
        <div key={step.id} className="relative">
          {depth > 0 && <span className="absolute -left-5 top-4 h-px w-4 bg-stone-200" />}
          <div className="flex gap-3">
            <StepTone status={step.status} />
            <StepCard step={step} depth={depth} />
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

function collectRunHighlights(steps: CommandStep[]): CommandTag[] {
  const queue = [...steps];
  const tags: CommandTag[] = [];
  const seen = new Set<string>();

  while (queue.length > 0 && tags.length < 6) {
    const step = queue.shift()!;
    for (const tag of step.tags ?? []) {
      const key = `${tag.tone ?? 'neutral'}:${tag.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tags.push(tag);
      if (tags.length >= 6) break;
    }
    queue.push(...step.children);
  }

  return tags;
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
      <ExpandableRaw label="Request payload" content={JSON.stringify(request.toolArgs, null, 2)} />
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
  const [expandedRunIds, setExpandedRunIds] = useState<string[] | null>(null);

  const visibleExpandedRunIds = useMemo(() => {
    if (expandedRunIds) return expandedRunIds;
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
          const runHighlights = collectRunHighlights(run.steps);
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
                  {run.active && run.currentActivity && (
                    <div className="mt-2 text-sm text-amber-700">Current activity: {run.currentActivity}</div>
                  )}
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-stone-500">
                    <span>{run.toolsUsed} tools</span>
                    <span>•</span>
                    <span>{run.llmTurns} LLM turns</span>
                    {run.totalTokens > 0 && (
                      <>
                        <span>•</span>
                        <span>{formatCompactCount(run.totalTokensIn)} in</span>
                        <span>•</span>
                        <span>{formatCompactCount(run.totalTokensOut)} out</span>
                      </>
                    )}
                    {run.blockers > 0 && (
                      <>
                        <span>•</span>
                        <span>{run.blockers} blocked</span>
                      </>
                    )}
                  </div>
                  {runHighlights.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {runHighlights.map((tag, index) => (
                        <TagPill key={`${tag.label}-${index}`} tag={tag} />
                      ))}
                    </div>
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
                      setExpandedRunIds((current) => {
                        const base = current ?? commandRuns.filter((candidate, index) => candidate.active || index === 0).map((candidate) => candidate.id);
                        return base.includes(run.id)
                          ? base.filter((id) => id !== run.id)
                          : [...base, run.id];
                      })
                    }
                    className="rounded-2xl border border-stone-200 bg-white px-3 py-2 text-xs font-medium text-stone-600 hover:border-stone-300 hover:text-stone-900"
                  >
                    {expanded ? 'Hide details' : 'View details'}
                  </button>
                </div>
              </div>

              {attachedApprovals.length > 0 && (
                <div className="mt-4 space-y-3">
                  {attachedApprovals.map((request) => (
                    <ApprovalCard key={request.id} request={request} onDecide={onHitlDecision} />
                  ))}
                </div>
              )}

              {run.responseText && (
                <div className="mt-4 rounded-[24px] border border-emerald-200 bg-emerald-50 p-4">
                  <div className="text-[11px] uppercase tracking-wide text-emerald-700">Agent Reply</div>
                  <div className="mt-2 text-sm leading-7 text-emerald-950">
                    <ExpandableMarkdown content={run.responseText} previewChars={520} />
                  </div>
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
