import { TaintLabel } from '@paddock/types';
import type { TaintEntry, TaintResult } from '@paddock/types';
import { VAULT_PATTERNS } from '../vault/sensitive-data-vault.js';

// Sink policies: which taint labels are forbidden at each sink
const SINK_POLICIES: Record<string, TaintLabel[]> = {
  exec: [TaintLabel.ExternalContent, TaintLabel.Secret],
  web_fetch: [TaintLabel.Secret, TaintLabel.PII],
  write: [], // writing files propagates labels but isn't blocked
};

// Sensitive file paths that trigger FileContent taint
const SENSITIVE_PATHS = [/\.env$/, /\.ssh\//, /\/etc\/passwd/, /\/etc\/shadow/, /\.pem$/, /\.key$/];

export class TaintTracker {
  private entries: TaintEntry[] = [];
  private maxEntries = 500;

  /**
   * Called after a tool produces a result. Scans the result and tags it.
   */
  onToolResult(toolName: string, result: string, meta?: { path?: string }): void {
    const labels = new Set<TaintLabel>();

    // Scan for secrets/PII using Vault patterns
    for (const { name, regex } of VAULT_PATTERNS) {
      regex.lastIndex = 0;
      const matches = result.match(regex);
      if (matches) {
        for (const m of matches) {
          if (m.length < 6) continue;
          const entryLabels = new Set<TaintLabel>();
          if (['email', 'phone', 'credit_card', 'ssn'].includes(name)) {
            entryLabels.add(TaintLabel.PII);
          } else {
            entryLabels.add(TaintLabel.Secret);
          }
          this.addEntry(m, entryLabels, `${toolName}:${name}`);
        }
      }
    }

    // Tag by source tool
    if (toolName === 'web_fetch' || toolName === 'web_search') {
      labels.add(TaintLabel.ExternalContent);
    }
    if (toolName === 'read' && meta?.path && SENSITIVE_PATHS.some(p => p.test(meta.path!))) {
      labels.add(TaintLabel.FileContent);
    }

    // If we have source-level labels, store a truncated sample
    if (labels.size > 0 && result.length > 0) {
      const sample = result.slice(0, 200);
      this.addEntry(sample, labels, `${toolName}:${meta?.path ?? 'result'}`);
    }
  }

  /**
   * Check if tool input contains tainted values that violate sink policies.
   */
  checkToolIntent(toolName: string, serializedInput: string): TaintResult {
    const forbidden = SINK_POLICIES[toolName];
    if (!forbidden || forbidden.length === 0) {
      return { risk: 0, matches: [] };
    }

    const matches: string[] = [];
    let risk = 0;

    for (const entry of this.entries) {
      // Check if any forbidden label is present
      const violating = forbidden.filter(l => entry.labels.has(l));
      if (violating.length === 0) continue;

      // Exact substring match
      if (serializedInput.includes(entry.value)) {
        matches.push(`taint:${[...entry.labels].join('+')}:from:${entry.source}`);
        risk = Math.max(risk, 80);
        continue;
      }

      // Base64 encoded variant
      try {
        const b64 = Buffer.from(entry.value).toString('base64');
        if (serializedInput.includes(b64)) {
          matches.push(`taint:b64:${entry.source}`);
          risk = Math.max(risk, 75);
          continue;
        }
      } catch { /* skip */ }

      // Hex encoded variant
      const hex = Buffer.from(entry.value).toString('hex');
      if (serializedInput.includes(hex)) {
        matches.push(`taint:hex:${entry.source}`);
        risk = Math.max(risk, 75);
      }
    }

    return { risk, matches };
  }

  private addEntry(value: string, labels: Set<TaintLabel>, source: string): void {
    // Deduplicate
    const existing = this.entries.find(e => e.value === value);
    if (existing) {
      for (const l of labels) existing.labels.add(l);
      return;
    }

    if (this.entries.length >= this.maxEntries) {
      this.entries.shift(); // evict oldest
    }
    this.entries.push({ value, labels, source, firstSeen: Date.now() });
  }

  clear(): void {
    this.entries = [];
  }

  getStats(): { count: number; labels: Record<string, number> } {
    const labels: Record<string, number> = {};
    for (const e of this.entries) {
      for (const l of e.labels) {
        labels[l] = (labels[l] ?? 0) + 1;
      }
    }
    return { count: this.entries.length, labels };
  }
}
