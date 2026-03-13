// HITL (Human-in-the-Loop) types

export type HITLVerdict = 'approved' | 'rejected' | 'modified';

export interface HITLRequest {
  id: string;
  sessionId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  reason: string;
  timestamp: number;
}

export interface HITLDecision {
  requestId: string;
  verdict: HITLVerdict;
  modifiedArgs?: Record<string, unknown>;
  decidedAt: number;
}

export interface HITLPolicy {
  toolPattern: string;
  action: 'approve' | 'block' | 'ask';
}

export const DEFAULT_POLICIES: HITLPolicy[] = [
  { toolPattern: 'read',       action: 'approve' },
  { toolPattern: 'edit',       action: 'approve' },
  { toolPattern: 'write',      action: 'approve' },
  { toolPattern: 'exec',       action: 'ask' },
  { toolPattern: 'web_search', action: 'approve' },
  { toolPattern: 'web_fetch',  action: 'approve' },
  { toolPattern: 'browser',    action: 'ask' },
  { toolPattern: 'host.*',     action: 'ask' },
];
