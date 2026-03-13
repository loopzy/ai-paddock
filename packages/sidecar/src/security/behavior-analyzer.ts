import type {
  ToolEvent,
  BehaviorResult,
  LoopVerdict,
  LoopGuardConfig,
  BehaviorAnalyzerProvider,
} from '@paddock/types';
import { createHash } from 'node:crypto';

// Sensitive path helpers
function isSensitivePath(path?: string): boolean {
  if (!path) return false;
  return /\.(env|pem|key|ssh|secret)/.test(path) || /\/etc\/(passwd|shadow)/.test(path) || /\.ssh\//.test(path);
}
function isWorkspacePath(path?: string): boolean {
  return !!path && (path.startsWith('/workspace') || path.startsWith('./'));
}
function isSystemPath(path?: string): boolean {
  return !!path && /^\/(etc|usr|var|root|boot|sys|proc)\//.test(path);
}

interface SequencePattern {
  name: string;
  desc: string;
  steps: Array<{ match: (e: ToolEvent) => boolean }>;
  maxGap: number;
  riskBoost: number;
}

const SEQUENCE_PATTERNS: SequencePattern[] = [
  {
    name: 'data_exfiltration',
    desc: 'Read sensitive file then make external request',
    steps: [
      { match: (e) => e.toolName === 'read' && isSensitivePath(e.path) },
      { match: (e) => ['exec', 'web_fetch'].includes(e.toolName) },
    ],
    maxGap: 10,
    riskBoost: 40,
  },
  {
    name: 'privilege_escalation',
    desc: 'Move from workspace to system directories',
    steps: [
      { match: (e) => isWorkspacePath(e.path) },
      { match: (e) => isSystemPath(e.path) },
    ],
    maxGap: 15,
    riskBoost: 30,
  },
];

const DEFAULT_LOOP_CONFIG: LoopGuardConfig = {
  warnThreshold: 3,
  blockThreshold: 5,
  circuitBreaker: 30,
  outcomeAware: true,
};

class LoopGuard {
  private config: LoopGuardConfig;
  private callFingerprints = new Map<string, number>(); // hash → count
  private resultFingerprints = new Map<string, number>(); // hash → count
  private totalCalls = 0;

  constructor(config: LoopGuardConfig = DEFAULT_LOOP_CONFIG) {
    this.config = config;
  }

  evaluate(toolName: string, toolInput: Record<string, unknown>, lastResult?: string): LoopVerdict {
    this.totalCalls++;

    // Circuit breaker
    if (this.totalCalls >= this.config.circuitBreaker) {
      return { action: 'circuit-break', count: this.totalCalls, reason: `Total calls (${this.totalCalls}) exceeded circuit breaker (${this.config.circuitBreaker})` };
    }

    const callHash = this.hash(`${toolName}:${JSON.stringify(toolInput)}`);
    const callCount = (this.callFingerprints.get(callHash) ?? 0) + 1;
    this.callFingerprints.set(callHash, callCount);

    // Outcome-aware: same call + same result = stronger signal
    if (this.config.outcomeAware && lastResult) {
      const resultHash = this.hash(`${callHash}:${lastResult.slice(0, 500)}`);
      const resultCount = (this.resultFingerprints.get(resultHash) ?? 0) + 1;
      this.resultFingerprints.set(resultHash, resultCount);

      if (resultCount >= this.config.blockThreshold) {
        return { action: 'block', count: resultCount, reason: `Same call+result repeated ${resultCount} times` };
      }
      if (resultCount >= this.config.warnThreshold) {
        return { action: 'warn', count: resultCount, reason: `Same call+result repeated ${resultCount} times` };
      }
    }

    if (callCount >= this.config.blockThreshold) {
      return { action: 'block', count: callCount, reason: `Same call repeated ${callCount} times` };
    }
    if (callCount >= this.config.warnThreshold) {
      return { action: 'warn', count: callCount, reason: `Same call repeated ${callCount} times` };
    }

    return { action: 'allow', count: callCount };
  }

  private hash(input: string): string {
    return createHash('sha256').update(input).digest('hex').slice(0, 16);
  }

  reset(): void {
    this.callFingerprints.clear();
    this.resultFingerprints.clear();
    this.totalCalls = 0;
  }
}

export class BehaviorAnalyzer implements BehaviorAnalyzerProvider {
  private window: ToolEvent[] = [];
  private maxWindow = 20;
  private loopGuard: LoopGuard;

  constructor(loopConfig?: LoopGuardConfig) {
    this.loopGuard = new LoopGuard(loopConfig);
  }

  evaluate(event: ToolEvent, lastResult?: string): BehaviorResult {
    this.window.push(event);
    if (this.window.length > this.maxWindow) {
      this.window.shift();
    }

    const triggered: string[] = [];
    let riskBoost = 0;

    // Check sequence patterns
    for (const pattern of SEQUENCE_PATTERNS) {
      if (this.matchSequence(pattern)) {
        triggered.push(pattern.name);
        riskBoost += pattern.riskBoost;
      }
    }

    // Check loop guard
    const loopVerdict = this.loopGuard.evaluate(event.toolName, event.toolInput, lastResult);
    if (loopVerdict.action === 'block' || loopVerdict.action === 'circuit-break') {
      triggered.push(`loop:${loopVerdict.action}`);
      riskBoost += 30;
    } else if (loopVerdict.action === 'warn') {
      triggered.push('loop:warn');
      riskBoost += 10;
    }

    return { riskBoost, triggered, loopVerdict };
  }

  private matchSequence(pattern: SequencePattern): boolean {
    let stepIdx = 0;
    let lastMatchIdx = -1;

    for (let i = 0; i < this.window.length && stepIdx < pattern.steps.length; i++) {
      if (pattern.steps[stepIdx].match(this.window[i])) {
        if (stepIdx > 0 && lastMatchIdx >= 0 && (i - lastMatchIdx) > pattern.maxGap) {
          // Gap too large, reset
          stepIdx = 0;
          lastMatchIdx = -1;
          if (pattern.steps[0].match(this.window[i])) {
            stepIdx = 1;
            lastMatchIdx = i;
          }
          continue;
        }
        lastMatchIdx = i;
        stepIdx++;
      }
    }

    return stepIdx >= pattern.steps.length;
  }

  reset(): void {
    this.window = [];
    this.loopGuard.reset();
  }
}
