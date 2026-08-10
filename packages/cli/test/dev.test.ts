import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runDevelopment } from '../src/dev.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('patchlens dev', () => {
  it('starts loopback services and cleans them after abort', async () => {
    const root = await createProject();
    const [hostPort, studioPort, daemonPort] = await reservePorts(3);
    const controller = new AbortController();
    const output: string[] = [];
    await writeConfig(root, {
      hostPort,
      studioPort,
      daemonPort,
      hostScript: createHttpServerScript(hostPort),
    });

    const session = await runDevelopment({
      cwd: root,
      signal: controller.signal,
      hostTimeoutMs: 5_000,
      output: (message) => {
        output.push(message);
        if (message.startsWith('MCP session:')) {
          controller.abort();
        }
      },
    });

    expect(session).toMatchObject({
      daemonUrl: `http://127.0.0.1:${daemonPort}`,
      previewUrl: `http://127.0.0.1:${hostPort}`,
    });
    expect(session.studioUrl).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:${studioPort}/\\?token=[a-f0-9]{64}$`),
    );
    expect(output).toEqual([
      expect.stringContaining(`PatchLens Studio: http://127.0.0.1:${studioPort}/?token=`),
      `Preview: http://127.0.0.1:${hostPort}`,
      `Daemon: http://127.0.0.1:${daemonPort}`,
      expect.stringContaining('MCP session:'),
    ]);
    await expectPortsAvailable([hostPort, studioPort, daemonPort]);
  });

  it('reports an occupied Studio port before starting services', async () => {
    const root = await createProject();
    const [hostPort, studioPort, daemonPort] = await reservePorts(3);
    const occupied = createServer();
    await listen(occupied, studioPort);
    await writeConfig(root, {
      hostPort,
      studioPort,
      daemonPort,
      hostScript: createHttpServerScript(hostPort),
    });

    try {
      await expect(
        runDevelopment({ cwd: root, signal: AbortSignal.abort(), hostTimeoutMs: 1_000 }),
      ).rejects.toThrow(`Studio port ${studioPort} is already in use`);
    } finally {
      await close(occupied);
    }
  });

  it('terminates a host process after readiness timeout', async () => {
    const root = await createProject();
    const [hostPort, studioPort, daemonPort] = await reservePorts(3);
    const pidPath = join(root, 'host.pid');
    await writeConfig(root, {
      hostPort,
      studioPort,
      daemonPort,
      hostScript: `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);`,
    });

    await expect(
      runDevelopment({ cwd: root, hostTimeoutMs: 1_000, output: () => undefined }),
    ).rejects.toThrow('Host dev server did not become ready within 1000 ms');

    const pid = Number.parseInt(await readFile(pidPath, 'utf8'), 10);
    await expectProcessExit(pid);
    await expectPortsAvailable([studioPort, daemonPort]);
  });
});

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'patchlens-dev-test-'));
  temporaryRoots.push(root);
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'patchlens-dev-fixture', private: true, packageManager: 'pnpm@10.16.0' }, null, 2)}\n`,
  );
  return root;
}

async function writeConfig(
  root: string,
  options: { hostPort: number; studioPort: number; daemonPort: number; hostScript: string },
): Promise<void> {
  await writeFile(
    join(root, 'patchlens.config.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        projectRoot: '.',
        host: {
          start: true,
          command: process.execPath,
          args: ['-e', options.hostScript],
          url: `http://127.0.0.1:${options.hostPort}`,
        },
        studio: { port: options.studioPort },
        daemon: { port: options.daemonPort },
        provider: 'mock',
      },
      null,
      2,
    )}\n`,
  );
}

function createHttpServerScript(port: number): string {
  return `require('node:http').createServer((_request, response) => response.end('ready')).listen(${port}, '127.0.0.1');`;
}

async function reservePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  while (ports.length < count) {
    const server = createServer();
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      await close(server);
      throw new Error('Cannot reserve a loopback port');
    }
    ports.push(address.port);
    await close(server);
  }
  return ports;
}

function listen(server: ReturnType<typeof createServer>, port: number): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, '127.0.0.1', resolveListen);
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

async function expectPortsAvailable(ports: readonly number[]): Promise<void> {
  for (const port of ports) {
    const server = createServer();
    await listen(server, port);
    await close(server);
  }
}

async function expectProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
        return;
      }
      throw error;
    }
  }
  throw new Error(`Host process ${pid} did not exit`);
}
