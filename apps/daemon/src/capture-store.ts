import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { isInlineScreenshot } from '@patchlens-ai/agent-protocol';
import type { InlineScreenshot, ScreenshotReference } from '@patchlens-ai/agent-protocol';

export class UnknownCaptureError extends Error {
  constructor(path: string) {
    super(`Unknown capture: ${path}`);
    this.name = 'UnknownCaptureError';
  }
}

export type StoredCapture = {
  content: Buffer;
  mimeType: ScreenshotReference['mimeType'];
};

export class ProjectCaptureStore {
  readonly #projectRoot: string;
  readonly #capturePathsBySelection = new Map<string, string[]>();
  readonly #knownCaptures = new Map<string, ScreenshotReference['mimeType']>();
  readonly #captureOrder: string[] = [];

  private constructor(projectRoot: string) {
    this.#projectRoot = projectRoot;
  }

  static async create(projectRoot: string): Promise<ProjectCaptureStore> {
    return new ProjectCaptureStore(await realpath(resolve(projectRoot)));
  }

  async save(selectionId: string, screenshot: InlineScreenshot): Promise<ScreenshotReference> {
    if (!isInlineScreenshot(screenshot)) {
      throw new Error('Inline screenshot payload is invalid');
    }
    const content = decodeScreenshot(screenshot);
    const extension = extensionForMimeType(screenshot.mimeType);
    const safeSelectionId = selectionId.replace(/[^A-Za-z0-9._-]/g, '_');
    const relativePath = `.patchlens/captures/${safeSelectionId}-${randomUUID()}.${extension}`;
    const path = resolve(this.#projectRoot, relativePath);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, content, { flag: 'wx', mode: 0o600 });
      await rename(temporaryPath, path);
      await chmod(path, 0o600);
    } finally {
      await rm(temporaryPath, { force: true });
    }

    const history = this.#capturePathsBySelection.get(selectionId) ?? [];
    history.push(relativePath);
    this.#capturePathsBySelection.set(selectionId, history);
    this.#knownCaptures.set(relativePath, screenshot.mimeType);
    this.#captureOrder.push(relativePath);
    while (history.length > 8) {
      await this.#removeCapture(history.shift()!);
    }
    while (this.#captureOrder.length > 256) {
      await this.#removeCapture(this.#captureOrder.shift()!);
    }
    return {
      path: relativePath,
      mimeType: screenshot.mimeType,
      width: screenshot.width,
      height: screenshot.height,
      byteLength: content.byteLength,
      ...(screenshot.perceptualHash ? { perceptualHash: screenshot.perceptualHash } : {}),
    };
  }

  async read(relativePath: string): Promise<StoredCapture> {
    const mimeType = this.#knownCaptures.get(relativePath);
    if (!mimeType) {
      throw new UnknownCaptureError(relativePath);
    }
    try {
      return {
        content: await readFile(resolve(this.#projectRoot, relativePath)),
        mimeType,
      };
    } catch {
      this.#knownCaptures.delete(relativePath);
      throw new UnknownCaptureError(relativePath);
    }
  }

  async #removeCapture(relativePath: string): Promise<void> {
    if (!this.#knownCaptures.delete(relativePath)) {
      return;
    }
    await rm(resolve(this.#projectRoot, relativePath), { force: true });
  }
}

function decodeScreenshot(screenshot: InlineScreenshot): Buffer {
  const prefix = `data:${screenshot.mimeType};base64,`;
  if (!screenshot.dataUrl.startsWith(prefix)) {
    throw new Error('Screenshot data URL MIME type does not match payload');
  }
  const encoded = screenshot.dataUrl.slice(prefix.length);
  if (
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    throw new Error('Screenshot data URL contains invalid base64');
  }
  const content = Buffer.from(encoded, 'base64');
  if (content.byteLength !== screenshot.byteLength) {
    throw new Error('Screenshot byte length does not match payload');
  }
  if (!matchesImageSignature(content, screenshot.mimeType)) {
    throw new Error('Screenshot content does not match declared MIME type');
  }
  return content;
}

function matchesImageSignature(content: Buffer, mimeType: InlineScreenshot['mimeType']): boolean {
  if (mimeType === 'image/png') {
    return content
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimeType === 'image/jpeg') {
    return (
      content[0] === 0xff &&
      content[1] === 0xd8 &&
      content.at(-2) === 0xff &&
      content.at(-1) === 0xd9
    );
  }
  return (
    content.subarray(0, 4).toString('ascii') === 'RIFF' &&
    content.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}

function extensionForMimeType(mimeType: InlineScreenshot['mimeType']): string {
  if (mimeType === 'image/png') {
    return 'png';
  }
  if (mimeType === 'image/jpeg') {
    return 'jpg';
  }
  return 'webp';
}
