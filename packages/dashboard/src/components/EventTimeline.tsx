import { useState, useRef, useEffect } from 'react';
import { EventBadge, getEventCategory, type EventCategory } from './EventBadge.js';

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

function RiskBadge({ score }: { score: number }) {
  const color = score > 70 ? 'text-red-400' : score > 30 ? 'text-yellow-400' : 'text-green-400';
  return <span className={`${color} text-xs font-mono`}>[{score}]</span>;
}

function EventDetail({ event }: { event: PaddockEvent }) {
  const p = event.payload;
  switch (event.type) {
    case 'amp.llm.request':
      return <span>{p.provider as string} / {p.model as string} ({p.messageCount as number} msgs)</span>;
    case 'amp.llm.response':
      return <span>{p.tokensIn as number} in / {p.tokensOut as number} out · {p.durationMs as number}ms</span>;
    case 'amp.thought':
      return <span className="text-yellow-400 italic">{(p.text as string)?.slice(0, 200) ?? ''}</span>;
    case 'amp.trace':
      return (
        <span>
          <span className="text-cyan-400">{(p.phase as string) ?? 'trace'}</span>
          <span className="text-gray-500 ml-2">{JSON.stringify(p).slice(0, 150)}</span>
        </span>
      );
    case 'amp.tool.intent':
      return (
        <span>
          <span className="text-cyan-400">{p.toolName as string}</span>
          <span className="text-gray-500 ml-2">{JSON.stringify(p.toolInput).slice(0, 120)}</span>
        </span>
      );
    case 'amp.tool.result':
      return <span className="text-gray-400">{JSON.stringify(p).slice(0, 150)}</span>;
    case 'amp.fs.change':
      return (
        <span>
          <span className={p.action === 'delete' ? 'text-red-400' : 'text-green-400'}>{p.action as string}</span>{' '}
          {p.path as string}
        </span>
      );
    case 'amp.gate.verdict':
      return (
        <span>
          <span className={p.verdict === 'approve' ? 'text-green-400' : p.verdict === 'reject' ? 'text-red-400' : 'text-orange-400'}>
            {p.verdict as string}
          </span>
          {' '}<RiskBadge score={p.riskScore as number ?? 0} />
          {(p.triggeredRules as string[])?.length > 0 && (
            <span className="text-gray-500 ml-2 text-xs">{(p.triggeredRules as string[]).join(', ')}</span>
          )}
        </span>
      );
    case 'amp.agent.ready':
      return <span className="text-green-400">Agent ready: {p.agent as string} v{p.version as string}</span>;
    case 'amp.agent.message':
      return <span className="text-emerald-300 whitespace-pre-wrap">{((p.text as string) ?? '').slice(0, 400)}</span>;
    case 'amp.command.status':
      return (
        <span>
          <span className="text-indigo-300">{(p.status as string) ?? 'updated'}</span>
          {(p.runId as string) && <span className="text-gray-500 ml-2">{p.runId as string}</span>}
          {(p.command as string) && <span className="text-gray-400 ml-2">{(p.command as string).slice(0, 120)}</span>}
        </span>
      );
    case 'amp.agent.heartbeat':
      return <span className="text-gray-500">uptime {p.uptime as number}s · {p.memoryMB as number}MB</span>;
    case 'amp.agent.error':
      return (
        <span className="text-red-400">
          [{p.category as string}] {p.code as string}: {p.message as string}
          {(p.recoverable as boolean) && <span className="text-yellow-500 ml-1">(recoverable)</span>}
        </span>
      );
    case 'amp.agent.fatal':
      return <span className="text-red-400 font-bold">FATAL: {p.code as string} — {p.message as string}</span>;
    case 'amp.agent.exit':
      return (
        <span className={p.reason === 'normal' ? 'text-gray-400' : 'text-red-400'}>
          exit({p.exitCode as number}) reason={p.reason as string}
        </span>
      );
    case 'amp.hitl.request':
      return <span className="text-orange-400">Awaiting approval: {p.toolName as string}</span>;
    case 'amp.hitl.decision':
      return <span className={p.verdict === 'approved' ? 'text-green-400' : 'text-red-400'}>{p.verdict as string}</span>;
    default:
      return <span className="text-gray-500">{JSON.stringify(p).slice(0, 150)}</span>;
  }
}

function ExpandablePayload({ event }: { event: PaddockEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(!open)} className="text-[10px] text-gray-600 hover:text-gray-400 ml-1" aria-label="Toggle payload">
        {open ? '[-]' : '[+]'}
      </button>
      {open && (
        <pre className="mt-1 ml-8 text-[10px] text-gray-600 bg-gray-950 rounded p-2 max-h-32 overflow-auto">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      )}
    </>
  );
}

const FILTER_TABS: EventCategory[] = ['All', 'LLM', 'Tools', 'Security', 'Agent', 'System'];

export function EventTimeline({ events, sessionId }: { events: PaddockEvent[]; sessionId: string }) {
  const [filter, setFilter] = useState<EventCategory>('All');
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [events.length]);

  const counts = FILTER_TABS.reduce((acc, tab) => {
    acc[tab] = tab === 'All' ? events.length : events.filter(e => getEventCategory(e.type) === tab).length;
    return acc;
  }, {} as Record<EventCategory, number>);

  const filtered = filter === 'All' ? events : events.filter(e => getEventCategory(e.type) === filter);
  const isError = (type: string) => type === 'amp.agent.error' || type === 'amp.agent.fatal';

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex gap-1 px-4 py-2 border-b border-gray-800 bg-gray-950 overflow-x-auto">
        {FILTER_TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setFilter(tab)}
            className={`px-2 py-1 text-[11px] rounded ${filter === tab ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}
          >
            {tab} <span className="text-gray-600 ml-0.5">{counts[tab]}</span>
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-1">
        {filtered.map(e => (
          <div key={e.id} className={`flex items-start gap-3 py-1 px-2 rounded text-sm ${isError(e.type) ? 'bg-red-950/30' : 'hover:bg-gray-900'}`}>
            <span className="text-gray-600 w-16 shrink-0 text-right tabular-nums">
              {new Date(e.timestamp).toLocaleTimeString()}
            </span>
            <EventBadge type={e.type} />
            <span className="text-gray-400 w-32 shrink-0 truncate text-xs">{e.type}</span>
            <span className="flex-1 truncate">
              <EventDetail event={e} />
              <ExpandablePayload event={e} />
            </span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
