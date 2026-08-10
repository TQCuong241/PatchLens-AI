import { readFile, stat } from 'node:fs/promises';
import { dirname, parse, resolve } from 'node:path';

export const PATCHLENS_CONFIG_FILENAME = 'patchlens.config.json';
export const PATCHLENS_CONFIG_VERSION = 1;

export type PatchLensCommand = {
  command: string;
  args: string[];
};

export type PatchLensConfig = {
  schemaVersion: 1;
  projectRoot: string;
  host: PatchLensCommand & {
    start: boolean;
    url: string;
  };
  studio: {
    port: number;
  };
  daemon: {
    port: number;
  };
  provider: string;
};

export type ResolvedPatchLensConfig = PatchLensConfig & {
  configPath: string;
  configDirectory: string;
  resolvedProjectRoot: string;
};

export class PatchLensConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchLensConfigError';
  }
}

export async function discoverConfig(startDirectory = process.cwd()): Promise<string | undefined> {
  let current = resolve(startDirectory);
  while (true) {
    const candidate = resolve(current, PATCHLENS_CONFIG_FILENAME);
    if (await isFile(candidate)) {
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current || current === parse(current).root) {
      return undefined;
    }
    current = parent;
  }
}

export async function loadConfig(configPath: string): Promise<ResolvedPatchLensConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, 'utf8')) as unknown;
  } catch (error) {
    throw new PatchLensConfigError(
      error instanceof SyntaxError
        ? `Malformed JSON in ${configPath}`
        : `Cannot read PatchLens config: ${configPath}`,
    );
  }

  const config = parseConfig(parsed);
  const configDirectory = dirname(resolve(configPath));
  return {
    ...config,
    configPath: resolve(configPath),
    configDirectory,
    resolvedProjectRoot: resolve(configDirectory, config.projectRoot),
  };
}

export async function discoverAndLoadConfig(
  startDirectory = process.cwd(),
): Promise<ResolvedPatchLensConfig> {
  const configPath = await discoverConfig(startDirectory);
  if (!configPath) {
    throw new PatchLensConfigError(
      `Cannot find ${PATCHLENS_CONFIG_FILENAME}; run patchlens init first`,
    );
  }
  return loadConfig(configPath);
}

export function createDefaultConfig(packageManager: string): PatchLensConfig {
  const command = createDevCommand(packageManager);
  return {
    schemaVersion: PATCHLENS_CONFIG_VERSION,
    projectRoot: '.',
    host: {
      start: true,
      command: command.command,
      args: command.args,
      url: 'http://127.0.0.1:4311',
    },
    studio: { port: 4310 },
    daemon: { port: 4312 },
    provider: 'mock',
  };
}

export function serializeConfig(config: PatchLensConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function parseConfig(value: unknown): PatchLensConfig {
  if (!isRecord(value) || value.schemaVersion !== PATCHLENS_CONFIG_VERSION) {
    throw new PatchLensConfigError('Unsupported PatchLens config version');
  }
  if (!isBoundedString(value.projectRoot, 4_096)) {
    throw new PatchLensConfigError('projectRoot must be a non-empty path');
  }
  if (!isRecord(value.host)) {
    throw new PatchLensConfigError('host config is required');
  }
  if (
    typeof value.host.start !== 'boolean' ||
    !isBoundedString(value.host.command, 256) ||
    !isStringArray(value.host.args, 64, 4_096) ||
    !isLoopbackHttpUrl(value.host.url)
  ) {
    throw new PatchLensConfigError('host config is invalid');
  }
  if (!isRecord(value.studio) || !isPort(value.studio.port)) {
    throw new PatchLensConfigError('studio.port is invalid');
  }
  if (!isRecord(value.daemon) || !isPort(value.daemon.port)) {
    throw new PatchLensConfigError('daemon.port is invalid');
  }
  if (value.studio.port === value.daemon.port) {
    throw new PatchLensConfigError('Studio and daemon ports must differ');
  }
  const hostPort = Number.parseInt(new URL(value.host.url).port || '80', 10);
  if (hostPort === value.studio.port || hostPort === value.daemon.port) {
    throw new PatchLensConfigError('Host, Studio, and daemon ports must differ');
  }
  if (!isBoundedString(value.provider, 128)) {
    throw new PatchLensConfigError('provider is invalid');
  }

  return value as PatchLensConfig;
}

function createDevCommand(packageManager: string): PatchLensCommand {
  const name = packageManager.split('@', 1)[0]?.toLowerCase();
  const viteArguments = ['--host', '127.0.0.1', '--port', '4311', '--strictPort'];
  if (name === 'pnpm') {
    return {
      command: 'corepack',
      args: ['pnpm', 'run', 'dev', '--', ...viteArguments],
    };
  }
  if (name === 'yarn') {
    return {
      command: 'corepack',
      args: ['yarn', 'run', 'dev', ...viteArguments],
    };
  }
  if (name === 'bun') {
    return { command: 'bun', args: ['run', 'dev', '--', ...viteArguments] };
  }
  return { command: 'npm', args: ['run', 'dev', '--', ...viteArguments] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength;
}

function isStringArray(
  value: unknown,
  maximumItems: number,
  maximumItemLength: number,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximumItems &&
    value.every((item) => isBoundedString(item, maximumItemLength))
  );
}

function isPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 65_535;
}

function isLoopbackHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
