import { describe, expect, it } from 'vitest';

import { PATCHLENS_PROTOCOL_VERSION } from '@patchlens-ai/agent-protocol';
import type { SelectionContext } from '@patchlens-ai/agent-protocol';

import { SelectionStoreProbe } from '../src/selection-probe.js';
import { SelectionStore } from '../src/selection-store.js';

describe('SelectionStoreProbe', () => {
  it('waits for a new screenshot path after change', async () => {
    const store = new SelectionStore();
    const baseline = createContext('before.webp');
    store.set('project-1', baseline);
    const probe = new SelectionStoreProbe({
      store,
      projectId: 'project-1',
      baseline,
      refreshTimeoutMs: 500,
      pollIntervalMs: 5,
    });

    await probe.capture({
      route: '/',
      selection: baseline.selection,
      captureScreenshot: true,
    });
    setTimeout(() => store.set('project-1', createContext('after.webp')), 10);
    const after = await probe.capture({
      route: '/',
      selection: baseline.selection,
      captureScreenshot: true,
    });

    expect(after.screenshot?.path).toBe('after.webp');
    expect(after.selectionPresent).toBe(true);
  });

  it('withholds stale screenshot after timeout', async () => {
    const store = new SelectionStore();
    const baseline = createContext('before.webp');
    store.set('project-1', baseline);
    const probe = new SelectionStoreProbe({
      store,
      projectId: 'project-1',
      baseline,
      refreshTimeoutMs: 1,
      pollIntervalMs: 1,
    });
    await probe.capture({
      route: '/',
      selection: baseline.selection,
      captureScreenshot: true,
    });

    const after = await probe.capture({
      route: '/',
      selection: baseline.selection,
      captureScreenshot: true,
    });

    expect(after.selectionPresent).toBe(true);
    expect(after.screenshot).toBeUndefined();
  });

  it('waits for refreshed context without exposing screenshots when capture is disabled', async () => {
    const store = new SelectionStore();
    const baseline = createContext('before.webp');
    store.set('project-1', baseline);
    const probe = new SelectionStoreProbe({
      store,
      projectId: 'project-1',
      baseline,
      refreshTimeoutMs: 500,
      pollIntervalMs: 5,
    });

    const before = await probe.capture({
      route: '/',
      selection: baseline.selection,
      captureScreenshot: false,
    });
    const refreshed = createContext('after.webp');
    refreshed.capturedAt = new Date(Date.parse(baseline.capturedAt) + 1_000).toISOString();
    setTimeout(() => store.set('project-1', refreshed), 10);
    const after = await probe.capture({
      route: '/',
      selection: baseline.selection,
      captureScreenshot: false,
    });

    expect(before.screenshot).toBeUndefined();
    expect(after.capturedAt).toBe(refreshed.capturedAt);
    expect(after.screenshot).toBeUndefined();
  });

  it('detects a cleared selection when screenshot capture is disabled', async () => {
    const store = new SelectionStore();
    const baseline = createContext('before.webp');
    store.set('project-1', baseline);
    const probe = new SelectionStoreProbe({
      store,
      projectId: 'project-1',
      baseline,
      refreshTimeoutMs: 500,
      pollIntervalMs: 5,
    });
    await probe.capture({
      route: '/',
      selection: baseline.selection,
      captureScreenshot: false,
    });

    setTimeout(() => store.clear('project-1'), 10);
    const after = await probe.capture({
      route: '/',
      selection: baseline.selection,
      captureScreenshot: false,
    });

    expect(after.routeRendered).toBe(false);
    expect(after.selectionPresent).toBe(false);
    expect(after.screenshot).toBeUndefined();
  });
});

function createContext(path: string): SelectionContext {
  const capturedAt = new Date().toISOString();
  return {
    schemaVersion: PATCHLENS_PROTOCOL_VERSION,
    selection: {
      schemaVersion: PATCHLENS_PROTOCOL_VERSION,
      id: 'selection-1',
      projectId: 'project-1',
      route: '/',
      viewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
      rectangle: { x: 0, y: 0, width: 100, height: 40 },
      elements: [
        {
          id: 'element-1',
          tagName: 'button',
          text: 'Start',
          sanitizedHtml: '<button>Start</button>',
          rectangle: { x: 0, y: 0, width: 100, height: 40 },
        },
      ],
      primaryElementId: 'element-1',
      sourceCandidates: [],
      confidence: 'visual-only',
      createdAt: capturedAt,
    },
    screenshot: {
      path,
      mimeType: 'image/webp',
      width: 100,
      height: 40,
      byteLength: 100,
    },
    sanitizedHtml: '<button>Start</button>',
    computedStyles: {},
    relatedSourceFiles: [],
    consoleEntries: [],
    capturedAt,
  };
}
