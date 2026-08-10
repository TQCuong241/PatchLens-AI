import { describe, expect, it } from 'vitest';

import {
  PATCHLENS_MESSAGE_SOURCE,
  PATCHLENS_PROTOCOL_LIMITS,
  PATCHLENS_PROTOCOL_VERSION,
  isInspectorMessage,
  isStudioMessage,
  isVisualSelection,
  parseAgentEvent,
  parseAgentRequest,
  parseDaemonHealth,
  parseInspectorMessage,
} from '../src/index.js';
import type { AgentRequest, SelectionContext, VisualSelection } from '../src/index.js';

const createdAt = '2026-08-09T12:00:00.000Z';

function createSelection(): VisualSelection {
  return {
    schemaVersion: PATCHLENS_PROTOCOL_VERSION,
    id: 'selection-1',
    projectId: 'project-1',
    route: '/pricing',
    viewport: {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
    },
    rectangle: {
      x: 100,
      y: 200,
      width: 240,
      height: 80,
    },
    elements: [
      {
        id: 'element-1',
        patchlensId: 'pl_abc123',
        tagName: 'button',
        text: 'Start now',
        sanitizedHtml: '<button>Start now</button>',
        rectangle: {
          x: 100,
          y: 200,
          width: 240,
          height: 80,
        },
        source: {
          id: 'pl_abc123',
          framework: 'react',
          componentName: 'PricingCta',
          file: 'src/components/PricingCta.tsx',
          line: 42,
          column: 8,
          tagName: 'button',
        },
      },
    ],
    primaryElementId: 'element-1',
    sourceCandidates: [
      {
        location: {
          id: 'pl_abc123',
          framework: 'react',
          componentName: 'PricingCta',
          file: 'src/components/PricingCta.tsx',
          line: 42,
          column: 8,
          tagName: 'button',
        },
        confidence: 1,
      },
    ],
    confidence: 'exact',
    createdAt,
  };
}

function createContext(): SelectionContext {
  return {
    schemaVersion: PATCHLENS_PROTOCOL_VERSION,
    selection: createSelection(),
    sanitizedHtml: '<button>Start now</button>',
    computedStyles: {
      color: 'rgb(255, 255, 255)',
      backgroundColor: 'rgb(232, 93, 42)',
    },
    relatedSourceFiles: [
      {
        path: 'src/components/PricingCta.tsx',
        startLine: 35,
        endLine: 50,
      },
    ],
    consoleEntries: [],
    capturedAt: createdAt,
  };
}

function createAgentRequest(): AgentRequest {
  return {
    schemaVersion: PATCHLENS_PROTOCOL_VERSION,
    requestId: 'request-1',
    projectId: 'project-1',
    selectionId: 'selection-1',
    provider: 'mock',
    instruction: 'Make the selected button more prominent.',
    context: createContext(),
    scopePolicy: 'prefer-selection',
    verification: {
      route: '/pricing',
      captureAfterChange: true,
      commands: ['test'],
    },
    createdAt,
  };
}

describe('Inspector message validation', () => {
  it('accepts a valid ready message', () => {
    const result = parseInspectorMessage({
      source: PATCHLENS_MESSAGE_SOURCE,
      schemaVersion: PATCHLENS_PROTOCOL_VERSION,
      messageId: 'message-1',
      channelId: 'channel-1',
      projectId: 'project-1',
      type: 'inspector:ready',
      payload: {
        route: '/pricing',
        viewport: {
          width: 1440,
          height: 900,
          deviceScaleFactor: 1,
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects an unknown Inspector type', () => {
    expect(
      isInspectorMessage({
        source: PATCHLENS_MESSAGE_SOURCE,
        schemaVersion: PATCHLENS_PROTOCOL_VERSION,
        messageId: 'message-2',
        channelId: 'channel-1',
        projectId: 'project-1',
        type: 'inspector:unknown',
        payload: {},
      }),
    ).toBe(false);
  });

  it('rejects a ready message with an invalid payload', () => {
    expect(
      isInspectorMessage({
        source: PATCHLENS_MESSAGE_SOURCE,
        schemaVersion: PATCHLENS_PROTOCOL_VERSION,
        messageId: 'message-3',
        channelId: 'channel-1',
        projectId: 'project-1',
        type: 'inspector:ready',
        payload: { route: '/pricing' },
      }),
    ).toBe(false);
  });

  it('rejects an unsupported schema version', () => {
    expect(
      isInspectorMessage({
        source: PATCHLENS_MESSAGE_SOURCE,
        schemaVersion: 2,
        messageId: 'message-4',
        channelId: 'channel-1',
        projectId: 'project-1',
        type: 'inspector:ready',
        payload: {
          route: '/pricing',
          viewport: {
            width: 1440,
            height: 900,
            deviceScaleFactor: 1,
          },
        },
      }),
    ).toBe(false);
  });

  it('rejects a selection from another project', () => {
    expect(
      isInspectorMessage({
        source: PATCHLENS_MESSAGE_SOURCE,
        schemaVersion: PATCHLENS_PROTOCOL_VERSION,
        messageId: 'message-5',
        channelId: 'channel-1',
        projectId: 'project-2',
        type: 'inspector:selection',
        payload: createSelection(),
      }),
    ).toBe(false);
  });

  it('accepts Next render boundaries and rejects unknown values', () => {
    const selection = createSelection();
    selection.sourceCandidates[0]!.location.framework = 'next';
    selection.sourceCandidates[0]!.location.renderBoundary = 'server';
    expect(isVisualSelection(selection)).toBe(true);

    const invalid = structuredClone(selection) as unknown as {
      sourceCandidates: Array<{ location: { renderBoundary: string } }>;
    };
    invalid.sourceCandidates[0]!.location.renderBoundary = 'edge-only';
    expect(isVisualSelection(invalid)).toBe(false);
  });

  it('rejects malformed screenshot perceptual hashes', () => {
    const selection = createSelection();
    expect(
      isInspectorMessage({
        source: PATCHLENS_MESSAGE_SOURCE,
        schemaVersion: PATCHLENS_PROTOCOL_VERSION,
        messageId: 'message-bad-hash',
        channelId: 'channel-1',
        projectId: 'project-1',
        type: 'inspector:context',
        payload: {
          schemaVersion: PATCHLENS_PROTOCOL_VERSION,
          selection,
          screenshot: {
            dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
            mimeType: 'image/png',
            width: 100,
            height: 40,
            byteLength: 8,
            perceptualHash: 'not-a-hash',
          },
          sanitizedHtml: '',
          computedStyles: {},
          relatedSourceFiles: [],
          consoleEntries: [],
          capturedAt: createdAt,
        },
      }),
    ).toBe(false);
  });

  it('accepts bounded Inspector context evidence', () => {
    const selection = createSelection();
    expect(
      isInspectorMessage({
        source: PATCHLENS_MESSAGE_SOURCE,
        schemaVersion: PATCHLENS_PROTOCOL_VERSION,
        messageId: 'message-context',
        channelId: 'channel-1',
        projectId: 'project-1',
        type: 'inspector:context',
        payload: {
          schemaVersion: PATCHLENS_PROTOCOL_VERSION,
          selection,
          screenshot: {
            dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
            mimeType: 'image/png',
            width: 100,
            height: 40,
            byteLength: 8,
          },
          sanitizedHtml: '<button>Start</button>',
          computedStyles: { display: 'inline-block' },
          relatedSourceFiles: [],
          consoleEntries: [],
          capturedAt: new Date().toISOString(),
        },
      }),
    ).toBe(true);
  });

  it('rejects oversized inline screenshot evidence', () => {
    const selection = createSelection();
    expect(
      isInspectorMessage({
        source: PATCHLENS_MESSAGE_SOURCE,
        schemaVersion: PATCHLENS_PROTOCOL_VERSION,
        messageId: 'message-context-large',
        channelId: 'channel-1',
        projectId: 'project-1',
        type: 'inspector:context',
        payload: {
          schemaVersion: PATCHLENS_PROTOCOL_VERSION,
          selection,
          screenshot: {
            dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
            mimeType: 'image/png',
            width: 100,
            height: 40,
            byteLength: PATCHLENS_PROTOCOL_LIMITS.screenshotBytes + 1,
          },
          sanitizedHtml: '',
          computedStyles: {},
          relatedSourceFiles: [],
          consoleEntries: [],
          capturedAt: new Date().toISOString(),
        },
      }),
    ).toBe(false);
  });
});

describe('Selection validation', () => {
  it('accepts a complete selection', () => {
    expect(isVisualSelection(createSelection())).toBe(true);
  });

  it('rejects a missing primary element', () => {
    const selection = createSelection();
    selection.primaryElementId = 'missing-element';

    expect(isVisualSelection(selection)).toBe(false);
  });

  it('rejects oversized sanitized HTML', () => {
    const selection = createSelection();
    selection.elements[0]!.sanitizedHtml = 'x'.repeat(PATCHLENS_PROTOCOL_LIMITS.htmlLength + 1);

    expect(isVisualSelection(selection)).toBe(false);
  });
});

describe('Studio message validation', () => {
  it('accepts a mode message with a boolean payload', () => {
    expect(
      isStudioMessage({
        source: PATCHLENS_MESSAGE_SOURCE,
        schemaVersion: PATCHLENS_PROTOCOL_VERSION,
        messageId: 'message-6',
        channelId: 'channel-1',
        projectId: 'project-1',
        type: 'studio:set-inspector-mode',
        payload: { enabled: true },
      }),
    ).toBe(true);
  });
});

describe('Agent request validation', () => {
  it('accepts a correlated request', () => {
    expect(parseAgentRequest(createAgentRequest()).success).toBe(true);
  });

  it('rejects a mismatched selection ID', () => {
    const request = createAgentRequest();
    request.selectionId = 'selection-2';

    expect(parseAgentRequest(request).success).toBe(false);
  });

  it('rejects a mismatched project ID', () => {
    const request = createAgentRequest();
    request.projectId = 'project-2';

    expect(parseAgentRequest(request).success).toBe(false);
  });

  it.each(['../secret.ts', '/tmp/secret.ts', 'C:/secret.ts', 'src\\secret.ts'])(
    'rejects unsafe source path %s',
    (path) => {
      const request = createAgentRequest();
      request.context.selection.sourceCandidates[0]!.location.file = path;
      request.context.relatedSourceFiles[0]!.path = path;

      expect(parseAgentRequest(request).success).toBe(false);
    },
  );

  it('rejects an arbitrary shell verification command', () => {
    const request = createAgentRequest();
    request.verification.commands = ['pnpm test' as 'test'];

    expect(parseAgentRequest(request).success).toBe(false);
  });

  it('rejects non-canonical and impossible timestamps', () => {
    const localeTimestamp = createAgentRequest();
    localeTimestamp.createdAt = '08/10/2026 12:00:00';
    const impossibleTimestamp = createAgentRequest();
    impossibleTimestamp.createdAt = '2026-02-30T12:00:00Z';

    expect(parseAgentRequest(localeTimestamp).success).toBe(false);
    expect(parseAgentRequest(impossibleTimestamp).success).toBe(false);
  });
});

describe('Agent event validation', () => {
  it('accepts a correlated completion event', () => {
    expect(
      parseAgentEvent({
        schemaVersion: PATCHLENS_PROTOCOL_VERSION,
        type: 'complete',
        requestId: 'request-1',
        sessionId: 'session-1',
        sequence: 4,
        createdAt,
        payload: {
          transactionId: 'transaction-1',
          summary: 'Updated selected component',
        },
      }).success,
    ).toBe(true);
  });

  it('rejects an event with an invalid payload', () => {
    expect(
      parseAgentEvent({
        schemaVersion: PATCHLENS_PROTOCOL_VERSION,
        type: 'error',
        requestId: 'request-1',
        sessionId: 'session-1',
        sequence: 5,
        createdAt,
        payload: { code: 'provider_failed', message: 'Failure' },
      }).success,
    ).toBe(false);
  });
});

describe('Daemon health validation', () => {
  it('accepts versioned provider availability', () => {
    expect(
      parseDaemonHealth({
        ok: true,
        service: 'patchlens-daemon',
        version: '0.0.0',
        protocolVersion: PATCHLENS_PROTOCOL_VERSION,
        providers: [{ id: 'mock', status: 'available' }],
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown provider status', () => {
    expect(
      parseDaemonHealth({
        ok: true,
        service: 'patchlens-daemon',
        version: '0.0.0',
        protocolVersion: PATCHLENS_PROTOCOL_VERSION,
        providers: [{ id: 'mock', status: 'broken' }],
      }).success,
    ).toBe(false);
  });
});
