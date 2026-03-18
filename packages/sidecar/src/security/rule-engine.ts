import { resolve, relative } from 'node:path';
import { realpathSync } from 'node:fs';
import type { RuleResult } from '@paddock/types';

interface Rule {
  pattern: RegExp;
  risk: number;
  name: string;
}

// ── exec tool: command pattern matching ──
const EXEC_RULES: Rule[] = [
  { pattern: /rm\s+(-[rf]+\s+)*\/(?!workspace)/, risk: 90, name: 'destructive_rm' },
  { pattern: /curl.*\|\s*(ba)?sh/, risk: 95, name: 'remote_code_exec' },
  { pattern: /\/dev\/tcp\//, risk: 99, name: 'reverse_shell' },
  { pattern: /nc\s+-[le].*\d+/, risk: 90, name: 'netcat_listener' },
  { pattern: /sudo\s/, risk: 70, name: 'sudo' },
  { pattern: /chmod\s+[47]77/, risk: 60, name: 'world_writable' },
  { pattern: />\s*\/etc\//, risk: 80, name: 'etc_write' },
  { pattern: />\s*~?\/?\.ssh\//, risk: 85, name: 'ssh_write' },
  { pattern: /curl\s.*-X\s*POST/, risk: 50, name: 'http_post' },
];

// Shell metacharacter injection patterns
const SHELL_INJECTION_PATTERNS: Rule[] = [
  { pattern: /`[^`]+`/, risk: 80, name: 'backtick_injection' },
  { pattern: /\$\([^)]+\)/, risk: 80, name: 'subshell_injection' },
  { pattern: /\$\{[^}]+\}/, risk: 70, name: 'variable_expansion' },
  { pattern: /;\s*\S/, risk: 60, name: 'command_chain' },
  { pattern: /\x00/, risk: 99, name: 'null_byte' },
];

// Pipe whitelist: safe pipe patterns
const SAFE_PIPE_PATTERNS = [
  /grep\s.*\|\s*head/, /grep\s.*\|\s*tail/, /grep\s.*\|\s*wc/,
  /ls\s.*\|\s*grep/, /cat\s.*\|\s*grep/, /sort\s.*\|\s*uniq/,
];

// ── read/write/edit tool: path rules ──
const PATH_RULES: Rule[] = [
  { pattern: /^\/etc\//, risk: 80, name: 'etc_path' },
  { pattern: /\.env$/, risk: 60, name: 'env_file' },
  { pattern: /\.ssh\//, risk: 85, name: 'ssh_path' },
  { pattern: /^\/(?!workspace)/, risk: 40, name: 'outside_workspace' },
];

// Safe environment variables whitelist
export const SAFE_ENV_VARS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TERM'];

/**
 * Validate a file path is safe (no traversal, no symlink escape).
 */
export function validatePath(rawPath: string, workspace: string): { safe: boolean; risk: number; rules: string[] } {
  const triggered: string[] = [];
  let risk = 0;

  // Phase 1: reject ".." path components
  if (rawPath.includes('..')) {
    return { safe: false, risk: 95, rules: ['path_traversal'] };
  }

  // Phase 2: resolve symlinks to get real path
  let realPath: string;
  try {
    realPath = realpathSync(resolve(workspace, rawPath));
  } catch {
    realPath = resolve(workspace, rawPath);
  }

  // Phase 3: confirm real path is within workspace (or allowed list)
  const rel = relative(workspace, realPath);
  if (rel.startsWith('..') || resolve(realPath) !== resolve(workspace, rel)) {
    triggered.push('symlink_escape');
    risk = Math.max(risk, 90);
  }

  // Check path rules
  for (const rule of PATH_RULES) {
    if (rule.pattern.test(rawPath) || rule.pattern.test(realPath)) {
      triggered.push(rule.name);
      risk = Math.max(risk, rule.risk);
    }
  }

  return { safe: triggered.length === 0, risk, rules: triggered };
}

/**
 * Validate a URL for outbound request safety.
 */
function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

export function validateUrl(
  url: string,
  options?: { allowLoopback?: boolean },
): { safe: boolean; risk: number; rules: string[] } {
  const triggered: string[] = [];
  let risk = 0;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { safe: false, risk: 80, rules: ['invalid_url'] };
  }

  // Only allow http/https
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { safe: false, risk: 90, rules: ['non_http_protocol'] };
  }

  const hostname = parsed.hostname.toLowerCase();
  const loopbackAllowed = options?.allowLoopback === true && isLoopbackHost(hostname);

  // Block special hosts
  const blockedHosts = ['localhost', '127.0.0.1', '0.0.0.0', 'metadata.google.internal', '169.254.169.254'];
  if (blockedHosts.includes(hostname) && !loopbackAllowed) {
    triggered.push('blocked_host');
    risk = Math.max(risk, 90);
  }

  // Block private IP ranges
  const privateIpPatterns = [
    /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^169\.254\./,
  ];
  for (const pat of privateIpPatterns) {
    if (pat.test(hostname)) {
      if (loopbackAllowed) {
        break;
      }
      triggered.push('private_ip');
      risk = Math.max(risk, 85);
      break;
    }
  }

  return { safe: triggered.length === 0, risk, rules: triggered };
}

export class RuleEngine {
  private workspace: string;

  constructor(workspace: string = '/workspace') {
    this.workspace = workspace;
  }

  evaluate(toolName: string, toolInput: Record<string, unknown>): RuleResult {
    switch (toolName) {
      case 'exec': return this.evaluateExec(toolInput);
      case 'read': case 'write': case 'edit': return this.evaluatePath(toolInput);
      case 'web_fetch': return this.evaluateUrl(toolInput);
      case 'web_search': return this.evaluateWebSearch(toolInput);
      case 'browser': return this.evaluateBrowser(toolInput);
      default: return { baseRisk: 0, triggered: [] };
    }
  }

  private evaluateExec(input: Record<string, unknown>): RuleResult {
    const command = String(input.command ?? '');
    const triggered: string[] = [];
    let risk = 0;

    // Check command patterns
    for (const rule of EXEC_RULES) {
      if (rule.pattern.test(command)) {
        triggered.push(rule.name);
        risk = Math.max(risk, rule.risk);
      }
    }

    // Check shell injection (unless pipe is whitelisted)
    const hasPipe = command.includes('|');
    const pipeWhitelisted = hasPipe && SAFE_PIPE_PATTERNS.some(p => p.test(command));

    if (hasPipe && !pipeWhitelisted) {
      triggered.push('pipe_not_whitelisted');
      risk = Math.max(risk, 50);
    }

    for (const rule of SHELL_INJECTION_PATTERNS) {
      if (rule.pattern.test(command)) {
        triggered.push(rule.name);
        risk = Math.max(risk, rule.risk);
      }
    }

    return { baseRisk: risk, triggered };
  }

  private evaluatePath(input: Record<string, unknown>): RuleResult {
    const path = String(input.path ?? input.file_path ?? '');
    if (!path) return { baseRisk: 0, triggered: [] };
    const result = validatePath(path, this.workspace);
    return { baseRisk: result.risk, triggered: result.rules };
  }

  private evaluateUrl(input: Record<string, unknown>): RuleResult {
    const url = String(input.url ?? '');
    if (!url) return { baseRisk: 0, triggered: [] };
    const result = validateUrl(url);
    return { baseRisk: result.risk, triggered: result.rules };
  }

  private evaluateWebSearch(input: Record<string, unknown>): RuleResult {
    const url = String(input.url ?? input.searchUrl ?? '');
    if (!url) return { baseRisk: 0, triggered: [] };
    return this.evaluateUrl({ url });
  }

  private evaluateBrowser(input: Record<string, unknown>): RuleResult {
    const action = String(input.action ?? '').toLowerCase();
    if (!['open', 'navigate', 'goto'].includes(action)) {
      return { baseRisk: 0, triggered: [] };
    }
    const url = String(input.url ?? '');
    if (!url) return { baseRisk: 0, triggered: [] };
    const result = validateUrl(url, { allowLoopback: true });
    return { baseRisk: result.risk, triggered: result.rules };
  }
}
