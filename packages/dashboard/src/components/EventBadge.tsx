// Event type → colored badge mapping
const badgeConfig: Record<string, { label: string; bg: string; text: string }> = {
  'amp.llm.request': { label: 'Model', bg: 'bg-sky-100', text: 'text-sky-700' },
  'amp.llm.response': { label: 'Model', bg: 'bg-sky-100', text: 'text-sky-700' },
  'amp.llm.review': { label: 'Safety', bg: 'bg-amber-100', text: 'text-amber-700' },
  'amp.thought': { label: 'Thinking', bg: 'bg-sky-100', text: 'text-sky-700' },
  'amp.trace': { label: 'System', bg: 'bg-stone-200', text: 'text-stone-700' },
  'amp.tool.intent': { label: 'Tool', bg: 'bg-violet-100', text: 'text-violet-700' },
  'amp.tool.result': { label: 'Tool', bg: 'bg-violet-100', text: 'text-violet-700' },
  'amp.gate.verdict': { label: 'Safety', bg: 'bg-amber-100', text: 'text-amber-700' },
  'amp.agent.ready': { label: 'Agent', bg: 'bg-emerald-100', text: 'text-emerald-700' },
  'amp.agent.message': { label: 'Answer', bg: 'bg-emerald-100', text: 'text-emerald-700' },
  'amp.agent.heartbeat': { label: 'Agent', bg: 'bg-emerald-100', text: 'text-emerald-700' },
  'amp.agent.error': { label: 'Issue', bg: 'bg-rose-100', text: 'text-rose-700' },
  'amp.agent.fatal': { label: 'Issue', bg: 'bg-rose-100', text: 'text-rose-700' },
  'amp.agent.exit': { label: 'Agent', bg: 'bg-emerald-100', text: 'text-emerald-700' },
  'amp.fs.change': { label: 'System', bg: 'bg-stone-200', text: 'text-stone-700' },
  'amp.net.egress': { label: 'System', bg: 'bg-stone-200', text: 'text-stone-700' },
  'amp.process.spawn': { label: 'System', bg: 'bg-stone-200', text: 'text-stone-700' },
  'amp.session.start': { label: 'System', bg: 'bg-stone-200', text: 'text-stone-700' },
  'amp.session.end': { label: 'System', bg: 'bg-stone-200', text: 'text-stone-700' },
  'amp.snapshot.created': { label: 'System', bg: 'bg-stone-200', text: 'text-stone-700' },
  'amp.snapshot.restored': { label: 'System', bg: 'bg-stone-200', text: 'text-stone-700' },
  'amp.hitl.request': { label: 'Security', bg: 'bg-amber-100', text: 'text-amber-700' },
  'amp.hitl.decision': { label: 'Security', bg: 'bg-amber-100', text: 'text-amber-700' },
  'amp.user.command': { label: 'Request', bg: 'bg-stone-200', text: 'text-stone-700' },
  'amp.command.status': { label: 'Run', bg: 'bg-indigo-100', text: 'text-indigo-700' },
};

const eventDisplayNames: Record<string, string> = {
  'user.command': 'Your request',
  'amp.user.command': 'Request accepted',
  'amp.command.status': 'Run status',
  'llm.request': 'Model request',
  'amp.llm.request': 'Model request',
  'llm.response': 'Model response',
  'amp.llm.response': 'Model response',
  'amp.llm.review': 'Model review',
  'amp.thought': 'Model reasoning',
  'amp.tool.intent': 'Tool started',
  'amp.tool.result': 'Tool finished',
  'amp.gate.verdict': 'Safety check',
  'amp.agent.ready': 'Agent ready',
  'amp.agent.message': 'Answer ready',
  'amp.agent.error': 'Agent issue',
  'amp.agent.fatal': 'Agent stopped',
  'amp.agent.exit': 'Agent exited',
  'amp.session.start': 'Setup progress',
  'amp.session.end': 'Session ended',
  'amp.snapshot.created': 'Checkpoint created',
  'amp.snapshot.restored': 'Checkpoint restored',
  'amp.hitl.request': 'Approval requested',
  'amp.hitl.decision': 'Approval decided',
};

export function EventBadge({ type }: { type: string }) {
  const config = badgeConfig[type] ?? { label: 'System', bg: 'bg-stone-200', text: 'text-stone-700' };
  return (
    <span className={`${config.bg} ${config.text} rounded-full px-2 py-0.5 text-[10px] font-medium`}>
      {config.label}
    </span>
  );
}

export function getEventDisplayName(type: string): string {
  return eventDisplayNames[type] ?? type;
}

export type EventCategory = 'All' | 'LLM' | 'Tools' | 'Security' | 'Agent' | 'System';

export function getEventCategory(type: string): EventCategory {
  if (type.includes('llm') || type === 'amp.thought') return 'LLM';
  if (type.includes('tool')) return 'Tools';
  if (type.includes('gate') || type.includes('hitl')) return 'Security';
  if (type.includes('agent')) return 'Agent';
  return 'System';
}
