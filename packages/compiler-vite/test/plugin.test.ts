import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'vite';

import { patchLensVitePlugin } from '../src/index.js';

let root: string | undefined;

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = undefined;
  }
});

describe('patchLensVitePlugin', () => {
  it('does not leak compiler metadata into a production build', async () => {
    root = await mkdtemp(join(tmpdir(), 'patchlens-vite-production-'));
    await mkdir(join(root, 'src'));
    await writeFile(
      join(root, 'index.html'),
      '<!doctype html><html><body><div id=root></div><script type=module src=/src/main.jsx></script></body></html>',
    );
    await writeFile(
      join(root, 'src', 'main.jsx'),
      'function createElement(type, props, ...children) { return { type, props, children }; }\nconst fixture = <button>Start</button>;\nwindow.__patchLensFixture = fixture;\n',
    );

    expect(patchLensVitePlugin().apply).toBe('serve');

    await build({
      root,
      logLevel: 'silent',
      esbuild: { jsx: 'transform', jsxFactory: 'createElement' },
      plugins: [patchLensVitePlugin()],
    });

    const assetDirectory = join(root, 'dist', 'assets');
    const output = (
      await Promise.all(
        (await readdir(assetDirectory))
          .filter((file) => file.endsWith('.js'))
          .map((file) => readFile(join(assetDirectory, file), 'utf8')),
      )
    ).join('\n');
    expect(output).not.toContain('data-patchlens-id');
    expect(output).not.toContain('data-patchlens-source');
  });
});
