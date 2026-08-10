import { describe, expect, it } from 'vitest';

import { PATCHLENS_PROTOCOL_VERSION } from '@patchlens-ai/agent-protocol';
import type { ConsoleEntry, VisualSelection } from '@patchlens-ai/agent-protocol';

import { VisualVerifier, comparePerceptualHashes, findNewConsoleEntries } from '../src/verifier.js';
import type { PreviewProbe, PreviewSnapshot } from '../src/verifier.js';

describe('VisualVerifier', () => {
  it('passes when route, component, console, and screenshot stay healthy', async () => {
    const probe = new QueueProbe([
      snapshot({ screenshotPath: 'before.png' }),
      snapshot({ screenshotPath: 'after.png' }),
    ]);
    const verifier = new VisualVerifier({ probe });
    const selection = createSelection();
    const baseline = await verifier.captureBaseline({
      route: '/',
      selection,
      captureAfterChange: true,
    });

    const result = await verifier.verifyAfter(baseline, {
      route: '/',
      selection,
      captureAfterChange: true,
      commands: [],
    });

    expect(result).toMatchObject({
      ok: true,
      routeRendered: true,
      selectionPresent: true,
      beforeScreenshot: { path: 'before.png' },
      afterScreenshot: { path: 'after.png' },
    });
  });

  it('fails for a missing component and new runtime error', async () => {
    const initialError = consoleEntry('error', 'existing error', '2026-08-09T10:00:00Z');
    const probe = new QueueProbe([
      snapshot({ consoleEntries: [initialError] }),
      snapshot({
        selectionPresent: false,
        consoleEntries: [initialError, consoleEntry('error', 'new crash', '2026-08-09T10:01:00Z')],
      }),
    ]);
    const verifier = new VisualVerifier({ probe });
    const selection = createSelection();
    const baseline = await verifier.captureBaseline({
      route: '/',
      selection,
      captureAfterChange: false,
    });

    const result = await verifier.verifyAfter(baseline, {
      route: '/',
      selection,
      captureAfterChange: false,
      commands: [],
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('selected component is missing');
    expect(result.summary).toContain('1 new console issue');
    expect(result.newConsoleEntries).toHaveLength(1);
  });

  it('rejects a baseline from another selection', async () => {
    const verifier = new VisualVerifier({ probe: new QueueProbe([snapshot({})]) });
    const selection = createSelection();

    await expect(
      verifier.verifyAfter(
        { selectionId: 'selection-other', route: '/', snapshot: snapshot({}) },
        {
          route: '/',
          selection,
          captureAfterChange: false,
          commands: [],
        },
      ),
    ).rejects.toThrow('does not match');
  });

  it('fails when requested before screenshot evidence is unavailable', async () => {
    const probe = new QueueProbe([snapshot({}), snapshot({ screenshotPath: 'after.png' })]);
    const verifier = new VisualVerifier({ probe });
    const selection = createSelection();
    const baseline = await verifier.captureBaseline({
      route: '/',
      selection,
      captureAfterChange: true,
    });

    const result = await verifier.verifyAfter(baseline, {
      route: '/',
      selection,
      captureAfterChange: true,
      commands: [],
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('before screenshot is missing');
  });
});

describe('findNewConsoleEntries', () => {
  it('uses occurrence counts and ignores timestamps', () => {
    const before = [consoleEntry('warning', 'duplicate', '2026-08-09T10:00:00Z')];
    const after = [
      consoleEntry('warning', 'duplicate', '2026-08-09T10:01:00Z'),
      consoleEntry('warning', 'duplicate', '2026-08-09T10:02:00Z'),
    ];

    expect(findNewConsoleEntries(before, after)).toEqual([after[1]]);
  });
});

describe('comparePerceptualHashes', () => {
  it('reports Hamming distance and similarity', () => {
    expect(comparePerceptualHashes('0000000000000000', '000000000000000f')).toEqual({
      hammingDistance: 4,
      similarity: 0.9375,
      changed: true,
    });
  });

  it('allows verifier thresholds for large visual drift', async () => {
    const probe = new QueueProbe([
      snapshot({ screenshotPath: 'before.png', perceptualHash: '0000000000000000' }),
      snapshot({ screenshotPath: 'after.png', perceptualHash: 'ffffffffffffffff' }),
    ]);
    const verifier = new VisualVerifier({
      probe,
      minimumVisualSimilarity: 0.9,
    });
    const selection = createSelection();
    const baseline = await verifier.captureBaseline({
      route: '/',
      selection,
      captureAfterChange: true,
    });

    const result = await verifier.verifyAfter(baseline, {
      route: '/',
      selection,
      captureAfterChange: true,
      commands: [],
    });

    expect(result.ok).toBe(false);
    expect(result.visualComparison).toMatchObject({
      hammingDistance: 64,
      similarity: 0,
    });
    expect(result.summary).toContain('visual similarity');
  });
});

class QueueProbe implements PreviewProbe {
  readonly #snapshots: PreviewSnapshot[];

  constructor(snapshots: PreviewSnapshot[]) {
    this.#snapshots = [...snapshots];
  }

  async capture(): Promise<PreviewSnapshot> {
    const snapshot = this.#snapshots.shift();
    if (!snapshot) {
      throw new Error('No queued preview snapshot');
    }
    return structuredClone(snapshot);
  }
}

function snapshot(options: {
  routeRendered?: boolean;
  selectionPresent?: boolean;
  screenshotPath?: string;
  perceptualHash?: string;
  consoleEntries?: ConsoleEntry[];
}): PreviewSnapshot {
  return {
    capturedAt: '2026-08-09T10:00:00Z',
    route: '/',
    routeRendered: options.routeRendered ?? true,
    selectionPresent: options.selectionPresent ?? true,
    screenshot: options.screenshotPath
      ? {
          path: options.screenshotPath,
          mimeType: 'image/png',
          width: 100,
          height: 50,
          byteLength: 500,
          ...(options.perceptualHash ? { perceptualHash: options.perceptualHash } : {}),
        }
      : undefined,
    consoleEntries: options.consoleEntries ?? [],
  };
}

function consoleEntry(
  level: 'warning' | 'error',
  message: string,
  createdAt: string,
): ConsoleEntry {
  return { level, message, createdAt };
}

function createSelection(): VisualSelection {
  return {
    schemaVersion: PATCHLENS_PROTOCOL_VERSION,
    id: 'selection-1',
    projectId: 'project-1',
    route: '/',
    viewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
    rectangle: { x: 10, y: 10, width: 100, height: 50 },
    elements: [
      {
        id: 'element-1',
        patchlensId: 'pl_component',
        tagName: 'button',
        text: 'Start',
        sanitizedHtml: '<button>Start</button>',
        rectangle: { x: 10, y: 10, width: 100, height: 50 },
      },
    ],
    primaryElementId: 'element-1',
    sourceCandidates: [],
    confidence: 'exact',
    createdAt: '2026-08-09T10:00:00Z',
  };
}
