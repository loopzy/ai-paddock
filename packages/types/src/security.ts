// Security engine types

export enum TaintLabel {
  Secret = 'Secret',
  PII = 'PII',
  ExternalContent = 'ExternalContent',
  FileContent = 'FileContent',
}

export interface TaintEntry {
  value: string;
  labels: Set<TaintLabel>;
  source: string;
  firstSeen: number;
}

export interface SequencePattern {
  name: string;
  desc: string;
  steps: Array<{ match: (e: ToolEvent) => boolean }>;
  maxGap: number;
  riskBoost: number;
}

export interface ToolEvent {
  toolName: string;
  toolInput: Record<string, unknown>;
  path?: string;
  timestamp: number;
}

export interface LoopGuardConfig {
  warnThreshold: number;
  blockThreshold: number;
  circuitBreaker: number;
  outcomeAware: boolean;
}

export interface LoopVerdict {
  action: 'allow' | 'warn' | 'block' | 'circuit-break';
  count: number;
  reason?: string;
}

export interface TrustProfile {
  score: number;
  anomalyCount: number;
  penaltyBoost: number;
}

export interface RuleResult {
  baseRisk: number;
  triggered: string[];
}

export interface TaintResult {
  risk: number;
  matches: string[];
}

export interface BehaviorResult {
  riskBoost: number;
  triggered: string[];
  loopVerdict?: LoopVerdict;
}

export interface BehaviorAnalyzerProvider {
  evaluate(event: ToolEvent, lastResult?: string): BehaviorResult;
  reset(): void;
}
