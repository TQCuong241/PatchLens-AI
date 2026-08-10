import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PATCHLENS_MESSAGE_SOURCE,
  PATCHLENS_PROTOCOL_VERSION,
  type InspectorSelectionContext,
  type InspectorToStudioMessage,
  type VisualSelection,
} from '@patchlens-ai/agent-protocol';

import { App } from '../src/App.js';

let root: Root | undefined;

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('PatchLens Studio client', () => {
  it('binds preview messages to origin, window, project, and channel', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(createElement(App)));

    const iframe = document.querySelector('iframe');
    const previewWindow = iframe?.contentWindow;
    if (!iframe || !previewWindow) {
      throw new Error('Expected Studio preview iframe');
    }
    const previewUrl = new URL(iframe.src);
    const projectId = previewUrl.searchParams.get('patchlensProjectId');
    const channelId = previewUrl.searchParams.get('patchlensChannelId');
    if (!projectId || !channelId) {
      throw new Error('Expected preview connection parameters');
    }
    const postMessage = vi.spyOn(previewWindow, 'postMessage').mockImplementation(() => undefined);

    await dispatchPreviewMessage(
      previewWindow,
      createReadyMessage(projectId, channelId),
      'http://attacker.test',
    );
    expect(document.body.textContent).toContain('Waiting for preview');

    await dispatchPreviewMessage(
      window,
      createReadyMessage(projectId, channelId),
      previewUrl.origin,
    );
    expect(document.body.textContent).toContain('Waiting for preview');

    await dispatchPreviewMessage(
      previewWindow,
      createReadyMessage(projectId, channelId),
      previewUrl.origin,
    );
    expect(document.body.textContent).toContain('Preview connected');
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'studio:set-inspector-mode', payload: { enabled: false } }),
      previewUrl.origin,
    );

    const selectButton = findButton('Select UI');
    await act(async () => selectButton.click());
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'studio:set-inspector-mode', payload: { enabled: true } }),
      previewUrl.origin,
    );

    const selection = createSelection(projectId);
    await dispatchPreviewMessage(
      previewWindow,
      createSelectionMessage(projectId, channelId, selection, 'other-channel'),
      previewUrl.origin,
    );
    expect(document.querySelector('.selection-details')).toBeNull();

    await dispatchPreviewMessage(
      previewWindow,
      createSelectionMessage(projectId, channelId, selection),
      previewUrl.origin,
    );
    expect(document.querySelector('.selection-details')?.textContent).toContain('PrimaryButton');
    expect(document.querySelector('.selection-details')?.textContent).toContain('src/App.tsx');
    expect(findButton('Capturing context...').disabled).toBe(true);

    await dispatchPreviewMessage(
      previewWindow,
      createContextMessage(projectId, channelId, selection),
      previewUrl.origin,
    );
    expect(findButton('Send to mock').disabled).toBe(true);

    await act(async () => findButton('Clear').click());
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'studio:clear-selection',
        payload: { selectionId: selection.id },
      }),
      previewUrl.origin,
    );
    expect(document.querySelector('.selection-details')).toBeNull();
  });
});

function createReadyMessage(projectId: string, channelId: string): InspectorToStudioMessage {
  return {
    source: PATCHLENS_MESSAGE_SOURCE,
    schemaVersion: PATCHLENS_PROTOCOL_VERSION,
    messageId: 'message-ready',
    channelId,
    projectId,
    type: 'inspector:ready',
    payload: {
      route: '/',
      viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    },
  };
}

function createSelectionMessage(
  projectId: string,
  channelId: string,
  selection: VisualSelection,
  overriddenChannelId = channelId,
): InspectorToStudioMessage {
  return {
    source: PATCHLENS_MESSAGE_SOURCE,
    schemaVersion: PATCHLENS_PROTOCOL_VERSION,
    messageId: 'message-selection',
    channelId: overriddenChannelId,
    projectId,
    type: 'inspector:selection',
    payload: selection,
  };
}

function createContextMessage(
  projectId: string,
  channelId: string,
  selection: VisualSelection,
): InspectorToStudioMessage {
  const context: InspectorSelectionContext = {
    schemaVersion: PATCHLENS_PROTOCOL_VERSION,
    selection,
    sanitizedHtml: '<button>Choose Builder</button>',
    computedStyles: { display: 'inline-flex' },
    relatedSourceFiles: [{ path: 'src/App.tsx', startLine: 30, endLine: 66 }],
    consoleEntries: [],
    capturedAt: '2026-08-10T08:00:01.000Z',
  };
  return {
    source: PATCHLENS_MESSAGE_SOURCE,
    schemaVersion: PATCHLENS_PROTOCOL_VERSION,
    messageId: 'message-context',
    channelId,
    projectId,
    type: 'inspector:context',
    payload: context,
  };
}

function createSelection(projectId: string): VisualSelection {
  return {
    schemaVersion: PATCHLENS_PROTOCOL_VERSION,
    id: 'selection-studio-test',
    projectId,
    route: '/pricing',
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    rectangle: { x: 120, y: 140, width: 180, height: 48 },
    elements: [
      {
        id: 'element-studio-test',
        patchlensId: 'button-primary',
        tagName: 'button',
        text: 'Choose Builder',
        sanitizedHtml: '<button>Choose Builder</button>',
        rectangle: { x: 120, y: 140, width: 180, height: 48 },
        source: {
          id: 'button-primary',
          framework: 'react',
          componentName: 'PrimaryButton',
          file: 'src/App.tsx',
          line: 42,
          column: 4,
          tagName: 'button',
        },
      },
    ],
    primaryElementId: 'element-studio-test',
    sourceCandidates: [
      {
        confidence: 1,
        location: {
          id: 'button-primary',
          framework: 'react',
          componentName: 'PrimaryButton',
          file: 'src/App.tsx',
          line: 42,
          column: 4,
          tagName: 'button',
        },
      },
    ],
    confidence: 'exact',
    createdAt: '2026-08-10T08:00:00.000Z',
  };
}

async function dispatchPreviewMessage(
  source: MessageEventSource,
  data: InspectorToStudioMessage,
  origin: string,
): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data, origin, source }));
    await Promise.resolve();
  });
}

function findButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
}
