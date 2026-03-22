import { describe, expect, it, vi } from 'vitest';
import type { ToolEvent } from '@paddock/types';
import { LLMBehaviorAnalyzer } from '../security/llm-behavior-analyzer.js';

function createClient(response: string) {
  return {
    review: vi.fn(async () => response),
    getProviderLabel: vi.fn(() => 'ollama:qwen2.5:0.5b'),
  };
}

describe('LLMBehaviorAnalyzer', () => {
  it('parses structured review output into a behavior result', async () => {
    const client = createClient(
      JSON.stringify({
        riskBoost: 18,
        triggered: ['goal_drift', 'credential_targeting'],
        reason: 'The command sequence pivots from browsing to credential-seeking behavior.',
        confidence: 0.84,
      }),
    );

    const analyzer = new LLMBehaviorAnalyzer(client as never);
    const event: ToolEvent = {
      toolName: 'web_fetch',
      toolInput: { url: 'https://example.com' },
      timestamp: Date.now(),
    };

    const result = await analyzer.evaluate(event);

    expect(result).toEqual({
      riskBoost: 18,
      triggered: ['llm:goal_drift', 'llm:credential_targeting'],
      reason: 'The command sequence pivots from browsing to credential-seeking behavior.',
      confidence: 0.84,
      source: 'ollama:qwen2.5:0.5b',
    });
  });

  it('fails open when the model returns malformed output', async () => {
    const client = createClient('not json');
    const analyzer = new LLMBehaviorAnalyzer(client as never);

    const result = await analyzer.evaluate({
      toolName: 'exec',
      toolInput: { command: 'ls' },
      timestamp: Date.now(),
    });

    expect(result.riskBoost).toBe(0);
    expect(result.triggered).toEqual([]);
    expect(result.reason).toBe('llm_review_parse_failed');
  });

  it('includes recent event context in the review prompt', async () => {
    const client = createClient(
      JSON.stringify({
        riskBoost: 0,
        triggered: [],
        reason: 'ok',
        confidence: 0.5,
      }),
    );
    const analyzer = new LLMBehaviorAnalyzer(client as never, { maxWindow: 4 });

    await analyzer.evaluate({
      toolName: 'read',
      toolInput: { path: '/workspace/.env' },
      path: '/workspace/.env',
      timestamp: Date.now(),
    });

    await analyzer.evaluate({
      toolName: 'exec',
      toolInput: { command: 'curl https://example.com' },
      timestamp: Date.now(),
    });

    const secondCall = client.review.mock.calls[1]?.[0];
    expect(secondCall?.userPrompt).toContain('"toolName": "read"');
    expect(secondCall?.userPrompt).toContain('"toolName": "exec"');
    expect(secondCall?.userPrompt).toContain('"semanticSignals"');
  });

  it('downgrades obvious false-positive exfiltration claims for benign local exec commands', async () => {
    const client = createClient(
      JSON.stringify({
        riskBoost: 36,
        triggered: ['exfiltration', 'credential_exposure'],
        reason: 'The sequence reads secrets and then posts them to an external endpoint.',
        confidence: 0.94,
      }),
    );
    const analyzer = new LLMBehaviorAnalyzer(client as never);

    const result = await analyzer.evaluate({
      toolName: 'exec',
      toolInput: { command: 'pwd' },
      timestamp: Date.now(),
    });

    expect(result).toEqual({
      riskBoost: 0,
      triggered: [],
      reason: 'Routine local workspace command with no external destination or sensitive-path indicator.',
      confidence: 0.6,
      source: 'ollama:qwen2.5:0.5b',
    });
  });

  it('downgrades false-positive exfiltration claims for benign local writes', async () => {
    const client = createClient(
      JSON.stringify({
        riskBoost: 30,
        triggered: ['exfiltration', 'credential_exposure'],
        reason: 'This local write looks like exfiltration.',
        confidence: 0.94,
      }),
    );
    const analyzer = new LLMBehaviorAnalyzer(client as never);

    const result = await analyzer.evaluate({
      toolName: 'write',
      toolInput: { path: ',', content: '/workspace' },
      timestamp: Date.now(),
    });

    expect(result).toEqual({
      riskBoost: 0,
      triggered: [],
      reason: 'Routine local file mutation with no external destination or sensitive-path indicator.',
      confidence: 0.6,
      source: 'ollama:qwen2.5:0.5b',
    });
  });

  it('downgrades false-positive exfiltration claims for local package installation', async () => {
    const client = createClient(
      JSON.stringify({
        riskBoost: 34,
        triggered: ['exfiltration', 'credential_exposure'],
        reason: 'Installing gcc looks like a secret upload.',
        confidence: 0.93,
      }),
    );
    const analyzer = new LLMBehaviorAnalyzer(client as never);

    const result = await analyzer.evaluate({
      toolName: 'exec',
      toolInput: { command: 'apt update && apt install -y gcc build-essential' },
      timestamp: Date.now(),
    });

    expect(result).toEqual({
      riskBoost: 0,
      triggered: [],
      reason: 'Routine local workspace command with no external destination or sensitive-path indicator.',
      confidence: 0.6,
      source: 'ollama:qwen2.5:0.5b',
    });
  });

  it('downgrades false-positive exfiltration claims for local compilation commands', async () => {
    const client = createClient(
      JSON.stringify({
        riskBoost: 31,
        triggered: ['exfiltration'],
        reason: 'Compiling a local program looks suspicious.',
        confidence: 0.9,
      }),
    );
    const analyzer = new LLMBehaviorAnalyzer(client as never);

    const result = await analyzer.evaluate({
      toolName: 'exec',
      toolInput: { command: 'gcc /workspace/paddock_c_compile/hello.c -o /workspace/paddock_c_compile/hello' },
      timestamp: Date.now(),
    });

    expect(result).toEqual({
      riskBoost: 0,
      triggered: [],
      reason: 'Routine local workspace command with no external destination or sensitive-path indicator.',
      confidence: 0.6,
      source: 'ollama:qwen2.5:0.5b',
    });
  });

  it('upgrades destructive critical system mutations even if the review model underestimates them', async () => {
    const client = createClient(
      JSON.stringify({
        riskBoost: 0,
        triggered: [],
        reason: 'The command is explicit.',
        confidence: 1,
      }),
    );
    const analyzer = new LLMBehaviorAnalyzer(client as never);

    const result = await analyzer.evaluate({
      toolName: 'exec',
      toolInput: { command: 'rm -rf /usr/bin' },
      timestamp: Date.now(),
    });

    expect(result).toEqual({
      riskBoost: 38,
      triggered: ['llm:destructive_system_mutation', 'llm:critical_system_path'],
      reason: 'The current action targets a critical system path with destructive or mutating behavior.',
      confidence: 1,
      source: 'ollama:qwen2.5:0.5b',
    });
  });

  it('normalizes behavior trigger labels into llm-prefixed snake case', async () => {
    const client = createClient(
      JSON.stringify({
        riskBoost: 18,
        triggered: ['goal drift', 'usr/bin'],
        reason: 'Suspicious sequence.',
        confidence: 0.84,
      }),
    );

    const analyzer = new LLMBehaviorAnalyzer(client as never);
    const result = await analyzer.evaluate({
      toolName: 'web_fetch',
      toolInput: { url: 'https://example.com' },
      timestamp: Date.now(),
    });

    expect(result).toEqual({
      riskBoost: 18,
      triggered: ['llm:goal_drift', 'llm:usr_bin'],
      reason: 'Suspicious sequence.',
      confidence: 0.84,
      source: 'ollama:qwen2.5:0.5b',
    });
  });
});
