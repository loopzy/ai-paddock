import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventStore } from '../events/event-store.js';
import { SessionManager } from '../session/session-manager.js';
import type { SandboxDriver, ExecResult, VMInfo, SandboxSnapshot, SandboxConfig } from '@paddock/types';

/** Minimal mock SandboxDriver that records calls */
function createMockDriver(): SandboxDriver & { calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    async createBox(config?: SandboxConfig) {
      calls.push({ method: 'createBox', args: [config] });
      return 'vm-mock-123';
    },
    async getInfo(vmId: string): Promise<VMInfo | null> {
      calls.push({ method: 'getInfo', args: [vmId] });
      return { id: vmId, name: 'mock', status: 'running', created: new Date() };
    },
    async exec(vmId: string, command: string): Promise<ExecResult> {
      calls.push({ method: 'exec', args: [vmId, command] });
      // Simulate pgrep success for sidecar verify
      if (command.includes('pgrep')) return { stdout: '1234', stderr: '', exitCode: 0 };
      if (command.includes('test -f /opt/paddock/browser-runtime.ready')) return { stdout: '', stderr: '', exitCode: 1 };
      if (command.includes('for browser in') && command.includes('chromium-browser')) {
        return { stdout: '/usr/bin/chromium\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    async copyIn(vmId: string, hostPath: string, vmPath: string) {
      calls.push({ method: 'copyIn', args: [vmId, hostPath, vmPath] });
    },
    async copyOut(vmId: string, vmPath: string, hostPath: string) {
      calls.push({ method: 'copyOut', args: [vmId, vmPath, hostPath] });
    },
    async createSnapshot(vmId: string, label?: string): Promise<SandboxSnapshot> {
      calls.push({ method: 'createSnapshot', args: [vmId, label] });
      return { id: 'snap-1', sessionId: vmId, seq: 0, label, createdAt: Date.now(), boxliteSnapshotId: 'bx-snap-1' };
    },
    async restoreSnapshot(vmId: string, snapshotId: string) {
      calls.push({ method: 'restoreSnapshot', args: [vmId, snapshotId] });
    },
    async destroyBox(vmId: string) {
      calls.push({ method: 'destroyBox', args: [vmId] });
    },
    async getMetrics(vmId: string) {
      calls.push({ method: 'getMetrics', args: [vmId] });
      return { cpuPercent: 10, memoryMiB: 256 };
    },
  };
}

describe('SessionManager', () => {
  let eventStore: EventStore;
  let driver: ReturnType<typeof createMockDriver>;
  let manager: SessionManager;
  const originalBootDelay = process.env.PADDOCK_AGENT_BOOT_DELAY_MS;
  const originalSidecarDelay = process.env.PADDOCK_SIDECAR_BOOT_DELAY_MS;
  const originalReadyTimeout = process.env.PADDOCK_AGENT_READY_TIMEOUT_MS;
  const originalAgentProvider = process.env.PADDOCK_LLM_PROVIDER;
  const originalAgentModel = process.env.PADDOCK_AGENT_MODEL;
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const originalAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const originalOpenAIKey = process.env.OPENAI_API_KEY;
  const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const originalDeploymentMode = process.env.PADDOCK_OPENCLAW_DEPLOYMENT_MODE;

  beforeEach(() => {
    process.env.PADDOCK_AGENT_BOOT_DELAY_MS = '0';
    process.env.PADDOCK_SIDECAR_BOOT_DELAY_MS = '0';
    process.env.PADDOCK_AGENT_READY_TIMEOUT_MS = '50';
    process.env.PADDOCK_OPENCLAW_DEPLOYMENT_MODE = 'compat';
    eventStore = new EventStore(':memory:');
    driver = createMockDriver();
    manager = new SessionManager(eventStore, driver, eventStore.db);
  });

  afterEach(() => {
    if (originalBootDelay === undefined) delete process.env.PADDOCK_AGENT_BOOT_DELAY_MS;
    else process.env.PADDOCK_AGENT_BOOT_DELAY_MS = originalBootDelay;
    if (originalSidecarDelay === undefined) delete process.env.PADDOCK_SIDECAR_BOOT_DELAY_MS;
    else process.env.PADDOCK_SIDECAR_BOOT_DELAY_MS = originalSidecarDelay;
    if (originalReadyTimeout === undefined) delete process.env.PADDOCK_AGENT_READY_TIMEOUT_MS;
    else process.env.PADDOCK_AGENT_READY_TIMEOUT_MS = originalReadyTimeout;
    if (originalAgentProvider === undefined) delete process.env.PADDOCK_LLM_PROVIDER;
    else process.env.PADDOCK_LLM_PROVIDER = originalAgentProvider;
    if (originalAgentModel === undefined) delete process.env.PADDOCK_AGENT_MODEL;
    else process.env.PADDOCK_AGENT_MODEL = originalAgentModel;
    if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    if (originalAnthropicAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = originalAnthropicAuthToken;
    if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAIKey;
    if (originalOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
    if (originalDeploymentMode === undefined) delete process.env.PADDOCK_OPENCLAW_DEPLOYMENT_MODE;
    else process.env.PADDOCK_OPENCLAW_DEPLOYMENT_MODE = originalDeploymentMode;
    eventStore.close();
  });

  describe('create', () => {
    it('should create a session with default sandbox type', async () => {
      const session = await manager.create('openclaw');
      expect(session.id).toBeTruthy();
      expect(session.status).toBe('created');
      expect(session.agentType).toBe('openclaw');
      expect(session.sandboxType).toBe('simple-box');
      expect(session.createdAt).toBeGreaterThan(0);
    });

    it('should create a session with specified sandbox type', async () => {
      const session = await manager.create('openclaw', 'computer-box');
      expect(session.sandboxType).toBe('computer-box');
    });

    it('should persist session to DB', async () => {
      const session = await manager.create('openclaw');
      const row = eventStore.db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id) as any;
      expect(row).toBeTruthy();
      expect(row.status).toBe('created');
      expect(row.agent_type).toBe('openclaw');
    });

    it('should emit session.status event on create', async () => {
      const session = await manager.create('openclaw');
      const events = eventStore.getEvents(session.id);
      expect(events.some(e => e.type === 'session.status' && (e.payload as any).status === 'created')).toBe(true);
    });
  });

  describe('start', () => {
    it('should start a created session', async () => {
      const session = await manager.create('openclaw');
      await manager.start(session.id);

      const updated = manager.get(session.id);
      expect(updated?.status).toBe('running');
      expect(updated?.vmId).toBe('vm-mock-123');
    });

    it('should call driver.createBox', async () => {
      const session = await manager.create('openclaw');
      await manager.start(session.id);
      expect(driver.calls.some(c => c.method === 'createBox')).toBe(true);
    });

    it('should deploy sidecar (copyIn + exec)', async () => {
      const session = await manager.create('openclaw');
      await manager.start(session.id);

      const copyInCalls = driver.calls.filter(c => c.method === 'copyIn');
      expect(copyInCalls.length).toBeGreaterThanOrEqual(2); // sidecar files + pal shims

      const execCalls = driver.calls.filter(c => c.method === 'exec');
      expect(execCalls.length).toBeGreaterThanOrEqual(3); // node install + chmod + start + verify
    });

    it('should throw if session not found', async () => {
      await expect(manager.start('nonexistent')).rejects.toThrow('not found');
    });

    it('should throw if session already started', async () => {
      const session = await manager.create('openclaw');
      await manager.start(session.id);
      await expect(manager.start(session.id)).rejects.toThrow('already started');
    });

    it('should emit progress events during start', async () => {
      const session = await manager.create('openclaw');
      await manager.start(session.id);

      const events = eventStore.getEvents(session.id);
      const phases = events
        .filter(e => e.type === 'amp.session.start')
        .map(e => (e.payload as any).phase);

      expect(phases).toContain('vm.init');
      expect(phases).toContain('vm.image');
      expect(phases).toContain('vm.ready');
      expect(phases).toContain('sidecar');
      expect(phases).toContain('sidecar.copy');
      expect(phases).toContain('sidecar.start');
      expect(phases).toContain('sidecar.verify');
      expect(phases).toContain('sandbox_ready');
    });

    it('should verify control-plane reachability and Sidecar health before sandbox_ready', async () => {
      const session = await manager.create('openclaw');
      await manager.start(session.id);

      const execCommands = driver.calls
        .filter(c => c.method === 'exec')
        .map(c => String(c.args[1]));

      expect(execCommands.some(command => command.includes('/api/health'))).toBe(true);
      expect(execCommands.some(command => command.includes('http://127.0.0.1:8801/amp/health'))).toBe(true);
    });

    it('should write provider-aware agent env defaults into the VM', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      delete process.env.OPENAI_API_KEY;
      process.env.OPENROUTER_API_KEY = 'or-test';

      const session = await manager.create('openclaw');
      await manager.start(session.id);

      const envWriteCall = driver.calls.find(
        (call) => call.method === 'exec' && String(call.args[1]).includes('cat >> /etc/environment')
      );

      expect(envWriteCall).toBeTruthy();
      expect(String(envWriteCall?.args[1])).toContain('OPENROUTER_API_KEY=paddock-proxy');
      expect(String(envWriteCall?.args[1])).toContain('PADDOCK_LLM_PROVIDER=openrouter');
      expect(String(envWriteCall?.args[1])).toContain('PADDOCK_AGENT_MODEL=moonshotai/kimi-k2');
    });

    it('should emit error event if sidecar fails to start', { timeout: 15000 }, async () => {
      // Override exec to simulate pgrep failure
      const failDriver = createMockDriver();
      failDriver.exec = async (vmId: string, command: string) => {
        failDriver.calls.push({ method: 'exec', args: [vmId, command] });
        if (command.includes('kill -0')) return { stdout: '', stderr: '', exitCode: 1 };
        if (command.includes('tail')) return { stdout: 'Error: module not found', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      };

      const mgr2 = new SessionManager(eventStore, failDriver, eventStore.db);
      const session = await mgr2.create('openclaw');
      await expect(mgr2.start(session.id)).rejects.toThrow('Sidecar process exited during startup');
    });

    it('should mark the session as error if the Sidecar health endpoint never comes up', async () => {
      const failDriver = createMockDriver();
      failDriver.exec = async (vmId: string, command: string) => {
        failDriver.calls.push({ method: 'exec', args: [vmId, command] });
        if (command.includes('command -v node')) return { stdout: '/usr/bin/node\n', stderr: '', exitCode: 0 };
        if (command.includes('/amp/health')) return { stdout: '', stderr: 'connection refused', exitCode: 22 };
        if (command.includes('tail -50 /var/log/paddock-sidecar.log')) return { stdout: 'AMP Gate failed: listen EADDRINUSE', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      };

      const mgr2 = new SessionManager(eventStore, failDriver, eventStore.db);
      const session = await mgr2.create('openclaw');

      await expect(mgr2.start(session.id)).rejects.toThrow('Sidecar AMP Gate is not accepting connections');
      expect(mgr2.get(session.id)?.status).toBe('error');

      const statusEvent = [...eventStore.getEvents(session.id)].reverse().find(
        (event) => event.type === 'session.status' && event.payload.status === 'error'
      );
      expect(statusEvent?.payload.error).toContain('Failed to start sandbox');
    });
  });

  describe('stop', () => {
    it('should stop a running session', async () => {
      const session = await manager.create('openclaw');
      await manager.start(session.id);
      await manager.stop(session.id);

      const updated = manager.get(session.id);
      expect(updated?.status).toBe('terminated');
      expect(driver.calls.some(c => c.method === 'destroyBox')).toBe(true);
    });

    it('should throw if session not found', async () => {
      await expect(manager.stop('nonexistent')).rejects.toThrow('not found');
    });
  });

  describe('deployAgent', () => {
    it('should deploy openclaw agent', { timeout: 15000 }, async () => {
      const session = await manager.create('openclaw');
      await manager.start(session.id);

      setTimeout(() => {
        eventStore.append(session.id, 'amp.agent.ready' as any, {
          agent: 'openclaw',
          version: 'test-1.0.0',
          capabilities: ['chat'],
        });
      }, 0);

      await manager.deployAgent(session.id, 'openclaw');

      const events = eventStore.getEvents(session.id);
      const phases = events
        .filter(e => e.type === 'amp.session.start')
        .map(e => (e.payload as any).phase);
      expect(phases).toContain('agent.node');
      expect(phases).toContain('agent.copy_adapter');
      expect(phases).toContain('agent_ready');
      expect(events.some(e => e.type === 'amp.agent.ready')).toBe(true);
    });

    it('should start the bundled agent against the loopback Sidecar with NO_PROXY', async () => {
      const session = await manager.create('openclaw');
      await manager.start(session.id);

      setTimeout(() => {
        eventStore.append(session.id, 'amp.agent.ready' as any, {
          agent: 'openclaw',
          version: 'test-1.0.0',
          capabilities: ['chat'],
        });
      }, 0);

      await manager.deployAgent(session.id, 'openclaw');

      const launchCall = driver.calls.find(
        (call) => call.method === 'exec' && String(call.args[1]).includes('python3 -m paddock_amp.builtin_agent')
      );
      expect(launchCall).toBeTruthy();
      expect(String(launchCall?.args[1])).toContain('PADDOCK_SIDECAR_URL=http://127.0.0.1:8801');
      expect(String(launchCall?.args[1])).toContain('NO_PROXY=127.0.0.1,localhost');
      expect(String(launchCall?.args[1])).toContain('PADDOCK_BROWSER_HEADLESS=1');
    });

    it('should support the official-script deployment mode for OpenClaw', async () => {
      process.env.PADDOCK_OPENCLAW_DEPLOYMENT_MODE = 'official-script';
      process.env.OPENROUTER_API_KEY = 'or-test';

      const session = await manager.create('openclaw');
      await manager.start(session.id);
      await manager.deployAgent(session.id, 'openclaw');

      const copyInCalls = driver.calls
        .filter((call) => call.method === 'copyIn')
        .map((call) => String(call.args[1]));
      expect(copyInCalls.some((hostPath) => hostPath.endsWith('/dist/deployers/openclaw'))).toBe(true);
      expect(
        copyInCalls.some((hostPath) => hostPath.endsWith('/dist/openclaw-runtime.tar.gz'))
        || copyInCalls.some((hostPath) => hostPath.includes('/dist/openclaw-runtime/'))
      ).toBe(true);

      const launchCall = driver.calls.find(
        (call) => call.method === 'exec' && String(call.args[1]).includes('/opt/paddock/openclaw/launch.sh')
      );
      expect(launchCall).toBeTruthy();
      expect(String(launchCall?.args[1])).toContain('OPENCLAW_CONFIG_PATH=/workspace/.openclaw/openclaw.json');
      expect(String(launchCall?.args[1])).toContain('OPENCLAW_SKIP_CHANNELS=1');
      expect(String(launchCall?.args[1])).toContain('OPENCLAW_BUNDLED_PLUGINS_DIR=/opt/paddock/openclaw/paddock-amp-plugin');
      expect(String(launchCall?.args[1])).not.toContain('PADDOCK_OPENCLAW_HOST_BROWSER_IS_SANDBOX=1');

      const configWriteCall = driver.calls.find(
        (call) => call.method === 'exec' && String(call.args[1]).includes('cat > /workspace/.openclaw/openclaw.json')
      );
      expect(configWriteCall).toBeTruthy();
      expect(String(configWriteCall?.args[1])).toContain('"primary": "openrouter/moonshotai/kimi-k2"');
      expect(String(configWriteCall?.args[1])).toContain('"contextTokens": 262144');
      expect(String(configWriteCall?.args[1])).toContain('"maxTokens": 8192');
      expect(String(configWriteCall?.args[1])).toContain('"parallelToolCalls": false');
      expect(String(configWriteCall?.args[1])).toContain('"sandbox": {');
      expect(String(configWriteCall?.args[1])).toContain('"mode": "off"');
      expect(String(configWriteCall?.args[1])).toContain('"noSandbox": true');
      expect(String(configWriteCall?.args[1])).toContain('"executablePath": "/usr/bin/chromium"');
      expect(String(configWriteCall?.args[1])).toContain('"baseUrl": "http://127.0.0.1:8800/openrouter/api/v1"');

      const execCommands = driver.calls
        .filter((call) => call.method === 'exec')
        .map((call) => String(call.args[1]));
      expect(execCommands.some((command) => command.includes('for browser in') && command.includes('chromium-browser'))).toBe(true);
      expect(execCommands.some((command) => command.includes('apt-get update && (DEBIAN_FRONTEND=noninteractive apt-get install -y chromium'))).toBe(false);

      const healthCall = driver.calls.find(
        (call) => call.method === 'exec' && String(call.args[1]).includes('openclaw.mjs gateway health --json --port 18789')
      );
      expect(healthCall).toBeTruthy();
      expect(String(healthCall?.args[1])).toContain('OPENCLAW_STATE_DIR=/workspace/.openclaw');
      expect(String(healthCall?.args[1])).toContain('OPENCLAW_CONFIG_PATH=/workspace/.openclaw/openclaw.json');

      const browserPrewarmCall = driver.calls.find(
        (call) => call.method === 'exec' && String(call.args[1]).includes('openclaw.mjs browser start --json')
      );
      expect(browserPrewarmCall).toBeTruthy();
      expect(String(browserPrewarmCall?.args[1])).toContain('OPENCLAW_STATE_DIR=/workspace/.openclaw');
      expect(String(browserPrewarmCall?.args[1])).toContain('OPENCLAW_CONFIG_PATH=/workspace/.openclaw/openclaw.json');

      expect(manager.get(session.id)?.agentTransport).toBe('openclaw-gateway');
      expect(manager.get(session.id)?.agentSessionKey).toBe(`paddock:${session.id}`);
      expect(eventStore.getEvents(session.id).some((event) => event.type === 'amp.agent.ready')).toBe(true);
    });

    it('should retry the official OpenClaw gateway health probe until the runtime is ready', async () => {
      process.env.PADDOCK_OPENCLAW_DEPLOYMENT_MODE = 'official-script';

      const retryDriver = createMockDriver();
      let healthChecks = 0;
      retryDriver.exec = async (vmId: string, command: string) => {
        retryDriver.calls.push({ method: 'exec', args: [vmId, command] });
        if (command.includes('for browser in') && command.includes('chromium-browser')) {
          return { stdout: '/usr/bin/chromium\n', stderr: '', exitCode: 0 };
        }
        if (command.includes('openclaw.mjs gateway health --json --port 18789')) {
          healthChecks += 1;
          if (healthChecks < 3) {
            return { stdout: '', stderr: 'gateway closed (1006 abnormal closure)', exitCode: 1 };
          }
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      };

      const mgr2 = new SessionManager(eventStore, retryDriver, eventStore.db);
      const session = await mgr2.create('openclaw');
      await mgr2.start(session.id);
      await mgr2.deployAgent(session.id, 'openclaw');

      expect(healthChecks).toBe(3);
      expect(
        retryDriver.calls.some(
          (call) => call.method === 'exec' && String(call.args[1]).includes('openclaw.mjs browser start --json')
        )
      ).toBe(true);
      expect(eventStore.getEvents(session.id).some((event) => event.type === 'amp.agent.ready')).toBe(true);
    });

    it('should install a sandbox system browser with apt during official-script deployment when missing', async () => {
      process.env.PADDOCK_OPENCLAW_DEPLOYMENT_MODE = 'official-script';

      const aptDriver = createMockDriver();
      let browserInstalled = false;
      aptDriver.exec = async (vmId: string, command: string) => {
        aptDriver.calls.push({ method: 'exec', args: [vmId, command] });
        if (command.includes('for browser in') && command.includes('chromium-browser')) {
          return browserInstalled
            ? { stdout: '/usr/bin/chromium\n', stderr: '', exitCode: 0 }
            : { stdout: '', stderr: '', exitCode: 1 };
        }
        if (command.includes('apt-get update && (DEBIAN_FRONTEND=noninteractive apt-get install -y chromium')) {
          browserInstalled = true;
          return { stdout: 'installed chromium', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      };

      const mgr2 = new SessionManager(eventStore, aptDriver, eventStore.db);
      const session = await mgr2.create('openclaw');
      await mgr2.start(session.id);
      await mgr2.deployAgent(session.id, 'openclaw');

      const execCommands = aptDriver.calls
        .filter((call) => call.method === 'exec')
        .map((call) => String(call.args[1]));

      expect(execCommands.some((command) => command.includes('apt-get update && (DEBIAN_FRONTEND=noninteractive apt-get install -y chromium'))).toBe(true);
      const configWriteCall = aptDriver.calls.find(
        (call) => call.method === 'exec' && String(call.args[1]).includes('cat > /workspace/.openclaw/openclaw.json')
      );
      expect(String(configWriteCall?.args[1])).toContain('"enabled": true');
      expect(String(configWriteCall?.args[1])).toContain('"noSandbox": true');
      expect(String(configWriteCall?.args[1])).toContain('"executablePath": "/usr/bin/chromium"');
    });

    it('should fall back to a bundled Chromium runtime when ubuntu chromium-browser is only a snap stub', async () => {
      process.env.PADDOCK_OPENCLAW_DEPLOYMENT_MODE = 'official-script';

      const fallbackDriver = createMockDriver();
      let aptAttempted = false;
      let pythonReady = false;
      let browserRuntimeReady = false;

      fallbackDriver.exec = async (vmId: string, command: string) => {
        fallbackDriver.calls.push({ method: 'exec', args: [vmId, command] });

        if (command.includes('for browser in') && command.includes('chromium-browser')) {
          return { stdout: `${browserRuntimeReady ? '/usr/bin/chromium' : '/usr/bin/chromium-browser'}\n`, stderr: '', exitCode: 0 };
        }

        if (command.includes('BROWSER_BIN=') && command.includes('--version')) {
          if (browserRuntimeReady) {
            return { stdout: 'Chromium 123.0.0.0\n', stderr: '', exitCode: 0 };
          }
          return {
            stdout: '',
            stderr: "Command '/usr/bin/chromium-browser' requires the chromium snap to be installed.",
            exitCode: 1,
          };
        }

        if (command.includes('apt-get update && (DEBIAN_FRONTEND=noninteractive apt-get install -y chromium')) {
          aptAttempted = true;
          return { stdout: 'attempted apt browser install', stderr: '', exitCode: 0 };
        }

        if (command.includes('command -v python3 >/dev/null 2>&1 && python3 -m pip --version >/dev/null 2>&1')) {
          return { stdout: '', stderr: '', exitCode: pythonReady ? 0 : 1 };
        }

        if (command.includes('apt-get update && apt-get install -y python3 python3-pip python3-requests')) {
          pythonReady = true;
          return { stdout: 'installed python', stderr: '', exitCode: 0 };
        }

        if (command.includes('test -f /opt/paddock/browser-runtime.ready')) {
          return { stdout: '', stderr: '', exitCode: browserRuntimeReady ? 0 : 1 };
        }

        if (command.includes('python3 -m pip install --no-cache-dir -r /opt/paddock/amp-openclaw/requirements.txt')) {
          return { stdout: 'installed browser deps', stderr: '', exitCode: 0 };
        }

        if (command.includes('python3 -m playwright install --with-deps chromium')) {
          browserRuntimeReady = true;
          return { stdout: 'installed playwright chromium', stderr: '', exitCode: 0 };
        }

        if (command.includes('ln -sf "$BROWSER_BIN" /usr/bin/chromium')) {
          return { stdout: 'linked chromium', stderr: '', exitCode: 0 };
        }

        if (command.includes('printf "browser-runtime=1\\n" > /opt/paddock/browser-runtime.ready')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }

        return { stdout: '', stderr: '', exitCode: 0 };
      };

      const mgr2 = new SessionManager(eventStore, fallbackDriver, eventStore.db);
      const session = await mgr2.create('openclaw');
      await mgr2.start(session.id);
      await mgr2.deployAgent(session.id, 'openclaw');

      const execCommands = fallbackDriver.calls
        .filter((call) => call.method === 'exec')
        .map((call) => String(call.args[1]));

      expect(aptAttempted).toBe(true);
      expect(execCommands.some((command) => command.includes('python3 -m playwright install --with-deps chromium'))).toBe(true);
      const configWriteCall = fallbackDriver.calls.find(
        (call) => call.method === 'exec' && String(call.args[1]).includes('cat > /workspace/.openclaw/openclaw.json')
      );
      expect(String(configWriteCall?.args[1])).toContain('"executablePath": "/usr/bin/chromium"');
      expect(String(configWriteCall?.args[1])).toContain('"noSandbox": true');
    });

    it('should prepare browser runtime dependencies during agent deployment', async () => {
      const session = await manager.create('openclaw');
      await manager.start(session.id);

      setTimeout(() => {
        eventStore.append(session.id, 'amp.agent.ready' as any, {
          agent: 'openclaw',
          version: 'test-1.0.0',
          capabilities: ['chat'],
        });
      }, 0);

      await manager.deployAgent(session.id, 'openclaw');

      const execCommands = driver.calls
        .filter((call) => call.method === 'exec')
        .map((call) => String(call.args[1]));

      expect(execCommands.some((command) => command.includes('python3 -m pip install --no-cache-dir -r /opt/paddock/amp-openclaw/requirements.txt'))).toBe(true);
      expect(execCommands.some((command) => command.includes('python3 -m playwright install'))).toBe(true);
    });

    it('should skip browser runtime installation when the sandbox rootfs already includes it', async () => {
      const preloadedDriver = createMockDriver();
      preloadedDriver.exec = async (vmId: string, command: string) => {
        preloadedDriver.calls.push({ method: 'exec', args: [vmId, command] });
        if (command.includes('test -f /opt/paddock/browser-runtime.ready')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      };

      const mgr2 = new SessionManager(eventStore, preloadedDriver, eventStore.db);
      const session = await mgr2.create('openclaw');
      await mgr2.start(session.id);

      setTimeout(() => {
        eventStore.append(session.id, 'amp.agent.ready' as any, {
          agent: 'openclaw',
          version: 'test-1.0.0',
          capabilities: ['chat'],
        });
      }, 0);

      await mgr2.deployAgent(session.id, 'openclaw');

      const execCommands = preloadedDriver.calls
        .filter((call) => call.method === 'exec')
        .map((call) => String(call.args[1]));

      expect(execCommands.some((command) => command.includes('test -f /opt/paddock/browser-runtime.ready'))).toBe(true);
      expect(execCommands.some((command) => command.includes('apt-get update && apt-get install -y python3 python3-pip python3-requests'))).toBe(false);
      expect(execCommands.some((command) => command.includes('python3 -m pip install --no-cache-dir -r /opt/paddock/amp-openclaw/requirements.txt'))).toBe(false);
      expect(execCommands.some((command) => command.includes('python3 -m playwright install'))).toBe(false);
      expect(execCommands.some((command) => command.includes('ln -sf "$BROWSER_BIN" /usr/bin/chromium'))).toBe(true);
    });

    it('should treat computer-box sandboxes as headed browser targets', async () => {
      expect((manager as any).isBrowserHeadless('simple-box')).toBe(true);
      expect((manager as any).isBrowserHeadless('computer-box')).toBe(false);
    });

    it('should rewrite guest agent env using the requested provider and model before deploy', async () => {
      const session = await manager.create('openclaw');
      await manager.start(session.id);

      setTimeout(() => {
        eventStore.append(session.id, 'amp.agent.ready' as any, {
          agent: 'openclaw',
          version: 'test-1.0.0',
          capabilities: ['chat'],
        });
      }, 0);

      await manager.deployAgent(session.id, 'openclaw', {
        provider: 'openrouter',
        model: 'deepseek/deepseek-chat',
      });

      const envWrites = driver.calls.filter(
        (call) => call.method === 'exec' && String(call.args[1]).includes('cat >> /etc/environment')
      );
      const latestEnvWrite = String(envWrites.at(-1)?.args[1]);

      expect(latestEnvWrite).toContain('PADDOCK_LLM_PROVIDER=openrouter');
      expect(latestEnvWrite).toContain('PADDOCK_AGENT_MODEL=deepseek/deepseek-chat');
      expect(latestEnvWrite).toContain('OPENROUTER_API_KEY=paddock-proxy');
      expect(manager.get(session.id)?.agentConfig).toEqual({
        provider: 'openrouter',
        model: 'deepseek/deepseek-chat',
      });
    });

    it('should emit fatal error if agent never reports ready', async () => {
      const session = await manager.create('openclaw');
      await manager.start(session.id);

      await expect(manager.deployAgent(session.id, 'openclaw')).rejects.toThrow('Timed out waiting for amp.agent.ready');

      const fatal = eventStore.getEvents(session.id).find(e => e.type === 'amp.agent.fatal');
      expect(fatal).toBeTruthy();
      expect((fatal?.payload as any).code).toBe('ERR_AGENT_NOT_READY');
    });

    it('should surface a fatal error when preparing the required Node.js runtime fails', async () => {
      process.env.PADDOCK_OPENCLAW_DEPLOYMENT_MODE = 'official-script';

      const failDriver = createMockDriver();
      let bundledNodeLinkAttempts = 0;
      failDriver.exec = async (vmId: string, command: string) => {
        failDriver.calls.push({ method: 'exec', args: [vmId, command] });
        if (command.includes('command -v node')) {
          return { stdout: 'upgrade\n', stderr: '', exitCode: 0 };
        }
        if (command.includes('ln -sf /opt/paddock/node-bin-')) {
          bundledNodeLinkAttempts += 1;
          if (bundledNodeLinkAttempts >= 2) {
            return { stdout: '', stderr: 'permission denied', exitCode: 1 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('deb.nodesource.com/setup_22.x')) {
          return { stdout: '', stderr: 'temporary failure resolving deb.nodesource.com', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      };

      const mgr2 = new SessionManager(eventStore, failDriver, eventStore.db);
      const session = await mgr2.create('openclaw');
      await mgr2.start(session.id);

      await expect(mgr2.deployAgent(session.id, 'openclaw')).rejects.toThrow('Failed to link bundled Node.js runtime');

      const phases = eventStore
        .getEvents(session.id)
        .filter((event) => event.type === 'amp.session.start')
        .map((event) => event.payload.phase);
      expect(phases).toContain('agent.node');

      const fatal = eventStore.getEvents(session.id).find((event) => event.type === 'amp.agent.fatal');
      expect(fatal).toBeTruthy();
      expect((fatal?.payload as any).code).toBe('ERR_AGENT_RUNTIME');
      expect((fatal?.payload as any).stage).toBe('agent.node');
    });

    it('should throw for unknown agent type', async () => {
      const session = await manager.create('openclaw');
      await manager.start(session.id);
      await expect(manager.deployAgent(session.id, 'unknown-agent')).rejects.toThrow('Unknown agent type');
    });

    it('should throw if no VM running', async () => {
      const session = await manager.create('openclaw');
      await expect(manager.deployAgent(session.id, 'openclaw')).rejects.toThrow('no running VM');
    });
  });

  describe('list / get / getDriverForSession', () => {
    it('should list all sessions', async () => {
      await manager.create('openclaw');
      await manager.create('openclaw', 'computer-box');
      expect(manager.list()).toHaveLength(2);
    });

    it('should get a session by id', async () => {
      const session = await manager.create('openclaw');
      expect(manager.get(session.id)).toEqual(session);
    });

    it('should return undefined for unknown session', () => {
      expect(manager.get('nonexistent')).toBeUndefined();
    });

    it('should return driver for session', async () => {
      const session = await manager.create('openclaw');
      const d = manager.getDriverForSession(session.id);
      expect(d).toBe(driver); // simple-box uses default driver
    });

    it('should throw for unknown session in getDriverForSession', () => {
      expect(() => manager.getDriverForSession('nonexistent')).toThrow('not found');
    });

    it('should reconcile stale running sessions to terminated when the runtime disappears', async () => {
      const failDriver = createMockDriver();
      failDriver.getInfo = async () => null;
      const mgr2 = new SessionManager(eventStore, failDriver, eventStore.db);
      const session = await mgr2.create('openclaw');
      await mgr2.start(session.id);

      const sessions = await mgr2.listWithRuntimeStatus();

      expect(sessions[0]?.status).toBe('terminated');
      const terminatedEvent = eventStore
        .getEvents(session.id)
        .find((event) => event.type === 'session.status' && (event.payload as any).reason === 'runtime_unavailable');
      expect(terminatedEvent).toBeTruthy();
    });

    it('should remove a session and its persisted history', async () => {
      const session = await manager.create('openclaw');
      eventStore.append(session.id, 'user.command', { command: 'cleanup me' });

      const removed = await manager.remove(session.id);

      expect(removed).toBe(true);
      expect(manager.get(session.id)).toBeUndefined();
      const row = eventStore.db.prepare('SELECT id FROM sessions WHERE id = ?').get(session.id);
      expect(row).toBeUndefined();
      expect(eventStore.getEvents(session.id)).toEqual([]);
    });
  });
});
