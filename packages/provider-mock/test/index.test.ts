import { describe, expect, it } from 'vitest';

import { PATCHLENS_PROTOCOL_VERSION } from '@patchlens-ai/agent-protocol';
import type { AgentEvent, AgentRequest } from '@patchlens-ai/agent-protocol';

import { MockCodingProvider } from '../src/index.js';

describe('MockCodingProvider', () => {
  it('streams a deterministic request lifecycle', async () => {
    const provider = new MockCodingProvider({ delayMs: 0 });
    const session = await provider.createSession({ projectId: 'project-1' });
    const events: AgentEvent[] = [];

    for await (const event of provider.sendMessage(session, createRequest())) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(['status', 'message', 'files', 'complete']);
  });

  it('emits cancelled when session is cancelled before execution', async () => {
    const provider = new MockCodingProvider({ delayMs: 0 });
    const session = await provider.createSession({ projectId: 'project-1' });
    await provider.cancel(session);

    const events: AgentEvent[] = [];
    for await (const event of provider.sendMessage(session, createRequest())) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(['cancelled']);
  });
});

function createRequest(): AgentRequest {
  const createdAt = '2026-08-09T12:00:00.000Z';
  return {
    schemaVersion: PATCHLENS_PROTOCOL_VERSION,
    requestId: 'request-1',
    projectId: 'project-1',
    selectionId: 'selection-1',
    provider: 'mock',
    instruction: 'Make it more prominent.',
    context: {
      schemaVersion: PATCHLENS_PROTOCOL_VERSION,
      selection: {
        schemaVersion: PATCHLENS_PROTOCOL_VERSION,
        id: 'selection-1',
        projectId: 'project-1',
        route: '/',
        viewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
        rectangle: { x: 10, y: 10, width: 100, height: 40 },
        elements: [
          {
            id: 'element-1',
            patchlensId: 'pl_button',
            tagName: 'button',
            text: 'Start',
            sanitizedHtml: '<button>Start</button>',
            rectangle: { x: 10, y: 10, width: 100, height: 40 },
          },
        ],
        primaryElementId: 'element-1',
        sourceCandidates: [
          {
            location: {
              id: 'pl_button',
              framework: 'react',
              componentName: 'PrimaryButton',
              file: 'src/PrimaryButton.tsx',
              line: 10,
              column: 2,
            },
            confidence: 1,
          },
        ],
        confidence: 'exact',
        createdAt,
      },
      sanitizedHtml: '<button>Start</button>',
      computedStyles: {},
      relatedSourceFiles: [],
      consoleEntries: [],
      capturedAt: createdAt,
    },
    scopePolicy: 'prefer-selection',
    verification: { route: '/', captureAfterChange: false, commands: [] },
    createdAt,
  };
}
