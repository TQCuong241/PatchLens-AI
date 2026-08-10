import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

import type { VerificationCommandId } from '@patchlens-ai/agent-protocol';

export type TrustedVerificationCommand = {
  command: string;
  args: string[];
  timeoutMs?: number;
};

export type VerificationCommandAllowlist = Readonly<
  Partial<Record<VerificationCommandId, TrustedVerificationCommand>>
>;

export type VerificationCommandResult = {
  id: VerificationCommandId;
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
};

export type RunVerificationCommandsOptions = {
  cwd: string;
  allowlist: VerificationCommandAllowlist;
  maximumOutputBytes?: number;
};

const validCommandIds = new Set<VerificationCommandId>(['typecheck', 'lint', 'test', 'build']);

export function createPackageManagerCommandAllowlist(
  packageManager: string,
): VerificationCommandAllowlist {
  return {
    typecheck: createScriptCommand(packageManager, 'typecheck'),
    lint: createScriptCommand(packageManager, 'lint'),
    test: createScriptCommand(packageManager, 'test'),
    build: createScriptCommand(packageManager, 'build'),
  };
}

export async function runAllowedVerificationCommands(
  requestedCommands: readonly VerificationCommandId[],
  options: RunVerificationCommandsOptions,
): Promise<VerificationCommandResult[]> {
  const commands = [...new Set(requestedCommands)];
  const results: VerificationCommandResult[] = [];
  for (const id of commands) {
    if (!validCommandIds.has(id)) {
      throw new Error(`Verification command is not allowed: ${String(id)}`);
    }
    const definition = options.allowlist[id];
    if (!definition) {
      throw new Error(`Verification command is not configured: ${id}`);
    }
    results.push(
      await runCommand(id, definition, {
        cwd: options.cwd,
        maximumOutputBytes: options.maximumOutputBytes ?? 32_000,
      }),
    );
  }
  return results;
}

function createScriptCommand(
  packageManager: string,
  script: VerificationCommandId,
): TrustedVerificationCommand {
  const name = packageManager.split('@', 1)[0]?.toLowerCase();
  if (name === 'pnpm') {
    return { command: 'corepack', args: ['pnpm', 'run', script] };
  }
  if (name === 'yarn') {
    return { command: 'corepack', args: ['yarn', 'run', script] };
  }
  if (name === 'bun') {
    return { command: 'bun', args: ['run', script] };
  }
  return { command: 'npm', args: ['run', script] };
}

async function runCommand(
  id: VerificationCommandId,
  definition: TrustedVerificationCommand,
  options: { cwd: string; maximumOutputBytes: number },
): Promise<VerificationCommandResult> {
  if (!definition.command || definition.command.length > 1_024) {
    throw new Error(`Trusted command definition is invalid: ${id}`);
  }
  if (definition.args.length > 128 || definition.args.some((argument) => argument.length > 8_192)) {
    throw new Error(`Trusted command arguments are invalid: ${id}`);
  }
  if (
    !Number.isInteger(options.maximumOutputBytes) ||
    options.maximumOutputBytes < 1_024 ||
    options.maximumOutputBytes > 1_000_000
  ) {
    throw new Error('maximumOutputBytes must be between 1024 and 1000000');
  }

  const startedAt = Date.now();
  const timeoutMs = definition.timeoutMs ?? 120_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 900_000) {
    throw new Error(`Trusted command timeout is invalid: ${id}`);
  }
  const child = spawn(resolveExecutable(definition.command), definition.args, {
    cwd: options.cwd,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      CI: '1',
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  child.stdout?.on('data', (chunk: Buffer | string) => {
    stdout = appendBounded(stdout, chunk, options.maximumOutputBytes);
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr = appendBounded(stderr, chunk, options.maximumOutputBytes);
  });

  let timedOut = false;
  let terminationPromise: Promise<void> | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    terminationPromise = terminateChild(child);
  }, timeoutMs);
  try {
    const exit = await waitForClose(child);
    await terminationPromise;
    return {
      id,
      ok: !timedOut && exit.code === 0,
      exitCode: exit.code,
      signal: exit.signal,
      timedOut,
      durationMs: Date.now() - startedAt,
      stdout: stdout.toString('utf8'),
      stderr: stderr.toString('utf8'),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function waitForClose(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveClose, rejectClose) => {
    child.once('error', rejectClose);
    child.once('close', (code, signal) => resolveClose({ code, signal }));
  });
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) {
    return;
  }
  if (process.platform === 'win32') {
    const terminatedTree = await new Promise<boolean>((resolveTermination) => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', () => resolveTermination(false));
      killer.once('exit', (code) => resolveTermination(code === 0));
    });
    if (!terminatedTree && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    return;
  }
  const processGroupId = child.pid;
  signalProcessGroup(processGroupId, 'SIGTERM');
  if (!(await waitForProcessGroupExit(processGroupId, 2_000))) {
    signalProcessGroup(processGroupId, 'SIGKILL');
    await waitForProcessGroupExit(processGroupId, 500);
  }
}

function signalProcessGroup(processGroupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ESRCH') {
      throw error;
    }
  }
}

async function waitForProcessGroupExit(
  processGroupId: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(processGroupId)) {
      return true;
    }
    await delay(25);
  }
  return !isProcessGroupAlive(processGroupId);
}

function isProcessGroupAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return !isNodeError(error) || error.code !== 'ESRCH';
  }
}

function appendBounded(current: Buffer, chunk: Buffer | string, maximumBytes: number): Buffer {
  if (current.length >= maximumBytes) {
    return current;
  }
  const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = maximumBytes - current.length;
  return Buffer.concat([current, next.subarray(0, remaining)]);
}

function resolveExecutable(command: string): string {
  if (process.platform !== 'win32') {
    return command;
  }
  if (['corepack', 'npm', 'pnpm', 'yarn'].includes(command)) {
    return `${command}.cmd`;
  }
  return command;
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, timeoutMs));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
