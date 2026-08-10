import { PATCHLENS_PROTOCOL_LIMITS } from '@patchlens-ai/agent-protocol';
import type { InlineScreenshot, Rectangle } from '@patchlens-ai/agent-protocol';
import { toCanvas } from 'html-to-image';

const maximumEdge = 1_600;
const maximumPixels = 2_000_000;

export async function captureSelectionScreenshot(
  elements: readonly Element[],
  rectangle: Rectangle,
): Promise<InlineScreenshot | undefined> {
  if (elements.length === 0 || rectangle.width <= 0 || rectangle.height <= 0) {
    return undefined;
  }

  const scale = Math.min(
    1,
    maximumEdge / rectangle.width,
    maximumEdge / rectangle.height,
    Math.sqrt(maximumPixels / (rectangle.width * rectangle.height)),
  );
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(rectangle.width * scale));
  canvas.height = Math.max(1, Math.ceil(rectangle.height * scale));
  const context = canvas.getContext('2d');
  if (!context) {
    return undefined;
  }

  let capturedElements = 0;
  for (const element of elements) {
    const elementRectangle = element.getBoundingClientRect();
    if (elementRectangle.width <= 0 || elementRectangle.height <= 0) {
      continue;
    }
    try {
      const elementCanvas = await toCanvas(element as HTMLElement, {
        pixelRatio: 1,
        cacheBust: true,
        filter: (node) =>
          !(node instanceof HTMLElement && node.dataset.patchlensOverlay === 'true'),
      });
      context.drawImage(
        elementCanvas,
        Math.round((elementRectangle.x - rectangle.x) * scale),
        Math.round((elementRectangle.y - rectangle.y) * scale),
        Math.max(1, Math.round(elementRectangle.width * scale)),
        Math.max(1, Math.round(elementRectangle.height * scale)),
      );
      capturedElements += 1;
    } catch {
      continue;
    }
  }

  return capturedElements > 0 ? encodeWithinBudget(canvas) : undefined;
}

function encodeWithinBudget(sourceCanvas: HTMLCanvasElement): InlineScreenshot | undefined {
  let canvas = sourceCanvas;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const dataUrl = canvas.toDataURL('image/webp', 0.82);
    const mimeType = dataUrl.startsWith('data:image/webp;') ? 'image/webp' : 'image/png';
    const byteLength = dataUrlByteLength(dataUrl);
    if (byteLength <= PATCHLENS_PROTOCOL_LIMITS.screenshotBytes) {
      const perceptualHash = createPerceptualHash(canvas);
      return {
        dataUrl,
        mimeType,
        width: canvas.width,
        height: canvas.height,
        byteLength,
        ...(perceptualHash ? { perceptualHash } : {}),
      };
    }

    const scaled = document.createElement('canvas');
    scaled.width = Math.max(1, Math.floor(canvas.width * 0.7));
    scaled.height = Math.max(1, Math.floor(canvas.height * 0.7));
    const context = scaled.getContext('2d');
    if (!context) {
      return undefined;
    }
    context.drawImage(canvas, 0, 0, scaled.width, scaled.height);
    canvas = scaled;
  }
  return undefined;
}

function createPerceptualHash(canvas: HTMLCanvasElement): string | undefined {
  const sample = document.createElement('canvas');
  sample.width = 9;
  sample.height = 8;
  const context = sample.getContext('2d', { willReadFrequently: true });
  if (!context) {
    return undefined;
  }
  try {
    context.drawImage(canvas, 0, 0, sample.width, sample.height);
    const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
    let hash = 0n;
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        const left = pixelLuminance(pixels, y * 9 + x);
        const right = pixelLuminance(pixels, y * 9 + x + 1);
        hash = (hash << 1n) | (left > right ? 1n : 0n);
      }
    }
    return hash.toString(16).padStart(16, '0');
  } catch {
    return undefined;
  }
}

function pixelLuminance(pixels: Uint8ClampedArray, index: number): number {
  const offset = index * 4;
  return (
    (pixels[offset] ?? 0) * 0.299 +
    (pixels[offset + 1] ?? 0) * 0.587 +
    (pixels[offset + 2] ?? 0) * 0.114
  );
}

function dataUrlByteLength(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}
