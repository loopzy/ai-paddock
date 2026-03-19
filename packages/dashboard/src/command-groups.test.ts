import { describe, expect, it } from 'vitest';
import { buildCommandRuns } from './command-groups.js';

function event(
  seq: number,
  type: string,
  payload: Record<string, unknown>,
  overrides?: Partial<{ timestamp: number; id: string }>
) {
  return {
    id: overrides?.id ?? `evt-${seq}`,
    sessionId: 'sess-1',
    seq,
    timestamp: overrides?.timestamp ?? 1_700_000_000_000 + seq * 1_000,
    type,
    payload,
  };
}

describe('buildCommandRuns', () => {
  it('groups raw events into human-friendly command runs keyed by the dashboard command', () => {
    const runs = buildCommandRuns([
      event(1, 'user.command', { command: '去虎扑看看明天什么有什么球赛' }),
      event(2, 'amp.user.command', {
        command: '去虎扑看看明天什么有什么球赛',
        runId: 'run-1',
      }),
      event(3, 'llm.request', {
        provider: 'openrouter',
        model: 'moonshotai/kimi-k2',
        messageCount: 2,
        toolCount: 24,
        messagesPreview: [{ role: 'user', text: '去虎扑看看明天什么有什么球赛' }],
      }),
      event(4, 'llm.response', {
        provider: 'openrouter',
        model: 'moonshotai/kimi-k2',
        tokensIn: 1200,
        tokensOut: 80,
        responsePreview: '[tool] browser',
      }),
      event(5, 'amp.tool.intent', {
        toolName: 'browser',
        toolInput: { action: 'open', url: 'https://www.hupu.com' },
        runId: 'run-1',
      }),
      event(6, 'amp.gate.verdict', {
        verdict: 'approve',
        riskScore: 0,
        triggeredRules: [],
        runId: 'run-1',
      }),
      event(7, 'amp.tool.result', {
        result: { ok: true },
        runId: 'run-1',
        toolName: 'browser',
      }),
      event(8, 'amp.agent.message', {
        text: '明天有几场足球和篮球比赛。',
        runId: 'run-1',
      }),
    ]);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      command: '去虎扑看看明天什么有什么球赛',
      runId: 'run-1',
      status: 'completed',
      responseText: '明天有几场足球和篮球比赛。',
      toolNames: ['browser'],
      toolsUsed: 1,
      approvals: 1,
      blockers: 0,
      hasRawLogs: true,
      currentActivity: 'Reply: 明天有几场足球和篮球比赛。',
    });
    expect(runs[0].steps[0]).toMatchObject({
      kind: 'llm-request',
      summary: 'openrouter / moonshotai/kimi-k2 · 去虎扑看看明天什么有什么球赛',
    });
    expect(runs[0].steps[0]?.children[1]).toMatchObject({
      kind: 'tool-intent',
      title: 'Tool · browser',
      detail: JSON.stringify({ action: 'open', url: 'https://www.hupu.com' }, null, 2),
    });
    expect(runs[0].steps.at(-1)).toMatchObject({
      kind: 'agent-message',
      detail: '明天有几场足球和篮球比赛。',
    });
  });

  it('marks aborted runs and keeps the stop target available while the command is active', () => {
    const runs = buildCommandRuns([
      event(1, 'user.command', { command: '长时间运行的任务' }),
      event(2, 'amp.user.command', {
        command: '长时间运行的任务',
        runId: 'run-2',
      }),
      event(3, 'amp.tool.intent', {
        toolName: 'exec',
        toolInput: { command: 'sleep 1000' },
        runId: 'run-2',
      }),
      event(4, 'amp.command.status', {
        status: 'aborted',
        runId: 'run-2',
      }),
    ]);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      runId: 'run-2',
      status: 'aborted',
      active: false,
      stopTargetRunId: 'run-2',
    });
  });

  it('falls back to sequence-based grouping when a command has not received a run id yet', () => {
    const runs = buildCommandRuns([
      event(1, 'user.command', { command: '第一个命令' }),
      event(2, 'amp.tool.intent', {
        toolName: 'browser',
        toolInput: { action: 'open', url: 'https://example.com' },
      }),
      event(3, 'user.command', { command: '第二个命令' }),
      event(4, 'amp.agent.error', {
        code: 'ERR_TIMEOUT',
        message: 'Timed out',
      }),
    ]);

    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({
      command: '第二个命令',
      status: 'failed',
      latestError: 'Timed out',
    });
    expect(runs[1]).toMatchObject({
      command: '第一个命令',
      status: 'running',
      toolsUsed: 1,
    });
  });
});
