import type {
  BehaviorAnalyzerProvider,
  BehaviorResult,
  LoopVerdict,
  ToolEvent,
} from '@paddock/types';

const LOOP_VERDICT_PRIORITY: Record<LoopVerdict['action'], number> = {
  allow: 0,
  warn: 1,
  block: 2,
  'circuit-break': 3,
};

function mergeLoopVerdicts(left?: LoopVerdict, right?: LoopVerdict): LoopVerdict | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return LOOP_VERDICT_PRIORITY[right.action] > LOOP_VERDICT_PRIORITY[left.action] ? right : left;
}

export class CompositeBehaviorAnalyzer implements BehaviorAnalyzerProvider {
  private readonly analyzers: BehaviorAnalyzerProvider[];

  constructor(analyzers: BehaviorAnalyzerProvider[]) {
    this.analyzers = analyzers;
  }

  async evaluate(event: ToolEvent, lastResult?: string): Promise<BehaviorResult> {
    const results = await Promise.all(this.analyzers.map((analyzer) => analyzer.evaluate(event, lastResult)));

    return results.reduce<BehaviorResult>(
      (combined, current) => ({
        riskBoost: combined.riskBoost + current.riskBoost,
        triggered: Array.from(new Set([...combined.triggered, ...current.triggered])),
        loopVerdict: mergeLoopVerdicts(combined.loopVerdict, current.loopVerdict),
        reason: combined.reason ?? current.reason,
        confidence: combined.confidence ?? current.confidence,
        source: combined.source ?? current.source,
      }),
      { riskBoost: 0, triggered: [] },
    );
  }

  reset(): void {
    for (const analyzer of this.analyzers) {
      analyzer.reset();
    }
  }
}
