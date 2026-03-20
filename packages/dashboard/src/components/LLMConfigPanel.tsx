import { useEffect, useMemo, useState } from 'react';

interface LLMConfigPanelProps {
  providers: Array<Record<string, any>>;
  onConfigured: () => void;
}

interface SavedConfig {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  enabled: boolean;
}

type PanelMode = 'select' | 'add' | 'edit';

function providerLabel(providers: Array<Record<string, any>>, providerId: string) {
  return providers.find((provider) => provider.id === providerId)?.label ?? providerId;
}

export function LLMConfigPanel({ providers, onConfigured }: LLMConfigPanelProps) {
  const [savedConfigs, setSavedConfigs] = useState<SavedConfig[]>([]);
  const [mode, setMode] = useState<PanelMode>('select');
  const [selectedProvider, setSelectedProvider] = useState<string>('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    void fetchConfigs();
  }, []);

  const selectedProviderInfo = useMemo(
    () => providers.find((provider) => provider.id === selectedProvider),
    [providers, selectedProvider],
  );

  const resetForm = () => {
    setSelectedProvider('');
    setApiKey('');
    setBaseUrl('');
    setError(null);
    setSuccess(null);
  };

  const fetchConfigs = async () => {
    try {
      const res = await fetch('/api/llm-config');
      const data = await res.json();
      setSavedConfigs(data.providers || []);
    } catch (err) {
      console.error('Failed to fetch configs:', err);
    }
  };

  const handleSelectExisting = (provider: string) => {
    setSelectedProvider(provider);
    setTimeout(() => {
      onConfigured();
    }, 300);
  };

  const handleStartAdd = () => {
    resetForm();
    setMode('add');
  };

  const handleStartEdit = (config: SavedConfig) => {
    setSelectedProvider(config.provider);
    setBaseUrl(config.baseUrl || '');
    setApiKey('');
    setError(null);
    setSuccess(null);
    setMode('edit');
  };

  const handleCancel = () => {
    resetForm();
    setMode('select');
  };

  const handleSave = async () => {
    if (!selectedProvider) {
      setError('Please select a provider');
      return;
    }

    const isEditing = mode === 'edit';
    if (!isEditing && !apiKey) {
      setError('Please enter an API key');
      return;
    }

    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      const body: Record<string, unknown> = {
        provider: selectedProvider,
        baseUrl: baseUrl || undefined,
      };
      if (apiKey) {
        body.apiKey = apiKey;
      }

      const res = await fetch('/api/llm-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      setSuccess(isEditing ? 'Configuration updated.' : 'Configuration saved.');
      await fetchConfigs();
      onConfigured();
      setTimeout(() => {
        resetForm();
        setMode('select');
      }, 900);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (provider: string) => {
    if (!confirm(`Delete ${provider} configuration?`)) return;
    try {
      await fetch(`/api/llm-config/${provider}`, { method: 'DELETE' });
      await fetchConfigs();
      onConfigured();
    } catch (err) {
      setError(`Failed to delete: ${(err as Error).message}`);
    }
  };

  const availableProviders = providers.filter(
    (provider) => mode === 'edit' || !savedConfigs.some((config) => config.provider === provider.id),
  );

  return (
    <div className="rounded-[24px] border border-stone-200 bg-stone-50/80 p-4">
      <h3 className="mb-3 text-sm font-semibold text-stone-900">LLM Provider Configuration</h3>

      {mode === 'select' ? (
        <>
          {savedConfigs.length > 0 ? (
            <div className="space-y-2">
              <div className="text-xs text-stone-500">Configured providers</div>
              {savedConfigs.map((config) => (
                <div
                  key={config.provider}
                  className="flex items-center gap-3 rounded-2xl border border-stone-200 bg-white px-3 py-3"
                >
                  <button
                    type="button"
                    onClick={() => handleSelectExisting(config.provider)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-emerald-100 text-[11px] font-semibold text-emerald-700">
                      ✓
                    </span>
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium text-stone-800">
                        {providerLabel(providers, config.provider)}
                      </div>
                      <div className="mt-0.5 text-[11px] text-stone-500">
                        {config.baseUrl || 'Default endpoint'}
                      </div>
                    </div>
                  </button>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleStartEdit(config)}
                      className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-1 text-[10px] font-medium text-stone-600 transition hover:border-stone-300 hover:bg-stone-100"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(config.provider)}
                      className="rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-[10px] font-medium text-rose-700 transition hover:bg-rose-100"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={handleStartAdd}
                className="mt-2 w-full rounded-2xl border border-stone-200 bg-white px-3 py-2 text-xs font-medium text-stone-700 transition hover:border-stone-300 hover:bg-stone-100"
              >
                + Add Provider
              </button>
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-stone-300 bg-white px-4 py-5 text-center">
              <div className="text-xs text-stone-500">No providers configured yet</div>
              <button
                type="button"
                onClick={handleStartAdd}
                className="mt-3 rounded-2xl bg-amber-500 px-4 py-2 text-xs font-medium text-white transition hover:bg-amber-600"
              >
                Add Provider
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="space-y-3 rounded-2xl border border-stone-200 bg-white p-4">
          <div className="text-xs font-medium text-stone-700">
            {mode === 'edit' ? `Edit ${providerLabel(providers, selectedProvider)}` : 'Add provider'}
          </div>

          <div>
            <label className="mb-1 block text-xs text-stone-500">Provider</label>
            <select
              value={selectedProvider}
              onChange={(e) => setSelectedProvider(e.target.value)}
              disabled={mode === 'edit'}
              className="w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-800 disabled:cursor-not-allowed disabled:bg-stone-100"
            >
              <option value="">Select a provider...</option>
              {availableProviders.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.label}
                </option>
              ))}
            </select>
          </div>

          {selectedProviderInfo && (
            <>
              <div className="text-xs leading-5 text-stone-500">{selectedProviderInfo.description}</div>

              <div>
                <label className="mb-1 block text-xs text-stone-500">
                  API Key
                  {selectedProviderInfo.docsUrl && (
                    <a
                      href={selectedProviderInfo.docsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-2 text-amber-700 hover:underline"
                    >
                      Get key
                    </a>
                  )}
                </label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={
                    mode === 'edit'
                      ? 'Leave empty to keep the current key'
                      : `Enter ${selectedProviderInfo.label} API key`
                  }
                  className="w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-800"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs text-stone-500">Base URL (optional)</label>
                <input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="Leave empty for the default endpoint"
                  className="w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-800"
                />
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving || !selectedProvider || (mode === 'add' && !apiKey)}
                  className="flex-1 rounded-2xl bg-amber-500 px-3 py-2 text-xs font-medium text-white transition hover:bg-amber-600 disabled:cursor-not-allowed disabled:bg-stone-300"
                >
                  {saving ? 'Saving...' : mode === 'edit' ? 'Save changes' : 'Save configuration'}
                </button>
                <button
                  type="button"
                  onClick={handleCancel}
                  className="rounded-2xl border border-stone-200 bg-stone-50 px-3 py-2 text-xs font-medium text-stone-600 transition hover:border-stone-300 hover:bg-stone-100"
                >
                  Cancel
                </button>
              </div>
            </>
          )}

          {error && (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {error}
            </div>
          )}

          {success && (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
              {success}
            </div>
          )}
        </div>
      )}

      <div className="mt-4 rounded-2xl border border-stone-200 bg-white px-4 py-3">
        <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.16em] text-stone-500">Tip</div>
        <p className="mb-2 text-xs text-stone-500">You can also configure providers with environment variables:</p>
        <pre className="overflow-x-auto rounded-xl border border-stone-200 bg-stone-50 p-3 text-[10px] leading-5 text-stone-700">
{`export ANTHROPIC_API_KEY="your-anthropic-key"
export OPENAI_API_KEY="your-openai-key"
export OPENROUTER_API_KEY="your-openrouter-key"`}
        </pre>
      </div>
    </div>
  );
}
