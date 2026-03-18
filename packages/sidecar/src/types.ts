// Re-export types from @paddock/types
export type {
  AMPEventType,
  AMPEvent,
  AMPGateRequest,
  AMPGateVerdict,
  AMPAgentError,
  AMPHealthStatus,
  AMPAgentErrorCategory,
} from '@paddock/types';

// Sidecar event type: includes both legacy and AMP event types
export type EventType =
  | 'llm.request'
  | 'llm.response'
  | 'agent.thought'
  | 'tool.intent'
  | 'tool.result'
  | 'fs.change'
  | 'user.command'
  | 'hitl.request'
  | 'hitl.decision'
  | 'snapshot.created'
  | 'snapshot.restored'
  | 'session.status'
  // AMP event types
  | 'amp.llm.request' | 'amp.llm.response'
  | 'amp.tool.intent' | 'amp.tool.result'
  | 'amp.thought'
  | 'amp.trace'
  | 'amp.fs.change'
  | 'amp.net.egress' | 'amp.process.spawn'
  | 'amp.session.start' | 'amp.session.end'
  | 'amp.snapshot.created' | 'amp.snapshot.restored'
  | 'amp.hitl.request' | 'amp.hitl.decision'
  | 'amp.user.command'
  | 'amp.gate.verdict'
  // Agent Lifecycle
  | 'amp.agent.ready' | 'amp.agent.message' | 'amp.agent.heartbeat'
  | 'amp.agent.error' | 'amp.agent.fatal'
  | 'amp.agent.exit';
