import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type AgentCommandTransport = 'amp-command-file' | 'openclaw-gateway';
export type AgentDeploymentMode = 'compat' | 'official-script';

export type AgentDeploymentSpec = {
  agentType: string;
  mode: AgentDeploymentMode;
  bundleDir: string;
  commandTransport: AgentCommandTransport;
  requiredNodeMajor: number;
  requiredNodeVersion: string;
};

const OPENCLAW_REQUIRED_NODE_MAJOR = 22;
const OPENCLAW_REQUIRED_NODE_VERSION = '22.16.0';

function resolveOpenClawDeploymentMode(projectRoot: string, env: NodeJS.ProcessEnv): AgentDeploymentMode {
  const override = env.PADDOCK_OPENCLAW_DEPLOYMENT_MODE?.trim().toLowerCase();
  if (override === 'compat' || override === 'official-script') {
    return override;
  }

  const officialBundleReady =
    existsSync(join(projectRoot, 'dist', 'openclaw-runtime')) &&
    existsSync(join(projectRoot, 'dist', 'deployers', 'openclaw'));

  return officialBundleReady ? 'official-script' : 'compat';
}

export function resolveAgentDeploymentSpec(
  agentType: string,
  params: { projectRoot: string; env?: NodeJS.ProcessEnv },
): AgentDeploymentSpec | null {
  const env = params.env ?? process.env;

  if (agentType !== 'openclaw') {
    return null;
  }

  const mode = resolveOpenClawDeploymentMode(params.projectRoot, env);

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

  return {
    agentType,
    mode,
    bundleDir: join(params.projectRoot, 'dist', 'amp-openclaw'),
    commandTransport: 'amp-command-file',
    requiredNodeMajor: OPENCLAW_REQUIRED_NODE_MAJOR,
    requiredNodeVersion: OPENCLAW_REQUIRED_NODE_VERSION,
  };
}

