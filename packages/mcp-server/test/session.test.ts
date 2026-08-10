import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  discoverPatchLensSession,
  loadPatchLensSession,
  removePatchLensSession,
  writePatchLensSession,
} from '../src/session.js';

let projectRoot: string | undefined;

afterEach(async () => {
  if (projectRoot) {
    await rm(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  }
});

describe('PatchLens MCP session descriptor', () => {
  it('writes, discovers, validates, and conditionally removes a session', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-mcp-session-'));
    const nested = join(projectRoot, 'src', 'components');
    await mkdir(nested, { recursive: true });
    const written = await writePatchLensSession({
      daemonUrl: 'http://127.0.0.1:4312',
      daemonToken: 'daemon-token',
      projectId: 'project-1',
      projectRoot,
      packageManager: 'pnpm@10.16.0',
      daemonPid: process.pid,
    });

    await expect(discoverPatchLensSession(nested)).resolves.toBe(written.path);
    await expect(loadPatchLensSession(written.path)).resolves.toMatchObject({
      schemaVersion: 2,
      sessionId: written.descriptor.sessionId,
      projectRoot,
    });
    await expect(removePatchLensSession(written.path, 'bridge-other')).resolves.toBe(false);
    await expect(removePatchLensSession(written.path, written.descriptor.sessionId)).resolves.toBe(
      true,
    );
  });

  it('rejects a descriptor owned by a stale daemon process', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-mcp-session-'));
    const written = await writePatchLensSession({
      daemonUrl: 'http://127.0.0.1:4312',
      daemonToken: 'daemon-token',
      projectId: 'project-1',
      projectRoot,
      packageManager: 'npm',
      daemonPid: 2_147_483_647,
    });

    await expect(loadPatchLensSession(written.path)).rejects.toThrow('stale');
  });

  it('rejects an expired descriptor even while daemon PID is alive', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-mcp-session-'));
    const written = await writePatchLensSession({
      daemonUrl: 'http://127.0.0.1:4312',
      daemonToken: 'daemon-token',
      projectId: 'project-1',
      projectRoot,
      packageManager: 'npm',
      daemonPid: process.pid,
    });
    const descriptor = JSON.parse(await readFile(written.path, 'utf8')) as Record<string, unknown>;
    descriptor.createdAt = new Date(Date.now() - 2_000).toISOString();
    descriptor.expiresAt = new Date(Date.now() - 1_000).toISOString();
    await writeFile(written.path, `${JSON.stringify(descriptor, null, 2)}\n`);

    await expect(loadPatchLensSession(written.path)).rejects.toThrow('expired');
  });

  it.each([
    'https://127.0.0.1:4312',
    'http://user:pass@127.0.0.1:4312',
    'http://127.0.0.1:4312/other',
    'http://127.0.0.1:4312?token=secret',
    'http://127.0.0.1:4312/#session',
  ])('rejects unsafe daemon URL %s', async (daemonUrl) => {
    projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-mcp-session-'));

    await expect(
      writePatchLensSession({
        daemonUrl,
        daemonToken: 'daemon-token',
        projectId: 'project-1',
        projectRoot,
        packageManager: 'npm',
        daemonPid: process.pid,
      }),
    ).rejects.toThrow('loopback HTTP');
  });
});
