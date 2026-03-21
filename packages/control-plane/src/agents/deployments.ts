import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readOpenClawPackageManager, resolveOpenClawSourceRoot } from './openclaw-source.js';

export type AgentCommandTransport = 'amp-command-file' | 'openclaw-gateway';
export type AgentDeploymentMode = 'compat' | 'official-script' | 'vm-source';

export type AgentDeploymentSpec = {
  agentType: string;
  mode: AgentDeploymentMode;
  bundleDir: string;
  commandTransport: AgentCommandTransport;
  requiredNodeMajor: number;
  requiredNodeVersion: string;
  sourceRoot?: string;
  packageManager?: string;
};

const OPENCLAW_REQUIRED_NODE_MAJOR = 22;
const OPENCLAW_REQUIRED_NODE_VERSION = '22.16.0';

async function resolveOpenClawDeploymentMode(projectRoot: string, env: NodeJS.ProcessEnv): Promise<AgentDeploymentMode> {
  const override = env.PADDOCK_OPENCLAW_DEPLOYMENT_MODE?.trim().toLowerCase();
  if (override === 'compat' || override === 'official-script' || override === 'vm-source') {
    return override;
  }

  const officialBundleReady =
    existsSync(join(projectRoot, 'dist', 'openclaw-runtime')) &&
    existsSync(join(projectRoot, 'dist', 'deployers', 'openclaw'));

  if (officialBundleReady) {
    return 'official-script';
  }

  const openClawSourceRoot = resolveOpenClawSourceRoot(projectRoot, env);
  if (openClawSourceRoot && existsSync(join(projectRoot, 'dist', 'deployers', 'openclaw'))) {
    return 'vm-source';
  }

  return 'compat';
}

export async function resolveAgentDeploymentSpec(
  agentType: string,
  params: { projectRoot: string; env?: NodeJS.ProcessEnv },
): Promise<AgentDeploymentSpec | null> {
  const env = params.env ?? process.env;

  if (agentType !== 'openclaw') {
    return null;
  }

  const mode = await resolveOpenClawDeploymentMode(params.projectRoot, env);

  if (mode === 'official-script') {
    return {
      agentType,
      mode,
      bundleDir: join(params.projectRoot, 'dist', 'deployers', 'openclaw'),
      commandTransport: 'openclaw-gateway',
      requiredNodeMajor: OPENCLAW_REQUIRED_NODE_MAJOR,
      requiredNodeVersion: OPENCLAW_REQUIRED_NODE_VERSION,
    };
  }

  if (mode === 'vm-source') {
    const sourceRoot = resolveOpenClawSourceRoot(params.projectRoot, env) ?? join(params.projectRoot, 'thirdparty', 'openclaw');
    return {
      agentType,
      mode,
      bundleDir: join(params.projectRoot, 'dist', 'deployers', 'openclaw'),
      commandTransport: 'openclaw-gateway',
      requiredNodeMajor: OPENCLAW_REQUIRED_NODE_MAJOR,
      requiredNodeVersion: OPENCLAW_REQUIRED_NODE_VERSION,
      sourceRoot,
      packageManager: (await readOpenClawPackageManager(sourceRoot)) ?? undefined,
    };
  }

  return {
    agentType,
    mode,
    bundleDir: join(params.projectRoot, 'dist', 'amp-openclaw'),
    commandTransport: 'amp-command-file',
    requiredNodeMajor: OPENCLAW_REQUIRED_NODE_MAJOR,
    requiredNodeVersion: OPENCLAW_REQUIRED_NODE_VERSION,
  };
}
