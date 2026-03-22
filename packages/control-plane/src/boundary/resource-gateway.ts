import type { ResourceRequest, ResourceResponse } from '../types.js';
import { LLMRelay, type LLMProxyRequest } from '../mcp/llm-relay.js';
import { MCPGateway } from '../mcp/gateway.js';
import { HITLArbiter } from '../hitl/arbiter.js';
import { EventStore } from '../events/event-store.js';

/**
 * ResourceGateway — unified boundary for all resource requests.
 * Routes by ResourceRequest.type: llm → LLMRelay, host-tool → MCPGateway.
 * Integrates HITL checks and records all boundary crossings as AMP events.
 */
export class ResourceGateway {
  private llmRelay: LLMRelay;
  private mcpGateway: MCPGateway;
  private hitlArbiter: HITLArbiter;
  private eventStore: EventStore;

  constructor(llmRelay: LLMRelay, mcpGateway: MCPGateway, hitlArbiter: HITLArbiter, eventStore: EventStore) {
    this.llmRelay = llmRelay;
    this.mcpGateway = mcpGateway;
    this.hitlArbiter = hitlArbiter;
    this.eventStore = eventStore;
  }

  async handle(req: ResourceRequest): Promise<ResourceResponse> {
    switch (req.type) {
      case 'llm':
        return this.handleLLM(req);
      case 'host-tool':
        return this.handleHostTool(req);
      default:
        return { status: 400, body: JSON.stringify({ error: `Unknown resource type: ${req.type}` }) };
    }
  }

  private async handleLLM(req: ResourceRequest): Promise<ResourceResponse> {
    const proxyReq: LLMProxyRequest = {
      provider: req.provider ?? 'unknown',
      method: req.method ?? 'POST',
      path: req.path ?? '/',
      headers: req.headers ?? {},
      body: req.body ?? '',
    };

    this.eventStore.append(req.sessionId, 'llm.request', { provider: proxyReq.provider, via: 'resource-gateway' });
    const result = await this.llmRelay.forward(proxyReq);
    this.eventStore.append(req.sessionId, 'llm.response', { status: result.status, via: 'resource-gateway' });

    return { status: result.status, headers: result.headers, body: result.body };
  }

  private async handleHostTool(req: ResourceRequest): Promise<ResourceResponse> {
    const tool = req.tool ?? '';
    let args = req.args ?? '';

    // HITL check
    if (this.hitlArbiter.requiresApproval(`host.${tool}`)) {
      const decision = await this.hitlArbiter.requestApproval(
        req.sessionId, `host.${tool}`, { args }, 'Host-side tool call requires approval'
      );
      if (decision.verdict === 'rejected') {
        return { status: 403, body: 'Tool call rejected by user', exitCode: 1 };
      }
      if (decision.verdict === 'modified') {
        if (!decision.modifiedArgs || !('args' in decision.modifiedArgs)) {
          return { status: 400, body: 'Tool call modification was missing updated arguments', exitCode: 1 };
        }
        const modifiedArgs = decision.modifiedArgs.args;
        if (typeof modifiedArgs !== 'string' && !Array.isArray(modifiedArgs)) {
          return { status: 400, body: 'Tool call modification must provide string or string[] arguments', exitCode: 1 };
        }
        args = modifiedArgs;
      }
    }

    const result = await this.mcpGateway.callTool(tool, args);
    this.eventStore.append(req.sessionId, 'tool.result', { toolName: `host.${tool}`, result, via: 'resource-gateway' });

    return { status: 200, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  }

  getConfiguredProviders(): string[] {
    return this.llmRelay.getConfiguredProviders();
  }
}
