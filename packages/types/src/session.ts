// Session types

import type { SandboxType } from './sandbox.js';

export type SessionStatus = 'created' | 'running' | 'paused' | 'terminated' | 'error';

export interface AgentLLMConfig {
  provider: string;
  model: string;
}

export type AgentCommandTransport = 'amp-command-file' | 'openclaw-gateway';

export interface Session {
  id: string;
  status: SessionStatus;
  agentType: string;
  sandboxType: SandboxType;
  createdAt: number;
  updatedAt: number;
  vmId?: string;
  guiPorts?: { httpPort: number; httpsPort: number };
  agentConfig?: AgentLLMConfig;
  agentTransport?: AgentCommandTransport;
  agentSessionKey?: string;
}
