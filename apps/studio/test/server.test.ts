import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createStudioServer } from '../server/index.js';
import type { StudioServer } from '../server/index.js';

let assetsRoot: string | undefined;
let studio: StudioServer | undefined;

afterEach(async () => {
  await studio?.stop();
  studio = undefined;
  if (assetsRoot) {
    await rm(assetsRoot, { recursive: true, force: true });
    assetsRoot = undefined;
  }
});

describe('Studio static server', () => {
  it('requires token login and injects runtime config', async () => {
    assetsRoot = await createAssets();
    studio = createStudioServer({
      accessToken: 'studio-token',
      daemonUrl: 'http://127.0.0.1:4312',
      daemonToken: 'daemon-token',
      projectRoot: assetsRoot,
      previewUrl: 'http://127.0.0.1:4311',
      provider: 'mock',
      projectId: 'project-1',
      assetsRoot,
      port: 0,
    });
    const address = await studio.start();
    const baseUrl = `http://${address.address}:${address.port}`;

    const denied = await fetch(baseUrl, { redirect: 'manual' });
    const login = await fetch(`${baseUrl}/?token=studio-token`, {
      redirect: 'manual',
    });
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    const page = await fetch(baseUrl, {
      headers: { Accept: 'text/html', Cookie: cookie ?? '' },
    });
    const dottedAsset = await fetch(`${baseUrl}/..name/app.js`, {
      headers: { Cookie: cookie ?? '' },
    });
    const html = await page.text();

    expect(denied.status).toBe(401);
    expect(denied.headers.get('cache-control')).toBe('no-store');
    expect(login.status).toBe(302);
    expect(login.headers.get('cache-control')).toBe('no-store');
    expect(login.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.status).toBe(200);
    expect(dottedAsset.status).toBe(200);
    await expect(dottedAsset.text()).resolves.toContain('dotted asset');
    expect(html).toContain('"daemonToken":"daemon-token"');
    expect(html).toContain('"provider":"mock"');
    expect(html).not.toContain('{"mode":"development"}');
  });

  it('rejects invalid cookies and missing assets', async () => {
    assetsRoot = await createAssets();
    studio = createStudioServer({
      accessToken: 'studio-token',
      daemonUrl: 'http://127.0.0.1:4312',
      daemonToken: 'daemon-token',
      projectRoot: assetsRoot,
      previewUrl: 'http://127.0.0.1:4311',
      provider: 'mock',
      projectId: 'project-1',
      assetsRoot,
      port: 0,
    });
    const address = await studio.start();
    const baseUrl = `http://${address.address}:${address.port}`;

    const invalid = await fetch(baseUrl, {
      headers: { Cookie: 'patchlens_studio=wrong' },
    });
    const missing = await fetch(`${baseUrl}/assets/missing.js`, {
      headers: { Cookie: 'patchlens_studio=studio-token' },
    });

    expect(invalid.status).toBe(401);
    expect(missing.status).toBe(404);
  });
});

async function createAssets(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'patchlens-studio-assets-'));
  await mkdir(join(root, 'assets'));
  await mkdir(join(root, '..name'));
  const runtimeConfig = JSON.stringify({ mode: 'development' });
  await writeFile(
    join(root, 'index.html'),
    `<script id='patchlens-runtime-config' type='application/json'>${runtimeConfig}</script><main>Studio</main>`,
  );
  await writeFile(join(root, 'assets', 'app.js'), 'console.log("Studio");\n');
  await writeFile(join(root, '..name', 'app.js'), 'console.log("dotted asset");\n');
  return root;
}
