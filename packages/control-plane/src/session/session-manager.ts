import { nanoid } from 'nanoid';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { readdirSync } from 'node:fs';
import type { Session, SessionStatus, SandboxType, SandboxDriver, ExecResult, PaddockEvent } from '../types.js';
import { EventStore } from '../events/event-store.js';
import { createSandbox } from '../sandbox/factory.js';
import type { ComputerBoxDriver } from '../sandbox/computer-box-driver.js';
import { getSandboxStartupMessage } from '../sandbox/sandbox-rootfs.js';
import type { AgentLLMConfig } from '../mcp/agent-llm-config.js';
import { getDefaultAgentLLMConfig, resolveAgentLLMConfig } from '../mcp/agent-llm-config.js';
import { LLMConfigStore } from '../config/llm-config-store.js';
import { resolveAgentDeploymentSpec, type AgentDeploymentSpec } from '../agents/deployments.js';
import { buildOpenClawRuntimeConfig } from '../agents/openclaw-config.js';
import Database from 'better-sqlite3';

// Project root: packages/control-plane/src/session/session-manager.ts → ../../../../
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..', '..');
type GuestPackageManager = 'apt' | 'apk';
type RuntimeSession = Session & { agentConfig?: AgentLLMConfig };

const SANDBOX_PACKAGE_MANAGER_MAP: Partial<Record<SandboxType, GuestPackageManager>> = {
  'simple-box': 'apt',
  'computer-box': 'apt',
};

/**
 * Session Manager — orchestrates agent sessions with sandbox lifecycle.
 * Now supports multiple sandbox types via SandboxDriver interface.
 */
export class SessionManager {
  private eventStore: EventStore;
  private defaultDriver: SandboxDriver;
  private db: Database.Database;
  private configStore: LLMConfigStore;
  private sessions = new Map<string, RuntimeSession>();
  private drivers = new Map<string, SandboxDriver>();

  constructor(eventStore: EventStore, defaultDriver: SandboxDriver, db: Database.Database, configStore?: LLMConfigStore) {
    this.eventStore = eventStore;
    this.defaultDriver = defaultDriver;
    this.db = db;
    this.configStore = configStore ?? new LLMConfigStore(db);
    this.ensureSchema();
    this.loadSessions();
  }

  private ensureSchema() {
    const cols = this.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'sandbox_type')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN sandbox_type TEXT NOT NULL DEFAULT 'simple-box'");
    }
  }

  private loadSessions() {
    const rows = this.db.prepare('SELECT * FROM sessions').all() as Array<{
      id: string; status: string; agent_type: string; vm_id: string | null;
      created_at: number; updated_at: number; sandbox_type?: string;
    }>;
    for (const r of rows) {
      this.sessions.set(r.id, {
        id: r.id,
        status: r.status as SessionStatus,
        agentType: r.agent_type,
        sandboxType: (r.sandbox_type ?? 'simple-box') as SandboxType,
        vmId: r.vm_id ?? undefined,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      });
    }
  }

  private getDriver(sandboxType: SandboxType): SandboxDriver {
    if (sandboxType === 'simple-box') return this.defaultDriver;
    let driver = this.drivers.get(sandboxType);
    if (!driver) {
      driver = createSandbox(sandboxType);
      this.drivers.set(sandboxType, driver);
    }
    return driver;
  }

  private getGuestPackageManager(sandboxType?: SandboxType): GuestPackageManager {
    return SANDBOX_PACKAGE_MANAGER_MAP[sandboxType ?? 'simple-box'] ?? 'apt';
  }

  private isBrowserHeadless(sandboxType?: SandboxType): boolean {
    return (sandboxType ?? 'simple-box') !== 'computer-box';
  }

  private async ensurePythonRuntime(driver: SandboxDriver, vmId: string, packageManager: GuestPackageManager): Promise<void> {
    const check = await driver.exec(vmId, 'command -v python3 >/dev/null 2>&1 && python3 -m pip --version >/dev/null 2>&1');
    if (check.exitCode === 0) return;

    if (packageManager === 'apk') {
      await this.execOrThrow(
        driver,
        vmId,
        'apk add --no-cache python3 py3-pip py3-requests',
        'Failed to install Python runtime',
      );
    } else {
      await this.execOrThrow(
        driver,
        vmId,
        'apt-get update && apt-get install -y python3 python3-pip python3-requests',
        'Failed to install Python runtime',
      );
    }
  }

  private async ensureBrowserRuntime(driver: SandboxDriver, vmId: string): Promise<void> {
    const preloaded = await driver.exec(vmId, 'test -f /opt/paddock/browser-runtime.ready');
    if (preloaded.exitCode !== 0) {
      await this.execOrThrow(
        driver,
        vmId,
        'mkdir -p /workspace/.paddock/browser /opt/paddock/ms-playwright',
        'Failed to prepare browser runtime directories',
      );
      await this.execOrThrow(
        driver,
        vmId,
        'PLAYWRIGHT_BROWSERS_PATH=/opt/paddock/ms-playwright python3 -m pip install --no-cache-dir -r /opt/paddock/amp-openclaw/requirements.txt',
        'Failed to install browser runtime dependencies',
      );
      await this.execOrThrow(
        driver,
        vmId,
        'PLAYWRIGHT_BROWSERS_PATH=/opt/paddock/ms-playwright python3 -m playwright install --with-deps chromium',
        'Failed to install Chromium runtime',
      );
    }

    await this.execOrThrow(
      driver,
      vmId,
      'BROWSER_BIN="$(find /opt/paddock/ms-playwright -type f \\( -path \'*/chrome-linux/chrome\' -o -path \'*/chrome-linux64/chrome\' \\) | head -n1)" && test -n "$BROWSER_BIN" && ln -sf "$BROWSER_BIN" /usr/bin/chromium && ln -sf "$BROWSER_BIN" /usr/bin/chromium-browser',
      'Failed to expose Chromium as a system browser',
    );
    await this.execOrThrow(
      driver,
      vmId,
      'mkdir -p /opt/paddock && printf "browser-runtime=1\n" > /opt/paddock/browser-runtime.ready',
      'Failed to mark browser runtime as ready',
    );
  }

  private async detectSystemBrowser(driver: SandboxDriver, vmId: string): Promise<{ enabled: boolean; executablePath?: string }> {
    const result = await driver.exec(
      vmId,
      [
        'for browser in',
        '"${PADDOCK_BROWSER_EXECUTABLE:-}"',
        '/usr/bin/chromium',
        'chromium',
        'google-chrome',
        'google-chrome-stable',
        'chrome',
        'brave-browser',
        'microsoft-edge',
        'chromium-browser',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/opt/google/chrome/chrome',
        '/snap/bin/chromium',
        '; do',
        '  [ -n "$browser" ] || continue;',
        '  if command -v "$browser" >/dev/null 2>&1; then',
        '    command -v "$browser";',
        '    exit 0;',
        '  fi;',
        '  if [ -x "$browser" ]; then',
        '    printf "%s\\n" "$browser";',
        '    exit 0;',
        '  fi;',
        'done;',
        'exit 1',
      ].join(' '),
    );
    const executablePath = result.stdout.trim();
    if (result.exitCode === 0 && executablePath) {
      return { enabled: true, executablePath };
    }
    return { enabled: false };
  }

  private async isUsableSystemBrowser(
    driver: SandboxDriver,
    vmId: string,
    executablePath: string,
  ): Promise<boolean> {
    const escapedPath = executablePath.replace(/'/g, `'\\''`);
    const result = await driver.exec(
      vmId,
      `BROWSER_BIN='${escapedPath}' && "$BROWSER_BIN" --version 2>&1`,
    );
    const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
    if (output.includes('requires the chromium snap to be installed')) {
      return false;
    }
    return result.exitCode === 0;
  }

  private async ensureSystemBrowser(
    driver: SandboxDriver,
    vmId: string,
    packageManager: GuestPackageManager,
  ): Promise<{ enabled: boolean; executablePath?: string }> {
    const existing = await this.detectSystemBrowser(driver, vmId);
    if (existing.enabled && existing.executablePath && await this.isUsableSystemBrowser(driver, vmId, existing.executablePath)) {
      return existing;
    }

    if (packageManager === 'apk') {
      await driver.exec(vmId, 'apk add --no-cache chromium');
    } else {
      await driver.exec(
        vmId,
        'apt-get update && (DEBIAN_FRONTEND=noninteractive apt-get install -y chromium || DEBIAN_FRONTEND=noninteractive apt-get install -y chromium-browser)',
      );
    }

    const installed = await this.detectSystemBrowser(driver, vmId);
    if (installed.enabled && installed.executablePath && await this.isUsableSystemBrowser(driver, vmId, installed.executablePath)) {
      return installed;
    }

    await this.ensurePythonRuntime(driver, vmId, packageManager);
    await this.ensureBrowserRuntime(driver, vmId);

    const fallback = await this.detectSystemBrowser(driver, vmId);
    if (fallback.enabled && fallback.executablePath && await this.isUsableSystemBrowser(driver, vmId, fallback.executablePath)) {
      return fallback;
    }

    return fallback;
  }

  async create(agentType: string, sandboxType: SandboxType = 'simple-box'): Promise<Session> {
    const now = Date.now();
    const session: Session = { id: nanoid(), status: 'created', agentType, sandboxType, createdAt: now, updatedAt: now };
    this.db
      .prepare('INSERT INTO sessions (id, status, agent_type, sandbox_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(session.id, session.status, session.agentType, session.sandboxType, session.createdAt, session.updatedAt);
    this.sessions.set(session.id, session);
    this.eventStore.append(session.id, 'session.status', { status: session.status, agentType, sandboxType });
    return session;
  }

  async start(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (session.status !== 'created') throw new Error(`Session ${sessionId} already started`);
    const driver = this.getDriver(session.sandboxType);

    try {
      this.eventStore.append(session.id, 'amp.session.start', { phase: 'vm.init', message: 'Initializing VM...' });
      this.eventStore.append(session.id, 'amp.session.start', {
        phase: 'vm.image',
        message: getSandboxStartupMessage(session.sandboxType),
      });

      const vmId = await driver.createBox({ name: `paddock-${sessionId}`, sandboxType: session.sandboxType });

      session.vmId = vmId;
      session.status = 'running';
      session.updatedAt = Date.now();

      // Record GUI ports for computer-box sessions
      if (session.sandboxType === 'computer-box' && 'getGuiPorts' in driver) {
        const ports = (driver as ComputerBoxDriver).getGuiPorts(vmId);
        if (ports) session.guiPorts = ports;
      }

      this.db.prepare('UPDATE sessions SET status = ?, vm_id = ?, updated_at = ? WHERE id = ?').run(session.status, session.vmId, session.updatedAt, session.id);

      this.eventStore.append(session.id, 'session.status', { status: 'running', vmId });
      this.eventStore.append(session.id, 'amp.session.start', { phase: 'vm.ready', message: 'VM created successfully' });
      this.eventStore.append(session.id, 'amp.session.start', { phase: 'sidecar', message: 'Deploying Sidecar...' });

      await this.deploySidecar(driver, vmId, sessionId);

      this.eventStore.append(session.id, 'amp.session.start', { phase: 'env', message: 'Configuring environment...' });
      await this.configureAgentEnv(driver, vmId, session.agentConfig);
      this.eventStore.append(session.id, 'amp.session.start', { phase: 'sandbox_ready', message: 'Sandbox ready' });
    } catch (err) {
      const error = err as Error;
      this.updateSessionStatus(session, 'error');
      this.eventStore.append(sessionId, 'session.status', { status: 'error', error: `Failed to start sandbox: ${error.message}` });
      throw err;
    }
  }

  private async deploySidecar(driver: SandboxDriver, vmId: string, sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    const packageManager = this.getGuestPackageManager(session?.sandboxType);

    try {
      this.eventStore.append(sessionId, 'amp.session.start', { phase: 'sidecar.copy', message: 'Copying Sidecar files to VM...' });
      // copyIn preserves the source directory name, so dist/sidecar → /opt/paddock/sidecar/
      await driver.copyIn(vmId, join(PROJECT_ROOT, 'dist', 'sidecar'), '/opt/paddock');

      await this.ensureGuestTools(driver, vmId, packageManager);

      this.eventStore.append(sessionId, 'amp.session.start', { phase: 'sidecar.node', message: 'Installing Node.js...' });
      await this.ensureNode(driver, vmId, packageManager);

      this.eventStore.append(sessionId, 'amp.session.start', { phase: 'sidecar.shims', message: 'Installing PAL shims...' });
      // copyIn preserves directory name: pal-shims/ → /usr/local/bin/pal-shims/
      // We need shims directly in /usr/local/bin, so copy then move
      await driver.copyIn(vmId, join(PROJECT_ROOT, 'packages', 'sidecar', 'pal-shims'), '/opt/paddock');
      await this.execOrThrow(
        driver,
        vmId,
        'cp /opt/paddock/pal-shims/* /usr/local/bin/ && chmod +x /usr/local/bin/open /usr/local/bin/pbcopy /usr/local/bin/pbpaste /usr/local/bin/say /usr/local/bin/osascript /usr/local/bin/paddock-host-tool',
        'Failed to install PAL shims',
      );
      await this.execOrThrow(driver, vmId, 'mkdir -p /workspace /var/log /var/run', 'Failed to prepare Sidecar runtime directories');

      this.eventStore.append(sessionId, 'amp.session.start', { phase: 'sidecar.start', message: 'Starting Sidecar process...' });
      const controlUrl = await this.resolveControlPlaneUrlForVm(driver, vmId);
      const controlUrlCandidates = JSON.stringify(this.getControlPlaneUrlCandidates());
      // sidecar files are at /opt/paddock/sidecar/ due to copyIn behavior
      await this.execOrThrow(
        driver,
        vmId,
        `cd /opt/paddock/sidecar && NO_PROXY=127.0.0.1,localhost PADDOCK_SESSION_ID=${sessionId} PADDOCK_CONTROL_URL='${controlUrl}' PADDOCK_CONTROL_URL_CANDIDATES='${controlUrlCandidates}' PADDOCK_WATCH_DIR=/workspace PADDOCK_PROXY_PORT=8800 nohup node index.js > /var/log/paddock-sidecar.log 2>&1 & echo $! > /var/run/paddock-sidecar.pid`,
        'Failed to start Sidecar process',
      );

      this.eventStore.append(sessionId, 'amp.session.start', { phase: 'sidecar.verify', message: 'Verifying Sidecar is running...' });
      await new Promise((resolve) => setTimeout(resolve, Number(process.env.PADDOCK_SIDECAR_BOOT_DELAY_MS ?? 2000)));
      await this.execOrThrow(driver, vmId, 'test -s /var/run/paddock-sidecar.pid && kill -0 "$(cat /var/run/paddock-sidecar.pid)"', 'Sidecar process exited during startup');
      await this.execOrThrow(driver, vmId, 'curl --noproxy "*" -fsS http://127.0.0.1:8801/amp/health', 'Sidecar AMP Gate is not accepting connections');
    } catch (err) {
      const error = err as Error;
      const logs = await this.tailLog(driver, vmId, '/var/log/paddock-sidecar.log');
      const message = logs ? `${error.message}. Sidecar logs: ${logs}` : error.message;
      throw new Error(message);
    }
  }

  private async ensureGuestTools(driver: SandboxDriver, vmId: string, packageManager: GuestPackageManager): Promise<void> {
    const curlCheck = await driver.exec(vmId, 'command -v curl');
    if (curlCheck.exitCode === 0) return;

    if (packageManager === 'apk') {
      await this.execOrThrow(driver, vmId, 'apk add --no-cache curl ca-certificates', 'Failed to install guest tools via apk');
    } else {
      await this.execOrThrow(driver, vmId, 'apt-get update && apt-get install -y curl ca-certificates', 'Failed to install guest tools via apt');
    }
  }

  private async ensureNode(
    driver: SandboxDriver,
    vmId: string,
    packageManager: GuestPackageManager,
    requiredNodeVersion = '20.0.0',
  ): Promise<void> {
    const versionCheck = await driver.exec(
      vmId,
      `command -v node >/dev/null 2>&1 && node -p "const current=process.versions.node.split('.').map(Number); const required='${requiredNodeVersion}'.split('.').map(Number); const ok=current[0]>required[0] || (current[0]===required[0] && (current[1]>required[1] || (current[1]===required[1] && current[2]>=required[2]))); ok ? 'ok' : 'upgrade'"`,
    );
    if (versionCheck.exitCode === 0 && versionCheck.stdout.trim() === 'ok') return;

    // Detect guest architecture
    const arch = await driver.exec(vmId, 'uname -m');
    const nodeArch = arch.stdout.trim() === 'aarch64' ? 'arm64' : 'x64';

    // Try pre-bundled Node.js binary (fastest — no network needed, ~1.5s via copyIn)
    const nodeBinDir = join(PROJECT_ROOT, 'dist', `node-bin-${nodeArch}`);
    const { existsSync } = await import('node:fs');
    if (existsSync(join(nodeBinDir, 'bin', 'node'))) {
      // copyIn preserves dir name: node-bin-arm64 → /opt/paddock/node-bin-arm64/
      await driver.copyIn(vmId, nodeBinDir, '/opt/paddock');
      await this.execOrThrow(driver, vmId, `ln -sf /opt/paddock/node-bin-${nodeArch}/bin/node /usr/local/bin/node`, 'Failed to link bundled Node.js runtime');
      await this.execOrThrow(
        driver,
        vmId,
        `node -p "const current=process.versions.node.split('.').map(Number); const required='${requiredNodeVersion}'.split('.').map(Number); const ok=current[0]>required[0] || (current[0]===required[0] && (current[1]>required[1] || (current[1]===required[1] && current[2]>=required[2]))); if (!ok) process.exit(1); console.log(process.versions.node)"`,
        'Bundled Node.js runtime is not executable',
      );
      return;
    }

    // Fallback: install via package manager (slower, needs network)
    const requiredNodeMajor = Number(requiredNodeVersion.split('.')[0] ?? 20);
    if (packageManager === 'apk') {
      await this.execOrThrow(driver, vmId, 'apk add --no-cache nodejs npm', 'Failed to install Node.js via apk');
    } else {
      await this.execOrThrow(
        driver,
        vmId,
        `curl -fsSL https://deb.nodesource.com/setup_${requiredNodeMajor}.x | bash - && apt-get install -y nodejs`,
        'Failed to install Node.js via apt',
      );
    }
  }

  private async configureAgentEnv(driver: SandboxDriver, vmId: string, config?: AgentLLMConfig): Promise<void> {
    const resolvedConfig = config ? resolveAgentLLMConfig(config, process.env, this.configStore) : getDefaultAgentLLMConfig(process.env, this.configStore);
    const envLines = [
      '# Paddock: Route LLM traffic through Sidecar proxy',
      'ANTHROPIC_BASE_URL=http://127.0.0.1:8800/anthropic',
      'OPENAI_BASE_URL=http://127.0.0.1:8800/openai',
      'OPENROUTER_BASE_URL=http://127.0.0.1:8800/openrouter',
      'ANTHROPIC_API_KEY=paddock-proxy',
      'OPENAI_API_KEY=paddock-proxy',
      'OPENROUTER_API_KEY=paddock-proxy',
      `PADDOCK_LLM_PROVIDER=${resolvedConfig.provider}`,
      `PADDOCK_AGENT_MODEL=${resolvedConfig.model}`,
    ];
    await this.execOrThrow(
      driver,
      vmId,
      `cat >> /etc/environment << 'PADDOCK_EOF'\n${envLines.join('\n')}\nPADDOCK_EOF`,
      'Failed to configure agent environment',
    );
  }

  async deployAgent(sessionId: string, agentType: string, requestedConfig?: Partial<AgentLLMConfig>): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (!session.vmId) throw new Error(`Session ${sessionId} has no running VM`);
    if (session.status !== 'running') throw new Error(`Session ${sessionId} is not in a running state`);
    const driver = this.getDriver(session.sandboxType);
    const vmId = session.vmId;
    session.agentConfig = resolveAgentLLMConfig(requestedConfig, process.env, this.configStore);
    const deployment = resolveAgentDeploymentSpec(agentType, { projectRoot: PROJECT_ROOT, env: process.env });

    if (!deployment) {
      throw new Error(`Unknown agent type: ${agentType}`);
    }

    if (deployment.agentType === 'openclaw') {
      const packageManager = this.getGuestPackageManager(session.sandboxType);
      this.eventStore.append(sessionId, 'amp.session.start', {
        phase: 'agent.node',
        message: `Preparing Node.js runtime (${deployment.requiredNodeVersion})...`,
      });
      try {
        await this.ensureNode(driver, vmId, packageManager, deployment.requiredNodeVersion);
      } catch (err) {
        const error = err as Error;
        this.eventStore.append(sessionId, 'amp.agent.fatal', {
          agent: 'openclaw',
          code: 'ERR_AGENT_RUNTIME',
          message: error.message,
          stage: 'agent.node',
        });
        throw error;
      }
      session.agentTransport = deployment.commandTransport;
      session.agentSessionKey = deployment.commandTransport === 'openclaw-gateway' ? `paddock:${sessionId}` : undefined;

      if (deployment.mode === 'official-script') {
        await this.deployOfficialOpenClaw(driver, vmId, sessionId, session, deployment);
      } else {
        await this.deployCompatOpenClaw(driver, vmId, sessionId, session, packageManager);
      }
    } else {
      throw new Error(`Unknown agent type: ${agentType}`);
    }
  }

  private async deployCompatOpenClaw(
    driver: SandboxDriver,
    vmId: string,
    sessionId: string,
    session: RuntimeSession,
    packageManager: GuestPackageManager,
  ): Promise<void> {
    let stage = 'agent.copy_adapter';

    try {
      this.eventStore.append(sessionId, 'amp.session.start', { phase: 'agent.copy_adapter', message: 'Copying AMP adapter...' });
      // copyIn preserves dir name: amp-openclaw → /opt/paddock/amp-openclaw/
      await driver.copyIn(vmId, join(PROJECT_ROOT, 'dist', 'amp-openclaw'), '/opt/paddock');

      stage = 'agent.install_python';
      this.eventStore.append(sessionId, 'amp.session.start', { phase: 'agent.install_python', message: 'Installing Python runtime...' });
      await this.ensurePythonRuntime(driver, vmId, packageManager);

      stage = 'agent.env';
      this.eventStore.append(sessionId, 'amp.session.start', {
        phase: 'agent.env',
        message: `Configuring agent model (${session.agentConfig?.provider} / ${session.agentConfig?.model})...`,
      });
      await this.configureAgentEnv(driver, vmId, session.agentConfig);

      stage = 'agent.install_adapter';
      this.eventStore.append(sessionId, 'amp.session.start', { phase: 'agent.install_adapter', message: 'Preparing bundled AMP agent...' });
      await this.execOrThrow(
        driver,
        vmId,
        'PYTHONPATH=/opt/paddock/amp-openclaw python3 -c "import paddock_amp; print(\'paddock_amp ready\')"',
        'Failed to prepare bundled AMP agent',
      );

      stage = 'agent.install_browser';
      this.eventStore.append(sessionId, 'amp.session.start', {
        phase: 'agent.install_browser',
        message: 'Installing sandbox-local browser runtime...',
      });
      await this.ensureBrowserRuntime(driver, vmId);

      stage = 'agent.starting';
      this.eventStore.append(sessionId, 'amp.session.start', { phase: 'agent.starting', message: 'Starting bundled OpenClaw compatibility agent...' });
      const browserHeadless = this.isBrowserHeadless(session.sandboxType) ? '1' : '0';
      // Source /etc/environment so the bundled agent routes LLM traffic through the Sidecar proxy.
      await this.execOrThrow(
        driver,
        vmId,
        `set -a && . /etc/environment && set +a && NO_PROXY=127.0.0.1,localhost PLAYWRIGHT_BROWSERS_PATH=/opt/paddock/ms-playwright PADDOCK_SIDECAR_URL=http://127.0.0.1:8801 PADDOCK_BROWSER_ENABLED=1 PADDOCK_BROWSER_HEADLESS=${browserHeadless} PADDOCK_BROWSER_DEFAULT_TIMEOUT_MS=15000 PADDOCK_BROWSER_OUTPUT_DIR=/workspace/.paddock/browser PYTHONPATH=/opt/paddock/amp-openclaw nohup python3 -m paddock_amp.builtin_agent > /var/log/openclaw.log 2>&1 & echo $! > /var/run/openclaw.pid`,
        'Failed to launch OpenClaw',
      );

      await new Promise(r => setTimeout(r, Number(process.env.PADDOCK_AGENT_BOOT_DELAY_MS ?? 3000)));

      stage = 'agent.verify';
      this.eventStore.append(sessionId, 'amp.session.start', { phase: 'agent.verify', message: 'Waiting for agent to report AMP readiness...' });
      await this.execOrThrow(driver, vmId, 'test -s /var/run/openclaw.pid && kill -0 "$(cat /var/run/openclaw.pid)"', 'OpenClaw process exited during startup');
      await this.waitForAgentReady(sessionId);

      this.eventStore.append(sessionId, 'amp.session.start', { phase: 'agent_ready', message: 'OpenClaw connected to Paddock' });
    } catch (err) {
      const error = err as Error;
      const logs = await this.tailLog(driver, vmId, '/var/log/openclaw.log');
      const message = logs ? `${error.message}. OpenClaw logs: ${logs}` : error.message;
      this.eventStore.append(sessionId, 'amp.agent.fatal', {
        agent: 'openclaw',
        code: stage === 'agent.verify' ? 'ERR_AGENT_NOT_READY' : 'ERR_AGENT_DEPLOY',
        message,
        stage,
      });
      throw new Error(message);
    }
  }

  private async deployOfficialOpenClaw(
    driver: SandboxDriver,
    vmId: string,
    sessionId: string,
    session: RuntimeSession,
    deployment: AgentDeploymentSpec,
  ): Promise<void> {
    let stage = 'agent.copy_adapter';
    const packageManager = this.getGuestPackageManager(session.sandboxType);

    try {
      this.eventStore.append(sessionId, 'amp.session.start', {
        phase: 'agent.copy_adapter',
        message: 'Copying OpenClaw deployment scripts...',
      });
      await driver.copyIn(vmId, deployment.bundleDir, '/opt/paddock');

      stage = 'agent.copy_runtime';
      this.eventStore.append(sessionId, 'amp.session.start', {
        phase: 'agent.copy_runtime',
        message: 'Copying OpenClaw runtime bundle...',
      });
      const compressedRuntime = join(PROJECT_ROOT, 'dist', 'openclaw-runtime.tar.gz');
      if (await this.hostPathExists(compressedRuntime)) {
        await driver.copyIn(vmId, compressedRuntime, '/opt/paddock');
        await this.execOrThrow(
          driver,
          vmId,
          'mkdir -p /opt/paddock && tar -xzf /opt/paddock/openclaw-runtime.tar.gz -C /opt/paddock && rm -f /opt/paddock/openclaw-runtime.tar.gz',
          'Failed to unpack the OpenClaw runtime bundle',
        );
      } else {
        await this.copyOpenClawRuntimeBundle(driver, vmId, join(PROJECT_ROOT, 'dist', 'openclaw-runtime'));
      }

      stage = 'agent.env';
      this.eventStore.append(sessionId, 'amp.session.start', {
        phase: 'agent.env',
        message: `Configuring agent model (${session.agentConfig?.provider} / ${session.agentConfig?.model})...`,
      });
      await this.configureAgentEnv(driver, vmId, session.agentConfig);

      stage = 'agent.install_browser';
      this.eventStore.append(sessionId, 'amp.session.start', {
        phase: 'agent.install_browser',
        message: 'Ensuring a sandbox system browser is installed...',
      });
      const browserRuntime = await this.ensureSystemBrowser(driver, vmId, packageManager);
      this.eventStore.append(sessionId, 'amp.session.start', {
        phase: 'agent.browser',
        message: browserRuntime.enabled
          ? `Using sandbox system browser: ${browserRuntime.executablePath}`
          : 'No system browser detected in the sandbox. Install chromium/chrome with apt to enable browser tools.',
      });
      await this.writeOpenClawConfig(
        driver,
        vmId,
        session.agentConfig ?? getDefaultAgentLLMConfig(process.env, this.configStore),
        session.sandboxType,
        browserRuntime,
      );

      stage = 'agent.install_adapter';
      this.eventStore.append(sessionId, 'amp.session.start', {
        phase: 'agent.install_adapter',
        message: 'Preparing official OpenClaw runtime...',
      });
      await this.execOrThrow(
        driver,
        vmId,
        'OPENCLAW_STATE_DIR=/workspace/.openclaw OPENCLAW_CONFIG_PATH=/workspace/.openclaw/openclaw.json OPENCLAW_GATEWAY_PORT=18789 /opt/paddock/openclaw/install.sh',
        'Failed to prepare official OpenClaw runtime',
      );

      stage = 'agent.starting';
      this.eventStore.append(sessionId, 'amp.session.start', {
        phase: 'agent.starting',
        message: 'Starting official OpenClaw gateway runtime...',
      });
      await this.execOrThrow(
        driver,
        vmId,
        'set -a && . /etc/environment && set +a && OPENCLAW_STATE_DIR=/workspace/.openclaw OPENCLAW_CONFIG_PATH=/workspace/.openclaw/openclaw.json OPENCLAW_GATEWAY_PORT=18789 OPENCLAW_SKIP_CHANNELS=1 OPENCLAW_BUNDLED_PLUGINS_DIR=/opt/paddock/openclaw/paddock-amp-plugin NO_PROXY=127.0.0.1,localhost /opt/paddock/openclaw/launch.sh',
        'Failed to launch OpenClaw',
      );

      await new Promise(r => setTimeout(r, Number(process.env.PADDOCK_AGENT_BOOT_DELAY_MS ?? 3000)));

      stage = 'agent.verify';
      this.eventStore.append(sessionId, 'amp.session.start', {
        phase: 'agent.verify',
        message: 'Waiting for the OpenClaw gateway to accept commands...',
      });
      await this.execOrThrow(driver, vmId, 'test -s /var/run/openclaw.pid && kill -0 "$(cat /var/run/openclaw.pid)"', 'OpenClaw process exited during startup');
      await this.waitForExecSuccess(
        driver,
        vmId,
        'OPENCLAW_STATE_DIR=/workspace/.openclaw OPENCLAW_CONFIG_PATH=/workspace/.openclaw/openclaw.json OPENCLAW_GATEWAY_PORT=18789 NO_PROXY=127.0.0.1,localhost node /opt/paddock/openclaw-runtime/openclaw.mjs gateway health --json --port 18789 >/tmp/paddock-openclaw-health.json',
        'OpenClaw gateway is not responding',
        Number(process.env.PADDOCK_OPENCLAW_GATEWAY_READY_TIMEOUT_MS ?? 90000),
        Number(process.env.PADDOCK_OPENCLAW_GATEWAY_READY_INTERVAL_MS ?? 2000),
      );

      if (browserRuntime.enabled) {
        stage = 'agent.browser_prewarm';
        this.eventStore.append(sessionId, 'amp.session.start', {
          phase: 'agent.browser_prewarm',
          message: 'Pre-warming the OpenClaw browser runtime...',
        });
        await this.waitForExecSuccess(
          driver,
          vmId,
          'OPENCLAW_STATE_DIR=/workspace/.openclaw OPENCLAW_CONFIG_PATH=/workspace/.openclaw/openclaw.json OPENCLAW_GATEWAY_PORT=18789 NO_PROXY=127.0.0.1,localhost node /opt/paddock/openclaw-runtime/openclaw.mjs browser start --json >/tmp/paddock-openclaw-browser.json',
          'OpenClaw browser runtime is not ready',
          Number(process.env.PADDOCK_OPENCLAW_BROWSER_READY_TIMEOUT_MS ?? 60000),
          Number(process.env.PADDOCK_OPENCLAW_BROWSER_READY_INTERVAL_MS ?? 2000),
        );
      }

      this.eventStore.append(sessionId, 'amp.agent.ready', {
        agent: 'openclaw',
        version: 'official-script',
        capabilities: ['chat', 'gateway'],
        transport: deployment.commandTransport,
      });
      this.eventStore.append(sessionId, 'amp.session.start', { phase: 'agent_ready', message: 'OpenClaw connected to Paddock' });
    } catch (err) {
      const error = err as Error;
      const logs = await this.tailLog(driver, vmId, '/var/log/openclaw.log');
      const message = logs ? `${error.message}. OpenClaw logs: ${logs}` : error.message;
      this.eventStore.append(sessionId, 'amp.agent.fatal', {
        agent: 'openclaw',
        code: stage === 'agent.verify' ? 'ERR_AGENT_NOT_READY' : 'ERR_AGENT_DEPLOY',
        message,
        stage,
      });
      throw new Error(message);
    }
  }

  private async writeOpenClawConfig(
    driver: SandboxDriver,
    vmId: string,
    config: AgentLLMConfig,
    sandboxType?: SandboxType,
    browserRuntime?: { enabled: boolean; executablePath?: string },
  ): Promise<void> {
    const runtimeConfig = buildOpenClawRuntimeConfig({
      llm: config,
      gatewayPort: 18789,
      browserEnabled: browserRuntime?.enabled ?? true,
      browserHeadless: this.isBrowserHeadless(sandboxType),
      browserExecutablePath: browserRuntime?.executablePath,
      proxyBaseUrl: 'http://127.0.0.1:8800',
    });
    const payload = JSON.stringify(runtimeConfig, null, 2);

    await this.execOrThrow(
      driver,
      vmId,
      `mkdir -p /workspace/.openclaw && cat > /workspace/.openclaw/openclaw.json <<'PADDOCK_OPENCLAW_EOF'\n${payload}\nPADDOCK_OPENCLAW_EOF`,
      'Failed to write OpenClaw runtime config',
    );
  }

  private async copyOpenClawRuntimeBundle(driver: SandboxDriver, vmId: string, hostBundleDir: string): Promise<void> {
    await this.execOrThrow(driver, vmId, 'mkdir -p /opt/paddock/openclaw-runtime /opt/paddock/openclaw-runtime/node_modules/.pnpm', 'Failed to prepare OpenClaw runtime directories');

    for (const entry of readdirSync(hostBundleDir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') {
        await this.copyOpenClawNodeModules(driver, vmId, join(hostBundleDir, entry.name));
        continue;
      }
      const hostPath = join(hostBundleDir, entry.name);
      if (entry.isDirectory()) {
        await this.copyDirectoryContents(driver, vmId, hostPath, `/opt/paddock/openclaw-runtime/${entry.name}`);
      } else {
        await driver.copyIn(vmId, hostPath, '/opt/paddock/openclaw-runtime');
      }
    }
  }

  private async hostPathExists(hostPath: string): Promise<boolean> {
    try {
      const { statSync } = await import('node:fs');
      statSync(hostPath);
      return true;
    } catch {
      return false;
    }
  }

  private async copyOpenClawNodeModules(driver: SandboxDriver, vmId: string, hostNodeModulesDir: string): Promise<void> {
    const vmNodeModulesDir = '/opt/paddock/openclaw-runtime/node_modules';
    await this.execOrThrow(driver, vmId, `mkdir -p ${vmNodeModulesDir} ${vmNodeModulesDir}/.pnpm`, 'Failed to prepare OpenClaw node_modules directory');

    for (const entry of readdirSync(hostNodeModulesDir, { withFileTypes: true })) {
      if (entry.name === '.pnpm') {
        for (const packageEntry of readdirSync(join(hostNodeModulesDir, '.pnpm'), { withFileTypes: true })) {
          const hostPath = join(hostNodeModulesDir, '.pnpm', packageEntry.name);
          if (packageEntry.isDirectory()) {
            await this.copyDirectoryContents(driver, vmId, hostPath, `${vmNodeModulesDir}/.pnpm/${packageEntry.name}`);
          } else {
            await driver.copyIn(vmId, hostPath, `${vmNodeModulesDir}/.pnpm`);
          }
        }
        continue;
      }
      await driver.copyIn(vmId, join(hostNodeModulesDir, entry.name), vmNodeModulesDir);
    }
  }

  private async copyDirectoryContents(driver: SandboxDriver, vmId: string, hostDir: string, vmDir: string): Promise<void> {
    await this.execOrThrow(driver, vmId, `mkdir -p '${vmDir}'`, `Failed to prepare runtime directory ${vmDir}`);

    for (const entry of readdirSync(hostDir, { withFileTypes: true })) {
      const hostPath = join(hostDir, entry.name);
      if (entry.isDirectory()) {
        await this.copyDirectoryContents(driver, vmId, hostPath, `${vmDir}/${entry.name}`);
      } else {
        await driver.copyIn(vmId, hostPath, vmDir);
      }
    }
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (session.vmId) {
      const driver = this.getDriver(session.sandboxType);
      await driver.destroyBox(session.vmId);
    }
    session.status = 'terminated';
    session.updatedAt = Date.now();
    this.db.prepare('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?').run(session.status, session.updatedAt, session.id);
    this.eventStore.append(session.id, 'session.status', { status: 'terminated' });
  }

  getDriverForSession(sessionId: string): SandboxDriver {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    return this.getDriver(session.sandboxType);
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  list(): Session[] {
    return Array.from(this.sessions.values());
  }

  async listWithRuntimeStatus(): Promise<Session[]> {
    const sessions = Array.from(this.sessions.values());
    for (const session of sessions) {
      await this.reconcileRuntimeStatus(session);
    }
    return sessions;
  }

  async remove(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    if (session.vmId && session.status === 'running') {
      try {
        const driver = this.getDriver(session.sandboxType);
        await driver.destroyBox(session.vmId);
      } catch {
        // best effort cleanup only
      }
    }

    this.sessions.delete(sessionId);
    this.db.prepare('DELETE FROM snapshots WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM events WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    return true;
  }

  private updateSessionStatus(session: Session, status: SessionStatus) {
    session.status = status;
    session.updatedAt = Date.now();
    this.db.prepare('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?').run(session.status, session.updatedAt, session.id);
  }

  private async reconcileRuntimeStatus(session: RuntimeSession): Promise<void> {
    if (!session.vmId) return;
    if (session.status !== 'running' && session.status !== 'paused') return;

    try {
      const driver = this.getDriver(session.sandboxType);
      const info = await driver.getInfo(session.vmId);
      if (info?.status === 'running') return;
    } catch {
      // If the driver cannot see the VM anymore, surface that truth in the UI.
    }

    this.updateSessionStatus(session, 'terminated');
    this.eventStore.append(session.id, 'session.status', {
      status: 'terminated',
      reason: 'runtime_unavailable',
    });
  }

  private async execOrThrow(driver: SandboxDriver, vmId: string, command: string, description: string): Promise<ExecResult> {
    const result = await driver.exec(vmId, command);
    if (result.exitCode === 0) return result;

    const detail = [result.stderr.trim(), result.stdout.trim()]
      .filter(Boolean)
      .join(' | ')
      .slice(0, 800);

    throw new Error(`${description} (exit ${result.exitCode})${detail ? `: ${detail}` : ''}`);
  }

  private async waitForExecSuccess(
    driver: SandboxDriver,
    vmId: string,
    command: string,
    description: string,
    timeoutMs: number,
    intervalMs: number,
  ): Promise<ExecResult> {
    const startedAt = Date.now();
    let lastResult: ExecResult | null = null;

    while (Date.now() - startedAt < timeoutMs) {
      lastResult = await driver.exec(vmId, command);
      if (lastResult.exitCode === 0) {
        return lastResult;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    const detail = lastResult
      ? [lastResult.stderr.trim(), lastResult.stdout.trim()].filter(Boolean).join(' | ').slice(0, 800)
      : '';
    const suffix = lastResult ? ` (exit ${lastResult.exitCode})` : '';
    throw new Error(`${description}${suffix}${detail ? `: ${detail}` : ''}`);
  }

  private async tailLog(driver: SandboxDriver, vmId: string, path: string): Promise<string> {
    const result = await driver.exec(vmId, `tail -50 ${path} 2>&1 || true`);
    return [result.stdout.trim(), result.stderr.trim()]
      .filter(Boolean)
      .join(' | ')
      .slice(0, 1000);
  }

  private async waitForAgentReady(sessionId: string): Promise<PaddockEvent> {
    const existing = this.eventStore.getEvents(sessionId, { types: ['amp.agent.ready'] });
    if (existing.length > 0) return existing[existing.length - 1];

    const timeoutMs = Number(process.env.PADDOCK_AGENT_READY_TIMEOUT_MS ?? 15000);

    return new Promise<PaddockEvent>((resolve, reject) => {
      const cleanup = (timer: ReturnType<typeof setTimeout>, listener: (event: PaddockEvent) => void) => {
        clearTimeout(timer);
        this.eventStore.offEvent(listener);
      };

      const listener = (event: PaddockEvent) => {
        if (event.sessionId !== sessionId) return;
        if (event.type === 'amp.agent.ready') {
          cleanup(timer, listener);
          resolve(event);
          return;
        }
        if (event.type === 'amp.agent.fatal' || event.type === 'amp.agent.exit') {
          cleanup(timer, listener);
          reject(new Error(`Agent exited before reporting ready: ${JSON.stringify(event.payload)}`));
        }
      };

      const timer = setTimeout(() => {
        cleanup(timer, listener);
        reject(new Error(`Timed out waiting for amp.agent.ready after ${timeoutMs}ms`));
      }, timeoutMs);

      this.eventStore.onEvent(listener);
    });
  }

  private getControlPlaneUrlCandidates(): string[] {
    const port = Number(process.env.PADDOCK_PORT ?? 3100);
    const candidates = new Set<string>();
    const preferred = process.env.PADDOCK_CONTROL_URL;
    if (preferred) candidates.add(preferred);

    candidates.add(`http://host.internal:${port}`);
    candidates.add(`http://host.docker.internal:${port}`);
    candidates.add(`http://10.0.2.2:${port}`);

    for (const iface of Object.values(networkInterfaces())) {
      for (const address of iface ?? []) {
        if (address.family === 'IPv4' && !address.internal) {
          candidates.add(`http://${address.address}:${port}`);
        }
      }
    }

    return Array.from(candidates);
  }

  private async resolveControlPlaneUrlForVm(driver: SandboxDriver, vmId: string): Promise<string> {
    const candidates = this.getControlPlaneUrlCandidates();
    for (const candidate of candidates) {
      const result = await driver.exec(vmId, `curl --noproxy "*" -fsS --max-time 2 '${candidate}/api/health' >/dev/null`);
      if (result.exitCode === 0) return candidate;
    }

    throw new Error(`VM cannot reach control plane. Tried: ${candidates.join(', ')}`);
  }
}
