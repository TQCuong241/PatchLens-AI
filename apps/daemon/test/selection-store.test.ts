import { describe, expect, it } from 'vitest';

import { PATCHLENS_PROTOCOL_VERSION } from '@patchlens-ai/agent-protocol';
import type { SelectionContext } from '@patchlens-ai/agent-protocol';

import { SelectionStore } from '../src/selection-store.js';

describe('SelectionStore', () => {
  it('does not let an older asynchronous write replace newer context', () => {
    const store = new SelectionStore();
    const newer = createContext('2026-08-10T10:00:02.000Z', '<button>New</button>');
    const older = createContext('2026-08-10T10:00:01.000Z', '<button>Old</button>');

    store.set('project-1', newer);
    const result = store.set('project-1', older);

    expect(result).toEqual(newer);
    expect(store.get('project-1')).toEqual(newer);
  });

  it('allows one capture to enrich context with the same timestamp', () => {
    const store = new SelectionStore();
    const base = createContext('2026-08-10T10:00:01.000Z', '<button>Start</button>');
    const enriched: SelectionContext = {
      ...base,
      screenshot: {
        path: '.patchlens/captures/capture-1.webp',
        mimeType: 'image/webp',
        width: 100,
        height: 40,
        byteLength: 1_024,
      },
    };

    store.set('project-1', base);
    store.set('project-1', enriched);

    expect(store.get('project-1')).toEqual(enriched);
  });
});

function createContext(capturedAt: string, sanitizedHtml: string): SelectionContext {
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
          sanitizedHtml,
          rectangle: { x: 0, y: 0, width: 100, height: 40 },
        },
      ],
      primaryElementId: 'element-1',
      sourceCandidates: [],
      confidence: 'visual-only',
      createdAt: capturedAt,
    },
    sanitizedHtml,
    computedStyles: {},
    relatedSourceFiles: [],
    consoleEntries: [],
    capturedAt,
  };
}
