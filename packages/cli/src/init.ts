import { randomUUID } from 'node:crypto';
import { COPYFILE_EXCL } from 'node:constants';
import { copyFile, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import {
  PATCHLENS_CONFIG_FILENAME,
  createDefaultConfig,
  loadConfig,
  serializeConfig,
} from './config.js';

export type InitOptions = {
  cwd?: string;
  dryRun?: boolean;
};

export type InitResult = {
  root: string;
  modifiedFiles: string[];
  backupFiles: string[];
  unchangedFiles: string[];
};

type PlannedWrite = {
  path: string;
  previous?: string;
  next: string;
};

const viteConfigCandidates = [
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.js',
  'vite.config.mjs',
];
const entryCandidates = ['src/main.tsx', 'src/main.ts', 'src/main.jsx', 'src/main.js'];

export async function initializeProject(options: InitOptions = {}): Promise<InitResult> {
  const root = resolve(options.cwd ?? process.cwd());
  const packagePath = resolve(root, 'package.json');
  const packageSource = await readRequiredFile(packagePath, 'package.json');
  const packageJson = parsePackageJson(packageSource, packagePath);
  const viteConfigPath = await findRequiredFile(root, viteConfigCandidates, 'Vite config');
  const entryPath = await findRequiredFile(root, entryCandidates, 'application entry');
  const viteSource = await readFile(viteConfigPath, 'utf8');
  const entrySource = await readFile(entryPath, 'utf8');
  const configPath = resolve(root, PATCHLENS_CONFIG_FILENAME);
  const existingConfig = await readOptionalFile(configPath);
  const gitIgnorePath = resolve(root, '.gitignore');
  const existingGitIgnore = await readOptionalFile(gitIgnorePath);

  if (existingConfig !== undefined) {
    await loadConfig(configPath);
  }

  const packageManager =
    typeof packageJson.packageManager === 'string' ? packageJson.packageManager : 'npm';
  const nextPackageSource = updatePackageScript(packageJson, packageSource);
  const nextViteSource = updateViteConfig(viteSource, viteConfigPath);
  const nextEntrySource = updateApplicationEntry(entrySource);
  const writes: PlannedWrite[] = [
    { path: packagePath, previous: packageSource, next: nextPackageSource },
    { path: viteConfigPath, previous: viteSource, next: nextViteSource },
    { path: entryPath, previous: entrySource, next: nextEntrySource },
    {
      path: configPath,
      previous: existingConfig,
      next: existingConfig ?? serializeConfig(createDefaultConfig(packageManager)),
    },
    {
      path: gitIgnorePath,
      previous: existingGitIgnore,
      next: updateGitIgnore(existingGitIgnore ?? ''),
    },
  ];

  const modifiedFiles: string[] = [];
  const backupFiles: string[] = [];
  const unchangedFiles: string[] = [];
  for (const write of writes) {
    if (write.previous === write.next) {
      unchangedFiles.push(write.path);
      continue;
    }
    modifiedFiles.push(write.path);
    if (options.dryRun) {
      continue;
    }

    if (write.previous !== undefined) {
      backupFiles.push(await createBackup(write.path));
    }
    await writeAtomically(write.path, write.next);
  }

  return { root, modifiedFiles, backupFiles, unchangedFiles };
}

function updatePackageScript(packageJson: Record<string, unknown>, originalSource: string): string {
  const scripts = isRecord(packageJson.scripts) ? { ...packageJson.scripts } : {};
  if (typeof scripts.patchlens === 'string') {
    return originalSource;
  }
  scripts.patchlens = 'patchlens dev';
  return `${JSON.stringify({ ...packageJson, scripts }, null, 2)}\n`;
}

function updateViteConfig(source: string, path: string): string {
  if (source.includes('patchLensVitePlugin(')) {
    return source;
  }
  const pluginsPattern = /plugins\s*:\s*\[/;
  if (!pluginsPattern.test(source)) {
    throw new Error(`${basename(path)} must contain a literal plugins array for automatic setup`);
  }
  const importStatement = "import { patchLensVitePlugin } from '@patchlens-ai/dev/vite';\n";
  const withImport = source.includes('@patchlens-ai/dev/vite')
    ? source
    : `${importStatement}${source}`;
  return withImport.replace(pluginsPattern, (match) => `${match}patchLensVitePlugin(), `);
}

function updateApplicationEntry(source: string): string {
  if (source.includes("import('@patchlens-ai/dev/runtime')")) {
    return source;
  }
  const separator = source.endsWith('\n') ? '\n' : '\n\n';
  return `${source}${separator}if (import.meta.env.DEV) {\n  void import('@patchlens-ai/dev/runtime').then(({ installPatchLensInspector }) => {\n    void installPatchLensInspector();\n  });\n}\n`;
}

function updateGitIgnore(source: string): string {
  const lines = source.split(/\r?\n/);
  if (lines.some((line) => line.trim() === '.patchlens/')) {
    return source;
  }
  const separator = source.length === 0 || source.endsWith('\n') ? '' : '\n';
  return `${source}${separator}.patchlens/\n`;
}

async function createBackup(path: string): Promise<string> {
  let suffix = 0;
  while (true) {
    const candidate = `${path}.patchlens.bak${suffix === 0 ? '' : `.${suffix}`}`;
    try {
      await copyFile(path, candidate, COPYFILE_EXCL);
      return candidate;
    } catch (error) {
      if (isNodeError(error) && error.code === 'EEXIST') {
        suffix += 1;
        continue;
      }
      throw error;
    }
  }
}

async function writeAtomically(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.patchlens-${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { flag: 'wx' });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function findRequiredFile(
  root: string,
  candidates: string[],
  label: string,
): Promise<string> {
  for (const candidate of candidates) {
    const path = resolve(root, candidate);
    if (await isFile(path)) {
      return path;
    }
  }
  throw new Error(`${label} not found in ${root}`);
}

async function readRequiredFile(path: string, label: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    throw new Error(`${label} not found at ${path}`);
  }
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function parsePackageJson(source: string, path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(source);
    if (!isRecord(value)) {
      throw new Error('Package JSON must be an object');
    }
    return value;
  } catch {
    throw new Error(`Malformed package.json at ${path}`);
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
