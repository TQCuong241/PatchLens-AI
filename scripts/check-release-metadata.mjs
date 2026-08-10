import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const workspaceRoots = ['apps', 'packages', 'examples'];
const packages = new Map();

for (const workspaceRoot of workspaceRoots) {
  for (const entry of await readdir(workspaceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const directory = `${workspaceRoot}/${entry.name}`;
    const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
    packages.set(manifest.name, { directory, manifest });
  }
}

const publishable = [...packages.values()].filter(({ manifest }) => manifest.private !== true);
if (publishable.length === 0) {
  throw new Error('No publishable PatchLens packages found');
}

const versions = new Set(publishable.map(({ manifest }) => manifest.version));
if (versions.size !== 1 || versions.has('0.0.0')) {
  throw new Error(
    `Publishable packages must share one non-placeholder version: ${[...versions].join(', ')}`,
  );
}

for (const { directory, manifest } of publishable) {
  assertText(manifest.description, `${manifest.name} description`);
  assertText(manifest.repository?.url, `${manifest.name} repository URL`);
  if (manifest.repository?.directory !== directory) {
    throw new Error(`${manifest.name} repository directory must be ${directory}`);
  }
  if (manifest.engines?.node !== '>=20.19.0') {
    throw new Error(`${manifest.name} must declare Node >=20.19.0`);
  }
  if (manifest.publishConfig?.access !== 'public' || manifest.publishConfig?.provenance !== true) {
    throw new Error(`${manifest.name} must publish public packages with provenance`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error(`${manifest.name} must restrict published files`);
  }

  for (const dependencyGroup of [manifest.dependencies, manifest.optionalDependencies]) {
    for (const [dependency, range] of Object.entries(dependencyGroup ?? {})) {
      if (!dependency.startsWith('@patchlens-ai/')) {
        continue;
      }
      const target = packages.get(dependency);
      if (!target || target.manifest.private === true) {
        throw new Error(
          `${manifest.name} depends on non-publishable workspace package ${dependency}`,
        );
      }
      if (range !== 'workspace:*') {
        throw new Error(
          `${manifest.name} must use workspace:* for internal dependency ${dependency}`,
        );
      }
    }
  }
}

for (const name of [
  'patchlens-ai',
  '@patchlens-ai/react-vite-demo',
  '@patchlens-ai/next-app-demo',
]) {
  if (name === 'patchlens-ai') {
    const root = JSON.parse(await readFile('package.json', 'utf8'));
    if (root.private !== true) {
      throw new Error('Workspace root must remain private');
    }
    continue;
  }
  if (packages.get(name)?.manifest.private !== true) {
    throw new Error(`${name} must remain private`);
  }
}

const version = [...versions][0];
const publicEntry = packages.get('@patchlens-ai/dev');
if (!publicEntry?.manifest.files?.includes('README.md')) {
  throw new Error('@patchlens-ai/dev must publish its package README');
}
for (const file of [
  'apps/daemon/src/server.ts',
  'packages/mcp-server/src/server.ts',
  'packages/cli/src/index.ts',
]) {
  const source = await readFile(file, 'utf8');
  if (!source.includes(`'${version}'`)) {
    throw new Error(`${file} does not report release version ${version}`);
  }
}

console.log(`Release metadata valid for ${publishable.length} packages at ${version}`);

function assertText(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
}
