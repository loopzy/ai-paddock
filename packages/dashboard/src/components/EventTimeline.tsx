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

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateText(value: string, limit = 220): string {
  const collapsed = collapseWhitespace(value);
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit - 1)}…`;
}

function compactPayload(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function ExpandablePayload({ event }: { event: PaddockEvent }) {
  const [open, setOpen] = useState(false);
  const serialized = compactPayload(event.payload);
  const compact = truncateText(serialized, 360);
  const pretty = JSON.stringify(event.payload, null, 2);
  const shouldCollapse = serialized.length > 360;
  return (
    <div className="min-w-0 flex-1">
      {!open && (
        <code className="min-w-0 block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11px] leading-5 text-stone-600">
          {compact}
        </code>
      )}
      <div className="mt-1">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="rounded-full border border-stone-200 bg-white px-2.5 py-1 text-[11px] font-medium text-stone-500 transition hover:border-stone-300 hover:text-stone-900"
          aria-label={open ? 'Collapse payload' : shouldCollapse ? 'Expand full payload' : 'Expand payload'}
        >
          {open ? 'Collapse payload' : shouldCollapse ? 'Expand full payload' : 'Expand payload'}
        </button>
      </div>
      {open && (
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-2xl bg-white p-3 text-[10px] leading-5 text-stone-600 ring-1 ring-stone-200">
          {pretty}
        </pre>
      )}
    </div>
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
            <ExpandablePayload event={e} />
          </div>
        ))}
      </div>
    </div>
  );
}
