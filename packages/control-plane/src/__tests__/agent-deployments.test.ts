import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAgentDeploymentSpec } from '../agents/deployments.js';

describe('resolveAgentDeploymentSpec', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) {
        import('node:fs').then(({ rmSync }) => rmSync(dir, { recursive: true, force: true }));
      }
    }
  });

  function createProjectRoot() {
    const root = mkdtempSync(join(tmpdir(), 'paddock-agent-deploy-'));
    dirs.push(root);
    mkdirSync(join(root, 'dist'), { recursive: true });
    return root;
  }

  it('falls back to compat deployment when the official OpenClaw bundle is absent', () => {
    const projectRoot = createProjectRoot();

    const spec = resolveAgentDeploymentSpec('openclaw', { projectRoot, env: {} as NodeJS.ProcessEnv });

    expect(spec).toEqual({
      agentType: 'openclaw',
      mode: 'compat',
      bundleDir: join(projectRoot, 'dist', 'amp-openclaw'),
      commandTransport: 'amp-command-file',
      requiredNodeMajor: 22,
      requiredNodeVersion: '22.16.0',
    });
  });

  it('prefers the official deployer when both runtime and deployer bundles exist', () => {
    const projectRoot = createProjectRoot();
    mkdirSync(join(projectRoot, 'dist', 'openclaw-runtime'), { recursive: true });
    mkdirSync(join(projectRoot, 'dist', 'deployers', 'openclaw'), { recursive: true });

    const spec = resolveAgentDeploymentSpec('openclaw', { projectRoot, env: {} as NodeJS.ProcessEnv });

    expect(spec).toEqual({
      agentType: 'openclaw',
      mode: 'official-script',
      bundleDir: join(projectRoot, 'dist', 'deployers', 'openclaw'),
      commandTransport: 'openclaw-gateway',
      requiredNodeMajor: 22,
      requiredNodeVersion: '22.16.0',
    });
  });

  it('honors an explicit deployment mode override', () => {
    const projectRoot = createProjectRoot();

    const compat = resolveAgentDeploymentSpec('openclaw', {
      projectRoot,
      env: { PADDOCK_OPENCLAW_DEPLOYMENT_MODE: 'compat' } as NodeJS.ProcessEnv,
    });
    const official = resolveAgentDeploymentSpec('openclaw', {
      projectRoot,
      env: { PADDOCK_OPENCLAW_DEPLOYMENT_MODE: 'official-script' } as NodeJS.ProcessEnv,
    });

    expect(compat?.mode).toBe('compat');
    expect(official?.mode).toBe('official-script');
    expect(official?.commandTransport).toBe('openclaw-gateway');
  });

  it('returns null for unknown agent types', () => {
    const projectRoot = createProjectRoot();
    expect(resolveAgentDeploymentSpec('unknown-agent', { projectRoot, env: {} as NodeJS.ProcessEnv })).toBeNull();
  });
});

