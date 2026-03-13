import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

type PackageManifest = {
  dependencies?: Record<string, string>;
};

const STUBBED_RUNTIME_PACKAGES: Record<string, { packageJson: PackageManifest & { name: string; type: 'module' }; files: Record<string, string> }> = {
  '@tloncorp/api': {
    packageJson: {
      name: '@tloncorp/api',
      type: 'module',
      dependencies: {},
    },
    files: {
      'dist/index.js': `function unavailable() {
  throw new Error("@tloncorp/api is disabled in this Paddock runtime bundle because Tlon channels are not enabled inside the sandbox.");
}

export const configureClient = unavailable;
export const uploadFile = unavailable;
export default { configureClient, uploadFile };
`,
    },
  },
};

const SOURCE_WORKTREE_DIRS = [
  ['src'],
  ['apps', 'shared'],
  ['scripts'],
] as const;

const SOURCE_WORKTREE_FILES = [
  'tsconfig.json',
  'tsconfig.plugin-sdk.dts.json',
  'pnpm-workspace.yaml',
] as const;

export function collectBundledExtensionDependencies(extensionsDir: string): Record<string, string> {
  if (!existsSync(extensionsDir)) {
    return {};
  }

  const merged = new Map<string, string>();
  for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const packageJsonPath = join(extensionsDir, entry.name, 'package.json');
    if (!existsSync(packageJsonPath)) {
      continue;
    }

    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as PackageManifest;
    for (const [name, version] of Object.entries(packageJson.dependencies ?? {})) {
      if (!merged.has(name)) {
        merged.set(name, version);
      }
    }
  }

  return Object.fromEntries([...merged.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export function collectRootBareRuntimeImports(distDir: string): string[] {
  if (!existsSync(distDir)) {
    return [];
  }

  const bareImports = new Set<string>();
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) {
      continue;
    }

    const contents = readFileSync(join(distDir, entry.name), 'utf8');
    for (const match of contents.matchAll(/^import .* from "([^"]+)";$/gm)) {
      const specifier = match[1];
      if (specifier.startsWith('.') || specifier.startsWith('node:')) {
        continue;
      }
      bareImports.add(specifier);
    }
  }

  return [...bareImports].sort((left, right) => left.localeCompare(right));
}

export async function resolveAdditionalRuntimeDependencies(stageRoot: string): Promise<Record<string, string>> {
  const packageJsonPath = join(stageRoot, 'package.json');
  const rootPackage = JSON.parse(await readFile(packageJsonPath, 'utf8')) as PackageManifest;
  const rootDependencies = rootPackage.dependencies ?? {};
  const extensionDependencies = collectBundledExtensionDependencies(join(stageRoot, 'dist', 'extensions'));
  const bareImports = collectRootBareRuntimeImports(join(stageRoot, 'dist'));

  const additional: Record<string, string> = {};
  for (const specifier of bareImports) {
    if (specifier in rootDependencies) {
      continue;
    }
    if (specifier in STUBBED_RUNTIME_PACKAGES) {
      continue;
    }
    const extensionVersion = extensionDependencies[specifier];
    if (extensionVersion) {
      additional[specifier] = extensionVersion;
    }
  }
  return additional;
}

export async function prepareOpenClawRuntimeStage(params: {
  sourceRoot: string;
  stageRoot: string;
}): Promise<void> {
  const packageJsonPath = join(params.stageRoot, 'package.json');
  const rootPackage = JSON.parse(await readFile(packageJsonPath, 'utf8')) as PackageManifest;
  const additionalDependencies = await resolveAdditionalRuntimeDependencies(params.stageRoot);
  rootPackage.dependencies = mergeDependencyMaps(rootPackage.dependencies ?? {}, additionalDependencies);
  await writeFile(packageJsonPath, `${JSON.stringify(rootPackage, null, 2)}\n`, 'utf8');

  for (const relativeParts of SOURCE_WORKTREE_DIRS) {
    const sourceDir = join(params.sourceRoot, ...relativeParts);
    if (!existsSync(sourceDir)) {
      continue;
    }

    const targetDir = join(params.stageRoot, ...relativeParts);
    await mkdir(dirname(targetDir), { recursive: true });
    await cp(sourceDir, targetDir, {
      recursive: true,
      force: true,
      verbatimSymlinks: false,
    });
  }

  for (const relativeFile of SOURCE_WORKTREE_FILES) {
    const sourceFile = join(params.sourceRoot, relativeFile);
    if (!existsSync(sourceFile)) {
      continue;
    }

    const targetFile = join(params.stageRoot, relativeFile);
    await mkdir(dirname(targetFile), { recursive: true });
    await cp(sourceFile, targetFile, {
      force: true,
      verbatimSymlinks: false,
    });
  }
}

export async function writeOpenClawRuntimeStubs(stageRoot: string): Promise<void> {
  for (const [packageName, definition] of Object.entries(STUBBED_RUNTIME_PACKAGES)) {
    const packageRoot = join(stageRoot, 'node_modules', ...packageName.split('/'));
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, 'package.json'),
      `${JSON.stringify({
        ...definition.packageJson,
        exports: './dist/index.js',
        main: './dist/index.js',
      }, null, 2)}\n`,
      'utf8',
    );

    for (const [relativePath, contents] of Object.entries(definition.files)) {
      const absolutePath = join(packageRoot, relativePath);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, contents, 'utf8');
    }
  }
}

function mergeDependencyMaps(
  rootDependencies: Record<string, string>,
  bundledDependencies: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = { ...rootDependencies };
  for (const [name, version] of Object.entries(bundledDependencies)) {
    if (!(name in merged)) {
      merged[name] = version;
    }
  }
  return merged;
}
