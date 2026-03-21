import { useState, useEffect } from 'react';
import { ExpandableTextBlock } from './ExpandableTextBlock.js';

interface PaddockEvent {
  id: string;
  sessionId: string;
  seq: number;
  timestamp: number;
  type: string;
  payload: Record<string, unknown>;
  correlationId?: string;
}

interface ErrorInfo {
  category: string;
  code: string;
  message: string;
  recoverable: boolean;
}

export function ErrorBanner({ events }: { events: PaddockEvent[] }) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const errorEvents = events.filter(
    e => (e.type === 'amp.agent.error' || e.type === 'amp.agent.fatal') && !dismissed.has(e.id)
  );

  if (errorEvents.length === 0) return null;

  const latest = errorEvents[errorEvents.length - 1];
  const p = latest.payload as unknown as ErrorInfo;
  const isFatal = latest.type === 'amp.agent.fatal';
  const isConfig = p.category === 'config' || p.category === 'auth';

  return (
    <div className={`px-4 py-2 text-xs ${isFatal ? 'bg-red-950 border-b border-red-800 text-red-300' : 'bg-red-950/70 border-b border-red-900 text-red-400'}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="break-words">
            <span className="font-bold">{isFatal ? 'FATAL' : 'ERROR'}</span>
            <span className="mx-2 text-red-600">|</span>
            <span className="text-red-500">{p.category}</span>
            <span className="mx-1 text-red-700">/</span>
            <code className="text-red-300">{p.code}</code>
            <span className="mx-2 text-red-700">—</span>
          </div>
          <div className="mt-1">
            <ExpandableTextBlock
              content={p.message}
              previewChars={260}
              expandLabel="Expand full error"
              collapseLabel="Collapse error"
              preserveWhitespace
              textClassName="text-red-300"
              buttonClassName="border-red-800 bg-red-950/40 text-red-300 hover:border-red-700 hover:text-red-100"
            />
          </div>
          {isConfig && (
            <div className="mt-1 text-yellow-500">
              Hint: Check your environment variables. Missing API keys should be set before deploying the agent.
            </div>
          )}
        </div>
        <button
          onClick={() => setDismissed(prev => new Set([...prev, latest.id]))}
          className="text-red-700 hover:text-red-400 shrink-0"
          aria-label="Dismiss error"
        >
          x
        </button>
      </div>
      {errorEvents.length > 1 && (
        <div className="mt-1 text-red-600">{errorEvents.length - 1} more error{errorEvents.length > 2 ? 's' : ''}</div>
      )}
    </div>
  );
}
