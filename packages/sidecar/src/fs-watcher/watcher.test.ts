import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPatch } from 'diff';
import { FSWatcher, MAX_FS_CHANGE_DIFF_CHARS, shouldIgnoreFSChange, truncateFSChangeDiff } from './watcher.js';

vi.mock('diff', () => ({
  createPatch: vi.fn(),
}));

describe('FSWatcher helpers', () => {
  it('ignores OpenClaw internal state noise', () => {
    expect(shouldIgnoreFSChange('/workspace/.openclaw/browser/openclaw/user-data/Local State')).toBe(true);
    expect(shouldIgnoreFSChange('/workspace/.openclaw/devices/paired.json')).toBe(true);
    expect(shouldIgnoreFSChange('/workspace/.openclaw/identity/device-auth.json')).toBe(true);
    expect(shouldIgnoreFSChange('/workspace/.openclaw/agents/main/sessions/sessions.json')).toBe(true);
    expect(shouldIgnoreFSChange('/workspace/paddock_complex/report.html')).toBe(false);
  });

  it('truncates oversized diffs', () => {
    const oversizedDiff = 'x'.repeat(MAX_FS_CHANGE_DIFF_CHARS + 128);
    const result = truncateFSChangeDiff(oversizedDiff, MAX_FS_CHANGE_DIFF_CHARS);

    expect(result.truncated).toBe(true);
    expect(result.diff).toContain('[truncated 128 chars]');
    expect(result.diff.length).toBeLessThan(oversizedDiff.length);
  });
});

describe('FSWatcher', () => {
  it('skips reporting ignored internal OpenClaw paths', async () => {
    const reporter = { report: vi.fn().mockResolvedValue(true) };
    const watcher = new FSWatcher('/workspace', reporter as any);

    await (watcher as any).onFile('modify', '/workspace/.openclaw/browser/openclaw/user-data/Local State');
    await (watcher as any).onDelete('/workspace/.openclaw/devices/paired.json');
    await (watcher as any).onFile('modify', '/workspace/.openclaw/agents/main/sessions/sessions.json');

    expect(reporter.report).not.toHaveBeenCalled();
  });

  it('marks oversized diffs as truncated before reporting', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'paddock-fsw-'));
    const filePath = path.join(tempDir, 'history.jsonl');
    const reporter = { report: vi.fn().mockResolvedValue(true) };
    const watcher = new FSWatcher(tempDir, reporter as any);

    try {
      const beforeContent = 'before-line\n';
      const afterContent = 'after-line\n';
      vi.mocked(createPatch).mockReturnValue('x'.repeat(MAX_FS_CHANGE_DIFF_CHARS + 512));

      await writeFile(filePath, afterContent, 'utf8');
      (watcher as any).fileCache.set(filePath, beforeContent);

      await (watcher as any).onFile('modify', filePath);

      expect(reporter.report).toHaveBeenCalledTimes(1);
      const [, payload] = reporter.report.mock.calls[0];
      expect(payload.path).toBe(filePath);
      expect(payload.diffTruncated).toBe(true);
      expect(typeof payload.diff).toBe('string');
      expect(payload.diff).toContain('[truncated');

      const persisted = await readFile(filePath, 'utf8');
      expect(persisted).toBe(afterContent);
    } finally {
      watcher.stop();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
