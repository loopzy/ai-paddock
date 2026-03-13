import { watch, type FSWatcher as NodeFSWatcher } from 'chokidar';
import { readFile } from 'node:fs/promises';
import { createPatch } from 'diff';
import type { EventReporter } from '../reporter.js';

export const MAX_FS_CHANGE_DIFF_CHARS = 64 * 1024;

const IGNORED_PATH_SEGMENTS = [
  '/node_modules/',
  '/.git/',
  '/dist/',
  '/.openclaw/',
];

export function shouldIgnoreFSChange(filePath: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/');
  return IGNORED_PATH_SEGMENTS.some((segment) => normalizedPath.includes(segment));
}

export function truncateFSChangeDiff(
  diff: string,
  maxChars = MAX_FS_CHANGE_DIFF_CHARS,
): { diff: string; truncated: boolean } {
  if (diff.length <= maxChars) {
    return { diff, truncated: false };
  }

  const omittedChars = diff.length - maxChars;
  return {
    diff: `${diff.slice(0, maxChars)}\n... [truncated ${omittedChars} chars]\n`,
    truncated: true,
  };
}

/**
 * FS Watcher — monitors the agent's workspace for file changes
 * and reports diffs to the Control Plane.
 */
export class FSWatcher {
  private dir: string;
  private reporter: EventReporter;
  private watcher: NodeFSWatcher | null = null;
  private fileCache = new Map<string, string>(); // path → last known content

  constructor(dir: string, reporter: EventReporter) {
    this.dir = dir;
    this.reporter = reporter;
  }

  start() {
    this.watcher = watch(this.dir, {
      ignoreInitial: true,
      ignored: (filePath) => shouldIgnoreFSChange(filePath),
      persistent: true,
    });

    this.watcher.on('add', (path) => this.onFile('create', path));
    this.watcher.on('change', (path) => this.onFile('modify', path));
    this.watcher.on('unlink', (path) => this.onDelete(path));
  }

  stop() {
    this.watcher?.close();
  }

  private async onFile(action: 'create' | 'modify', filePath: string) {
    if (shouldIgnoreFSChange(filePath)) {
      return;
    }

    try {
      const content = await readFile(filePath, 'utf-8');
      const oldContent = this.fileCache.get(filePath) ?? '';

      let diff: string | undefined;
      let diffTruncated = false;
      if (action === 'modify' && oldContent) {
        const diffSummary = truncateFSChangeDiff(
          createPatch(filePath, oldContent, content, '', '', { context: 3 }),
        );
        diff = diffSummary.diff;
        diffTruncated = diffSummary.truncated;
      }

      this.fileCache.set(filePath, content);

      await this.reporter.report('fs.change', {
        action,
        path: filePath,
        diff,
        ...(diffTruncated ? { diffTruncated: true } : {}),
        sizeBytes: Buffer.byteLength(content),
      });
    } catch {
      // File might be binary or unreadable
      await this.reporter.report('fs.change', {
        action,
        path: filePath,
      });
    }
  }

  private async onDelete(filePath: string) {
    if (shouldIgnoreFSChange(filePath)) {
      return;
    }

    this.fileCache.delete(filePath);
    await this.reporter.report('fs.change', {
      action: 'delete',
      path: filePath,
    });
  }
}
