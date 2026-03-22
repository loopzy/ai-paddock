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

type LLMReviewVerdict = 'allow' | 'warn' | 'ask' | 'block';

interface LLMReviewSignal {
  phase: 'request' | 'response';
  verdict: LLMReviewVerdict;
  riskScore: number;
  triggered: string[];
  reason?: string;
  confidence?: number;
  source?: string;
  summary?: string;
}

interface ActiveLLMReviewState extends LLMReviewSignal {
  penaltyBoost: number;
  forceAsk: boolean;
  forceReject: boolean;
  observedAt: number;
  expiresAt: number;
}

const ACTIVE_LLM_REVIEW_TTL_MS = 5 * 60_000;

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
  private activeLLMReviews: Partial<Record<'request' | 'response', ActiveLLMReviewState>>;

  constructor(workspaceOrOptions?: string | PolicyGateOptions) {
    const options: PolicyGateOptions =
      typeof workspaceOrOptions === 'string'
        ? { workspace: workspaceOrOptions }
        : (workspaceOrOptions ?? {});

    this.ruleEngine = new RuleEngine(options.workspace);
    this.taintTracker = new TaintTracker();
    this.behaviorAnalyzer = options.behaviorAnalyzer ?? new BehaviorAnalyzer();
    this.trustProfile = { score: 100, anomalyCount: 0, penaltyBoost: 0 };
    this.activeLLMReviews = {};
  }

  /**
   * Evaluate a tool call and return a verdict.
   */
  async evaluate(req: AMPGateRequest): Promise<AMPGateVerdict> {
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
    const behavior = await this.behaviorAnalyzer.evaluate(event);
    const llmReview = this.getActiveLLMReview();

    // Composite scoring
    const baseRisk = Math.max(rules.baseRisk, taint.risk);
    const behaviorRisk = behavior.riskBoost;
    const llmReviewRisk = llmReview?.penaltyBoost ?? 0;
    const trustPenalty = this.trustProfile.penaltyBoost;
    let risk = baseRisk + behaviorRisk;
    risk += llmReviewRisk;
    risk += trustPenalty;
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
    if (llmReview?.forceReject) {
      verdict = 'reject';
    } else if (llmReview?.forceAsk && verdict === 'approve') {
      verdict = 'ask';
    }

    // Update trust profile on anomalies
    const allTriggered = [...rules.triggered, ...taint.matches, ...behavior.triggered, ...(llmReview?.triggered ?? [])];
    if (allTriggered.length > 0) {
      this.recordAnomaly();
    }

    return {
      verdict,
      riskScore: risk,
      triggeredRules: allTriggered,
      behaviorFlags: behavior.triggered.length > 0 ? behavior.triggered : undefined,
      behaviorReview:
        behavior.source || behavior.reason || behavior.triggered.length > 0 || behavior.riskBoost > 0
          ? {
              riskBoost: behavior.riskBoost,
              triggered: behavior.triggered,
              reason: behavior.reason,
              confidence: behavior.confidence,
              source: behavior.source,
            }
          : undefined,
      riskBreakdown: {
        rules: rules.baseRisk,
        taint: taint.risk,
        behavior: behaviorRisk,
        llmReview: llmReviewRisk,
        trustPenalty,
      },
      llmReview: llmReview
        ? {
            phase: llmReview.phase,
            verdict: llmReview.verdict,
            riskScore: llmReview.riskScore,
            triggered: llmReview.triggered,
            reason: llmReview.reason,
            confidence: llmReview.confidence,
            source: llmReview.source,
            summary: llmReview.summary,
          }
        : undefined,
      reason: allTriggered.length > 0 ? allTriggered.join(', ') : undefined,
    };
  }

  /**
   * Feed tool results into taint tracker for propagation.
   */
  onToolResult(toolName: string, result: string, meta?: { path?: string }): void {
    this.taintTracker.onToolResult(toolName, result, meta);
  }

  onLLMReview(review: LLMReviewSignal): void {
    const observedAt = Date.now();
    const penaltyBoost = this.mapLLMReviewPenalty(review.verdict, review.riskScore);
    const state: ActiveLLMReviewState = {
      ...review,
      penaltyBoost,
      forceAsk: review.verdict === 'ask',
      forceReject: review.verdict === 'block',
      observedAt,
      expiresAt: observedAt + ACTIVE_LLM_REVIEW_TTL_MS,
    };

    if (review.phase === 'request') {
      this.activeLLMReviews.response = undefined;
    }
    this.activeLLMReviews[review.phase] = state;

    if (review.verdict !== 'allow' || review.riskScore >= 40) {
      this.recordAnomaly(this.mapLLMReviewTrustPenalty(review.verdict));
    }
  }

  private recordAnomaly(weight = 1): void {
    this.trustProfile.anomalyCount += weight;
    this.trustProfile.score = Math.max(0, this.trustProfile.score - (5 * weight));
    if (this.trustProfile.score < 30) {
      this.trustProfile.penaltyBoost = 40;
    } else if (this.trustProfile.score < 60) {
      this.trustProfile.penaltyBoost = 20;
    }
  }

  private mapLLMReviewPenalty(verdict: LLMReviewVerdict, riskScore: number): number {
    switch (verdict) {
      case 'warn':
        return Math.max(10, Math.min(25, Math.round(riskScore / 4)));
      case 'ask':
        return Math.max(30, Math.min(50, Math.round(riskScore / 2)));
      case 'block':
        return Math.max(60, Math.min(90, riskScore));
      case 'allow':
      default:
        return 0;
    }
  }

  private mapLLMReviewTrustPenalty(verdict: LLMReviewVerdict): number {
    switch (verdict) {
      case 'warn':
        return 1;
      case 'ask':
        return 2;
      case 'block':
        return 3;
      case 'allow':
      default:
        return 0;
    }
  }

  private getActiveLLMReview(now = Date.now()): ActiveLLMReviewState | undefined {
    const requestReview = this.pruneExpiredReview('request', now);
    const responseReview = this.pruneExpiredReview('response', now);
    const candidates = [requestReview, responseReview].filter((value): value is ActiveLLMReviewState => Boolean(value));
    if (candidates.length === 0) {
      return undefined;
    }

    const strongest = [...candidates].sort((left, right) => {
      if (left.forceReject !== right.forceReject) return left.forceReject ? -1 : 1;
      if (left.forceAsk !== right.forceAsk) return left.forceAsk ? -1 : 1;
      if (left.penaltyBoost !== right.penaltyBoost) return right.penaltyBoost - left.penaltyBoost;
      return right.riskScore - left.riskScore;
    })[0];

    return {
      ...strongest,
      triggered: Array.from(new Set(candidates.flatMap((candidate) => candidate.triggered))),
      reason: candidates.map((candidate) => candidate.reason).filter((value): value is string => Boolean(value)).join(' | ') || strongest.reason,
      source: Array.from(new Set(candidates.map((candidate) => candidate.source).filter((value): value is string => Boolean(value)))).join(', ') || strongest.source,
      summary: candidates.map((candidate) => candidate.summary).filter((value): value is string => Boolean(value)).join(' | ') || strongest.summary,
      penaltyBoost: Math.max(...candidates.map((candidate) => candidate.penaltyBoost)),
      forceAsk: candidates.some((candidate) => candidate.forceAsk),
      forceReject: candidates.some((candidate) => candidate.forceReject),
      riskScore: Math.max(...candidates.map((candidate) => candidate.riskScore)),
    };
  }

  private pruneExpiredReview(
    phase: 'request' | 'response',
    now: number,
  ): ActiveLLMReviewState | undefined {
    const review = this.activeLLMReviews[phase];
    if (!review) return undefined;
    if (review.expiresAt > now) return review;
    this.activeLLMReviews[phase] = undefined;
    return undefined;
  }

  getTrustProfile(): TrustProfile {
    return { ...this.trustProfile };
  }

  reset(): void {
    this.taintTracker.clear();
    this.behaviorAnalyzer.reset();
    this.trustProfile = { score: 100, anomalyCount: 0, penaltyBoost: 0 };
    this.activeLLMReviews = {};
  }
}
