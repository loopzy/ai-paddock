// Event type → colored badge mapping
const badgeConfig: Record<string, { label: string; bg: string; text: string }> = {
  'amp.llm.request': { label: 'LLM', bg: 'bg-blue-900', text: 'text-blue-300' },
  'amp.llm.response': { label: 'LLM', bg: 'bg-blue-900', text: 'text-blue-300' },
  'amp.thought': { label: 'LLM', bg: 'bg-blue-900', text: 'text-blue-300' },
  'amp.tool.intent': { label: 'Tool', bg: 'bg-purple-900', text: 'text-purple-300' },
  'amp.tool.result': { label: 'Tool', bg: 'bg-purple-900', text: 'text-purple-300' },
  'amp.gate.verdict': { label: 'Security', bg: 'bg-orange-900', text: 'text-orange-300' },
  'amp.agent.ready': { label: 'Agent', bg: 'bg-green-900', text: 'text-green-300' },
  'amp.agent.heartbeat': { label: 'Agent', bg: 'bg-green-900', text: 'text-green-300' },
  'amp.agent.error': { label: 'Error', bg: 'bg-red-900', text: 'text-red-300' },
  'amp.agent.fatal': { label: 'Error', bg: 'bg-red-900', text: 'text-red-300' },
  'amp.agent.exit': { label: 'Agent', bg: 'bg-green-900', text: 'text-green-300' },
  'amp.fs.change': { label: 'System', bg: 'bg-gray-800', text: 'text-gray-300' },
  'amp.net.egress': { label: 'System', bg: 'bg-gray-800', text: 'text-gray-300' },
  'amp.process.spawn': { label: 'System', bg: 'bg-gray-800', text: 'text-gray-300' },
  'amp.session.start': { label: 'System', bg: 'bg-gray-800', text: 'text-gray-300' },
  'amp.session.end': { label: 'System', bg: 'bg-gray-800', text: 'text-gray-300' },
  'amp.snapshot.created': { label: 'System', bg: 'bg-gray-800', text: 'text-gray-300' },
  'amp.snapshot.restored': { label: 'System', bg: 'bg-gray-800', text: 'text-gray-300' },
  'amp.hitl.request': { label: 'Security', bg: 'bg-orange-900', text: 'text-orange-300' },
  'amp.hitl.decision': { label: 'Security', bg: 'bg-orange-900', text: 'text-orange-300' },
  'amp.user.command': { label: 'System', bg: 'bg-gray-800', text: 'text-gray-300' },
};

export function EventBadge({ type }: { type: string }) {
  const config = badgeConfig[type] ?? { label: 'System', bg: 'bg-gray-800', text: 'text-gray-300' };
  return (
    <span className={`${config.bg} ${config.text} text-[10px] font-medium px-1.5 py-0.5 rounded`}>
      {config.label}
    </span>
  );
}

export type EventCategory = 'All' | 'LLM' | 'Tools' | 'Security' | 'Agent' | 'System';

export function getEventCategory(type: string): EventCategory {
  if (type.includes('llm') || type === 'amp.thought') return 'LLM';
  if (type.includes('tool')) return 'Tools';
  if (type.includes('gate') || type.includes('hitl')) return 'Security';
  if (type.includes('agent')) return 'Agent';
  return 'System';
}
