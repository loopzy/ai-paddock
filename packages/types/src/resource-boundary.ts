// Resource boundary types — unified LLM Relay + MCP Gateway

export type ResourceRequestType = 'llm' | 'host-tool';

export interface ResourceRequest {
  type: ResourceRequestType;
  sessionId: string;
  // LLM request fields
  provider?: string;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
  // Host-tool request fields
  tool?: string;
  args?: string | string[];
}

export interface ResourceResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}
