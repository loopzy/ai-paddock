import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectRootBareRuntimeImports,
  collectBundledExtensionDependencies,
  prepareOpenClawRuntimeStage,
  writeOpenClawRuntimeStubs,
} from '../agents/openclaw-runtime-bundle.js';

describe('openclaw runtime bundle preparation', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  it('collects bundled extension dependencies that are missing from the root manifest', () => {
    const stageRoot = createTempDir('paddock-openclaw-stage-');
    const tlonDir = join(stageRoot, 'dist', 'extensions', 'tlon');
    const matrixDir = join(stageRoot, 'dist', 'extensions', 'matrix');
    mkdirSync(tlonDir, { recursive: true });
    mkdirSync(matrixDir, { recursive: true });

    writeFileSync(
      join(tlonDir, 'package.json'),
      JSON.stringify({
        name: '@openclaw/extension-tlon',
        dependencies: {
          '@tloncorp/api': 'github:tloncorp/api-beta#deadbeef',
          zod: '^4.3.6',
        },
      }),
    );
    writeFileSync(
      join(matrixDir, 'package.json'),
      JSON.stringify({
        name: '@openclaw/extension-matrix',
        dependencies: {
          '@matrix-org/matrix-sdk-crypto-nodejs': '^0.4.0',
        },
      }),
    );

    expect(collectBundledExtensionDependencies(join(stageRoot, 'dist', 'extensions'))).toEqual({
      '@matrix-org/matrix-sdk-crypto-nodejs': '^0.4.0',
      '@tloncorp/api': 'github:tloncorp/api-beta#deadbeef',
      zod: '^4.3.6',
    });
  });

  it('merges bundled extension deps into the staged root manifest and copies runtime sources', async () => {
    const sourceRoot = createTempDir('paddock-openclaw-src-');
    const stageRoot = createTempDir('paddock-openclaw-stage-');

    mkdirSync(join(sourceRoot, 'src', 'plugins', 'runtime'), { recursive: true });
    mkdirSync(join(sourceRoot, 'apps', 'shared', 'OpenClawKit', 'Sources', 'OpenClawKit', 'Resources'), {
      recursive: true,
    });
    mkdirSync(join(sourceRoot, 'scripts'), { recursive: true });
    writeFileSync(join(sourceRoot, 'src', 'plugins', 'runtime', 'index.ts'), 'export const createPluginRuntime = () => ({ ok: true });\n');
    writeFileSync(join(sourceRoot, 'src', 'plugins', 'runtime', 'types.ts'), 'export type PluginRuntime = { ok: true };\n');
    writeFileSync(
      join(sourceRoot, 'apps', 'shared', 'OpenClawKit', 'Sources', 'OpenClawKit', 'Resources', 'tool-display.json'),
      '{"ok":true}\n',
    );
    writeFileSync(join(sourceRoot, 'scripts', 'doctor.ts'), 'export {};\n');
    writeFileSync(join(sourceRoot, 'tsconfig.json'), '{"compilerOptions":{}}\n');

    mkdirSync(join(stageRoot, 'dist', 'extensions', 'tlon'), { recursive: true });
    writeFileSync(join(stageRoot, 'dist', 'gateway-cli.js'), 'import { configureClient } from "@tloncorp/api";\nimport { z } from "zod";\n');
    writeFileSync(
      join(stageRoot, 'package.json'),
      JSON.stringify({
        name: 'openclaw',
        version: '0.0.0-test',
        dependencies: {
          express: '^5.2.1',
          zod: '^4.3.6',
        },
      }, null, 2),
    );
    writeFileSync(
      join(stageRoot, 'dist', 'extensions', 'tlon', 'package.json'),
      JSON.stringify({
        name: '@openclaw/extension-tlon',
        dependencies: {
          '@tloncorp/api': 'github:tloncorp/api-beta#deadbeef',
          zod: '^4.3.6',
        },
      }),
    );

    await prepareOpenClawRuntimeStage({ sourceRoot, stageRoot });

    const manifest = JSON.parse(readFileSync(join(stageRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies).toMatchObject({
      '@tloncorp/api': 'github:tloncorp/api-beta#deadbeef',
      express: '^5.2.1',
      zod: '^4.3.6',
    });
    expect(manifest.dependencies).not.toHaveProperty('@matrix-org/matrix-sdk-crypto-nodejs');

    const copiedSource = join(stageRoot, 'src', 'plugins', 'runtime', 'index.ts');
    expect(readFileSync(copiedSource, 'utf8')).toContain('createPluginRuntime');
    expect(
      readFileSync(
        join(
          stageRoot,
          'apps',
          'shared',
          'OpenClawKit',
          'Sources',
          'OpenClawKit',
          'Resources',
          'tool-display.json',
        ),
        'utf8',
      ),
    ).toContain('"ok":true');
    expect(readFileSync(join(stageRoot, 'scripts', 'doctor.ts'), 'utf8')).toContain('export {}');
    expect(readFileSync(join(stageRoot, 'tsconfig.json'), 'utf8')).toContain('compilerOptions');
  });

  it('does not overwrite an existing root dependency version when an extension repeats it', async () => {
    const sourceRoot = createTempDir('paddock-openclaw-src-');
    const stageRoot = createTempDir('paddock-openclaw-stage-');

    mkdirSync(join(sourceRoot, 'src'), { recursive: true });
    writeFileSync(join(sourceRoot, 'src', 'noop.ts'), 'export {};\n');

    mkdirSync(join(stageRoot, 'dist', 'extensions', 'tlon'), { recursive: true });
    writeFileSync(
      join(stageRoot, 'package.json'),
      JSON.stringify({
        name: 'openclaw',
        dependencies: {
          zod: '^4.4.0',
        },
      }),
    );
    writeFileSync(
      join(stageRoot, 'dist', 'extensions', 'tlon', 'package.json'),
      JSON.stringify({
        name: '@openclaw/extension-tlon',
        dependencies: {
          zod: '^4.3.6',
        },
      }),
    );

    await prepareOpenClawRuntimeStage({ sourceRoot, stageRoot });

    const manifest = JSON.parse(readFileSync(join(stageRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies?.zod).toBe('^4.4.0');
  });

  it('only considers bare imports from root dist entrypoints when resolving additional deps', () => {
    const stageRoot = createTempDir('paddock-openclaw-stage-');
    mkdirSync(join(stageRoot, 'dist'), { recursive: true });
    writeFileSync(join(stageRoot, 'dist', 'gateway-cli.js'), 'import chalk from "chalk";\nimport { configureClient } from "@tloncorp/api";\n');
    writeFileSync(join(stageRoot, 'dist', 'internal.js'), 'import "./chunk.js";\nimport fs from "node:fs";\n');

    expect(collectRootBareRuntimeImports(join(stageRoot, 'dist'))).toEqual(['@tloncorp/api', 'chalk']);
  });

  it('leaves dependency installation untouched when no runtime packages are stubbed', async () => {
    const stageRoot = createTempDir('paddock-openclaw-stage-');

    await writeOpenClawRuntimeStubs(stageRoot);

    expect(existsSync(join(stageRoot, 'node_modules', '@tloncorp', 'api'))).toBe(false);
  });
});
