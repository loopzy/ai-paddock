import { cp, mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

const DEFAULT_OPENCLAW_SOURCE_CANDIDATES = ['thirdparty/openclaw'] as const;
const EXCLUDED_BASENAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  '.artifacts',
  'coverage',
  '.turbo',
  '.cache',
  '.DS_Store',
]);

export function resolveOpenClawSourceRoot(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [env.OPENCLAW_SRC, ...DEFAULT_OPENCLAW_SOURCE_CANDIDATES.map((entry) => join(projectRoot, entry))].filter(
    (value): value is string => Boolean(value && value.trim()),
  );

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json')) && existsSync(join(candidate, 'openclaw.mjs'))) {
      return candidate;
    }
  }

  return null;
}

export async function readOpenClawPackageManager(sourceRoot: string): Promise<string | null> {
  const packageJsonPath = join(sourceRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return null;
  }

  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { packageManager?: string };
  return typeof packageJson.packageManager === 'string' && packageJson.packageManager.trim()
    ? packageJson.packageManager.trim()
    : null;
}

export async function stageOpenClawSourceTree(sourceRoot: string): Promise<{ stageRoot: string; runtimeDir: string }> {
  const stageRoot = await mkdtemp(join(tmpdir(), 'paddock-openclaw-source-'));
  const runtimeDir = join(stageRoot, 'openclaw-runtime');

  await cp(sourceRoot, runtimeDir, {
    recursive: true,
    force: true,
    verbatimSymlinks: false,
    filter: (src) => {
      const rel = relative(sourceRoot, src);
      if (!rel || rel === '') return true;
      return !rel.split(/[\\/]/).some((part) => EXCLUDED_BASENAMES.has(part));
    },
  });

  return { stageRoot, runtimeDir };
}
