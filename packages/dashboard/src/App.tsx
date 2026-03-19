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
      className="w-full min-w-0 bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-xs text-gray-300" aria-label="Select sandbox type">
      <option value="simple-box">Simple Box (Headless Ubuntu 22.04)</option>
      <option value="computer-box">Computer Box (GUI Ubuntu XFCE Desktop)</option>
      <option value="cua" disabled>CUA (macOS) — Coming Soon</option>
    </select>
  );
}

function AgentSelector({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className="w-full min-w-0 bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-xs text-gray-300" aria-label="Select agent type">
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
    <div className="border-t border-gray-800">
      <div className="flex gap-2 p-4">
        <input
          className="flex-1 bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-cyan-600 disabled:opacity-50 disabled:cursor-not-allowed"
          placeholder={disabled ? hint : 'Send command to agent...'}
          value={value}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <button
          onClick={submit}
          disabled={disabled}
          className="px-4 py-2 bg-cyan-700 hover:bg-cyan-600 rounded text-sm disabled:bg-gray-800 disabled:text-gray-500 disabled:cursor-not-allowed"
        >
          Send
        </button>
        {onStop && (
          <button
            type="button"
            onClick={onStop}
            disabled={stopping}
            className="px-4 py-2 bg-red-950 hover:bg-red-900 border border-red-900 rounded text-sm text-red-200 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {stopping ? 'Stopping…' : 'Stop Current'}
          </button>
        )}
      </div>
      {disabled && <div className="px-4 pb-3 text-[11px] text-gray-500">{hint}</div>}
    </div>
  );
}

function formatSessionStatus(status: string): string {
  switch (status) {
    case 'running':
      return 'Running';
    case 'created':
      return 'Starting';
    case 'paused':
      return 'Paused';
    case 'terminated':
      return 'Stopped';
    case 'error':
      return 'Error';
    default:
      return status;
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

function SessionSidebar({
  sessions,
  selectedSessionId,
  sandboxType,
  creating,
  createError,
  collapsed,
  showArchived,
  onSandboxTypeChange,
  onCreateSession,
  onSelectSession,
  onDeleteSession,
  onToggleCollapsed,
  onToggleArchived,
}: {
  sessions: SessionSummary[];
  selectedSessionId: string | null;
  sandboxType: SandboxType;
  creating: boolean;
  createError: string | null;
  collapsed: boolean;
  showArchived: boolean;
  onSandboxTypeChange: (value: SandboxType) => void;
  onCreateSession: () => void;
  onSelectSession: (session: SessionSummary) => void;
  onDeleteSession: (sessionId: string) => void;
  onToggleCollapsed: () => void;
  onToggleArchived: () => void;
}) {
  const sortedSessions = sortSessions(sessions);
  const liveSessions = sortedSessions.filter((session) => !['terminated', 'error'].includes(session.status));
  const archivedSessions = sortedSessions.filter((session) => ['terminated', 'error'].includes(session.status));

  if (collapsed) {
    return (
      <aside className="w-20 shrink-0 border-r border-gray-800 bg-gray-950/90 flex flex-col items-center py-4 gap-3">
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="flex h-10 w-10 items-center justify-center rounded-2xl border border-gray-800 bg-gray-900 text-gray-300 hover:border-gray-700 hover:text-white"
          aria-label="Expand sidebar"
        >
          »
        </button>
        <button
          type="button"
          onClick={onCreateSession}
          disabled={creating}
          className="flex h-10 w-10 items-center justify-center rounded-2xl bg-cyan-700 text-lg font-semibold text-white hover:bg-cyan-600 disabled:opacity-60"
          aria-label="Create sandbox"
        >
          +
        </button>
        <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-2">
          {liveSessions.map((session) => {
            const active = session.id === selectedSessionId;
            return (
              <button
                key={session.id}
                type="button"
                onClick={() => onSelectSession(session)}
                className={`flex h-11 w-11 items-center justify-center rounded-2xl border text-[10px] font-medium ${
                  active
                    ? 'border-cyan-700 bg-cyan-950/40 text-cyan-200'
                    : 'border-gray-800 bg-gray-900 text-gray-400 hover:border-gray-700 hover:text-white'
                }`}
                aria-label={session.id}
                title={`${session.id} · ${formatSessionStatus(session.status)}`}
              >
                {session.sandboxType === 'computer-box' ? 'GUI' : 'VM'}
              </button>
            );
          })}
        </div>
      </aside>
    );
  }

  return (
    <aside className="w-[360px] shrink-0 border-r border-gray-800 bg-gray-950/90 flex flex-col min-h-0">
      <div className="border-b border-gray-800 px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-gray-100">Sandboxes</h2>
            <p className="mt-1 text-xs text-gray-500">Create, switch, and clean up VMs without leaving the current session.</p>
          </div>
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="flex h-9 w-9 items-center justify-center rounded-2xl border border-gray-800 bg-gray-900 text-gray-300 hover:border-gray-700 hover:text-white"
            aria-label="Collapse sidebar"
          >
            «
          </button>
        </div>
      </div>

      <div className="border-b border-gray-800 px-4 py-4 space-y-3">
        <div>
          <label className="block text-[11px] uppercase tracking-wide text-gray-500 mb-2">New Sandbox</label>
          <SandboxSelector value={sandboxType} onChange={onSandboxTypeChange} />
        </div>
        {createError && (
          <div className="rounded-xl border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
            {createError}
          </div>
        )}
        <button
          onClick={onCreateSession}
          disabled={creating}
          className="w-full rounded-xl bg-cyan-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-cyan-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {creating ? 'Creating…' : 'Create Sandbox'}
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3">
        <div className="space-y-2">
          {liveSessions.map((session) => {
            const active = session.id === selectedSessionId;
            const statusTone =
              session.status === 'running'
                ? 'bg-emerald-500'
                : session.status === 'error'
                  ? 'bg-red-500'
                  : 'bg-yellow-500';
            return (
              <div
                key={session.id}
                className={`rounded-2xl border transition ${
                  active
                    ? 'border-cyan-700 bg-cyan-950/40'
                    : 'border-gray-800 bg-gray-900/70 hover:border-gray-700 hover:bg-gray-900'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelectSession(session)}
                  className="w-full min-w-0 px-3 py-3 text-left"
                  aria-label={session.id}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-gray-100">{session.id}</div>
                      <div className="mt-1 text-[11px] text-gray-500">
                        {session.sandboxType === 'computer-box' ? 'GUI Ubuntu' : 'Headless Ubuntu'}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`h-2.5 w-2.5 rounded-full ${statusTone}`} />
                      <span className="rounded-full bg-gray-900 px-2 py-0.5 text-[11px] text-gray-300">
                        {formatSessionStatus(session.status)}
                      </span>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
                    <span>{session.agentType}</span>
                    <span>•</span>
                    <span>{new Date(session.updatedAt ?? session.createdAt).toLocaleString()}</span>
                  </div>
                </button>
              </div>
            );
          })}
        </div>

        <div className="mt-5">
          <button
            type="button"
            onClick={onToggleArchived}
            className="flex w-full items-center justify-between rounded-2xl border border-gray-800 bg-gray-900/70 px-3 py-3 text-left hover:border-gray-700"
          >
            <div>
              <div className="text-sm font-medium text-gray-100">Archived sessions</div>
              <div className="mt-1 text-[11px] text-gray-500">Old stopped or failed sandboxes from earlier runs.</div>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-gray-950 px-2 py-0.5 text-[11px] text-gray-400">{archivedSessions.length}</span>
              <span className="text-gray-500">{showArchived ? '−' : '+'}</span>
            </div>
          </button>

          {showArchived && (
            <div className="mt-2 space-y-2">
              {archivedSessions.map((session) => (
                <div key={session.id} className="rounded-2xl border border-gray-800 bg-gray-900/60 px-3 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => onSelectSession(session)}
                      className="min-w-0 flex-1 text-left"
                      aria-label={session.id}
                    >
                      <div className="truncate font-medium text-gray-200">{session.id}</div>
                      <div className="mt-1 text-[11px] text-gray-500">
                        {formatSessionStatus(session.status)} · {new Date(session.updatedAt ?? session.createdAt).toLocaleString()}
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteSession(session.id)}
                      className="rounded-lg border border-red-900 bg-red-950 px-2.5 py-1.5 text-[11px] text-red-300 hover:bg-red-900/70"
                      aria-label={`Delete ${session.id}`}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
              {archivedSessions.length === 0 && (
                <div className="rounded-xl border border-dashed border-gray-800 px-4 py-5 text-xs text-gray-500">
                  No archived sessions.
                </div>
              )}
            </div>
          )}
        </div>

        {sortedSessions.length === 0 && (
          <div className="mt-3 rounded-xl border border-dashed border-gray-800 px-4 py-5 text-xs text-gray-500">
            No sessions yet. Create one to start.
          </div>
        )}
      </div>
    </aside>
  );
}

function ConfigBanner({ warnings }: { warnings: HealthWarning[] }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || warnings.length === 0) return null;
  return (
    <div className="border-b border-yellow-900 px-4 py-2 bg-yellow-950 text-yellow-300 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-1">
          {warnings.map((w, i) => (
            <div key={i}>
              <span className="font-medium">{w.message}</span>
              <span className="text-yellow-500 ml-2">{w.hint}</span>
              {w.envHints && Object.keys(w.envHints).length > 0 && (
                <div className="mt-1 text-yellow-600">
                  {Object.entries(w.envHints).map(([key, url]) => (
                    <span key={key} className="mr-3">
                      <code className="bg-yellow-900/50 px-1 rounded">{key}</code>
                      {url && <> — <a href={url} target="_blank" rel="noreferrer" className="underline hover:text-yellow-400">{url}</a></>}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        <button onClick={() => setDismissed(true)} className="text-yellow-600 hover:text-yellow-400 shrink-0" aria-label="Dismiss">x</button>
      </div>
    </div>
  );
}

// ─── Security Alert Panel ───
function SecurityPanel({ events }: { events: PaddockEvent[] }) {
  const alerts = events.filter(e => e.type === 'amp.gate.verdict' && (e.payload.riskScore as number) > 30);
  if (alerts.length === 0) return null;
  return (
    <div className="border-b border-gray-800 px-4 py-2 bg-gray-950">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-orange-400 text-sm font-bold">Security Alerts</span>
        <span className="text-xs text-gray-500">({alerts.length})</span>
      </div>
      <div className="space-y-1 max-h-24 overflow-y-auto">
        {alerts.slice(-5).map(a => (
          <div key={a.id} className="text-xs flex items-center gap-2">
            <span className={`${(a.payload.riskScore as number) > 70 ? 'text-red-400' : 'text-yellow-400'} text-xs font-mono`}>[{a.payload.riskScore as number}]</span>
            <span className="text-gray-400">{a.payload.toolName as string}</span>
            <span className="text-gray-600">{(a.payload.triggeredRules as string[])?.join(', ')}</span>
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
      <div className="border-b border-gray-800 px-4 py-3 bg-gray-950">
        <div className="text-xs text-gray-500 mb-2">Deploying Agent...</div>
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
    <div className="border-b border-gray-800 px-4 py-3 bg-gray-950">
      {preflightWarning && (
        <div className="text-xs text-yellow-400 bg-yellow-950 border border-yellow-900 rounded px-2 py-1 mb-2">{preflightWarning}</div>
      )}
      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-500">
          {agentLifecycle === 'offline' ? 'Agent disconnected.' : 'No agent running.'}
        </span>
        <AgentSelector value={agentType} onChange={setAgentType} />
        <button onClick={deployAgent} className="px-3 py-1 bg-cyan-700 hover:bg-cyan-600 rounded text-xs">Deploy Agent</button>
        <span className="text-[10px] text-gray-600 ml-auto">
          Will use: {defaultProvider} / {defaultModel || 'default'}.
          {' '}Or install your own agent via the terminal and connect it to the Sidecar at localhost:8801.
        </span>
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
  const [healthWarnings, setHealthWarnings] = useState<HealthWarning[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'commands' | 'logs' | 'vm'>('commands');
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [abortingRunId, setAbortingRunId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showArchivedSessions, setShowArchivedSessions] = useState(false);
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
    const interval = setInterval(() => {
      refreshSessions();
    }, 5000);
    return () => clearInterval(interval);
  }, [refreshSessions]);

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
      setActiveTab('commands');
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

  const handleDeleteSession = async (targetSessionId: string) => {
    await fetch(`/api/sessions/${targetSessionId}`, { method: 'DELETE' });
    if (sessionId === targetSessionId) {
      setSessionId(null);
      setAbortingRunId(null);
      setPendingApprovals([]);
    }
    refreshSessions();
  };

  const openSession = (session: SessionSummary) => {
    setSessionId(session.id);
    setDeploying(false);
    setCreateError(null);
    setDraftSandboxType(session.sandboxType as SandboxType);
    setActiveTab('commands');
  };

  const lastGate = [...events].reverse().find(e => e.type === 'amp.gate.verdict');
  const trustScore = lastGate ? 100 - (lastGate.payload.riskScore as number ?? 0) : 100;

  const currentSandboxType = (selectedSession?.sandboxType as SandboxType | undefined) ?? draftSandboxType;
  const vmTabLabel = currentSandboxType === 'computer-box' ? 'Desktop' : 'Terminal';

  return (
    <div className="h-screen flex flex-col">
      {showConfigModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowConfigModal(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-lg p-6 max-w-lg w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-gray-200">Configure LLM Providers</h2>
              <button
                onClick={() => setShowConfigModal(false)}
                className="text-gray-500 hover:text-gray-300 text-2xl leading-none"
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

      <header className="flex items-center justify-between px-4 py-3 border-b border-gray-800 bg-gray-950">
        <div className="flex items-center gap-3">
          <button onClick={() => { setSessionId(null); setDeploying(false); setActiveTab('commands'); }} className="text-lg font-bold tracking-tight hover:text-cyan-400">Paddock</button>
          {sessionId && (
            <>
              <span className="text-xs text-gray-500 bg-gray-900 px-2 py-0.5 rounded">{sessionId}</span>
              <span className={`text-xs px-2 py-0.5 rounded ${trustScore > 60 ? 'bg-green-900 text-green-400' : trustScore > 30 ? 'bg-yellow-900 text-yellow-400' : 'bg-red-900 text-red-400'}`}>
                Trust: {trustScore}
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowConfigModal(true)}
            className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded text-xs font-medium text-gray-300"
            title="Configure LLM API Keys"
          >
            ⚙️ API Keys
          </button>
          {sessionId && <button onClick={killSession} className="px-3 py-1.5 bg-red-700 hover:bg-red-600 rounded text-sm font-bold">KILL</button>}
        </div>
      </header>

      <ConfigBanner warnings={healthWarnings} />
      <ErrorBanner events={events} />

      <div className="flex-1 min-h-0 flex">
        <SessionSidebar
          sessions={sessions}
          selectedSessionId={sessionId}
          sandboxType={draftSandboxType}
          creating={deploying && !sessionId}
          createError={createError}
          collapsed={sidebarCollapsed}
          showArchived={showArchivedSessions}
          onSandboxTypeChange={setDraftSandboxType}
          onCreateSession={createSession}
          onSelectSession={openSession}
          onDeleteSession={handleDeleteSession}
          onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
          onToggleArchived={() => setShowArchivedSessions((value) => !value)}
        />

        <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {sessionId && deploying ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="space-y-4 w-[32rem] max-w-full px-6">
                <h2 className="text-sm font-semibold text-gray-400">Setting up sandbox...</h2>
                <DeployPipeline events={events} />
              </div>
            </div>
          ) : sessionId ? (
            <>
              <div className="flex border-b border-gray-800 bg-gray-950">
                <button
                  onClick={() => setActiveTab('commands')}
                  className={`px-4 py-2 text-xs ${activeTab === 'commands' ? 'text-white border-b-2 border-cyan-500' : 'text-gray-500 hover:text-gray-300'}`}
                >
                  Commands
                </button>
                <button
                  onClick={() => setActiveTab('logs')}
                  className={`px-4 py-2 text-xs ${activeTab === 'logs' ? 'text-white border-b-2 border-cyan-500' : 'text-gray-500 hover:text-gray-300'}`}
                >
                  Raw Logs
                </button>
                <button
                  onClick={() => setActiveTab('vm')}
                  className={`px-4 py-2 text-xs ${activeTab === 'vm' ? 'text-white border-b-2 border-cyan-500' : 'text-gray-500 hover:text-gray-300'}`}
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
              <div className="max-w-xl rounded-3xl border border-gray-800 bg-gray-950/70 p-8">
                <h2 className="text-2xl font-semibold text-gray-100">Create a sandbox or reopen an existing one</h2>
                <p className="mt-3 text-sm leading-6 text-gray-500">
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
