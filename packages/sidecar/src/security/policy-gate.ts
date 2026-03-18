import type {
  AMPGateRequest,
  AMPGateVerdict,
  TrustProfile,
  ToolEvent,
  BehaviorAnalyzerProvider,
} from '@paddock/types';
import { RuleEngine } from './rule-engine.js';
import { TaintTracker } from './taint-tracker.js';
import { BehaviorAnalyzer } from './behavior-analyzer.js';

interface PolicyGateOptions {
  workspace?: string;
  behaviorAnalyzer?: BehaviorAnalyzerProvider;
}

/**
 * PolicyGate — orchestrates all security layers and produces a final verdict.
 *
 * Layers:
 *   1. Deterministic rule engine (<1ms)
 *   2. Taint tracking (<5ms)
 *   3. Behavior sequence analysis (<10ms)
 *   4. Trust decay scoring
 */
export class PolicyGate {
  private ruleEngine: RuleEngine;
  private taintTracker: TaintTracker;
  private behaviorAnalyzer: BehaviorAnalyzerProvider;
  private trustProfile: TrustProfile;

  constructor(workspaceOrOptions?: string | PolicyGateOptions) {
    const options: PolicyGateOptions =
      typeof workspaceOrOptions === 'string'
        ? { workspace: workspaceOrOptions }
        : (workspaceOrOptions ?? {});

    this.ruleEngine = new RuleEngine(options.workspace);
    this.taintTracker = new TaintTracker();
    this.behaviorAnalyzer = options.behaviorAnalyzer ?? new BehaviorAnalyzer();
    this.trustProfile = { score: 100, anomalyCount: 0, penaltyBoost: 0 };
  }

  /**
   * Evaluate a tool call and return a verdict.
   */
  evaluate(req: AMPGateRequest): AMPGateVerdict {
    const normalizedToolName = req.toolName.trim().toLowerCase();
    if (normalizedToolName === 'gateway') {
      this.recordAnomaly();
      return {
        verdict: 'reject',
        riskScore: 100,
        triggeredRules: ['boundary:disabled_tool'],
        reason: 'The gateway tool is disabled inside Paddock sandboxes.',
      };
    }

    // Layer 1: Rule engine
    const rules = this.ruleEngine.evaluate(req.toolName, req.toolInput);

    // Layer 2: Taint tracking
    const serialized = JSON.stringify(req.toolInput);
    const taint = this.taintTracker.checkToolIntent(req.toolName, serialized);

    // Layer 3: Behavior analysis
    const event: ToolEvent = {
      toolName: req.toolName,
      toolInput: req.toolInput,
      path: String(req.toolInput.path ?? req.toolInput.file_path ?? ''),
      timestamp: Date.now(),
    };
    const behavior = this.behaviorAnalyzer.evaluate(event);

    // Composite scoring
    let risk = Math.max(rules.baseRisk, taint.risk) + behavior.riskBoost;
    risk += this.trustProfile.penaltyBoost;
    risk = Math.min(risk, 100);

    // Monitor-first verdicts: keep capability available and escalate risky actions
    // to HITL instead of hard-blocking them. Explicit disabled boundaries (for
    // example `gateway`) are rejected above before we reach this point.
    let verdict: 'approve' | 'ask' | 'reject';
    if (risk <= 30) {
      verdict = 'approve';
    } else if (risk <= 70) {
      verdict = 'approve'; // pass-through with alert
    } else {
      verdict = 'ask'; // HITL approval required
    }

    // Update trust profile on anomalies
    const allTriggered = [...rules.triggered, ...taint.matches, ...behavior.triggered];
    if (allTriggered.length > 0) {
      this.recordAnomaly();
    }

    return {
      verdict,
      riskScore: risk,
      triggeredRules: allTriggered,
      behaviorFlags: behavior.triggered.length > 0 ? behavior.triggered : undefined,
      reason: allTriggered.length > 0 ? allTriggered.join(', ') : undefined,
    };
  }

  /**
   * Feed tool results into taint tracker for propagation.
   */
  onToolResult(toolName: string, result: string, meta?: { path?: string }): void {
    this.taintTracker.onToolResult(toolName, result, meta);
  }

  private recordAnomaly(): void {
    this.trustProfile.anomalyCount++;
    this.trustProfile.score = Math.max(0, this.trustProfile.score - 5);
    if (this.trustProfile.score < 30) {
      this.trustProfile.penaltyBoost = 40;
    } else if (this.trustProfile.score < 60) {
      this.trustProfile.penaltyBoost = 20;
    }
  }

  getTrustProfile(): TrustProfile {
    return { ...this.trustProfile };
  }

  reset(): void {
    this.taintTracker.clear();
    this.behaviorAnalyzer.reset();
    this.trustProfile = { score: 100, anomalyCount: 0, penaltyBoost: 0 };
  }
}
