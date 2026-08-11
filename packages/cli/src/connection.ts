import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverPatchLensSession, loadPatchLensSession } from '@patchlens-ai/mcp-server';

import { discoverAndLoadConfig } from './config.js';
import { spawnExternal } from './external-process.js';

export const PATCHLENS_CONNECTION_SCHEMA_VERSION = 1;
export const PATCHLENS_CODEX_CONNECTION_RELATIVE_PATH = '.patchlens/connections/codex.json';

export type AttachedAgentId = 'codex';

export type AgentConnectionRecord = {
  schemaVersion: 1;
  agent: AttachedAgentId;
  serverName: string;
  projectRoot: string;
  sessionPath: string;
  command: string;
  args: string[];
  connectedAt: string;
};

export type AgentConnectionResult = {
  agent: AttachedAgentId;
  serverName: string;
  recordPath: string;
  changed: boolean;
  connected: boolean;
};

export type AgentConnectionInspection = {
  agent: AttachedAgentId;
  serverName: string;
  recordPath: string;
  state: 'not-connected' | 'connected' | 'stale' | 'conflict';
};

export type ExternalCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export type ExternalCommandRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string },
) => ExternalCommandResult;

export type AgentConnectionOptions = {
  cwd?: string;
  commandRunner?: ExternalCommandRunner;
  codexExecutable?: string;
  mcpBinPath?: string;
  now?: () => Date;
};

export async function connectAttachedAgent(
  agent: AttachedAgentId,
  options: AgentConnectionOptions = {},
): Promise<AgentConnectionResult> {
  requireSupportedAgent(agent);
  const context = await resolveConnectionContext(options);
  const existingRecord = await readConnectionRecord(context.recordPath);
  const installedServer = await findCodexServer(
    context.commandRunner,
    context.codexExecutable,
    context.projectRoot,
    context.serverName,
  );

  if (installedServer && !matchesStdioServer(installedServer, context.command, context.args)) {
    throw new Error(
      `Codex MCP server ${context.serverName} already exists with a different command`,
    );
  }

  let changed = false;
  if (!installedServer) {
    runCodexCommand(context.commandRunner, context.codexExecutable, context.projectRoot, [
      'mcp',
      'add',
      context.serverName,
      '--',
      context.command,
      ...context.args,
    ]);
    changed = true;
  }

  const record: AgentConnectionRecord = {
    schemaVersion: PATCHLENS_CONNECTION_SCHEMA_VERSION,
    agent,
    serverName: context.serverName,
    projectRoot: context.projectRoot,
    sessionPath: context.sessionPath,
    command: context.command,
    args: context.args,
    connectedAt:
      existingRecord && matchesRecord(existingRecord, context)
        ? existingRecord.connectedAt
        : (options.now ?? (() => new Date()))().toISOString(),
  };
  if (!existingRecord || !sameConnectionRecord(existingRecord, record)) {
    await writeConnectionRecord(context.recordPath, record);
    changed = true;
  }

  return {
    agent,
    serverName: context.serverName,
    recordPath: context.recordPath,
    changed,
    connected: true,
  };
}

export async function disconnectAttachedAgent(
  agent: AttachedAgentId,
  options: AgentConnectionOptions = {},
): Promise<AgentConnectionResult> {
  requireSupportedAgent(agent);
  const config = await discoverAndLoadConfig(options.cwd);
  const projectRoot = await realpath(config.resolvedProjectRoot);
  const recordPath = resolve(projectRoot, PATCHLENS_CODEX_CONNECTION_RELATIVE_PATH);
  const record = await readConnectionRecord(recordPath);
  const serverName = record?.serverName ?? createCodexServerName(projectRoot);
  if (!record) {
    return { agent, serverName, recordPath, changed: false, connected: false };
  }

  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const codexExecutable = options.codexExecutable ?? 'codex';
  const installedServer = await findCodexServer(
    commandRunner,
    codexExecutable,
    projectRoot,
    serverName,
  );
  if (installedServer && !matchesStdioServer(installedServer, record.command, record.args)) {
    throw new Error(
      `Codex MCP server ${serverName} changed outside PatchLens; refusing to remove it`,
    );
  }

  if (installedServer) {
    runCodexCommand(commandRunner, codexExecutable, projectRoot, ['mcp', 'remove', serverName]);
  }
  await rm(recordPath, { force: true });
  return {
    agent,
    serverName,
    recordPath,
    changed: true,
    connected: false,
  };
}

export async function inspectAttachedAgent(
  agent: AttachedAgentId,
  options: AgentConnectionOptions = {},
): Promise<AgentConnectionInspection> {
  requireSupportedAgent(agent);
  const config = await discoverAndLoadConfig(options.cwd);
  const projectRoot = await realpath(config.resolvedProjectRoot);
  const recordPath = resolve(projectRoot, PATCHLENS_CODEX_CONNECTION_RELATIVE_PATH);
  const record = await readConnectionRecord(recordPath);
  const serverName = record?.serverName ?? createCodexServerName(projectRoot);
  if (!record) {
    return { agent, serverName, recordPath, state: 'not-connected' };
  }

  const installedServer = await findCodexServer(
    options.commandRunner ?? defaultCommandRunner,
    options.codexExecutable ?? 'codex',
    projectRoot,
    serverName,
  );
  if (!installedServer) {
    return { agent, serverName, recordPath, state: 'stale' };
  }
  return {
    agent,
    serverName,
    recordPath,
    state: matchesStdioServer(installedServer, record.command, record.args)
      ? 'connected'
      : 'conflict',
  };
}

export async function readCodexConnection(
  projectRoot: string,
): Promise<AgentConnectionRecord | undefined> {
  return readConnectionRecord(resolve(projectRoot, PATCHLENS_CODEX_CONNECTION_RELATIVE_PATH));
}

export function createCodexServerName(projectRoot: string): string {
  const stableRoot = process.platform === 'win32' ? projectRoot.toLowerCase() : projectRoot;
  const digest = createHash('sha256').update(stableRoot).digest('hex').slice(0, 12);
  return `patchlens-${digest}`;
}

type ResolvedConnectionContext = {
  projectRoot: string;
  sessionPath: string;
  recordPath: string;
  serverName: string;
  command: string;
  args: string[];
  commandRunner: ExternalCommandRunner;
  codexExecutable: string;
};

async function resolveConnectionContext(
  options: AgentConnectionOptions,
): Promise<ResolvedConnectionContext> {
  const config = await discoverAndLoadConfig(options.cwd);
  const projectRoot = await realpath(config.resolvedProjectRoot);
  const sessionPath = await discoverPatchLensSession(projectRoot);
  if (!sessionPath) {
    throw new Error('PatchLens session not found; run patchlens dev first');
  }
  const session = await loadPatchLensSession(sessionPath);
  if (session.projectRoot !== projectRoot) {
    throw new Error('PatchLens session belongs to a different project');
  }

  const mcpBinPath = resolve(options.mcpBinPath ?? resolveDefaultMcpBinPath());
  return {
    projectRoot,
    sessionPath: resolve(sessionPath),
    recordPath: resolve(projectRoot, PATCHLENS_CODEX_CONNECTION_RELATIVE_PATH),
    serverName: createCodexServerName(projectRoot),
    command: process.execPath,
    args: [mcpBinPath, '--session', resolve(sessionPath)],
    commandRunner: options.commandRunner ?? defaultCommandRunner,
    codexExecutable: options.codexExecutable ?? 'codex',
  };
}

function resolveDefaultMcpBinPath(): string {
  const entryUrl = import.meta.resolve('@patchlens-ai/mcp-server');
  return resolve(dirname(fileURLToPath(entryUrl)), 'bin.js');
}

const defaultCommandRunner: ExternalCommandRunner = (command, args, options) => {
  const result = spawnExternal.sync(command, [...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
};

function runCodexCommand(
  runner: ExternalCommandRunner,
  executable: string,
  cwd: string,
  args: readonly string[],
): ExternalCommandResult {
  const result = runner(executable, args, { cwd });
  if (result.error) {
    if (isNodeError(result.error) && result.error.code === 'ENOENT') {
      throw new Error('Codex CLI not found; install Codex before connecting');
    }
    throw new Error(`Cannot execute Codex CLI: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(detail ? `Codex MCP command failed: ${detail}` : 'Codex MCP command failed');
  }
  return result;
}

async function findCodexServer(
  runner: ExternalCommandRunner,
  executable: string,
  cwd: string,
  serverName: string,
): Promise<Record<string, unknown> | undefined> {
  const result = runCodexCommand(runner, executable, cwd, ['mcp', 'list', '--json']);
  let value: unknown;
  try {
    value = JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error('Codex MCP list returned malformed JSON');
  }
  if (!Array.isArray(value)) {
    throw new Error('Codex MCP list returned an invalid payload');
  }
  return value.find(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) && candidate.name === serverName,
  );
}

function matchesStdioServer(
  server: Record<string, unknown>,
  command: string,
  args: readonly string[],
): boolean {
  const transport = isRecord(server.transport) ? server.transport : server;
  return (
    transport.command === command &&
    Array.isArray(transport.args) &&
    transport.args.every((value) => typeof value === 'string') &&
    sameStringArray(transport.args, args)
  );
}

function matchesRecord(record: AgentConnectionRecord, context: ResolvedConnectionContext): boolean {
  return (
    record.serverName === context.serverName &&
    record.projectRoot === context.projectRoot &&
    record.sessionPath === context.sessionPath &&
    record.command === context.command &&
    sameStringArray(record.args, context.args)
  );
}

function sameConnectionRecord(left: AgentConnectionRecord, right: AgentConnectionRecord): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.agent === right.agent &&
    left.connectedAt === right.connectedAt &&
    left.serverName === right.serverName &&
    left.projectRoot === right.projectRoot &&
    left.sessionPath === right.sessionPath &&
    left.command === right.command &&
    sameStringArray(left.args, right.args)
  );
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function readConnectionRecord(path: string): Promise<AgentConnectionRecord | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return undefined;
    }
    throw new Error(
      error instanceof SyntaxError
        ? `PatchLens connection record contains malformed JSON: ${path}`
        : `Cannot read PatchLens connection record: ${path}`,
      { cause: error },
    );
  }
  if (!isConnectionRecord(value)) {
    throw new Error(`PatchLens connection record is invalid: ${path}`);
  }
  return value;
}

async function writeConnectionRecord(path: string, record: AgentConnectionRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function isConnectionRecord(value: unknown): value is AgentConnectionRecord {
  return (
    isRecord(value) &&
    value.schemaVersion === PATCHLENS_CONNECTION_SCHEMA_VERSION &&
    value.agent === 'codex' &&
    isBoundedString(value.serverName, 256) &&
    isBoundedString(value.projectRoot, 4_096) &&
    isBoundedString(value.sessionPath, 4_096) &&
    isBoundedString(value.command, 4_096) &&
    Array.isArray(value.args) &&
    value.args.length <= 16 &&
    value.args.every((argument) => isBoundedString(argument, 4_096)) &&
    isBoundedString(value.connectedAt, 64) &&
    !Number.isNaN(Date.parse(value.connectedAt))
  );
}

function requireSupportedAgent(agent: AttachedAgentId): void {
  if (agent !== 'codex') {
    throw new Error(`Unsupported attached agent: ${agent}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
