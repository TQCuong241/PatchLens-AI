import { gunzipSync } from 'node:zlib';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repositoryRoot = resolve(import.meta.dirname, '..');
const artifactRoot = resolve(repositoryRoot, 'release-artifacts');
const workspaceRoots = ['apps', 'packages', 'examples'];
const publishablePackages = [];
const corepackCommand =
  process.platform === 'win32'
    ? {
        executable: process.execPath,
        arguments: [resolve(dirname(process.execPath), 'node_modules/corepack/dist/corepack.js')],
      }
    : { executable: 'corepack', arguments: [] };

for (const workspaceRoot of workspaceRoots) {
  const root = resolve(repositoryRoot, workspaceRoot);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const directory = resolve(root, entry.name);
    const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
    if (manifest.private !== true) {
      publishablePackages.push({ directory, manifest });
    }
  }
}

await mkdir(artifactRoot, { recursive: true });
const artifacts = [];
for (const entry of publishablePackages.sort((left, right) =>
  left.manifest.name.localeCompare(right.manifest.name),
)) {
  const artifactName = `${entry.manifest.name.replace('@', '').replace('/', '-')}-${entry.manifest.version}.tgz`;
  const artifactPath = resolve(artifactRoot, artifactName);
  const result = spawnSync(
    corepackCommand.executable,
    [...corepackCommand.arguments, 'pnpm', 'pack', '--out', artifactPath],
    {
      cwd: entry.directory,
      encoding: 'utf8',
      env: process.env,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Cannot pack ${entry.manifest.name}: ${result.error?.message ?? result.stderr.trim()}`,
      { cause: result.error },
    );
  }

  const artifactStat = await stat(artifactPath);
  if (!artifactStat.isFile() || artifactStat.size === 0) {
    throw new Error(`Packed artifact is empty: ${artifactName}`);
  }
  const tarEntries = readTarEntries(gunzipSync(await readFile(artifactPath)));
  const packedManifestEntry = tarEntries.get('package/package.json');
  if (!packedManifestEntry) {
    throw new Error(`${artifactName} does not contain package/package.json`);
  }
  const packedManifest = JSON.parse(packedManifestEntry.toString('utf8'));
  if (
    packedManifest.name !== entry.manifest.name ||
    packedManifest.version !== entry.manifest.version
  ) {
    throw new Error(`${artifactName} contains mismatched package identity`);
  }
  for (const dependencyGroup of [
    packedManifest.dependencies,
    packedManifest.optionalDependencies,
  ]) {
    for (const [dependency, range] of Object.entries(dependencyGroup ?? {})) {
      if (dependency.startsWith('@patchlens-ai/') && String(range).startsWith('workspace:')) {
        throw new Error(`${artifactName} retains workspace protocol for ${dependency}`);
      }
    }
  }
  const paths = [...tarEntries.keys()];
  if (!paths.some((path) => path.startsWith('package/dist/'))) {
    throw new Error(`${artifactName} does not contain built dist files`);
  }
  if (paths.some((path) => path.startsWith('package/src/') || path.startsWith('package/test/'))) {
    throw new Error(`${artifactName} leaks source or test files`);
  }
  artifacts.push({
    package: entry.manifest.name,
    artifact: relative(repositoryRoot, artifactPath).replaceAll('\\', '/'),
    bytes: artifactStat.size,
    files: paths.length,
  });
}

console.log(JSON.stringify({ ok: true, artifacts }, null, 2));

function readTarEntries(buffer) {
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) {
      break;
    }
    const name = readTarText(header, 0, 100);
    const prefix = readTarText(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const sizeText = readTarText(header, 124, 12).trim();
    const size = Number.parseInt(sizeText || '0', 8);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`Invalid tar entry size for ${path}`);
    }
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > buffer.length) {
      throw new Error(`Truncated tar entry: ${path}`);
    }
    entries.set(path, buffer.subarray(contentStart, contentEnd));
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function readTarText(buffer, start, length) {
  const end = buffer.indexOf(0, start);
  const boundedEnd = end === -1 || end > start + length ? start + length : end;
  return buffer.subarray(start, boundedEnd).toString('utf8');
}
