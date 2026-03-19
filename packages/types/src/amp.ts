// AMP (Agent Monitoring Protocol) event types and Policy Gate types

export type AMPEventType =
  // Intent layer
  | 'amp.llm.request' | 'amp.llm.response'
  | 'amp.tool.intent' | 'amp.tool.result'
  | 'amp.thought'
  | 'amp.trace'
  // Effect layer
  | 'amp.fs.change'
  | 'amp.net.egress'
  | 'amp.process.spawn'
  // System / HITL / User
  | 'amp.session.start' | 'amp.session.end'
  | 'amp.snapshot.created' | 'amp.snapshot.restored'
  | 'amp.hitl.request' | 'amp.hitl.decision'
  | 'amp.user.command'
  | 'amp.command.status'
  // Security engine
  | 'amp.gate.verdict'
  // Agent Lifecycle layer
  | 'amp.agent.ready'
  | 'amp.agent.message'
  | 'amp.agent.heartbeat'
  | 'amp.agent.error'
  | 'amp.agent.fatal'
  | 'amp.agent.exit';

export interface AMPEvent {
  id: string;
  sessionId: string;
  seq: number;
  timestamp: number;
  type: AMPEventType;
  payload: Record<string, unknown>;
  correlationId?: string;
  causedBy?: string;
  snapshotRef?: string;
}

// Policy Gate: tool call approval request / verdict
export interface AMPGateRequest {
  correlationId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

export interface AMPGateVerdict {
  verdict: 'approve' | 'modify' | 'reject' | 'ask';
  riskScore: number;
  triggeredRules: string[];
  behaviorFlags?: string[];
  behaviorReview?: {
    riskBoost: number;
    triggered: string[];
    reason?: string;
    confidence?: number;
    source?: string;
  };
  riskBreakdown?: {
    rules: number;
    taint: number;
    behavior: number;
    trustPenalty: number;
  };
  reason?: string;
  modifiedInput?: Record<string, unknown>;
  snapshotRef?: string;
}

// ─── Agent Lifecycle Types ───

export type AMPAgentErrorCategory = 'config' | 'network' | 'auth' | 'resource' | 'runtime' | 'dependency';

export interface AMPAgentError {
  category: AMPAgentErrorCategory;
  code: string;
  message: string;
  recoverable: boolean;
  context?: Record<string, unknown>;
}

export interface AMPHealthStatus {
  healthy: boolean;
  uptime: number;
  memoryMB: number;
  pendingTasks: number;
  errors?: AMPAgentError[];
}

export interface AMPReporter {
  report(type: AMPEventType, payload: Record<string, unknown>): Promise<void>;
}

export interface AMPAgentAdapter {
  readonly name: string;
  readonly version: string;

  onReady(reporter: AMPReporter): Promise<void>;
  onError(reporter: AMPReporter, error: AMPAgentError): Promise<void>;
  onExit(reporter: AMPReporter, exitCode: number, reason: string): Promise<void>;

  getHealthStatus(): Promise<AMPHealthStatus>;
}
