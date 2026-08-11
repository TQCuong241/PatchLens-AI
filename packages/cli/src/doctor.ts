import { readdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, extname, resolve } from 'node:path';

import { discoverAndLoadConfig, type ResolvedPatchLensConfig } from './config.js';
import { inspectAttachedAgent } from './connection.js';
import { spawnExternal } from './external-process.js';

export type DoctorStatus = 'pass' | 'warn' | 'fail';

export type DoctorCheck = {
  id: string;
  status: DoctorStatus;
  message: string;
};

export type DoctorResult = {
  checks: DoctorCheck[];
  ok: boolean;
};

export type DoctorOptions = {
  cwd?: string;
};

const viteConfigCandidates = [
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.js',
  'vite.config.mjs',
];
const nextConfigCandidates = [
  'next.config.ts',
  'next.config.mts',
  'next.config.js',
  'next.config.mjs',
];
const entryCandidates = ['src/main.tsx', 'src/main.ts', 'src/main.jsx', 'src/main.js'];
const nextRuntimeCandidates = [
  'instrumentation-client.ts',
  'instrumentation-client.js',
  'src/instrumentation-client.ts',
  'src/instrumentation-client.js',
];
const leakPatterns = [
  'data-patchlens-id=',
  'data-patchlens-source=',
  'patchlens-overlay',
  'patchlensStudioOrigin',
  '@patchlens-ai/inspector-runtime',
  '@patchlens-ai/dev/runtime',
];

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [checkNodeVersion()];
  let config: ResolvedPatchLensConfig;
  try {
    config = await discoverAndLoadConfig(options.cwd);
    checks.push({
      id: 'config',
      status: 'pass',
      message: `Loaded ${config.configPath}`,
    });
  } catch (error) {
    checks.push({
      id: 'config',
      status: 'fail',
      message: error instanceof Error ? error.message : 'Config discovery failed',
    });
    return { checks, ok: false };
  }

  checks.push(await checkProjectRoot(config));
  checks.push(checkPackageManager(config));
  checks.push(...(await checkIntegration(config)));
  checks.push(await checkPort('studio-port', config.studio.port));
  checks.push(await checkPort('daemon-port', config.daemon.port));
  if (config.host.start) {
    checks.push(await checkPort('host-port', getUrlPort(config.host.url)));
  } else {
    checks.push(await checkHostUrl(config.host.url));
  }
  checks.push(checkProvider(config.provider));
  checks.push(await checkCodexAttachment(config));
  checks.push(await checkProductionLeak(config.resolvedProjectRoot));

  return {
    checks,
    ok: checks.every((check) => check.status !== 'fail'),
  };
}

function checkNodeVersion(): DoctorCheck {
  const [major = 0, minor = 0] = process.versions.node
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  const supported = major > 20 || (major === 20 && minor >= 19);
  return {
    id: 'node',
    status: supported ? 'pass' : 'fail',
    message: supported
      ? `Node ${process.versions.node}`
      : `Node >=20.19.0 required; found ${process.versions.node}`,
  };
}

async function checkProjectRoot(config: ResolvedPatchLensConfig): Promise<DoctorCheck> {
  try {
    const rootStat = await stat(config.resolvedProjectRoot);
    return {
      id: 'project-root',
      status: rootStat.isDirectory() ? 'pass' : 'fail',
      message: rootStat.isDirectory()
        ? `Project root ${config.resolvedProjectRoot}`
        : 'Configured project root is not a directory',
    };
  } catch {
    return {
      id: 'project-root',
      status: 'fail',
      message: `Project root not found: ${config.resolvedProjectRoot}`,
    };
  }
}

function checkPackageManager(config: ResolvedPatchLensConfig): DoctorCheck {
  const executable = config.host.command;
  const versionArguments =
    config.host.command === 'corepack' && config.host.args[0]
      ? [config.host.args[0], '--version']
      : ['--version'];
  const result = spawnExternal.sync(executable, versionArguments, {
    cwd: config.resolvedProjectRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5_000,
  });
  if (result.error || result.status !== 0) {
    return {
      id: 'package-manager',
      status: 'fail',
      message: `Cannot execute ${config.host.command}`,
    };
  }
  return {
    id: 'package-manager',
    status: 'pass',
    message: `${config.host.command} ${(result.stdout || result.stderr).trim()}`,
  };
}

async function checkIntegration(config: ResolvedPatchLensConfig): Promise<DoctorCheck[]> {
  const viteConfig = await findFile(config.resolvedProjectRoot, viteConfigCandidates);
  const nextConfig = await findFile(config.resolvedProjectRoot, nextConfigCandidates);
  const entry = await findFile(config.resolvedProjectRoot, entryCandidates);
  const nextRuntime = await findFile(config.resolvedProjectRoot, nextRuntimeCandidates);
  const checks: DoctorCheck[] = [];
  if (viteConfig) {
    const viteSource = await readFile(viteConfig, 'utf8');
    checks.push({
      id: 'vite-plugin',
      status: viteSource.includes('patchLensVitePlugin(') ? 'pass' : 'fail',
      message: viteSource.includes('patchLensVitePlugin(')
        ? `Compiler plugin configured in ${basename(viteConfig)}`
        : `Compiler plugin missing from ${basename(viteConfig)}`,
    });
    if (!entry) {
      checks.push({ id: 'runtime', status: 'fail', message: 'Application entry not found' });
      return checks;
    }
    const entrySource = await readFile(entry, 'utf8');
    const guarded =
      entrySource.includes('import.meta.env.DEV') &&
      entrySource.includes("import('@patchlens-ai/dev/runtime')");
    checks.push({
      id: 'runtime',
      status: guarded ? 'pass' : 'fail',
      message: guarded
        ? `Inspector runtime is development-only in ${basename(entry)}`
        : `Development-only Inspector bootstrap missing from ${basename(entry)}`,
    });
    return checks;
  }

  if (nextConfig) {
    const source = await readFile(nextConfig, 'utf8');
    checks.push({
      id: 'next-compiler',
      status: source.includes('withPatchLensNext(') ? 'pass' : 'fail',
      message: source.includes('withPatchLensNext(')
        ? `Next compiler configured in ${basename(nextConfig)}`
        : `Next compiler missing from ${basename(nextConfig)}`,
    });
    if (!nextRuntime) {
      checks.push({
        id: 'runtime',
        status: 'fail',
        message: 'Next instrumentation-client entry not found',
      });
      return checks;
    }
    const runtimeSource = await readFile(nextRuntime, 'utf8');
    const guarded =
      runtimeSource.includes("process.env.NODE_ENV === 'development'") &&
      runtimeSource.includes("import('@patchlens-ai/dev/runtime')");
    checks.push({
      id: 'runtime',
      status: guarded ? 'pass' : 'fail',
      message: guarded
        ? `Inspector runtime is development-only in ${basename(nextRuntime)}`
        : `Development-only Inspector bootstrap missing from ${basename(nextRuntime)}`,
    });
    return checks;
  }

  checks.push({
    id: 'compiler',
    status: 'fail',
    message: 'Vite or Next config not found',
  });
  checks.push({
    id: 'runtime',
    status: 'fail',
    message: 'Development-only Inspector bootstrap not found',
  });
  return checks;
}

async function checkPort(id: string, port: number): Promise<DoctorCheck> {
  const available = await isPortAvailable(port);
  return {
    id,
    status: available ? 'pass' : 'fail',
    message: available ? `Port ${port} is available` : `Port ${port} is already in use`,
  };
}

async function checkHostUrl(url: string): Promise<DoctorCheck> {
  try {
    const response = await fetchWithTimeout(url, 2_000);
    return {
      id: 'host-url',
      status: 'pass',
      message: `Host responded with HTTP ${response.status}`,
    };
  } catch {
    return {
      id: 'host-url',
      status: 'fail',
      message: `Host is not reachable at ${url}`,
    };
  }
}

function checkProvider(provider: string): DoctorCheck {
  if (provider === 'mock') {
    return { id: 'provider', status: 'pass', message: 'Mock provider available' };
  }
  if (provider === 'codex') {
    return {
      id: 'provider',
      status: 'warn',
      message: 'Codex managed authentication is checked on first request',
    };
  }
  if (provider === 'claude') {
    const configured = Boolean(
      process.env.ANTHROPIC_API_KEY ||
      process.env.CLAUDE_CODE_USE_BEDROCK ||
      process.env.CLAUDE_CODE_USE_VERTEX,
    );
    return {
      id: 'provider',
      status: configured ? 'pass' : 'warn',
      message: configured
        ? 'Claude Agent SDK authentication environment detected'
        : 'Claude Agent SDK authentication is checked on first request',
    };
  }
  return {
    id: 'provider',
    status: 'fail',
    message: `Unsupported provider: ${provider}`,
  };
}

async function checkCodexAttachment(config: ResolvedPatchLensConfig): Promise<DoctorCheck> {
  try {
    const inspection = await inspectAttachedAgent('codex', {
      cwd: config.resolvedProjectRoot,
    });
    if (inspection.state === 'connected') {
      return {
        id: 'codex-mcp',
        status: 'pass',
        message: `Codex MCP server ${inspection.serverName} is connected`,
      };
    }
    if (inspection.state === 'not-connected') {
      return {
        id: 'codex-mcp',
        status: 'warn',
        message: 'Codex MCP bridge is not connected',
      };
    }
    return {
      id: 'codex-mcp',
      status: 'fail',
      message:
        inspection.state === 'stale'
          ? `Codex MCP server ${inspection.serverName} is missing`
          : `Codex MCP server ${inspection.serverName} conflicts with its PatchLens record`,
    };
  } catch (error) {
    return {
      id: 'codex-mcp',
      status: 'fail',
      message: error instanceof Error ? error.message : 'Cannot inspect Codex MCP bridge',
    };
  }
}

async function checkProductionLeak(projectRoot: string): Promise<DoctorCheck> {
  const outputRoots = [resolve(projectRoot, 'dist'), resolve(projectRoot, '.next')];
  const existingRoots: string[] = [];
  for (const outputRoot of outputRoots) {
    if (await isDirectory(outputRoot)) {
      existingRoots.push(outputRoot);
    }
  }
  if (existingRoots.length === 0) {
    return {
      id: 'production-leak',
      status: 'warn',
      message: 'No dist or .next directory; run production build to check runtime leakage',
    };
  }

  const files = (await Promise.all(existingRoots.map((root) => collectFiles(root, 2_000)))).flat();
  for (const file of files) {
    if (!['.css', '.html', '.js', '.mjs'].includes(extname(file).toLowerCase())) {
      continue;
    }
    const fileStat = await stat(file);
    if (fileStat.size > 2_000_000) {
      continue;
    }
    const source = await readFile(file, 'utf8');
    const pattern = leakPatterns.find((candidate) => source.includes(candidate));
    if (pattern) {
      return {
        id: 'production-leak',
        status: 'fail',
        message: `Production output contains ${pattern} in ${file}`,
      };
    }
  }
  return {
    id: 'production-leak',
    status: 'pass',
    message: 'No PatchLens runtime markers found in production output',
  };
}

async function collectFiles(root: string, maximumFiles: number): Promise<string[]> {
  const files: string[] = [];
  const directories = [root];
  while (directories.length > 0 && files.length < maximumFiles) {
    const directory = directories.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(path);
      } else if (entry.isFile()) {
        files.push(path);
        if (files.length >= maximumFiles) {
          break;
        }
      }
    }
  }
  return files;
}

async function findFile(root: string, candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    const path = resolve(root, candidate);
    try {
      if ((await stat(path)).isFile()) {
        return path;
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return undefined;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolveAvailability, rejectAvailability) => {
    const server = createServer();
    server.unref();
    server.once('error', (error) => {
      if (isNodeError(error) && error.code === 'EADDRINUSE') {
        resolveAvailability(false);
        return;
      }
      rejectAvailability(error);
    });
    server.listen(port, '127.0.0.1', () => {
      server.close((error) => {
        if (error) {
          rejectAvailability(error);
          return;
        }
        resolveAvailability(true);
      });
    });
  });
}

function getUrlPort(value: string): number {
  const url = new URL(value);
  return Number.parseInt(url.port || '80', 10);
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
