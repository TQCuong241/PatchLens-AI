import { randomBytes } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, parse, resolve } from 'node:path';

import { createDaemonServer } from '@patchlens-ai/daemon';
import { removePatchLensSession, writePatchLensSession } from '@patchlens-ai/mcp-server';
import { createStudioServer } from '@patchlens-ai/studio/server';

import { discoverAndLoadConfig } from './config.js';
import { spawnExternal } from './external-process.js';

export type DevelopmentOptions = {
  cwd?: string;
  startHost?: boolean;
  hostTimeoutMs?: number;
  signal?: AbortSignal;
  output?: (message: string) => void;
};

export type DevelopmentSession = {
  studioUrl: string;
  daemonUrl: string;
  previewUrl: string;
  mcpSessionPath: string;
};

export async function runDevelopment(
  options: DevelopmentOptions = {},
): Promise<DevelopmentSession> {
  const output = options.output ?? console.log;
  const config = await discoverAndLoadConfig(options.cwd);
  const shouldStartHost = options.startHost ?? config.host.start;
  const studioOrigin = `http://127.0.0.1:${config.studio.port}`;
  const daemonUrl = `http://127.0.0.1:${config.daemon.port}`;

  await requireAvailablePort(config.studio.port, 'Studio');
  await requireAvailablePort(config.daemon.port, 'daemon');
  if (shouldStartHost) {
    await requireAvailablePort(getUrlPort(config.host.url), 'host');
  }

  const daemonToken = randomBytes(32).toString('hex');
  const studioAccessToken = randomBytes(32).toString('hex');
  const studioUrl = `${studioOrigin}/?token=${encodeURIComponent(studioAccessToken)}`;
  const daemon = createDaemonServer({
    port: config.daemon.port,
    token: daemonToken,
    allowedOrigins: [studioOrigin],
  });
  const project = await daemon.api.projects.register(config.resolvedProjectRoot);
  const studio = createStudioServer({
    port: config.studio.port,
    accessToken: studioAccessToken,
    daemonUrl,
    daemonToken,
    projectRoot: config.resolvedProjectRoot,
    previewUrl: config.host.url,
    provider: config.provider,
    projectId: project.id,
  });

  let hostProcess: ChildProcess | undefined;
  let daemonStarted = false;
  let studioStarted = false;
  let activeSession: { path: string; descriptor: { sessionId: string } } | undefined;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  let abortHandler: (() => void) | undefined;
  let resolveStop: ((reason: StopReason) => void) | undefined;
  const stopped = new Promise<StopReason>((resolveStopped) => {
    resolveStop = resolveStopped;
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const handler = () => resolveStop?.({ type: 'signal', signal });
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
  if (options.signal) {
    abortHandler = () => resolveStop?.({ type: 'abort' });
    if (options.signal.aborted) {
      abortHandler();
    } else {
      options.signal.addEventListener('abort', abortHandler, { once: true });
    }
  }

  try {
    await daemon.start();
    daemonStarted = true;
    await studio.start();
    studioStarted = true;
    const session = await writePatchLensSession({
      daemonUrl,
      daemonToken,
      projectId: project.id,
      projectRoot: config.resolvedProjectRoot,
      packageManager: await detectPackageManager(config.resolvedProjectRoot),
      daemonPid: process.pid,
    });
    activeSession = session;

    if (shouldStartHost) {
      hostProcess = startHostProcess(
        config.host.command,
        config.host.args,
        config.resolvedProjectRoot,
      );
      hostProcess.once('error', (error) => {
        resolveStop?.({ type: 'host-error', error });
      });
      hostProcess.once('exit', (code, signal) => {
        resolveStop?.({ type: 'host-exit', code, signal });
      });
    }

    const startupStop = await Promise.race([
      waitForUrl(config.host.url, options.hostTimeoutMs ?? 30_000, hostProcess).then(
        () => undefined,
      ),
      stopped,
    ]);
    if (startupStop) {
      if (startupStop.type === 'signal' || startupStop.type === 'abort') {
        return {
          studioUrl,
          daemonUrl,
          previewUrl: config.host.url,
          mcpSessionPath: session.path,
        };
      }
      throw stopReasonError(startupStop);
    }

    output(`PatchLens Studio: ${studioUrl}`);
    output(`Preview: ${config.host.url}`);
    output(`Daemon: ${daemonUrl}`);
    output(`MCP session: ${session.path}`);

    const reason = await stopped;
    if (reason.type === 'host-error' || reason.type === 'host-exit') {
      throw stopReasonError(reason);
    }

    return {
      studioUrl,
      daemonUrl,
      previewUrl: config.host.url,
      mcpSessionPath: session.path,
    };
  } finally {
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    if (options.signal && abortHandler) {
      options.signal.removeEventListener('abort', abortHandler);
    }
    if (hostProcess) {
      await terminateChild(hostProcess);
    }
    if (activeSession) {
      await removePatchLensSession(activeSession.path, activeSession.descriptor.sessionId);
    }
    if (studioStarted) {
      await studio.stop();
    }
    if (daemonStarted) {
      await daemon.stop();
    }
  }
}

type StopReason =
  | { type: 'signal'; signal: NodeJS.Signals }
  | { type: 'abort' }
  | { type: 'host-error'; error: Error }
  | { type: 'host-exit'; code: number | null; signal: NodeJS.Signals | null };

function stopReasonError(reason: Extract<StopReason, { type: 'host-error' | 'host-exit' }>): Error {
  if (reason.type === 'host-error') {
    return reason.error;
  }
  return new Error(`Host dev server stopped (${reason.signal ?? `exit ${reason.code ?? 1}`})`);
}

function startHostProcess(command: string, args: string[], cwd: string): ChildProcess {
  return spawnExternal(command, args, {
    cwd,
    env: { ...process.env, FORCE_COLOR: '1' },
    stdio: 'inherit',
    windowsHide: true,
  });
}

async function waitForUrl(
  url: string,
  timeoutMs: number,
  child: ChildProcess | undefined,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`Host dev server exited with code ${child.exitCode}`);
    }
    try {
      await fetchWithTimeout(url, 1_000);
      return;
    } catch {
      await delay(250);
    }
  }
  throw new Error(`Host dev server did not become ready within ${timeoutMs} ms`);
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) {
    return;
  }

  if (process.platform === 'win32') {
    const terminatedTree = await new Promise<boolean>((resolveTermination) => {
      const killer = spawnExternal('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', () => resolveTermination(false));
      killer.once('exit', (code) => resolveTermination(code === 0));
    });
    if (terminatedTree) {
      await waitForExit(child, 1_000);
      return;
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForExit(child, 1_000);
    }
    return;
  }

  child.kill('SIGTERM');
  const exited = await waitForExit(child, 3_000);
  if (!exited && child.exitCode === null) {
    child.kill('SIGKILL');
    await waitForExit(child, 1_000);
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolveExit) => {
    const handleExit = () => {
      clearTimeout(timer);
      resolveExit(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', handleExit);
      resolveExit(false);
    }, timeoutMs);
    child.once('exit', handleExit);
  });
}

async function requireAvailablePort(port: number, label: string): Promise<void> {
  if (!(await isPortAvailable(port))) {
    throw new Error(`${label} port ${port} is already in use`);
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

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function getUrlPort(value: string): number {
  const url = new URL(value);
  return Number.parseInt(url.port || '80', 10);
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, timeoutMs));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

async function detectPackageManager(projectRoot: string): Promise<string> {
  let current = resolve(projectRoot);
  while (true) {
    try {
      const value: unknown = JSON.parse(await readFile(resolve(current, 'package.json'), 'utf8'));
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        'packageManager' in value &&
        typeof value.packageManager === 'string'
      ) {
        return value.packageManager;
      }
    } catch (error) {
      if (!isNodeError(error) || (error.code !== 'ENOENT' && !(error instanceof SyntaxError))) {
        return 'npm';
      }
    }

    const parent = dirname(current);
    if (parent === current || current === parse(current).root) {
      return 'npm';
    }
    current = parent;
  }
}
