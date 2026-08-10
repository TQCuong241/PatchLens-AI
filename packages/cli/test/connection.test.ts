import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writePatchLensSession } from '@patchlens-ai/mcp-server';

import {
  connectAttachedAgent,
  createCodexServerName,
  disconnectAttachedAgent,
  inspectAttachedAgent,
  type ExternalCommandRunner,
} from '../src/connection.js';
import { serializeConfig } from '../src/config.js';

let projectRoot: string | undefined;

afterEach(async () => {
  if (projectRoot) {
    await rm(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  }
});

describe('PatchLens attached agent connection', () => {
  it('connects Codex idempotently and removes only its owned server', async () => {
    projectRoot = await createProject();
    const session = await writePatchLensSession({
      daemonUrl: 'http://127.0.0.1:4312',
      daemonToken: 'daemon-token',
      projectId: 'project-1',
      projectRoot,
      packageManager: 'npm',
      daemonPid: process.pid,
    });
    const fake = createFakeCodexRunner();
    const options = {
      cwd: projectRoot,
      commandRunner: fake.runner,
      codexExecutable: 'codex',
      mcpBinPath: join(projectRoot, 'patchlens-mcp.js'),
      now: () => new Date('2026-08-09T00:00:00.000Z'),
    };

    const first = await connectAttachedAgent('codex', options);
    const second = await connectAttachedAgent('codex', options);

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(fake.addCalls).toBe(1);
    expect(first.serverName).toBe(createCodexServerName(projectRoot));
    const record = JSON.parse(await readFile(first.recordPath, 'utf8')) as {
      sessionPath: string;
      connectedAt: string;
    };
    expect(record).toMatchObject({
      sessionPath: session.path,
      connectedAt: '2026-08-09T00:00:00.000Z',
    });
    await expect(inspectAttachedAgent('codex', options)).resolves.toMatchObject({
      state: 'connected',
    });

    const removed = await disconnectAttachedAgent('codex', options);
    const repeated = await disconnectAttachedAgent('codex', options);
    expect(removed).toMatchObject({ changed: true, connected: false });
    expect(repeated).toMatchObject({ changed: false, connected: false });
    await expect(inspectAttachedAgent('codex', options)).resolves.toMatchObject({
      state: 'not-connected',
    });
    expect(fake.removeCalls).toBe(1);
  });

  it('refuses to overwrite a conflicting Codex MCP server', async () => {
    projectRoot = await createProject();
    await writePatchLensSession({
      daemonUrl: 'http://127.0.0.1:4312',
      daemonToken: 'daemon-token',
      projectId: 'project-1',
      projectRoot,
      packageManager: 'npm',
      daemonPid: process.pid,
    });
    const fake = createFakeCodexRunner([
      {
        name: createCodexServerName(projectRoot),
        transport: { type: 'stdio', command: 'other', args: [] },
      },
    ]);

    await expect(
      connectAttachedAgent('codex', {
        cwd: projectRoot,
        commandRunner: fake.runner,
        codexExecutable: 'codex',
        mcpBinPath: join(projectRoot, 'patchlens-mcp.js'),
      }),
    ).rejects.toThrow('different command');
    expect(fake.addCalls).toBe(0);
  });
});

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'patchlens-cli-connect-'));
  await mkdir(join(root, 'src'));
  await writeFile(
    join(root, 'patchlens.config.json'),
    serializeConfig({
      schemaVersion: 1,
      projectRoot: '.',
      host: {
        start: false,
        command: process.execPath,
        args: [],
        url: 'http://127.0.0.1:4311',
      },
      studio: { port: 4310 },
      daemon: { port: 4312 },
      provider: 'mock',
    }),
  );
  return root;
}

function createFakeCodexRunner(initialServers: unknown[] = []): {
  runner: ExternalCommandRunner;
  readonly addCalls: number;
  readonly removeCalls: number;
} {
  const servers = [...initialServers];
  let addCalls = 0;
  let removeCalls = 0;
  const runner: ExternalCommandRunner = (_command, args) => {
    if (args[0] === 'mcp' && args[1] === 'list') {
      return { status: 0, stdout: JSON.stringify(servers), stderr: '' };
    }
    if (args[0] === 'mcp' && args[1] === 'add') {
      addCalls += 1;
      const separator = args.indexOf('--');
      servers.push({
        name: args[2],
        transport: {
          type: 'stdio',
          command: args[separator + 1],
          args: args.slice(separator + 2),
        },
      });
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'mcp' && args[1] === 'remove') {
      removeCalls += 1;
      const index = servers.findIndex(
        (server) =>
          typeof server === 'object' &&
          server !== null &&
          'name' in server &&
          server.name === args[2],
      );
      if (index >= 0) {
        servers.splice(index, 1);
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected command' };
  };
  return {
    runner,
    get addCalls() {
      return addCalls;
    },
    get removeCalls() {
      return removeCalls;
    },
  };
}
