import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { EventStore } from './events/event-store.js';
import { SessionManager } from './session/session-manager.js';
import { SnapshotManager } from './snapshot/snapshot-manager.js';
import { SimpleBoxDriver } from './sandbox/simple-box-driver.js';
import { HITLArbiter } from './hitl/arbiter.js';
import { MCPGateway } from './mcp/gateway.js';
import { LLMRelay } from './mcp/llm-relay.js';
import { ResourceGateway } from './boundary/resource-gateway.js';
import { LLMConfigStore } from './config/llm-config-store.js';
import { registerRoutes } from './api/routes.js';

const PORT = Number(process.env.PADDOCK_PORT ?? 3100);

export async function startControlPlane() {
  const eventStore = new EventStore();
  const llmConfigStore = new LLMConfigStore(eventStore.db);
  const sandboxDriver = new SimpleBoxDriver();
  const snapshotManager = new SnapshotManager(eventStore.db);
  const hitlArbiter = new HITLArbiter(eventStore);
  const mcpGateway = new MCPGateway();
  const llmRelay = new LLMRelay(llmConfigStore);
  const resourceGateway = new ResourceGateway(llmRelay, mcpGateway, hitlArbiter, eventStore);
  const sessionManager = new SessionManager(eventStore, sandboxDriver, eventStore.db, llmConfigStore);

  const providers = llmRelay.getConfiguredProviders();
  if (providers.length === 0) {
    console.warn('WARNING: No LLM API keys configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.');
  } else {
    console.log(`LLM providers configured: ${providers.join(', ')}`);
  }

  const app = Fastify({ logger: true });
  await app.register(websocket);

  registerRoutes(app, { eventStore, sessionManager, snapshotManager, sandboxDriver, hitlArbiter, mcpGateway, llmRelay, resourceGateway, llmConfigStore });

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`Paddock Control Plane running on :${PORT}`);
}
