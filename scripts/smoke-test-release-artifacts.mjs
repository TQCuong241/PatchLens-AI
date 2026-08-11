import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const artifactRoot = resolve(repositoryRoot, 'release-artifacts');
const workspaceRoots = ['apps', 'packages', 'examples'];
const corepackCommand =
  process.platform === 'win32'
    ? {
        executable: process.execPath,
        arguments: [resolve(dirname(process.execPath), 'node_modules/corepack/dist/corepack.js')],
      }
    : { executable: 'corepack', arguments: [] };

const rootManifest = JSON.parse(await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'));
if (
  typeof rootManifest.packageManager !== 'string' ||
  !rootManifest.packageManager.startsWith('pnpm@')
) {
  throw new Error('Root packageManager must pin pnpm for release consumer smoke tests');
}

const publishablePackages = await discoverPublishablePackages();
if (publishablePackages.length !== 17) {
  throw new Error(`Expected 17 publishable packages, found ${publishablePackages.length}`);
}

const dependencies = {};
const overrides = {};
for (const manifest of publishablePackages) {
  const artifactPath = resolve(
    artifactRoot,
    `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`,
  );
  const artifactStat = await stat(artifactPath);
  if (!artifactStat.isFile() || artifactStat.size === 0) {
    throw new Error(`Release artifact is missing or empty: ${artifactPath}`);
  }
  const artifactSpec = `file:${artifactPath.replaceAll('\\', '/')}`;
  dependencies[manifest.name] = artifactSpec;
  overrides[`${manifest.name}@${manifest.version}`] = artifactSpec;
}

const consumerRoot = await mkdtemp(join(tmpdir(), 'patchlens-release-consumer-'));
try {
  await writeFile(
    resolve(consumerRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'patchlens-release-consumer-smoke',
        version: '1.0.0',
        private: true,
        type: 'module',
        packageManager: rootManifest.packageManager,
        dependencies,
        pnpm: { overrides },
      },
      null,
      2,
    )}\n`,
  );

  runCommand(
    corepackCommand.executable,
    [
      ...corepackCommand.arguments,
      'pnpm',
      'install',
      '--offline',
      '--ignore-scripts',
      '--store-dir',
      resolve(repositoryRoot, '.pnpm-store'),
    ],
    consumerRoot,
    'Consumer install',
  );

  runCommand(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      [
        "const root = await import('@patchlens-ai/dev');",
        "const vite = await import('@patchlens-ai/dev/vite');",
        "const next = await import('@patchlens-ai/dev/next');",
        "const runtime = await import('@patchlens-ai/dev/runtime');",
        "if (typeof root.runPatchLensCli !== 'function') throw new Error('root export missing');",
        "if (typeof vite.patchLensVitePlugin !== 'function') throw new Error('Vite export missing');",
        "if (typeof next.withPatchLensNext !== 'function') throw new Error('Next export missing');",
        "if (typeof runtime.installPatchLensInspector !== 'function') throw new Error('runtime export missing');",
      ].join(''),
    ],
    consumerRoot,
    'Consumer import',
  );

  const binPath = resolve(
    consumerRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'patchlens.cmd' : 'patchlens',
  );
  if (!(await stat(binPath)).isFile()) {
    throw new Error('Installed patchlens executable is missing');
  }
  const cliResult = runCommand(
    corepackCommand.executable,
    [...corepackCommand.arguments, 'pnpm', 'exec', 'patchlens', '--help'],
    consumerRoot,
    'Consumer CLI',
  );
  if (!cliResult.stdout.includes('Usage:') || !cliResult.stdout.includes('patchlens doctor')) {
    throw new Error('Installed patchlens CLI did not return expected help output');
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        packages: publishablePackages.length,
        imports: ['@patchlens-ai/dev', './vite', './next', './runtime'],
        cli: 'patchlens --help',
      },
      null,
      2,
    ),
  );
} finally {
  await removeTemporaryConsumer(consumerRoot);
}

async function discoverPublishablePackages() {
  const manifests = [];
  for (const workspaceRoot of workspaceRoots) {
    for (const entry of await readdir(resolve(repositoryRoot, workspaceRoot), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) {
        continue;
      }
      let manifest;
      try {
        manifest = JSON.parse(
          await readFile(
            resolve(repositoryRoot, workspaceRoot, entry.name, 'package.json'),
            'utf8',
          ),
        );
      } catch (error) {
        if (error?.code === 'ENOENT') {
          continue;
        }
        throw error;
      }
      if (manifest.private !== true) {
        manifests.push(manifest);
      }
    }
  }
  return manifests.sort((left, right) => left.name.localeCompare(right.name));
}

function runCommand(executable, arguments_, cwd, label) {
  const result = spawnSync(executable, arguments_, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? (result.stderr.trim() || result.stdout.trim());
    throw new Error(`${label} failed: ${detail}`, { cause: result.error });
  }
  return result;
}

async function removeTemporaryConsumer(consumerRoot) {
  const temporaryRoot = resolve(tmpdir());
  const pathFromTemporaryRoot = relative(temporaryRoot, consumerRoot);
  if (
    !pathFromTemporaryRoot.startsWith('patchlens-release-consumer-') ||
    pathFromTemporaryRoot.includes('/') ||
    pathFromTemporaryRoot.includes('\\')
  ) {
    throw new Error(`Refusing to remove unsafe consumer path: ${consumerRoot}`);
  }
  await rm(consumerRoot, { recursive: true, force: true });
}
