import { describe, expect, it, vi } from 'vitest';
import type { BehaviorAnalyzerProvider, ToolEvent } from '@paddock/types';
import { CompositeBehaviorAnalyzer } from '../security/composite-behavior-analyzer.js';

describe('CompositeBehaviorAnalyzer', () => {
  it('merges results from deterministic and llm analyzers', async () => {
    const first: BehaviorAnalyzerProvider = {
      evaluate: vi.fn().mockResolvedValue({
        riskBoost: 10,
        triggered: ['loop:warn'],
        loopVerdict: { action: 'warn', count: 3, reason: 'repeat' },
      }),
      reset: vi.fn(),
    };
    const second: BehaviorAnalyzerProvider = {
      evaluate: vi.fn().mockResolvedValue({
        riskBoost: 14,
        triggered: ['llm:goal_drift'],
        reason: 'semantic drift',
        confidence: 0.8,
        source: 'ollama:model',
      }),
      reset: vi.fn(),
    };

    const analyzer = new CompositeBehaviorAnalyzer([first, second]);
    const event: ToolEvent = {
      toolName: 'exec',
      toolInput: { command: 'ls' },
      timestamp: Date.now(),
    };

    const result = await analyzer.evaluate(event);

    expect(result).toEqual({
      riskBoost: 24,
      triggered: ['loop:warn', 'llm:goal_drift'],
      loopVerdict: { action: 'warn', count: 3, reason: 'repeat' },
      reason: 'semantic drift',
      confidence: 0.8,
      source: 'ollama:model',
    });
  });

  it('resets all child analyzers', () => {
    const first: BehaviorAnalyzerProvider = {
      evaluate: vi.fn(),
      reset: vi.fn(),
    };
    const second: BehaviorAnalyzerProvider = {
      evaluate: vi.fn(),
      reset: vi.fn(),
    };

    const analyzer = new CompositeBehaviorAnalyzer([first, second]);
    analyzer.reset();

    expect(first.reset).toHaveBeenCalledOnce();
    expect(second.reset).toHaveBeenCalledOnce();
  });
});
