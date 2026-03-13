import { writeOpenClawRuntimeStubs } from '../packages/control-plane/src/agents/openclaw-runtime-bundle.js';

async function main() {
  const [stageRoot] = process.argv.slice(2);
  if (!stageRoot) {
    throw new Error('Usage: write-openclaw-runtime-stubs.ts <stageRoot>');
  }

  await writeOpenClawRuntimeStubs(stageRoot);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
