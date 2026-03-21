import Database from 'better-sqlite3';

export interface LLMProviderConfig {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  model?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export class LLMConfigStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS llm_provider_configs (
        provider TEXT PRIMARY KEY,
        api_key TEXT NOT NULL,
        base_url TEXT,
        model TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    const columns = this.db.prepare('PRAGMA table_info(llm_provider_configs)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'model')) {
      this.db.exec('ALTER TABLE llm_provider_configs ADD COLUMN model TEXT');
    }
  }

  upsert(
    provider: string,
    updates: {
      apiKey?: string;
      baseUrl?: string | null;
      model?: string | null;
    },
  ): void {
    const now = Date.now();
    const existing = this.get(provider);
    const apiKey = updates.apiKey?.trim() || existing?.apiKey;
    if (!apiKey) {
      throw new Error(`Missing API key for provider ${provider}`);
    }

    const baseUrl =
      updates.baseUrl === undefined
        ? (existing?.baseUrl ?? null)
        : (updates.baseUrl?.trim() || null);
    const model =
      updates.model === undefined
        ? (existing?.model ?? null)
        : (updates.model?.trim() || null);

    this.db.prepare(`
      INSERT INTO llm_provider_configs (provider, api_key, base_url, model, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        api_key = excluded.api_key,
        base_url = excluded.base_url,
        model = excluded.model,
        enabled = 1,
        updated_at = excluded.updated_at
    `).run(provider, apiKey, baseUrl, model, now, now);
  }

  set(provider: string, apiKey: string, baseUrl?: string, model?: string): void {
    this.upsert(provider, {
      apiKey,
      baseUrl: baseUrl ?? null,
      model: model ?? null,
    });
  }

  get(provider: string): LLMProviderConfig | null {
    const row = this.db.prepare('SELECT * FROM llm_provider_configs WHERE provider = ?').get(provider) as any;
    if (!row) return null;
    return {
      provider: row.provider,
      apiKey: row.api_key,
      baseUrl: row.base_url,
      model: row.model,
      enabled: Boolean(row.enabled),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  list(): LLMProviderConfig[] {
    const rows = this.db.prepare('SELECT * FROM llm_provider_configs WHERE enabled = 1').all() as any[];
    return rows.map(row => ({
      provider: row.provider,
      apiKey: row.api_key,
      baseUrl: row.base_url,
      model: row.model,
      enabled: Boolean(row.enabled),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  delete(provider: string): void {
    this.db.prepare('DELETE FROM llm_provider_configs WHERE provider = ?').run(provider);
  }

  // Get API key for a provider, checking both DB and env
  getApiKey(provider: string, env: NodeJS.ProcessEnv = process.env): string | null {
    // 1. Check database first
    const config = this.get(provider);
    if (config?.apiKey) return config.apiKey;

    // 2. Fallback to environment variables
    const envKeys: Record<string, string[]> = {
      'anthropic': ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
      'openai': ['OPENAI_API_KEY'],
      'openrouter': ['OPENROUTER_API_KEY'],
    };

    const keys = envKeys[provider] || [];
    for (const key of keys) {
      const value = env[key];
      if (value) return value;
    }

    return null;
  }

  // Get base URL for a provider
  getBaseUrl(provider: string, env: NodeJS.ProcessEnv = process.env): string | null {
    const config = this.get(provider);
    if (config?.baseUrl) return config.baseUrl;

    const envKeys: Record<string, string> = {
      'anthropic': 'ANTHROPIC_BASE_URL',
      'openai': 'OPENAI_BASE_URL',
      'openrouter': 'OPENROUTER_BASE_URL',
    };

    const key = envKeys[provider];
    return key ? (env[key] || null) : null;
  }

  getModel(provider: string): string | null {
    const config = this.get(provider);
    return config?.model?.trim() || null;
  }
}
