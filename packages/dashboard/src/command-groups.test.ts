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
      totalTokensIn: 1200,
      totalTokensOut: 80,
      totalTokens: 1280,
    });
    expect(runs[0].steps[0]).toMatchObject({
      kind: 'llm-request',
      title: 'moonshotai/kimi-k2',
      meta: expect.stringContaining('openrouter'),
      rawLabel: expect.stringContaining('80 out'),
    });
    expect(runs[0].steps[0]?.children[0]).toMatchObject({
      kind: 'tool-intent',
      title: 'browser',
      summary: 'open https://www.hupu.com',
    });
    expect(runs[0].steps.at(-1)).toMatchObject({
      kind: 'agent-message',
      title: 'Answer',
      body: '明天有几场足球和篮球比赛。',
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
      command: '第一个命令',
      status: 'running',
      toolsUsed: 1,
    });
    expect(runs[1]).toMatchObject({
      command: '第二个命令',
      status: 'failed',
      latestError: 'Timed out',
    });
  });

  it('sanitizes noisy query prefixes in web search summaries', () => {
    const runs = buildCommandRuns([
      event(1, 'user.command', { command: '附近有什么好吃的' }),
      event(2, 'amp.user.command', {
        command: '附近有什么好吃的',
        runId: 'run-3',
      }),
      event(3, 'amp.tool.intent', {
        toolName: 'web_search',
        toolInput: { query: ': "附近有什么好吃的 美食推荐 餐厅"' },
        runId: 'run-3',
      }),
    ]);

    expect(runs[0]?.steps[0]?.summary).toBe('附近有什么好吃的 美食推荐 餐厅');
  });

  it('marks a run completed when the final llm response contains the terminal answer', () => {
    const runs = buildCommandRuns([
      event(1, 'user.command', { command: '给我一句总结' }),
      event(2, 'amp.user.command', {
        command: '给我一句总结',
        runId: 'run-4',
      }),
      event(3, 'llm.request', {
        provider: 'openrouter',
        model: 'moonshotai/kimi-k2',
        messageCount: 2,
        toolCount: 0,
      }),
      event(4, 'llm.response', {
        provider: 'openrouter',
        model: 'moonshotai/kimi-k2',
        tokensIn: 320,
        tokensOut: 48,
        responsePreview: '这就是最终总结。',
      }),
    ]);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: 'completed',
      responseText: '这就是最终总结。',
      active: false,
    });
  });

  it('deduplicates proxy llm steps when native amp.llm events describe the same model turn', () => {
    const runs = buildCommandRuns([
      event(1, 'user.command', { command: '总结一下今天的重点新闻' }),
      event(2, 'amp.user.command', {
        command: '总结一下今天的重点新闻',
        runId: 'run-native-1',
      }),
      event(3, 'amp.llm.request', {
        source: 'openclaw-native-hook',
        provider: 'openrouter',
        model: 'minimax/minimax-m2.7',
        messageCount: 3,
        messagesPreview: [
          { role: 'system', text: 'You are a careful sandboxed agent.' },
          { role: 'user', text: '总结一下今天的重点新闻' },
        ],
      }),
      event(4, 'llm.request', {
        provider: 'openrouter',
        model: 'minimax/minimax-m2.7',
        messageCount: 2,
        toolCount: 24,
        messagesPreview: [
          { role: 'system', text: 'You are a careful sandboxed agent.' },
          { role: 'user', text: '总结一下今天的重点新闻' },
        ],
      }),
      event(5, 'llm.response', {
        provider: 'openrouter',
        model: 'minimax/minimax-m2.7',
        tokensIn: 1234,
        tokensOut: 56,
        responsePreview: '这是今天的重点新闻摘要。',
      }),
      event(6, 'amp.llm.response', {
        source: 'openclaw-native-hook',
        provider: 'openrouter',
        model: 'minimax/minimax-m2.7',
        tokensIn: 1234,
        tokensOut: 56,
        responseText: '这是今天的重点新闻摘要。',
        responsePreview: '这是今天的重点新闻摘要。',
      }),
    ]);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      llmTurns: 1,
      totalTokensIn: 1234,
      totalTokensOut: 56,
      responseText: '这是今天的重点新闻摘要。',
    });
    expect(runs[0]?.steps).toHaveLength(1);
    expect(runs[0]?.steps[0]).toMatchObject({
      title: 'minimax/minimax-m2.7',
      body: '这是今天的重点新闻摘要。',
    });
  });

  it('keeps proxy-only tool-side llm steps when native amp.llm events exist elsewhere in the same run', () => {
    const runs = buildCommandRuns([
      event(1, 'user.command', { command: '给我查一下这几天的新闻' }),
      event(2, 'amp.user.command', {
        command: '给我查一下这几天的新闻',
        runId: 'run-mixed-1',
      }),
      event(3, 'amp.llm.request', {
        source: 'openclaw-native-hook',
        provider: 'openrouter',
        model: 'minimax/minimax-m2.7',
        messageCount: 2,
        messagesPreview: [
          { role: 'user', text: '给我查一下这几天的新闻' },
        ],
      }),
      event(4, 'amp.llm.response', {
        source: 'openclaw-native-hook',
        provider: 'openrouter',
        model: 'minimax/minimax-m2.7',
        tokensIn: 1500,
        tokensOut: 90,
        responsePreview: '[tool] web_search',
      }),
      event(5, 'amp.tool.intent', {
        toolName: 'web_search',
        toolInput: { query: 'news 2026年3月 国际新闻' },
        runId: 'run-mixed-1',
      }),
      event(6, 'llm.request', {
        provider: 'openrouter',
        model: 'perplexity/sonar-pro',
        messageCount: 1,
        toolCount: 0,
        messagesPreview: [{ role: 'user', text: 'news 2026年3月 国际新闻' }],
      }),
      event(7, 'llm.response', {
        provider: 'openrouter',
        model: 'perplexity/sonar-pro',
        tokensIn: 11,
        tokensOut: 856,
        responsePreview: '2026年3月国际新闻\n中东局势升级',
      }),
      event(8, 'amp.agent.message', {
        text: '这几天的大新闻主要集中在中东局势。',
        runId: 'run-mixed-1',
      }),
    ]);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      llmTurns: 2,
      totalTokensIn: 1511,
      totalTokensOut: 946,
      responseText: '这几天的大新闻主要集中在中东局势。',
    });
    expect(runs[0]?.steps.map((step) => step.title)).toEqual([
      'minimax/minimax-m2.7',
      'perplexity/sonar-pro',
      'Answer',
    ]);
    expect(runs[0]?.steps[1]).toMatchObject({
      title: 'perplexity/sonar-pro',
      body: '2026年3月国际新闻\n中东局势升级',
    });
  });
});
