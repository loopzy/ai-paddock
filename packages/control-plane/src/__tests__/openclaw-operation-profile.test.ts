import { describe, expect, it } from 'vitest';
import {
  classifyOpenClawToolBoundary,
  getOpenClawOperationProfile,
} from '../agents/openclaw-operation-profile.js';

describe('openclaw-operation-profile', () => {
  it('keeps core OpenClaw coding tools available inside the sandbox', () => {
    expect(classifyOpenClawToolBoundary('read')).toBe('sandbox-local');
    expect(classifyOpenClawToolBoundary('exec')).toBe('sandbox-local');
    expect(classifyOpenClawToolBoundary('browser')).toBe('sandbox-local');
    expect(classifyOpenClawToolBoundary('web_search')).toBe('sandbox-local');
    expect(classifyOpenClawToolBoundary('web_fetch')).toBe('sandbox-local');
  });

  it('routes orchestration tools through the control plane', () => {
    expect(classifyOpenClawToolBoundary('sessions_spawn')).toBe('control-plane-routed');
    expect(classifyOpenClawToolBoundary('session_status')).toBe('control-plane-routed');
    expect(classifyOpenClawToolBoundary('cron')).toBe('control-plane-routed');
    expect(classifyOpenClawToolBoundary('rollback')).toBe('control-plane-routed');
  });

  it('keeps external delivery and host-boundary tools on MCP', () => {
    expect(classifyOpenClawToolBoundary('message')).toBe('mcp-external');
    expect(classifyOpenClawToolBoundary('tts')).toBe('mcp-external');
    expect(classifyOpenClawToolBoundary('browser.open')).toBe('mcp-external');
    expect(classifyOpenClawToolBoundary('api.github')).toBe('mcp-external');
  });

  it('disables gateway self-administration from sandbox sessions', () => {
    expect(classifyOpenClawToolBoundary('gateway')).toBe('disabled');
    expect(classifyOpenClawToolBoundary('list')).toBe('disabled');
    expect(classifyOpenClawToolBoundary('')).toBe('disabled');
  });

  it('publishes a unique operation profile with the main OpenClaw tool families', () => {
    const profile = getOpenClawOperationProfile();
    const names = profile.map((entry) => entry.toolName);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining([
        'read',
        'exec',
        'web_fetch',
        'browser',
        'sessions_spawn',
        'message',
        'tts',
        'gateway',
      ]),
    );
  });
});
