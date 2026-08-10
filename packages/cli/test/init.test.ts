import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { initializeProject } from '../src/init.js';

let projectRoot: string | undefined;

afterEach(async () => {
  if (projectRoot) {
    await rm(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  }
});

describe('patchlens init', () => {
  it('adds guarded integration, config, script, and backups idempotently', async () => {
    projectRoot = await createViteProject();

    const first = await initializeProject({ cwd: projectRoot });
    const second = await initializeProject({ cwd: projectRoot });

    expect(first.modifiedFiles).toHaveLength(5);
    expect(first.backupFiles).toHaveLength(3);
    expect(second.modifiedFiles).toHaveLength(0);
    expect(second.backupFiles).toHaveLength(0);
    await expect(readFile(join(projectRoot, 'vite.config.ts'), 'utf8')).resolves.toContain(
      'patchLensVitePlugin()',
    );
    const entry = await readFile(join(projectRoot, 'src', 'main.tsx'), 'utf8');
    expect(entry).toContain('if (import.meta.env.DEV)');
    expect(entry).toContain("import('@patchlens-ai/dev/runtime')");
    const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts.patchlens).toBe('patchlens dev');
    const config = JSON.parse(
      await readFile(join(projectRoot, 'patchlens.config.json'), 'utf8'),
    ) as { host: { command: string; url: string } };
    expect(config.host).toMatchObject({
      command: 'corepack',
      url: 'http://127.0.0.1:4311',
    });
    await expect(stat(join(projectRoot, 'vite.config.ts.patchlens.bak'))).resolves.toBeDefined();
    await expect(readFile(join(projectRoot, '.gitignore'), 'utf8')).resolves.toBe('.patchlens/\n');
  });

  it('does not write partial setup for unsupported Vite config shape', async () => {
    projectRoot = await createViteProject();
    const vitePath = join(projectRoot, 'vite.config.ts');
    await writeFile(vitePath, 'export default { server: { port: 5173 } };\n');
    const packageBefore = await readFile(join(projectRoot, 'package.json'), 'utf8');

    await expect(initializeProject({ cwd: projectRoot })).rejects.toThrow('literal plugins array');

    await expect(readFile(join(projectRoot, 'package.json'), 'utf8')).resolves.toBe(packageBefore);
    await expect(stat(`${vitePath}.patchlens.bak`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

async function createViteProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'patchlens-cli-init-'));
  await mkdir(join(root, 'src'));
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify(
      {
        name: 'vite-demo',
        packageManager: 'pnpm@10.16.0',
        scripts: { dev: 'vite' },
        devDependencies: { vite: '^8.0.0' },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(root, 'vite.config.ts'),
    "import { defineConfig } from 'vite';\nexport default defineConfig({ plugins: [] });\n",
  );
  await writeFile(join(root, 'src', 'main.tsx'), "console.log('app');\n");
  return root;
}
