const DEFAULT_CONTROL_PLANE_URLS = [
  'http://host.internal:3100',
  'http://host.docker.internal:3100',
  'http://10.0.2.2:3100',
];

export function parseControlPlaneUrls(primaryUrl: string, candidatesEnv: string): string[] {
  let parsedCandidates: string[] = [];

  if (candidatesEnv) {
    try {
      const parsed = JSON.parse(candidatesEnv);
      if (Array.isArray(parsed)) {
        parsedCandidates = parsed.filter((value): value is string => typeof value === 'string');
      }
    } catch {
      parsedCandidates = candidatesEnv.split(',').map((value) => value.trim()).filter(Boolean);
    }
  }

  return Array.from(new Set([primaryUrl, ...parsedCandidates, ...DEFAULT_CONTROL_PLANE_URLS].filter(Boolean)));
}

export class ControlPlaneClient {
  private urls: string[];

  constructor(urls: string[]) {
    this.urls = Array.from(new Set(urls.filter(Boolean)));
    if (this.urls.length === 0) {
      throw new Error('At least one control-plane URL is required');
    }
  }

  async resolveReachable(timeoutMs = 1500): Promise<string> {
    for (const url of this.urls) {
      try {
        const response = await fetch(`${url}/api/health`, {
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.ok) {
          this.promote(url);
          return url;
        }
      } catch {
        // try next candidate
      }
    }

    throw new Error(`Unable to reach control plane. Tried: ${this.urls.join(', ')}`);
  }

  async fetch(path: string, init?: RequestInit): Promise<Response> {
    let lastError: unknown;
    for (const url of this.urls) {
      try {
        const response = await global.fetch(`${url}${path}`, init);
        this.promote(url);
        return response;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(`Failed to reach control plane via ${this.urls.join(', ')}`);
  }

  getPrimaryUrl(): string {
    return this.urls[0];
  }

  private promote(url: string) {
    const index = this.urls.indexOf(url);
    if (index <= 0) return;
    this.urls = [url, ...this.urls.slice(0, index), ...this.urls.slice(index + 1)];
  }
}
