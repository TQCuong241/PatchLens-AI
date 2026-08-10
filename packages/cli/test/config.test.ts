import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDefaultConfig, discoverConfig, loadConfig, serializeConfig } from '../src/config.js';

let root: string | undefined;

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = undefined;
  }
});

describe('PatchLens config', () => {
  it('discovers config from a nested project directory', async () => {
    root = await mkdtemp(join(tmpdir(), 'patchlens-cli-config-'));
    const nested = join(root, 'src', 'components');
    await mkdir(nested, { recursive: true });
    const configPath = join(root, 'patchlens.config.json');
    await writeFile(configPath, serializeConfig(createDefaultConfig('npm')));

    await expect(discoverConfig(nested)).resolves.toBe(configPath);
    await expect(loadConfig(configPath)).resolves.toMatchObject({
      resolvedProjectRoot: root,
    });
  });

  it.each([
    'https://example.com',
    'http://user:pass@127.0.0.1:4311',
    'http://127.0.0.1:4311/preview',
    'http://127.0.0.1:4311?token=secret',
    'http://127.0.0.1:4311/#preview',
  ])('rejects unsafe host URL %s', async (hostUrl) => {
    root = await mkdtemp(join(tmpdir(), 'patchlens-cli-config-'));
    const config = createDefaultConfig('npm');
    config.host.url = hostUrl;
    const configPath = join(root, 'patchlens.config.json');
    await writeFile(configPath, serializeConfig(config));

    await expect(loadConfig(configPath)).rejects.toThrow('host config is invalid');
  });
});
