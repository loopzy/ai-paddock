import { useState, useEffect } from 'react';

interface LLMConfigPanelProps {
  providers: any[];
  onConfigured: () => void;
}

interface SavedConfig {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  enabled: boolean;
}

export function LLMConfigPanel({ providers, onConfigured }: LLMConfigPanelProps) {
  const [savedConfigs, setSavedConfigs] = useState<SavedConfig[]>([]);
  const [mode, setMode] = useState<'select' | 'add'>('select');
  const [selectedProvider, setSelectedProvider] = useState<string>('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    fetchConfigs();
  }, []);

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
    const config = savedConfigs.find(c => c.provider === provider);
    if (config) {
      setBaseUrl(config.baseUrl || '');
    }
    setTimeout(() => {
      onConfigured();
    }, 300);
  };

  const handleSave = async () => {
    if (!selectedProvider || !apiKey) {
      setError('Please select a provider and enter an API key');
      return;
    }

    setSaving(true);
    setError(null);
    setSuccess(false);

    try {
      const res = await fetch('/api/llm-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: selectedProvider,
          apiKey,
          baseUrl: baseUrl || undefined,
        }),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      setSuccess(true);
      setApiKey('');
      setBaseUrl('');
      setSelectedProvider('');
      await fetchConfigs();
      setTimeout(() => {
        setSuccess(false);
        setMode('select');
        onConfigured();
      }, 1500);
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

  const selectedProviderInfo = providers.find(p => p.id === selectedProvider);

  return (
    <div className="border border-gray-800 rounded bg-gray-950 p-4">
      <h3 className="text-sm font-bold text-gray-300 mb-3">LLM Provider Configuration</h3>

      {mode === 'select' ? (
        <>
          {/* Select from saved configurations */}
          {savedConfigs.length > 0 ? (
            <div className="space-y-2">
              <div className="text-xs text-gray-400 mb-2">Select a configured provider:</div>
              {savedConfigs.map((config) => {
                const providerInfo = providers.find(p => p.id === config.provider);
                return (
                  <button
                    key={config.provider}
                    onClick={() => handleSelectExisting(config.provider)}
                    className="w-full flex items-center gap-2 bg-gray-900 hover:bg-gray-800 border border-gray-700 hover:border-cyan-600 rounded px-3 py-2 transition-colors"
                  >
                    <span className="text-green-400 text-xs">✓</span>
                    <div className="flex-1 min-w-0 text-left">
                      <div className="text-xs text-gray-300 font-medium">{providerInfo?.label || config.provider}</div>
                      {config.baseUrl && (
                        <div className="text-[10px] text-gray-500 truncate">{config.baseUrl}</div>
                      )}
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(config.provider);
                      }}
                      className="px-2 py-1 text-[10px] text-red-400 hover:text-red-300 hover:bg-red-950/30 rounded shrink-0"
                    >
                      Delete
                    </button>
                  </button>
                );
              })}
              <button
                onClick={() => setMode('add')}
                className="w-full mt-3 px-3 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-cyan-400 rounded text-xs"
              >
                + Add New Provider
              </button>
            </div>
          ) : (
            <div className="text-center py-4">
              <div className="text-xs text-gray-500 mb-3">No providers configured yet</div>
              <button
                onClick={() => setMode('add')}
                className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded text-xs"
              >
                Add Provider
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          {/* Add new provider form */}
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Provider</label>
              <select
                value={selectedProvider}
                onChange={(e) => setSelectedProvider(e.target.value)}
                className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300"
              >
                <option value="">Select a provider...</option>
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.label}
                  </option>
                ))}
              </select>
            </div>

            {selectedProviderInfo && (
              <>
                <div className="text-xs text-gray-500">
                  {selectedProviderInfo.description}
                </div>

                <div>
                  <label className="block text-xs text-gray-400 mb-1">
                    API Key
                    <a
                      href={selectedProviderInfo.docsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-2 text-cyan-400 hover:underline"
                    >
                      Get Key →
                    </a>
                  </label>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={`Enter ${selectedProviderInfo.label} API Key`}
                    className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 font-mono"
                  />
                </div>

                <div>
                  <label className="block text-xs text-gray-400 mb-1">
                    Base URL (optional)
                  </label>
                  <input
                    type="text"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="Leave empty for default"
                    className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 font-mono"
                  />
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={handleSave}
                    disabled={saving || !apiKey}
                    className="flex-1 bg-cyan-600 hover:bg-cyan-500 disabled:bg-gray-700 disabled:text-gray-500 text-white px-3 py-2 rounded text-xs font-medium"
                  >
                    {saving ? 'Saving...' : success ? '✓ Saved!' : 'Save Configuration'}
                  </button>
                  <button
                    onClick={() => {
                      setMode('select');
                      setSelectedProvider('');
                      setApiKey('');
                      setBaseUrl('');
                      setError(null);
                    }}
                    className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded text-xs"
                  >
                    Cancel
                  </button>
                </div>

                {error && (
                  <div className="text-xs text-red-400 bg-red-950/50 border border-red-900 rounded px-2 py-1">
                    {error}
                  </div>
                )}

                {success && (
                  <div className="text-xs text-green-400 bg-green-950/50 border border-green-900 rounded px-2 py-1">
                    Configuration saved successfully!
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}

      <div className="mt-4 pt-3 border-t border-gray-800 text-xs text-gray-500">
        <p className="mb-1">💡 Tip: You can also configure via environment variables:</p>
        <pre className="bg-black/30 p-2 rounded text-[10px] overflow-x-auto">
{`export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."
export OPENROUTER_API_KEY="sk-or-..."`}</pre>
      </div>
    </div>
  );
}
