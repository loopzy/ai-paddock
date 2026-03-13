import { useState, useEffect, useRef, useCallback } from 'react';
import { HITLModal } from './components/HITLModal.js';
import { DeployPipeline } from './components/DeployPipeline.js';
import { EventTimeline } from './components/EventTimeline.js';
import { ErrorBanner } from './components/ErrorBanner.js';
import { VMPanel } from './components/VMPanel.js';
import { LLMConfigPanel } from './components/LLMConfigPanel.js';
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

// ─── WebSocket Hook ───
function useEventStream(sessionId: string | null) {
  const [events, setEvents] = useState<PaddockEvent[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!sessionId) return;
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
      className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300" aria-label="Select sandbox type">
      <option value="simple-box">Simple Box (Headless Ubuntu 22.04)</option>
      <option value="computer-box">Computer Box (GUI Ubuntu XFCE Desktop)</option>
      <option value="cua" disabled>CUA (macOS) — Coming Soon</option>
    </select>
  );
}

function AgentSelector({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300" aria-label="Select agent type">
      <option value="openclaw">OpenClaw (auto-install)</option>
    </select>
  );
}

function CommandInput({
  onSend,
  disabled,
  hint,
}: {
  onSend: (cmd: string) => void;
  disabled: boolean;
  hint: string;
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
      </div>
      {disabled && <div className="px-4 pb-3 text-[11px] text-gray-500">{hint}</div>}
    </div>
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
  const [sandboxType, setSandboxType] = useState<SandboxType>('simple-box');
  const [deploying, setDeploying] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [healthWarnings, setHealthWarnings] = useState<HealthWarning[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'monitor' | 'vm' | 'config'>('monitor');
  const [showConfigModal, setShowConfigModal] = useState(false);
  const { events, sendCommand } = useEventStream(sessionId);

  const fetchHealth = useCallback(() => {
    fetch('/api/health').then(r => r.json()).then((data: HealthResponse) => {
      setHealth(data);
      setHealthWarnings(data.warnings ?? []);
    }).catch(() => {
      setHealthWarnings([{ type: 'unreachable', message: 'Cannot reach control plane.', hint: 'Is the server running? Check port 3100.' }]);
    });
  }, []);

  useEffect(() => {
    fetch('/api/sessions').then(r => r.json()).then(setSessions).catch(console.error);
    fetchHealth();
  }, [fetchHealth]);

  const createSession = async () => {
    setDeploying(true);
    setCreateError(null);
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentType: 'none', sandboxType, autoStart: true }),
      });
      if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
      const session = await res.json();
      setSessionId(session.id);
      setSessions(prev => [session, ...prev]);
    } catch (err) {
      setCreateError((err as Error).message);
      setDeploying(false);
    }
  };

  const sandboxReady = isSandboxReady(events);
  const hasError = hasSessionError(events);
  const agentReady = isAgentReady(events);
  const commandState = getCommandInputState(events);
  useEffect(() => { if (sandboxReady || hasError) setDeploying(false); }, [sandboxReady, hasError]);

  const killSession = async () => {
    if (!sessionId) return;
    await fetch(`/api/sessions/${sessionId}/kill`, { method: 'POST' });
    setSessionId(null);
  };

  const handleHITLDecision = async (requestId: string, verdict: 'approved' | 'rejected') => {
    if (!sessionId) return;
    await fetch(`/api/sessions/${sessionId}/hitl`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, verdict }),
    });
  };

  const lastGate = [...events].reverse().find(e => e.type === 'amp.gate.verdict');
  const trustScore = lastGate ? 100 - (lastGate.payload.riskScore as number ?? 0) : 100;

  const vmTabLabel = sandboxType === 'computer-box' ? 'Desktop' : 'Terminal';

  return (
    <div className="h-screen flex flex-col">
      {sessionId && <HITLModal sessionId={sessionId} onDecide={handleHITLDecision} />}

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
          <button onClick={() => { setSessionId(null); setDeploying(false); setActiveTab('monitor'); }} className="text-lg font-bold tracking-tight hover:text-cyan-400">Paddock</button>
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

      {sessionId && !deploying ? (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Tab bar */}
          <div className="flex border-b border-gray-800 bg-gray-950">
            <button onClick={() => setActiveTab('monitor')}
              className={`px-4 py-2 text-xs ${activeTab === 'monitor' ? 'text-white border-b-2 border-cyan-500' : 'text-gray-500 hover:text-gray-300'}`}>
              Monitor
            </button>
            <button onClick={() => setActiveTab('vm')}
              className={`px-4 py-2 text-xs ${activeTab === 'vm' ? 'text-white border-b-2 border-cyan-500' : 'text-gray-500 hover:text-gray-300'}`}>
              {vmTabLabel}
            </button>
          </div>

          {activeTab === 'monitor' ? (
            <>
              <AgentPanel key={sessionId} sessionId={sessionId} events={events} health={health} />
              <SecurityPanel events={events} />
              <EventTimeline events={events} sessionId={sessionId} />
              <CommandInput onSend={sendCommand} disabled={commandState.disabled} hint={commandState.hint} />
            </>
          ) : (
            <VMPanel sessionId={sessionId} sandboxType={sandboxType} events={events} />
          )}
        </div>
      ) : sessionId && deploying ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="space-y-4 w-96">
            <h2 className="text-sm font-semibold text-gray-400">Setting up sandbox...</h2>
            <DeployPipeline events={events} />
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-6 max-w-md">
            <h2 className="text-xl font-semibold text-gray-200">Create a Sandbox</h2>
            <p className="text-xs text-gray-500">Start a sandbox VM with Sidecar. You can deploy an agent after it's running.</p>
            <div className="space-y-3 text-left">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Sandbox Type</label>
                <SandboxSelector value={sandboxType} onChange={setSandboxType} />
              </div>
            </div>
            {createError && (
              <div className="text-left text-xs text-red-400 bg-red-950 border border-red-900 rounded px-3 py-2">{createError}</div>
            )}
            <button onClick={createSession} className="w-full px-4 py-2 bg-cyan-700 hover:bg-cyan-600 rounded text-sm font-medium">
              Create Sandbox
            </button>
            {sessions.length > 0 && (
              <div className="mt-8 text-left">
                <h3 className="text-xs text-gray-500 mb-2 uppercase tracking-wide">Previous Sessions</h3>
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {sessions.map(s => (
                    <button key={s.id} onClick={() => { setSessionId(s.id); setDeploying(false); }}
                      className="w-full flex items-center justify-between px-3 py-2 bg-gray-900 hover:bg-gray-800 rounded text-xs">
                      <span className="text-gray-400 truncate">{s.id}</span>
                      <span className="flex items-center gap-2">
                        <span className="text-gray-500">{s.sandboxType}</span>
                        <span className={`w-1.5 h-1.5 rounded-full ${s.status === 'running' ? 'bg-green-400' : s.status === 'terminated' || s.status === 'error' ? 'bg-red-400' : 'bg-yellow-400'}`} />
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
