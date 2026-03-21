import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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

  function createOpenClawSourceTree(projectRoot: string, relativePath = join('thirdparty', 'openclaw')) {
    const sourceRoot = join(projectRoot, relativePath);
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(join(sourceRoot, 'package.json'), JSON.stringify({ name: 'openclaw', packageManager: 'pnpm@10.23.0' }));
    writeFileSync(join(sourceRoot, 'openclaw.mjs'), 'console.log("openclaw");\n');
    return sourceRoot;
  }

  it('falls back to compat deployment when the official OpenClaw bundle is absent', async () => {
    const projectRoot = createProjectRoot();

    const spec = await resolveAgentDeploymentSpec('openclaw', { projectRoot, env: {} as NodeJS.ProcessEnv });

    expect(spec).toEqual({
      agentType: 'openclaw',
      mode: 'compat',
      bundleDir: join(projectRoot, 'dist', 'amp-openclaw'),
      commandTransport: 'amp-command-file',
      requiredNodeMajor: 22,
      requiredNodeVersion: '22.16.0',
    });
  });

  it('prefers the official deployer when both runtime and deployer bundles exist', async () => {
    const projectRoot = createProjectRoot();
    mkdirSync(join(projectRoot, 'dist', 'openclaw-runtime'), { recursive: true });
    mkdirSync(join(projectRoot, 'dist', 'deployers', 'openclaw'), { recursive: true });

    const spec = await resolveAgentDeploymentSpec('openclaw', { projectRoot, env: {} as NodeJS.ProcessEnv });

    expect(spec).toEqual({
      agentType: 'openclaw',
      mode: 'official-script',
      bundleDir: join(projectRoot, 'dist', 'deployers', 'openclaw'),
      commandTransport: 'openclaw-gateway',
      requiredNodeMajor: 22,
      requiredNodeVersion: '22.16.0',
    });
  });

  it('falls back to vm-source deployment when a pinned OpenClaw source tree exists', async () => {
    const projectRoot = createProjectRoot();
    createOpenClawSourceTree(projectRoot);
    mkdirSync(join(projectRoot, 'dist', 'deployers', 'openclaw'), { recursive: true });

    const spec = await resolveAgentDeploymentSpec('openclaw', { projectRoot, env: {} as NodeJS.ProcessEnv });

    expect(spec).toEqual({
      agentType: 'openclaw',
      mode: 'vm-source',
      bundleDir: join(projectRoot, 'dist', 'deployers', 'openclaw'),
      commandTransport: 'openclaw-gateway',
      requiredNodeMajor: 22,
      requiredNodeVersion: '22.16.0',
      sourceRoot: join(projectRoot, 'thirdparty', 'openclaw'),
      packageManager: 'pnpm@10.23.0',
    });
  });

  it('honors an explicit deployment mode override', async () => {
    const projectRoot = createProjectRoot();
    createOpenClawSourceTree(projectRoot, join('vendor', 'openclaw'));

    const compat = await resolveAgentDeploymentSpec('openclaw', {
      projectRoot,
      env: { PADDOCK_OPENCLAW_DEPLOYMENT_MODE: 'compat' } as NodeJS.ProcessEnv,
    });
    const official = await resolveAgentDeploymentSpec('openclaw', {
      projectRoot,
      env: { PADDOCK_OPENCLAW_DEPLOYMENT_MODE: 'official-script' } as NodeJS.ProcessEnv,
    });
    const vmSource = await resolveAgentDeploymentSpec('openclaw', {
      projectRoot,
      env: {
        PADDOCK_OPENCLAW_DEPLOYMENT_MODE: 'vm-source',
        OPENCLAW_SRC: join(projectRoot, 'vendor', 'openclaw'),
      } as NodeJS.ProcessEnv,
    });

    expect(compat?.mode).toBe('compat');
    expect(official?.mode).toBe('official-script');
    expect(official?.commandTransport).toBe('openclaw-gateway');
    expect(vmSource?.mode).toBe('vm-source');
    expect(vmSource?.sourceRoot).toBe(join(projectRoot, 'vendor', 'openclaw'));
  });

  it('returns null for unknown agent types', async () => {
    const projectRoot = createProjectRoot();
    expect(await resolveAgentDeploymentSpec('unknown-agent', { projectRoot, env: {} as NodeJS.ProcessEnv })).toBeNull();
  });
});
