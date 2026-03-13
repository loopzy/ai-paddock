import { EventReporter } from './reporter.js';
import type { AMPAgentError } from './types.js';

const HEARTBEAT_INTERVAL = 30_000; // 30s
const PROCESS_CHECK_INTERVAL = 10_000; // 10s

/**
 * AgentMonitor — monitors agent process health inside the VM.
 * - Periodic heartbeat via adapter health endpoint or process check
 * - Process liveness monitoring (pgrep)
 * - HTTP endpoint for agent to report errors
 */
export class AgentMonitor {
  private reporter: EventReporter;
  private agentName: string;
  private agentProcessPattern: string;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private processCheckTimer: ReturnType<typeof setInterval> | null = null;
  private startTime = Date.now();
  private lastAgentError: AMPAgentError | null = null;

  constructor(reporter: EventReporter, agentName = 'unknown', agentProcessPattern = 'openclaw') {
    this.reporter = reporter;
    this.agentName = agentName;
    this.agentProcessPattern = agentProcessPattern;
  }

  start() {
    this.heartbeatTimer = setInterval(() => this.reportHeartbeat(), HEARTBEAT_INTERVAL);
    this.processCheckTimer = setInterval(() => this.checkProcess(), PROCESS_CHECK_INTERVAL);
  }

  stop() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.processCheckTimer) clearInterval(this.processCheckTimer);
  }

  /** Called when agent reports ready */
  async reportReady(version = '0.0.0', capabilities: string[] = []) {
    return this.reporter.report('amp.agent.ready' as any, {
      agent: this.agentName,
      version,
      capabilities,
    });
  }

  /** Periodic heartbeat report */
  private async reportHeartbeat() {
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
    const memUsage = process.memoryUsage();
    await this.reporter.report('amp.agent.heartbeat' as any, {
      agent: this.agentName,
      uptime,
      memoryMB: Math.round(memUsage.rss / 1024 / 1024),
      pendingTasks: 0,
    });
  }

  /** Check if agent process is still alive */
  private async checkProcess() {
    try {
      const { execSync } = await import('node:child_process');
      execSync(`pgrep -f "${this.agentProcessPattern}"`, { stdio: 'pipe' });
    } catch {
      // Process not found — report exit
      await this.reporter.report('amp.agent.exit' as any, {
        agent: this.agentName,
        exitCode: -1,
        reason: 'crash',
      });
      // Stop monitoring after exit detected
      this.stop();
    }
  }

  /** Handle error report from agent adapter */
  async reportError(error: AMPAgentError) {
    this.lastAgentError = error;
    const eventType = error.recoverable ? 'amp.agent.error' : 'amp.agent.fatal';
    return this.reporter.report(eventType as any, {
      agent: this.agentName,
      category: error.category,
      code: error.code,
      message: error.message,
      recoverable: error.recoverable,
      context: error.context,
    });
  }

  /** Handle fatal error — agent is about to exit */
  async reportFatal(code: string, message: string, stack?: string) {
    return this.reporter.report('amp.agent.fatal' as any, {
      agent: this.agentName,
      code,
      message,
      stack,
    });
  }

  /** Handle agent exit */
  async reportExit(exitCode: number, reason: 'normal' | 'crash' | 'killed' | 'oom') {
    const ok = await this.reporter.report('amp.agent.exit' as any, {
      agent: this.agentName,
      exitCode,
      reason,
    });
    this.stop();
    return ok;
  }
}
