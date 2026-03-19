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
  const color = score > 70 ? 'text-rose-600' : score > 30 ? 'text-amber-700' : 'text-emerald-700';
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
      return <span className="italic text-amber-700">{(p.text as string)?.slice(0, 200) ?? ''}</span>;
    case 'amp.trace':
      return (
        <span>
          <span className="text-sky-700">{(p.phase as string) ?? 'trace'}</span>
          <span className="ml-2 text-stone-500">{JSON.stringify(p).slice(0, 150)}</span>
        </span>
      );
    case 'amp.tool.intent':
      return (
        <span>
          <span className="text-violet-700">{p.toolName as string}</span>
          <span className="ml-2 text-stone-500">{JSON.stringify(p.toolInput).slice(0, 120)}</span>
        </span>
      );
    case 'amp.tool.result':
      return <span className="text-stone-600">{JSON.stringify(p).slice(0, 150)}</span>;
    case 'amp.fs.change':
      return (
        <span>
          <span className={p.action === 'delete' ? 'text-rose-700' : 'text-emerald-700'}>{p.action as string}</span>{' '}
          {p.path as string}
        </span>
      );
    case 'amp.gate.verdict':
      return (
        <span>
          <span className={p.verdict === 'approve' ? 'text-emerald-700' : p.verdict === 'reject' ? 'text-rose-700' : 'text-amber-700'}>
            {p.verdict as string}
          </span>
          {' '}<RiskBadge score={p.riskScore as number ?? 0} />
          {(p.triggeredRules as string[])?.length > 0 && (
            <span className="ml-2 text-xs text-stone-500">{(p.triggeredRules as string[]).join(', ')}</span>
          )}
        </span>
      );
    case 'amp.agent.ready':
      return <span className="text-emerald-700">Agent ready: {p.agent as string} v{p.version as string}</span>;
    case 'amp.agent.message':
      return <span className="whitespace-pre-wrap text-emerald-800">{((p.text as string) ?? '').slice(0, 400)}</span>;
    case 'amp.command.status':
      return (
        <span>
          <span className="text-indigo-700">{(p.status as string) ?? 'updated'}</span>
          {(p.runId as string) && <span className="ml-2 text-stone-500">{p.runId as string}</span>}
          {(p.command as string) && <span className="ml-2 text-stone-600">{(p.command as string).slice(0, 120)}</span>}
        </span>
      );
    case 'amp.agent.heartbeat':
      return <span className="text-stone-500">uptime {p.uptime as number}s · {p.memoryMB as number}MB</span>;
    case 'amp.agent.error':
      return (
        <span className="text-rose-700">
          [{p.category as string}] {p.code as string}: {p.message as string}
          {(p.recoverable as boolean) && <span className="ml-1 text-amber-700">(recoverable)</span>}
        </span>
      );
    case 'amp.agent.fatal':
      return <span className="font-bold text-rose-700">FATAL: {p.code as string} — {p.message as string}</span>;
    case 'amp.agent.exit':
      return (
        <span className={p.reason === 'normal' ? 'text-stone-500' : 'text-rose-700'}>
          exit({p.exitCode as number}) reason={p.reason as string}
        </span>
      );
    case 'amp.hitl.request':
      return <span className="text-amber-700">Awaiting approval: {p.toolName as string}</span>;
    case 'amp.hitl.decision':
      return <span className={p.verdict === 'approved' ? 'text-emerald-700' : 'text-rose-700'}>{p.verdict as string}</span>;
    default:
      return <span className="text-stone-500">{JSON.stringify(p).slice(0, 150)}</span>;
  }
}

function ExpandablePayload({ event }: { event: PaddockEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(!open)} className="ml-1 text-[10px] text-stone-500 hover:text-stone-800" aria-label="Toggle payload">
        {open ? '[-]' : '[+]'}
      </button>
      {open && (
        <pre className="mt-1 ml-8 max-h-32 overflow-auto rounded-2xl bg-white p-3 text-[10px] text-stone-600 ring-1 ring-stone-200">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      )}
    </>
  );
}

const FILTER_TABS: EventCategory[] = ['All', 'LLM', 'Tools', 'Security', 'Agent', 'System'];

export function EventTimeline({ events, sessionId }: { events: PaddockEvent[]; sessionId: string }) {
  const [filter, setFilter] = useState<EventCategory>('All');
  const containerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || !stickToBottomRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [events.length, filter]);

  const counts = FILTER_TABS.reduce((acc, tab) => {
    acc[tab] = tab === 'All' ? events.length : events.filter(e => getEventCategory(e.type) === tab).length;
    return acc;
  }, {} as Record<EventCategory, number>);

  const filtered = filter === 'All' ? events : events.filter(e => getEventCategory(e.type) === filter);
  const isError = (type: string) => type === 'amp.agent.error' || type === 'amp.agent.fatal';

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex gap-1 overflow-x-auto border-b border-stone-200 bg-white px-4 py-2">
        {FILTER_TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setFilter(tab)}
            className={`rounded-full px-3 py-1 text-[11px] font-medium ${filter === tab ? 'bg-amber-500 text-white' : 'text-stone-500 hover:bg-stone-100 hover:text-stone-900'}`}
          >
            {tab} <span className="ml-0.5 text-[10px] opacity-70">{counts[tab]}</span>
          </button>
        ))}
      </div>
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto bg-stone-50/80 p-4 space-y-1"
        onScroll={(event) => {
          const node = event.currentTarget;
          const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
          stickToBottomRef.current = distance < 80;
        }}
      >
        {filtered.map(e => (
          <div key={e.id} className={`flex items-start gap-3 rounded-2xl px-3 py-2 text-sm ${isError(e.type) ? 'bg-rose-50' : 'hover:bg-white/80'}`}>
            <span className="w-16 shrink-0 text-right font-mono text-[11px] tabular-nums text-stone-500">
              {new Date(e.timestamp).toLocaleTimeString()}
            </span>
            <EventBadge type={e.type} />
            <span className="w-32 shrink-0 truncate text-xs text-stone-500">{e.type}</span>
            <span className="flex-1 truncate text-stone-700">
              <EventDetail event={e} />
              <ExpandablePayload event={e} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
