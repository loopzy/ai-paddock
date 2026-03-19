import { useState, useEffect, useRef, useCallback } from 'react';
import { CommandCenter } from './components/CommandCenter.js';
import { DeployPipeline } from './components/DeployPipeline.js';
import { EventTimeline } from './components/EventTimeline.js';
import { ErrorBanner } from './components/ErrorBanner.js';
import { VMPanel } from './components/VMPanel.js';
import { LLMConfigPanel } from './components/LLMConfigPanel.js';
import { buildCommandRuns } from './command-groups.js';
import { getAgentLifecycleState, getCommandInputState, hasSessionError, isAgentDeploying, isAgentReady, isSandboxReady } from './ui-state.js';

// ─── Types ───
interface PaddockEvent {
  id: string;
  sessionId: string;
  seq: number;
  timestamp: number;
  type: string;
  payload: Record<string, unknown>;
  correlationId?: string;
  causedBy?: string;
}

type SandboxType = 'simple-box' | 'computer-box' | 'cua';

interface SessionSummary {
  id: string;
  status: string;
  displayStatus?: 'starting' | 'ready' | 'paused' | 'stopped' | 'error';
  agentType: string;
  sandboxType: string;
  createdAt: number;
  updatedAt?: number;
  vmId?: string;
}

interface HealthWarning {
  type: string;
  message: string;
  hint: string;
  envHints?: Record<string, string>;
}

interface AgentLLMConfig {
  provider: string;
  model: string;
}

interface LLMModelOption {
  id: string;
  label: string;
  description: string;
}

interface LLMProviderOption {
  id: string;
  label: string;
  description: string;
  envKeys: string[];
  defaultModel: string;
  configured: boolean;
  models: LLMModelOption[];
}

interface HealthResponse {
  warnings: HealthWarning[];
  llmProviders?: string[];
  agentDefaults?: AgentLLMConfig;
  llmCatalog?: {
    providers: LLMProviderOption[];
  };
}

interface PendingApproval {
  id: string;
  sessionId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  reason: string;
  timestamp: number;
  riskScore?: number;
  triggeredRules?: string[];
}

const SESSION_LABELS_KEY = 'paddock.session.labels.v1';

function loadSessionLabels(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(SESSION_LABELS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0),
    );
  } catch {
    return {};
  }
}

function saveSessionLabels(labels: Record<string, string>) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(SESSION_LABELS_KEY, JSON.stringify(labels));
}

function sessionLabelIndex(labels: Record<string, string>): number {
  return Object.values(labels).reduce((max, label) => {
    const match = /^Session (\d+)$/.exec(label.trim());
    if (!match) return max;
    return Math.max(max, Number(match[1]));
  }, 0);
}

// ─── WebSocket Hook ───
function useEventStream(sessionId: string | null) {
  const [events, setEvents] = useState<PaddockEvent[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setEvents([]);
      return;
    }
    fetch(`/api/sessions/${sessionId}/events`)
      .then((r) => r.json())
      .then((data) => setEvents(data))
      .catch(console.error);

    const ws = new WebSocket(`ws://${location.host}/ws/sessions/${sessionId}`);
    ws.onmessage = (e) => {
      const event = JSON.parse(e.data) as PaddockEvent;
      setEvents((prev) => [...prev, event]);
    };
    wsRef.current = ws;
    return () => ws.close();
  }, [sessionId]);

  const sendCommand = useCallback(
    (command: string) => { wsRef.current?.send(JSON.stringify({ type: 'user.command', command })); },
    [],
  );

  return { events, sendCommand };
}

// ─── Small Shared Components ───

function SandboxSelector({ value, onChange }: { value: SandboxType; onChange: (v: SandboxType) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as SandboxType)}
      className="w-full min-w-0 rounded-2xl border border-stone-300 bg-white px-3 py-3 text-xs text-stone-800 shadow-sm" aria-label="Select sandbox type">
      <option value="simple-box">Simple Box (Headless Ubuntu 22.04)</option>
      <option value="computer-box">Computer Box (GUI Ubuntu XFCE Desktop)</option>
      <option value="cua" disabled>CUA (macOS) — Coming Soon</option>
    </select>
  );
}

function AgentSelector({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className="w-full min-w-0 rounded-2xl border border-stone-300 bg-white px-3 py-2 text-xs text-stone-800 shadow-sm" aria-label="Select agent type">
      <option value="openclaw">OpenClaw (auto-install)</option>
    </select>
  );
}

function CommandInput({
  onSend,
  disabled,
  hint,
  onStop,
  stopping,
}: {
  onSend: (cmd: string) => void;
  disabled: boolean;
  hint: string;
  onStop?: () => void;
  stopping?: boolean;
}) {
  const [value, setValue] = useState('');
  const submit = () => { if (disabled || !value.trim()) return; onSend(value.trim()); setValue(''); };
  return (
    <div className="border-t border-stone-200 bg-stone-50/80">
      <div className="flex gap-2 p-4">
        <input
          className="flex-1 rounded-2xl border border-stone-300 bg-white px-4 py-3 text-sm text-stone-900 shadow-sm outline-none transition focus:border-amber-400 focus:ring-2 focus:ring-amber-200 disabled:cursor-not-allowed disabled:bg-stone-100 disabled:text-stone-400"
          placeholder={disabled ? hint : 'Send command to agent...'}
          value={value}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <button
          onClick={submit}
          disabled={disabled}
          className="rounded-2xl bg-amber-500 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-amber-600 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-500"
        >
          Send
        </button>
        {onStop && (
          <button
            type="button"
            onClick={onStop}
            disabled={stopping}
            className="rounded-2xl border border-rose-300 bg-white px-4 py-2 text-sm font-medium text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {stopping ? 'Stopping…' : 'Stop Current'}
          </button>
        )}
      </div>
      {disabled && <div className="px-4 pb-3 text-[11px] text-stone-500">{hint}</div>}
    </div>
  );
}

function getSessionDisplayStatus(session: SessionSummary): NonNullable<SessionSummary['displayStatus']> {
  if (session.displayStatus) return session.displayStatus;
  switch (session.status) {
    case 'running':
      return 'ready';
    case 'created':
      return 'starting';
    case 'paused':
      return 'paused';
    case 'terminated':
      return 'stopped';
    case 'error':
      return 'error';
    default:
      return 'starting';
  }
}

function formatSessionStatus(session: SessionSummary): string {
  switch (getSessionDisplayStatus(session)) {
    case 'ready':
      return 'Ready';
    case 'starting':
      return 'Starting';
    case 'paused':
      return 'Paused';
    case 'stopped':
      return 'Stopped';
    case 'error':
      return 'Error';
    default:
      return 'Starting';
  }
}

function sortSessions(sessions: SessionSummary[]): SessionSummary[] {
  const order = new Map([
    ['running', 0],
    ['created', 1],
    ['paused', 2],
    ['error', 3],
    ['terminated', 4],
  ]);
  return [...sessions].sort((left, right) => {
    const leftRank = order.get(left.status) ?? 99;
    const rightRank = order.get(right.status) ?? 99;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return (right.updatedAt ?? right.createdAt) - (left.updatedAt ?? left.createdAt);
  });
}

function CreateSandboxModal({
  open,
  sandboxType,
  creating,
  createError,
  onSandboxTypeChange,
  onCreate,
  onClose,
}: {
  open: boolean;
  sandboxType: SandboxType;
  creating: boolean;
  createError: string | null;
  onSandboxTypeChange: (value: SandboxType) => void;
  onCreate: () => void;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-stone-900/20 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-sandbox-title"
        className="w-full max-w-md rounded-[28px] border border-stone-200 bg-white p-6 shadow-[0_24px_80px_rgba(80,60,30,0.16)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="create-sandbox-title" className="text-lg font-semibold text-stone-900">Create sandbox</h2>
            <p className="mt-1 text-sm text-stone-500">Choose the VM first. Deploy the agent after the session is ready.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full border border-stone-200 px-3 py-1 text-sm text-stone-500 transition hover:border-stone-300 hover:text-stone-900" aria-label="Close create sandbox dialog">
            ×
          </button>
        </div>
        <div className="mt-5 space-y-4">
          <div>
            <label className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-500">Sandbox type</label>
            <SandboxSelector value={sandboxType} onChange={onSandboxTypeChange} />
          </div>
          {createError && (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {createError}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-2xl border border-stone-200 px-4 py-2 text-sm text-stone-600 transition hover:bg-stone-50">
              Cancel
            </button>
            <button type="button" onClick={onCreate} disabled={creating} className="rounded-2xl bg-amber-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-amber-600 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-500">
              {creating ? 'Creating…' : 'Create sandbox'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SessionSidebar({
  sessions,
  selectedSessionId,
  sessionLabels,
  collapsed,
  onOpenCreateModal,
  onSelectSession,
  onRenameSession,
  onToggleCollapsed,
}: {
  sessions: SessionSummary[];
  selectedSessionId: string | null;
  sessionLabels: Record<string, string>;
  collapsed: boolean;
  onOpenCreateModal: () => void;
  onSelectSession: (session: SessionSummary) => void;
  onRenameSession: (sessionId: string, label: string) => void;
  onToggleCollapsed: () => void;
}) {
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState('');
  const sortedSessions = sortSessions(sessions);
  const liveSessions = sortedSessions.filter((session) => !['terminated', 'error'].includes(session.status));

  const startRename = (sessionId: string) => {
    setEditingSessionId(sessionId);
    setDraftLabel(sessionLabels[sessionId] ?? '');
  };

  const commitRename = () => {
    if (!editingSessionId) return;
    const next = draftLabel.trim();
    if (next) onRenameSession(editingSessionId, next);
    setEditingSessionId(null);
  };

  if (collapsed) {
    return (
      <aside className="flex w-16 shrink-0 flex-col items-center gap-2 border-r border-stone-200 bg-stone-50 px-2 py-4">
        <button type="button" onClick={onToggleCollapsed} className="flex h-9 w-9 items-center justify-center rounded-full border border-stone-200 bg-white text-stone-500 transition hover:border-stone-300 hover:text-stone-900" aria-label="Expand sidebar">
          »
        </button>
        <button type="button" onClick={onOpenCreateModal} className="flex h-9 w-9 items-center justify-center rounded-full bg-amber-500 text-lg font-semibold text-white transition hover:bg-amber-600" aria-label="Create sandbox">
          +
        </button>
        <div className="flex flex-1 flex-col gap-2 overflow-y-auto">
          {liveSessions.map((session) => {
            const active = session.id === selectedSessionId;
            return (
              <button
                key={session.id}
                type="button"
                onClick={() => onSelectSession(session)}
                className={`flex h-10 w-10 items-center justify-center rounded-2xl border text-[10px] font-semibold ${
                  active ? 'border-amber-300 bg-amber-100 text-amber-900' : 'border-stone-200 bg-white text-stone-500 hover:border-stone-300 hover:text-stone-900'
                }`}
                aria-label={`${sessionLabels[session.id] ?? session.id} (${session.id})`}
                title={`${sessionLabels[session.id] ?? session.id} · ${session.id} · ${formatSessionStatus(session)}`}
              >
                {session.sandboxType === 'computer-box' ? 'GUI' : 'UB'}
              </button>
            );
          })}
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex w-[244px] shrink-0 flex-col border-r border-stone-200 bg-stone-50/95 min-h-0">
      <div className="border-b border-stone-200 px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-stone-700">Sandboxes</h2>
            <p className="mt-1 text-[10px] leading-4 text-stone-500">Switch VMs without losing context.</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onOpenCreateModal} className="flex h-8 w-8 items-center justify-center rounded-full bg-amber-500 text-base font-semibold text-white transition hover:bg-amber-600" aria-label="Create sandbox">
              +
            </button>
            <button type="button" onClick={onToggleCollapsed} className="flex h-8 w-8 items-center justify-center rounded-full border border-stone-200 bg-white text-stone-500 transition hover:border-stone-300 hover:text-stone-900" aria-label="Collapse sidebar">
              «
            </button>
          </div>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3">
        <div className="space-y-2">
          {liveSessions.map((session) => {
            const active = session.id === selectedSessionId;
            const displayStatus = getSessionDisplayStatus(session);
            const statusTone =
              displayStatus === 'ready'
                ? 'bg-emerald-500'
                : displayStatus === 'error'
                  ? 'bg-rose-500'
                  : displayStatus === 'stopped'
                    ? 'bg-stone-400'
                    : 'bg-amber-500';
            const displayLabel = sessionLabels[session.id] ?? session.id;
            return (
              <div key={session.id} className={`rounded-[24px] border transition ${active ? 'border-amber-300 bg-white shadow-[0_8px_24px_rgba(120,90,30,0.08)]' : 'border-stone-200 bg-white/85 hover:border-stone-300 hover:bg-white'}`}>
                <div className="px-3 py-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className={`h-2.5 w-2.5 rounded-full ${statusTone}`} />
                      <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[9px] font-medium text-stone-600">{formatSessionStatus(session)}</span>
                    </div>
                    <button type="button" onClick={() => startRename(session.id)} className="rounded-full border border-stone-200 px-2.5 py-1 text-[9px] text-stone-500 transition hover:border-stone-300 hover:text-stone-900" aria-label="Rename session">
                      Rename
                    </button>
                  </div>
                  <button type="button" onClick={() => onSelectSession(session)} className="min-w-0 flex-1 text-left" aria-label={`${displayLabel} (${session.id})`}>
                    <div className="mt-2 min-w-0">
                      {editingSessionId === session.id ? (
                        <input
                          autoFocus
                          value={draftLabel}
                          onChange={(event) => setDraftLabel(event.target.value)}
                          onBlur={commitRename}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') commitRename();
                            if (event.key === 'Escape') setEditingSessionId(null);
                          }}
                          className="w-full rounded-lg border border-stone-300 bg-stone-50 px-2 py-1 text-xs font-semibold text-stone-900 outline-none focus:border-amber-400"
                          aria-label={`Rename ${session.id}`}
                        />
                      ) : (
                        <div className="truncate text-[13px] font-semibold text-stone-900">{displayLabel}</div>
                      )}
                      <div className="mt-1 truncate text-[9px] tracking-wide text-stone-500">{session.id}</div>
                      <div className="mt-2 text-[9px] text-stone-500">
                        {session.sandboxType === 'computer-box' ? 'GUI Ubuntu' : 'Headless Ubuntu'}
                      </div>
                    </div>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        {sortedSessions.length === 0 && <div className="mt-3 rounded-2xl border border-dashed border-stone-300 px-4 py-5 text-xs text-stone-500">No sessions yet. Create one to start.</div>}
      </div>
    </aside>
  );
}

function ConfigBanner({ warnings }: { warnings: HealthWarning[] }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || warnings.length === 0) return null;
  return (
    <div className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-1">
          {warnings.map((w, i) => (
            <div key={i}>
              <span className="font-medium">{w.message}</span>
              <span className="ml-2 text-amber-700">{w.hint}</span>
              {w.envHints && Object.keys(w.envHints).length > 0 && (
                <div className="mt-1 text-amber-700">
                  {Object.entries(w.envHints).map(([key, url]) => (
                    <span key={key} className="mr-3">
                      <code className="rounded bg-amber-100 px-1">{key}</code>
                      {url && <> — <a href={url} target="_blank" rel="noreferrer" className="underline hover:text-amber-900">{url}</a></>}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        <button onClick={() => setDismissed(true)} className="shrink-0 text-amber-700 hover:text-amber-950" aria-label="Dismiss">x</button>
      </div>
    </div>
  );
}

// ─── Security Alert Panel ───
function SecurityPanel({ events }: { events: PaddockEvent[] }) {
  const alerts = events.filter(e => e.type === 'amp.gate.verdict' && (e.payload.riskScore as number) > 30);
  if (alerts.length === 0) return null;
  return (
    <div className="border-b border-stone-200 bg-white px-4 py-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-sm font-bold text-amber-800">Security Alerts</span>
        <span className="text-xs text-stone-500">({alerts.length})</span>
      </div>
      <div className="space-y-1 max-h-24 overflow-y-auto">
        {alerts.slice(-5).map(a => (
          <div key={a.id} className="text-xs flex items-center gap-2">
            <span className={`${(a.payload.riskScore as number) > 70 ? 'text-rose-600' : 'text-amber-700'} text-xs font-mono`}>[{a.payload.riskScore as number}]</span>
            <span className="text-stone-700">{a.payload.toolName as string}</span>
            <span className="text-stone-500">{(a.payload.triggeredRules as string[])?.join(', ')}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Agent Deploy Panel ───
function AgentPanel({
  sessionId,
  events,
  health,
}: {
  sessionId: string;
  events: PaddockEvent[];
  health: HealthResponse | null;
}) {
  const [agentType, setAgentType] = useState('openclaw');
  const [deploying, setDeploying] = useState(false);
  const [preflightWarning, setPreflightWarning] = useState<string | null>(null);
  const agentLifecycle = getAgentLifecycleState(events);
  const agentReady = agentLifecycle === 'ready';
  const hasError = hasSessionError(events);
  const agentDeploying = isAgentDeploying(events);

  const defaultProvider = health?.agentDefaults?.provider ?? 'openrouter';
  const defaultModel = health?.agentDefaults?.model ?? '';

  useEffect(() => { if (agentReady || hasError) setDeploying(false); }, [agentReady, hasError]);

  if (agentReady) return null;

  if (deploying || agentDeploying) {
    return (
      <div className="border-b border-stone-200 bg-white px-4 py-3">
        <div className="mb-2 text-xs text-stone-500">Deploying Agent...</div>
        <DeployPipeline events={events.filter(e =>
          (e.type === 'amp.session.start' && (e.payload.phase as string).startsWith('agent')) ||
          (e.type === 'session.status' && e.payload.status === 'error')
        )} />
      </div>
    );
  }

  const deployAgent = async () => {
    // Preflight check
    if (health?.warnings?.some((w: HealthWarning) => w.type === 'no_llm_keys')) {
      setPreflightWarning('No LLM API keys configured. Agent will not be able to call LLMs.');
    } else {
      setPreflightWarning(null);
    }
    setDeploying(true);
    await fetch(`/api/sessions/${sessionId}/deploy-agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType }),
    });
  };

  return (
    <div className="border-b border-stone-200 bg-white px-4 py-3">
      {preflightWarning && (
        <div className="mb-2 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{preflightWarning}</div>
      )}
      <div className="flex items-center gap-3 overflow-x-auto whitespace-nowrap">
        <AgentSelector value={agentType} onChange={setAgentType} />
        <button
          onClick={deployAgent}
          className="rounded-2xl bg-amber-500 px-5 py-2 text-xs font-medium text-white transition hover:bg-amber-600 min-w-[8rem] shrink-0"
        >
          Deploy Agent
        </button>
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[10px] font-medium text-amber-800">
            {defaultModel || 'default model'}
          </span>
          <span className="inline-flex items-center rounded-full border border-stone-200 bg-stone-50 px-2.5 py-1 text-[10px] font-medium text-stone-600">
            {defaultProvider}
          </span>
          <span className="inline-flex items-center rounded-full border border-stone-200 bg-white px-2.5 py-1 text-[10px] font-medium text-stone-500">
            Sidecar localhost:8801
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── App ───
export function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [draftSandboxType, setDraftSandboxType] = useState<SandboxType>('simple-box');
  const [deploying, setDeploying] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionLabels, setSessionLabels] = useState<Record<string, string>>(() => loadSessionLabels());
  const [healthWarnings, setHealthWarnings] = useState<HealthWarning[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'commands' | 'logs' | 'vm'>('commands');
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [abortingRunId, setAbortingRunId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const { events, sendCommand } = useEventStream(sessionId);

  const refreshSessions = useCallback(() => {
    fetch('/api/sessions')
      .then(r => r.json())
      .then((nextSessions: SessionSummary[]) => {
        setSessions(nextSessions);
        if (sessionId && !nextSessions.some((session) => session.id === sessionId)) {
          setSessionId(null);
        }
      })
      .catch(console.error);
  }, [sessionId]);

  const fetchHealth = useCallback(() => {
    fetch('/api/health').then(r => r.json()).then((data: HealthResponse) => {
      setHealth(data);
      setHealthWarnings(data.warnings ?? []);
    }).catch(() => {
      setHealthWarnings([{ type: 'unreachable', message: 'Cannot reach control plane.', hint: 'Is the server running? Check port 3100.' }]);
    });
  }, []);

  useEffect(() => {
    refreshSessions();
    fetchHealth();
  }, [fetchHealth, refreshSessions]);

  useEffect(() => {
    setSessionLabels((current) => {
      const next = { ...current };
      let counter = sessionLabelIndex(current);
      let changed = false;
      for (const session of sortSessions(sessions)) {
        if (!next[session.id]) {
          counter += 1;
          next[session.id] = `Session ${counter}`;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [sessions]);

  useEffect(() => {
    saveSessionLabels(sessionLabels);
  }, [sessionLabels]);

  useEffect(() => {
    const interval = setInterval(() => {
      refreshSessions();
    }, 5000);
    return () => clearInterval(interval);
  }, [refreshSessions]);

  useEffect(() => {
    const lastEvent = events.at(-1);
    if (!sessionId || !lastEvent) return;
    if (['session.status', 'amp.agent.ready', 'amp.agent.exit', 'amp.session.start'].includes(lastEvent.type)) {
      const timer = window.setTimeout(() => {
        refreshSessions();
      }, 300);
      return () => window.clearTimeout(timer);
    }
  }, [events, refreshSessions, sessionId]);

  useEffect(() => {
    if (!sessionId) {
      setPendingApprovals([]);
      return;
    }

    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`/api/sessions/${sessionId}/hitl/pending`);
        const data = await response.json();
        if (!cancelled) {
          setPendingApprovals(Array.isArray(data) ? data as PendingApproval[] : []);
        }
      } catch {
        if (!cancelled) {
          setPendingApprovals([]);
        }
      }
    };

    void poll();
    const interval = setInterval(() => void poll(), 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [sessionId]);

  const createSession = async () => {
    setDeploying(true);
    setCreateError(null);
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentType: 'none', sandboxType: draftSandboxType, autoStart: true }),
      });
      if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
      const session = await res.json();
      setSessionId(session.id);
      setSessions(prev => [session, ...prev.filter((existing) => existing.id !== session.id)]);
      setSessionLabels((current) => {
        if (current[session.id]) return current;
        return {
          ...current,
          [session.id]: `Session ${sessionLabelIndex(current) + 1}`,
        };
      });
      setActiveTab('commands');
      setShowCreateModal(false);
    } catch (err) {
      setCreateError((err as Error).message);
      setDeploying(false);
    }
  };

  const sandboxReady = isSandboxReady(events);
  const hasError = hasSessionError(events);
  const agentReady = isAgentReady(events);
  const commandState = getCommandInputState(events);
  const commandRuns = buildCommandRuns(events);
  const activeCommand = commandRuns.find((run) => run.active && run.stopTargetRunId);
  const selectedSession = sessions.find((session) => session.id === sessionId) ?? null;
  useEffect(() => { if (sandboxReady || hasError) setDeploying(false); }, [sandboxReady, hasError]);

  const killSession = async () => {
    if (!sessionId) return;
    await fetch(`/api/sessions/${sessionId}/kill`, { method: 'POST' });
    setSessionId(null);
    setAbortingRunId(null);
    refreshSessions();
  };

  const handleHITLDecision = async (requestId: string, verdict: 'approved' | 'rejected') => {
    if (!sessionId) return;
    await fetch(`/api/sessions/${sessionId}/hitl`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, verdict }),
    });
  };

  const handleAbortCommand = async (runId: string) => {
    if (!sessionId) return;
    setAbortingRunId(runId);
    try {
      await fetch(`/api/sessions/${sessionId}/commands/abort`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId }),
      });
    } finally {
      setAbortingRunId(null);
    }
  };

  const openSession = (session: SessionSummary) => {
    setSessionId(session.id);
    setDeploying(false);
    setCreateError(null);
    setDraftSandboxType(session.sandboxType as SandboxType);
    setActiveTab('commands');
  };

  const handleRenameSession = (targetSessionId: string, label: string) => {
    setSessionLabels((current) => ({
      ...current,
      [targetSessionId]: label,
    }));
  };

  const lastGate = [...events].reverse().find(e => e.type === 'amp.gate.verdict');
  const trustScore = lastGate ? 100 - (lastGate.payload.riskScore as number ?? 0) : 100;

  const currentSandboxType = (selectedSession?.sandboxType as SandboxType | undefined) ?? draftSandboxType;
  const vmTabLabel = currentSandboxType === 'computer-box' ? 'Desktop' : 'Terminal';

  return (
    <div className="flex h-screen flex-col bg-[radial-gradient(circle_at_top_left,_rgba(245,158,11,0.14),_transparent_32%),linear-gradient(180deg,_#f7f4ec_0%,_#f3efe5_100%)] text-stone-900">
      <CreateSandboxModal
        open={showCreateModal}
        sandboxType={draftSandboxType}
        creating={deploying}
        createError={createError}
        onSandboxTypeChange={setDraftSandboxType}
        onCreate={createSession}
        onClose={() => {
          setShowCreateModal(false);
          setCreateError(null);
        }}
      />
      {showConfigModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/20 backdrop-blur-sm" onClick={() => setShowConfigModal(false)}>
          <div className="mx-4 w-full max-w-lg rounded-[28px] border border-stone-200 bg-white p-6 shadow-[0_24px_80px_rgba(80,60,30,0.16)]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-stone-900">Configure LLM Providers</h2>
              <button
                onClick={() => setShowConfigModal(false)}
                className="text-2xl leading-none text-stone-500 hover:text-stone-800"
              >
                ×
              </button>
            </div>
            <LLMConfigPanel
              providers={health?.llmCatalog?.providers ?? []}
              onConfigured={() => {
                fetchHealth();
                setShowConfigModal(false);
              }}
            />
          </div>
        </div>
      )}

      <header className="flex items-center justify-between border-b border-stone-200 bg-white/80 px-4 py-3 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <button onClick={() => { setSessionId(null); setDeploying(false); setActiveTab('commands'); }} className="text-lg font-bold tracking-tight text-stone-900 transition hover:text-amber-700">Paddock</button>
          {sessionId && (
            <>
              <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-500">{sessionLabels[sessionId] ?? sessionId}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs ${trustScore > 60 ? 'bg-emerald-100 text-emerald-700' : trustScore > 30 ? 'bg-amber-100 text-amber-700' : 'bg-rose-100 text-rose-700'}`}>
                Trust: {trustScore}
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowConfigModal(true)}
            className="rounded-2xl border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-600 transition hover:border-stone-300 hover:text-stone-900"
            title="Configure LLM API Keys"
          >
            API Keys
          </button>
          {sessionId && <button onClick={killSession} className="rounded-2xl bg-rose-600 px-3 py-1.5 text-sm font-bold text-white transition hover:bg-rose-700">KILL</button>}
        </div>
      </header>

      <ConfigBanner warnings={healthWarnings} />
      <ErrorBanner events={events} />

      <div className="flex-1 min-h-0 flex">
        <SessionSidebar
          sessions={sessions}
          selectedSessionId={sessionId}
          sessionLabels={sessionLabels}
          collapsed={sidebarCollapsed}
          onOpenCreateModal={() => setShowCreateModal(true)}
          onSelectSession={openSession}
          onRenameSession={handleRenameSession}
          onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
        />

        <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {sessionId && deploying ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="space-y-4 w-[32rem] max-w-full px-6">
                <h2 className="text-sm font-semibold text-stone-500">Setting up sandbox...</h2>
                <DeployPipeline events={events} />
              </div>
            </div>
          ) : sessionId ? (
            <>
              <div className="flex border-b border-stone-200 bg-white/80 px-2">
                <button
                  onClick={() => setActiveTab('commands')}
                  className={`rounded-t-2xl px-4 py-3 text-xs font-medium ${activeTab === 'commands' ? 'border-b-2 border-amber-500 text-stone-900' : 'text-stone-500 hover:text-stone-800'}`}
                >
                  Commands
                </button>
                <button
                  onClick={() => setActiveTab('logs')}
                  className={`rounded-t-2xl px-4 py-3 text-xs font-medium ${activeTab === 'logs' ? 'border-b-2 border-amber-500 text-stone-900' : 'text-stone-500 hover:text-stone-800'}`}
                >
                  Raw Logs
                </button>
                <button
                  onClick={() => setActiveTab('vm')}
                  className={`rounded-t-2xl px-4 py-3 text-xs font-medium ${activeTab === 'vm' ? 'border-b-2 border-amber-500 text-stone-900' : 'text-stone-500 hover:text-stone-800'}`}
                >
                  {vmTabLabel}
                </button>
              </div>

              {activeTab !== 'vm' && <AgentPanel key={sessionId} sessionId={sessionId} events={events} health={health} />}
              {activeTab === 'commands' && <SecurityPanel events={events} />}

              {activeTab === 'commands' ? (
                <CommandCenter
                  events={events}
                  onAbortCommand={handleAbortCommand}
                  abortingRunId={abortingRunId}
                  pendingApprovals={pendingApprovals}
                  onHitlDecision={handleHITLDecision}
                />
              ) : activeTab === 'logs' ? (
                <EventTimeline events={events} sessionId={sessionId} />
              ) : (
                <VMPanel sessionId={sessionId} sandboxType={currentSandboxType} events={events} />
              )}

              {activeTab !== 'vm' && (
                <CommandInput
                  onSend={sendCommand}
                  disabled={commandState.disabled}
                  hint={commandState.hint}
                  onStop={activeCommand?.stopTargetRunId ? () => void handleAbortCommand(activeCommand.stopTargetRunId!) : undefined}
                  stopping={abortingRunId === activeCommand?.stopTargetRunId}
                />
              )}
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center p-10">
              <div className="max-w-xl rounded-[32px] border border-stone-200 bg-white/90 p-8 shadow-[0_24px_80px_rgba(80,60,30,0.08)]">
                <h2 className="text-2xl font-semibold text-stone-900">Create a sandbox or reopen an existing one</h2>
                <p className="mt-3 text-sm leading-6 text-stone-500">
                  The sidebar stays available the whole time, so you can keep multiple VMs around and switch between them without losing your place.
                </p>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
