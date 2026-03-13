import { ComputerBox } from '@boxlite-ai/boxlite';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

async function main() {
  console.time('total');

  console.log('[1] Creating ComputerBox...');
  console.time('create');
  const box = new ComputerBox({ cpus: 4, memoryMib: 4096, guiHttpPort: 3000, guiHttpsPort: 3001 });
  const id = await box.getId();
  console.timeEnd('create');
  console.log(`    VM ID: ${id}`);

  console.log('[2] exec echo hello...');
  console.time('exec');
  const r = await box.exec('echo', 'hello');
  console.timeEnd('exec');
  console.log(`    result: exitCode=${r.exitCode} stdout="${r.stdout.trim()}"`);

  const sidecarPath = join(PROJECT_ROOT, 'dist', 'sidecar');
  console.log(`[3] copyIn ${sidecarPath} → /opt/paddock ...`);
  console.time('copyIn');
  await box.copyIn(sidecarPath, '/opt/paddock');
  console.timeEnd('copyIn');

  console.log('[4] ls /opt/paddock/sidecar/index.js ...');
  console.time('ls');
  const ls = await box.exec('ls', '/opt/paddock/sidecar/index.js');
  console.timeEnd('ls');
  console.log(`    result: exitCode=${ls.exitCode} stdout="${ls.stdout.trim()}"`);

  console.log('[5] exec sh -c "echo works" ...');
  console.time('sh-exec');
  const sh = await box.exec('sh', '-c', 'echo works && node --version 2>/dev/null || echo no-node');
  console.timeEnd('sh-exec');
  console.log(`    result: exitCode=${sh.exitCode} stdout="${sh.stdout.trim()}"`);

  console.log('[6] Stopping...');
  await box.stop();
  console.timeEnd('total');
}

main().catch(e => { console.error(e); process.exit(1); });
