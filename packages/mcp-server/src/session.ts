import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, parse, resolve } from 'node:path';

export const PATCHLENS_SESSION_SCHEMA_VERSION = 2;
export const PATCHLENS_SESSION_RELATIVE_PATH = '.patchlens/session.json';
export const PATCHLENS_SESSION_MAX_AGE_MS = 24 * 60 * 60_000;

export type PatchLensSessionDescriptor = {
  schemaVersion: 2;
  sessionId: string;
  daemonUrl: string;
  daemonToken: string;
  projectId: string;
  projectRoot: string;
  packageManager: string;
  daemonPid: number;
  createdAt: string;
  expiresAt: string;
};

export type WritePatchLensSessionInput = Omit<
  PatchLensSessionDescriptor,
  'schemaVersion' | 'sessionId' | 'projectRoot' | 'createdAt' | 'expiresAt'
> & {
  projectRoot: string;
};

export class PatchLensSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchLensSessionError';
  }
}

export async function writePatchLensSession(
  input: WritePatchLensSessionInput,
): Promise<{ path: string; descriptor: PatchLensSessionDescriptor }> {
  const projectRoot = await realpath(resolve(input.projectRoot));
  validateLoopbackUrl(input.daemonUrl);
  if (!isBoundedString(input.daemonToken, 4_096)) {
    throw new PatchLensSessionError('Daemon token is invalid');
  }
  if (
    !isBoundedString(input.projectId, 256) ||
    !isBoundedString(input.packageManager, 256) ||
    !Number.isInteger(input.daemonPid) ||
    input.daemonPid <= 0
  ) {
    throw new PatchLensSessionError('Session descriptor input is invalid');
  }

  const path = resolve(projectRoot, PATCHLENS_SESSION_RELATIVE_PATH);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const createdAt = new Date();
  const descriptor: PatchLensSessionDescriptor = {
    schemaVersion: PATCHLENS_SESSION_SCHEMA_VERSION,
    sessionId: `bridge-${randomUUID()}`,
    daemonUrl: input.daemonUrl,
    daemonToken: input.daemonToken,
    projectId: input.projectId,
    projectRoot,
    packageManager: input.packageManager,
    daemonPid: input.daemonPid,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + PATCHLENS_SESSION_MAX_AGE_MS).toISOString(),
  };
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(descriptor, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return { path, descriptor };
}

export async function discoverPatchLensSession(
  startDirectory = process.cwd(),
): Promise<string | undefined> {
  const configuredPath = process.env.PATCHLENS_SESSION_FILE;
  if (configuredPath) {
    return resolve(configuredPath);
  }

  let current = resolve(startDirectory);
  while (true) {
    const candidate = resolve(current, PATCHLENS_SESSION_RELATIVE_PATH);
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

export async function loadPatchLensSession(
  sessionPath: string,
): Promise<PatchLensSessionDescriptor> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(sessionPath, 'utf8')) as unknown;
  } catch (error) {
    throw new PatchLensSessionError(
      error instanceof SyntaxError
        ? 'PatchLens session file contains malformed JSON'
        : 'Cannot read PatchLens session file',
    );
  }
  if (!isSessionDescriptor(value)) {
    throw new PatchLensSessionError('PatchLens session descriptor is invalid');
  }
  validateLoopbackUrl(value.daemonUrl);

  const projectRoot = await realpath(resolve(value.projectRoot));
  const expectedPath = resolve(projectRoot, PATCHLENS_SESSION_RELATIVE_PATH);
  if (resolve(sessionPath) !== expectedPath) {
    throw new PatchLensSessionError('Session file is outside configured project root');
  }
  if (Date.parse(value.expiresAt) <= Date.now()) {
    throw new PatchLensSessionError('PatchLens daemon session has expired');
  }
  if (!(await isProcessAlive(value.daemonPid))) {
    throw new PatchLensSessionError('PatchLens daemon session is stale');
  }
  return { ...value, projectRoot };
}

export async function removePatchLensSession(
  sessionPath: string,
  expectedSessionId?: string,
): Promise<boolean> {
  if (expectedSessionId) {
    try {
      const value: unknown = JSON.parse(await readFile(sessionPath, 'utf8')) as unknown;
      if (!isSessionDescriptor(value) || value.sessionId !== expectedSessionId) {
        return false;
      }
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }
  await rm(sessionPath, { force: true });
  return true;
}

function isSessionDescriptor(value: unknown): value is PatchLensSessionDescriptor {
  return (
    isRecord(value) &&
    value.schemaVersion === PATCHLENS_SESSION_SCHEMA_VERSION &&
    isBoundedString(value.sessionId, 256) &&
    isBoundedString(value.daemonUrl, 2_048) &&
    isBoundedString(value.daemonToken, 4_096) &&
    isBoundedString(value.projectId, 256) &&
    isBoundedString(value.projectRoot, 4_096) &&
    isBoundedString(value.packageManager, 256) &&
    typeof value.daemonPid === 'number' &&
    Number.isInteger(value.daemonPid) &&
    value.daemonPid > 0 &&
    isBoundedString(value.createdAt, 64) &&
    isBoundedString(value.expiresAt, 64) &&
    isValidSessionWindow(value.createdAt, value.expiresAt)
  );
}

function isValidSessionWindow(createdAt: string, expiresAt: string): boolean {
  const createdAtMs = Date.parse(createdAt);
  const expiresAtMs = Date.parse(expiresAt);
  return (
    !Number.isNaN(createdAtMs) &&
    !Number.isNaN(expiresAtMs) &&
    expiresAtMs > createdAtMs &&
    expiresAtMs - createdAtMs <= PATCHLENS_SESSION_MAX_AGE_MS
  );
}

function validateLoopbackUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PatchLensSessionError('Daemon URL is invalid');
  }
  if (
    url.protocol !== 'http:' ||
    (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') ||
    Boolean(url.username) ||
    Boolean(url.password) ||
    url.pathname !== '/' ||
    Boolean(url.search) ||
    Boolean(url.hash)
  ) {
    throw new PatchLensSessionError('Daemon URL must use loopback HTTP');
  }
}

async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === 'EPERM';
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

function isBoundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
