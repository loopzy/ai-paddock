import { prepareOpenClawRuntimeStage } from '../packages/control-plane/src/agents/openclaw-runtime-bundle.js';

async function main() {
  const [sourceRoot, stageRoot] = process.argv.slice(2);
  if (!sourceRoot || !stageRoot) {
    throw new Error('Usage: prepare-openclaw-runtime-stage.ts <sourceRoot> <stageRoot>');
  }

  await prepareOpenClawRuntimeStage({ sourceRoot, stageRoot });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
