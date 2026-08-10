import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ProjectCaptureStore } from '../src/capture-store.js';

let projectRoot: string | undefined;

afterEach(async () => {
  if (projectRoot) {
    await rm(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  }
});

describe('ProjectCaptureStore', () => {
  it('writes validated image evidence inside project root', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-capture-'));
    const store = await ProjectCaptureStore.create(projectRoot);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

    const reference = await store.save('selection-1', {
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      mimeType: 'image/png',
      width: 10,
      height: 10,
      byteLength: png.byteLength,
      perceptualHash: '0000000000000000',
    });
    await store.save('selection-1', {
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      mimeType: 'image/png',
      width: 10,
      height: 10,
      byteLength: png.byteLength,
      perceptualHash: '0000000000000001',
    });

    expect(reference.path).toMatch(/^\.patchlens\/captures\/selection-1-/);
    expect(reference.perceptualHash).toBe('0000000000000000');
    await expect(readFile(resolve(projectRoot, reference.path))).resolves.toEqual(png);
    await expect(store.read(reference.path)).resolves.toMatchObject({
      content: png,
      mimeType: 'image/png',
    });
  });

  it('rejects a MIME type that does not match image bytes', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-capture-'));
    const store = await ProjectCaptureStore.create(projectRoot);
    const content = Buffer.from('not an image');

    await expect(
      store.save('selection-1', {
        dataUrl: `data:image/png;base64,${content.toString('base64')}`,
        mimeType: 'image/png',
        width: 10,
        height: 10,
        byteLength: content.byteLength,
      }),
    ).rejects.toThrow('declared MIME type');
  });

  it('rejects capture paths that were not issued by the store', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-capture-'));
    const store = await ProjectCaptureStore.create(projectRoot);

    await expect(store.read('../secret.txt')).rejects.toThrow('Unknown capture');
  });
});
