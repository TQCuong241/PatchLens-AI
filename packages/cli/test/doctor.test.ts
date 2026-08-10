import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { serializeConfig } from '../src/config.js';
import { runDoctor } from '../src/doctor.js';

let root: string | undefined;

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = undefined;
  }
});

describe('patchlens doctor', () => {
  it('detects PatchLens markers leaked into production output', async () => {
    const projectRoot = await createDoctorProject();
    await mkdir(join(projectRoot, 'dist'));
    await writeFile(
      join(projectRoot, 'vite.config.ts'),
      'export default { plugins: [patchLensVitePlugin()] };\n',
    );
    await writeFile(
      join(projectRoot, 'src', 'main.tsx'),
      "if (import.meta.env.DEV) void import('@patchlens-ai/dev/runtime');\n",
    );
    await writeFile(join(projectRoot, 'dist', 'app.js'), 'console.log("clean");\n');

    const clean = await runDoctor({ cwd: projectRoot });
    expect(clean.checks.find((check) => check.id === 'production-leak')).toMatchObject({
      status: 'pass',
    });

    await writeFile(join(projectRoot, 'dist', 'app.js'), 'const value = "data-patchlens-id=";\n');
    const leaked = await runDoctor({ cwd: projectRoot });
    expect(leaked.ok).toBe(false);
    expect(leaked.checks.find((check) => check.id === 'production-leak')).toMatchObject({
      status: 'fail',
    });
  });

  it('accepts Next.js compiler and instrumentation-client integration', async () => {
    const projectRoot = await createDoctorProject();
    await mkdir(join(projectRoot, '.next'));
    await writeFile(
      join(projectRoot, 'next.config.mjs'),
      'export default withPatchLensNext({});\n',
    );
    await writeFile(
      join(projectRoot, 'instrumentation-client.ts'),
      "if (process.env.NODE_ENV === 'development') void import('@patchlens-ai/dev/runtime');\n",
    );
    await writeFile(join(projectRoot, '.next', 'app.js'), 'console.log("clean");\n');

    const result = await runDoctor({ cwd: projectRoot });

    expect(result.checks.find((check) => check.id === 'next-compiler')).toMatchObject({
      status: 'pass',
    });
    expect(result.checks.find((check) => check.id === 'runtime')).toMatchObject({
      status: 'pass',
    });
    expect(result.checks.find((check) => check.id === 'production-leak')).toMatchObject({
      status: 'pass',
    });
  });

  it('fails unsupported provider configuration', async () => {
    const projectRoot = await createDoctorProject('unknown-provider');
    await writeFile(
      join(projectRoot, 'vite.config.ts'),
      'export default { plugins: [patchLensVitePlugin()] };\n',
    );
    await writeFile(
      join(projectRoot, 'src', 'main.tsx'),
      "if (import.meta.env.DEV) void import('@patchlens-ai/dev/runtime');\n",
    );

    const result = await runDoctor({ cwd: projectRoot });

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'provider')).toMatchObject({
      status: 'fail',
      message: 'Unsupported provider: unknown-provider',
    });
  });
});

async function createDoctorProject(provider = 'mock'): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-cli-doctor-'));
  root = projectRoot;
  await mkdir(join(projectRoot, 'src'));
  const ports = await freePorts(3);
  await writeFile(
    join(projectRoot, 'patchlens.config.json'),
    serializeConfig({
      schemaVersion: 1,
      projectRoot: '.',
      host: {
        start: true,
        command: process.execPath,
        args: [],
        url: `http://127.0.0.1:${ports[0]}`,
      },
      studio: { port: ports[1]! },
      daemon: { port: ports[2]! },
      provider,
    }),
  );
  return projectRoot;
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        rejectPort(new Error('Cannot allocate test port'));
        return;
      }
      server.close((error) => {
        if (error) {
          rejectPort(error);
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

async function freePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  while (ports.length < count) {
    const port = await freePort();
    if (!ports.includes(port)) {
      ports.push(port);
    }
  }
  return ports;
}
