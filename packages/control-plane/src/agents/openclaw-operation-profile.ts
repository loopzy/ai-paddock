export type OpenClawToolBoundary =
  | 'sandbox-local'
  | 'control-plane-routed'
  | 'mcp-external'
  | 'disabled';

export type OpenClawOperationProfileEntry = {
  toolName: string;
  boundary: OpenClawToolBoundary;
  monitorLayer: 'amp-gate' | 'amp-control' | 'mcp' | 'disabled';
  description: string;
};

const EXACT_TOOL_BOUNDARIES = new Map<string, OpenClawOperationProfileEntry>([
  ['read', { toolName: 'read', boundary: 'sandbox-local', monitorLayer: 'amp-gate', description: 'Read sandbox files' }],
  ['write', { toolName: 'write', boundary: 'sandbox-local', monitorLayer: 'amp-gate', description: 'Write sandbox files' }],
  ['edit', { toolName: 'edit', boundary: 'sandbox-local', monitorLayer: 'amp-gate', description: 'Edit sandbox files' }],
  ['apply_patch', { toolName: 'apply_patch', boundary: 'sandbox-local', monitorLayer: 'amp-gate', description: 'Patch sandbox files' }],
  ['exec', { toolName: 'exec', boundary: 'sandbox-local', monitorLayer: 'amp-gate', description: 'Execute commands in the VM' }],
  ['process', { toolName: 'process', boundary: 'sandbox-local', monitorLayer: 'amp-gate', description: 'Manage background processes in the VM' }],
  ['browser', { toolName: 'browser', boundary: 'sandbox-local', monitorLayer: 'amp-gate', description: 'Drive the VM-local browser' }],
  ['web_search', { toolName: 'web_search', boundary: 'sandbox-local', monitorLayer: 'amp-gate', description: 'Perform web searches from inside the VM' }],
  ['web_fetch', { toolName: 'web_fetch', boundary: 'sandbox-local', monitorLayer: 'amp-gate', description: 'Fetch remote web content from inside the VM' }],
  ['memory_search', { toolName: 'memory_search', boundary: 'sandbox-local', monitorLayer: 'amp-gate', description: 'Search local agent memory' }],
  ['memory_get', { toolName: 'memory_get', boundary: 'sandbox-local', monitorLayer: 'amp-gate', description: 'Read local agent memory' }],
  ['image', { toolName: 'image', boundary: 'sandbox-local', monitorLayer: 'amp-gate', description: 'Analyze local images' }],
  ['pdf', { toolName: 'pdf', boundary: 'sandbox-local', monitorLayer: 'amp-gate', description: 'Analyze local PDFs' }],
  ['agents_list', { toolName: 'agents_list', boundary: 'sandbox-local', monitorLayer: 'amp-gate', description: 'Inspect local OpenClaw agent configuration' }],

  ['sessions_list', { toolName: 'sessions_list', boundary: 'control-plane-routed', monitorLayer: 'amp-control', description: 'List Paddock sessions' }],
  ['sessions_history', { toolName: 'sessions_history', boundary: 'control-plane-routed', monitorLayer: 'amp-control', description: 'Read session history through the control plane' }],
  ['sessions_send', { toolName: 'sessions_send', boundary: 'control-plane-routed', monitorLayer: 'amp-control', description: 'Send a command to another session' }],
  ['sessions_spawn', { toolName: 'sessions_spawn', boundary: 'control-plane-routed', monitorLayer: 'amp-control', description: 'Spawn a sub-agent session' }],
  ['sessions_yield', { toolName: 'sessions_yield', boundary: 'control-plane-routed', monitorLayer: 'amp-control', description: 'Yield until sub-agent work completes' }],
  ['session_status', { toolName: 'session_status', boundary: 'control-plane-routed', monitorLayer: 'amp-control', description: 'Read session status through the control plane' }],
  ['subagents', { toolName: 'subagents', boundary: 'control-plane-routed', monitorLayer: 'amp-control', description: 'Manage spawned sub-agents' }],
  ['llm_prepare', { toolName: 'llm_prepare', boundary: 'control-plane-routed', monitorLayer: 'amp-control', description: 'Fetch host-side LLM policy overrides for native agent hooks' }],
  ['cron', { toolName: 'cron', boundary: 'control-plane-routed', monitorLayer: 'amp-control', description: 'Schedule future agent actions' }],
  ['rollback', { toolName: 'rollback', boundary: 'control-plane-routed', monitorLayer: 'amp-control', description: 'Restore a checkpoint or snapshot' }],

  ['message', { toolName: 'message', boundary: 'mcp-external', monitorLayer: 'mcp', description: 'Send outbound channel messages' }],
  ['canvas', { toolName: 'canvas', boundary: 'mcp-external', monitorLayer: 'mcp', description: 'Drive host or remote canvas surfaces' }],
  ['nodes', { toolName: 'nodes', boundary: 'mcp-external', monitorLayer: 'mcp', description: 'Reach host-attached or remote nodes/devices' }],
  ['tts', { toolName: 'tts', boundary: 'mcp-external', monitorLayer: 'mcp', description: 'Use external text-to-speech delivery' }],

  ['gateway', { toolName: 'gateway', boundary: 'disabled', monitorLayer: 'disabled', description: 'Gateway self-administration is disabled inside sandboxes' }],
]);

const PREFIX_BOUNDARIES: Array<{
  prefix: string;
  boundary: OpenClawToolBoundary;
  monitorLayer: OpenClawOperationProfileEntry['monitorLayer'];
  description: string;
}> = [
  { prefix: 'browser.', boundary: 'mcp-external', monitorLayer: 'mcp', description: 'Host-side browser bridge operations' },
  { prefix: 'clipboard.', boundary: 'mcp-external', monitorLayer: 'mcp', description: 'Host clipboard operations' },
  { prefix: 'tts.', boundary: 'mcp-external', monitorLayer: 'mcp', description: 'External TTS operations' },
  { prefix: 'applescript.', boundary: 'mcp-external', monitorLayer: 'mcp', description: 'Host AppleScript operations' },
  { prefix: 'channel.', boundary: 'mcp-external', monitorLayer: 'mcp', description: 'Outbound channel operations' },
  { prefix: 'api.', boundary: 'mcp-external', monitorLayer: 'mcp', description: 'Credential-backed external APIs' },
];

export function classifyOpenClawToolBoundary(toolName: string): OpenClawToolBoundary {
  const normalized = toolName.trim().toLowerCase();
  if (!normalized) return 'disabled';

  const exact = EXACT_TOOL_BOUNDARIES.get(normalized);
  if (exact) {
    return exact.boundary;
  }

  const prefixed = PREFIX_BOUNDARIES.find((entry) => normalized.startsWith(entry.prefix));
  if (prefixed) {
    return prefixed.boundary;
  }

  return 'disabled';
}

export function getOpenClawOperationProfile(): OpenClawOperationProfileEntry[] {
  return [
    ...EXACT_TOOL_BOUNDARIES.values(),
    ...PREFIX_BOUNDARIES.map((entry) => ({
      toolName: `${entry.prefix}*`,
      boundary: entry.boundary,
      monitorLayer: entry.monitorLayer,
      description: entry.description,
    })),
  ];
}
