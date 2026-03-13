#!/usr/bin/env node

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const pnpmStoreModules = join(projectRoot, 'node_modules', '.pnpm');

const rawArgs = process.argv.slice(2);
const useRootCwd = rawArgs[0] === '--cwd-root';
const [relativeEntryPoint, ...args] = useRootCwd ? rawArgs.slice(1) : rawArgs;

if (!relativeEntryPoint) {
  console.error('Usage: node scripts/run-local-cli.mjs <relative-entry-point> [...args]');
  process.exit(1);
}

function findEntryPoint(relativePath) {
  if (!existsSync(pnpmStoreModules)) return null;

  for (const entry of readdirSync(pnpmStoreModules)) {
    const candidate = join(pnpmStoreModules, entry, 'node_modules', relativePath);
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

const entryPoint = findEntryPoint(relativeEntryPoint);

if (!entryPoint) {
  console.error(`Unable to find local CLI entry point for ${relativeEntryPoint}`);
  process.exit(1);
}

const child = spawn(process.execPath, [entryPoint, ...args], {
  cwd: useRootCwd ? projectRoot : process.cwd(),
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_PATH: [
      join(projectRoot, 'node_modules', '.pnpm', 'node_modules'),
      join(projectRoot, 'node_modules'),
      process.env.NODE_PATH ?? '',
    ].filter(Boolean).join(':'),
  },
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
