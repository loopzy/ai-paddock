/**
 * Sensitive Data Vault — detects, masks, and restores sensitive data
 * flowing through the LLM Proxy.
 *
 * On outbound (Agent → LLM):
 *   Scans request body for passwords, tokens, keys, PII, etc.
 *   Replaces with placeholders: {{PADDOCK_SECRET_1}}
 *   Stores mapping in memory (never leaves VM)
 *
 * On inbound (LLM → Agent):
 *   Scans response for placeholders
 *   Restores original values so Agent can use them
 *
 * The LLM never sees real secrets. Event Store never records real secrets.
 * Dashboard never displays real secrets.
 */

interface SecretEntry {
  placeholder: string;
  original: string;
  category: string;
  firstSeen: number;
}

interface ScanResult {
  masked: string;
  secretsFound: number;
  categories: string[];
}

// Detection patterns ordered by specificity (most specific first)
// Exported for reuse by TaintTracker
export const VAULT_PATTERNS: Array<{ name: string; regex: RegExp; priority: number }> = [
  // API Keys & Tokens
  { name: 'anthropic_key',   regex: /sk-ant-[a-zA-Z0-9_-]{20,}/g,                    priority: 10 },
  { name: 'openai_key',      regex: /sk-(?:proj-)?[a-zA-Z0-9]{20,}/g,                  priority: 10 },
  { name: 'openrouter_key',  regex: /sk-or-[a-zA-Z0-9_-]{20,}/g,                      priority: 10 },
  { name: 'github_token',    regex: /gh[ps]_[a-zA-Z0-9]{36,}/g,                       priority: 10 },
  { name: 'github_pat',      regex: /github_pat_[a-zA-Z0-9_]{20,}/g,                  priority: 10 },
  { name: 'aws_access_key',  regex: /AKIA[0-9A-Z]{16}/g,                              priority: 10 },
  { name: 'aws_secret_key',  regex: /(?<=aws_secret_access_key\s*[=:]\s*)[A-Za-z0-9/+=]{40}/g, priority: 10 },
  { name: 'slack_token',     regex: /xox[bpras]-[a-zA-Z0-9-]{10,}/g,                  priority: 10 },
  { name: 'discord_token',   regex: /[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,}/g,     priority: 10 },
  { name: 'telegram_token',  regex: /\d{8,10}:[A-Za-z0-9_-]{35}/g,                    priority: 10 },
  { name: 'generic_bearer',  regex: /Bearer\s+[a-zA-Z0-9._\-]{20,}/g,                 priority: 8 },
  { name: 'jwt',             regex: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, priority: 9 },

  // SSH & Crypto Keys
  { name: 'ssh_private_key', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, priority: 10 },
  { name: 'pgp_private_key', regex: /-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]*?-----END PGP PRIVATE KEY BLOCK-----/g, priority: 10 },

  // Connection Strings
  { name: 'db_connection',   regex: /(?:mongodb|postgres|mysql|redis|amqp):\/\/[^\s"'`]+/g, priority: 9 },
  { name: 'connection_string', regex: /(?:Server|Data Source|Host)=[^;]+;.*(?:Password|Pwd)=[^;]+/gi, priority: 9 },

  // Passwords in common formats
  { name: 'password_field',  regex: /(?<=(?:password|passwd|pwd|secret|token|credential|auth_token|api_key|apikey|access_key|private_key)\s*[=:]\s*["']?)[^\s"',;}{]{6,}/gi, priority: 7 },

  // PII
  { name: 'email',           regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, priority: 3 },
  { name: 'phone',           regex: /(?:\+\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, priority: 3 },
  { name: 'credit_card',     regex: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g, priority: 8 },
  { name: 'ssn',             regex: /\b\d{3}-\d{2}-\d{4}\b/g,                         priority: 8 },
  { name: 'ipv4_private',    regex: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g, priority: 2 },
];

// Allowlist: values that look like secrets but aren't
const ALLOWLIST = new Set([
  'paddock-proxy',       // Our dummy API key
  'localhost',
  'host.internal',
  'true', 'false',
  'null', 'undefined',
]);

export class SensitiveDataVault {
  private secrets = new Map<string, SecretEntry>();
  private reverseMap = new Map<string, string>(); // original → placeholder
  private counter = 0;

  /**
   * Scan text and replace sensitive data with placeholders.
   */
  mask(text: string): ScanResult {
    let masked = text;
    const categories = new Set<string>();
    let secretsFound = 0;

    // Sort patterns by priority (highest first)
    const sorted = [...VAULT_PATTERNS].sort((a, b) => b.priority - a.priority);

    for (const { name, regex } of sorted) {
      // Reset regex state
      regex.lastIndex = 0;

      masked = masked.replace(regex, (match) => {
        // Skip allowlisted values
        if (ALLOWLIST.has(match) || match.length < 6) return match;

        // Check if we've already seen this value
        const existing = this.reverseMap.get(match);
        if (existing) {
          categories.add(name);
          secretsFound++;
          return existing;
        }

        // Create new placeholder
        this.counter++;
        const placeholder = `{{PADDOCK_SECRET_${this.counter}}}`;

        this.secrets.set(placeholder, {
          placeholder,
          original: match,
          category: name,
          firstSeen: Date.now(),
        });
        this.reverseMap.set(match, placeholder);

        categories.add(name);
        secretsFound++;
        return placeholder;
      });
    }

    return {
      masked,
      secretsFound,
      categories: Array.from(categories),
    };
  }

  /**
   * Restore placeholders back to original values.
   */
  unmask(text: string): string {
    let restored = text;
    for (const [placeholder, entry] of this.secrets) {
      // Use split+join for global replace without regex escaping issues
      restored = restored.split(placeholder).join(entry.original);
    }
    return restored;
  }

  /**
   * Get vault statistics (for Dashboard display).
   */
  getStats(): { totalSecrets: number; categories: Record<string, number> } {
    const categories: Record<string, number> = {};
    for (const entry of this.secrets.values()) {
      categories[entry.category] = (categories[entry.category] ?? 0) + 1;
    }
    return {
      totalSecrets: this.secrets.size,
      categories,
    };
  }

  /**
   * Get a redacted view of all secrets (for debugging, shows category + length only).
   */
  getRedactedList(): Array<{ placeholder: string; category: string; length: number }> {
    return Array.from(this.secrets.values()).map((e) => ({
      placeholder: e.placeholder,
      category: e.category,
      length: e.original.length,
    }));
  }

  /**
   * Clear all stored secrets (e.g., on session end).
   */
  clear(): void {
    this.secrets.clear();
    this.reverseMap.clear();
    this.counter = 0;
  }
}
