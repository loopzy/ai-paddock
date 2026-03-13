import { ComputerBox } from '@boxlite-ai/boxlite';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

async function main() {
  const box = new ComputerBox({ cpus: 4, memoryMib: 4096, guiHttpPort: 3002, guiHttpsPort: 3003 });
  const id = await box.getId();
  console.log(`VM: ${id}`);

  // Check if node exists
  console.log('\n--- command -v node ---');
  const nodeCheck = await box.exec('sh', '-c', 'command -v node');
  console.log(`exitCode=${nodeCheck.exitCode} stdout="${nodeCheck.stdout.trim()}" stderr="${nodeCheck.stderr.trim()}"`);

  // Check what's available
  console.log('\n--- which node nodejs ---');
  const which = await box.exec('sh', '-c', 'which node 2>/dev/null; which nodejs 2>/dev/null; node --version 2>/dev/null; echo "---"; apt list --installed 2>/dev/null | grep -i node | head -5');
  console.log(`stdout: ${which.stdout}`);

  // Try apt-get with timeout
  if (nodeCheck.exitCode !== 0) {
    console.log('\n--- apt-get update (5s timeout test) ---');
    console.time('apt-get');
    const apt = await box.exec('sh', '-c', 'timeout 10 apt-get update 2>&1 | tail -5');
    console.timeEnd('apt-get');
    console.log(`exitCode=${apt.exitCode}`);
    console.log(`stdout: ${apt.stdout}`);
    console.log(`stderr: ${apt.stderr}`);
  }

  await box.stop();
}

main().catch(e => { console.error(e); process.exit(1); });
