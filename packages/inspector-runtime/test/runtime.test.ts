import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PATCHLENS_MESSAGE_SOURCE,
  PATCHLENS_PROTOCOL_VERSION,
  type InspectorToStudioMessage,
  type SourceManifest,
  type StudioSetInspectorModeMessage,
} from '@patchlens-ai/agent-protocol';

import { createInspectorRuntime } from '../src/runtime.js';

vi.mock('../src/capture.js', () => ({
  captureSelectionScreenshot: vi.fn(async () => undefined),
}));

const targetOrigin = 'http://127.0.0.1:4400';
const projectId = 'project-runtime-test';
const channelId = 'channel-runtime-test';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('Inspector runtime', () => {
  it('requires an explicit target origin', () => {
    expect(() =>
      createInspectorRuntime({
        projectId,
        channelId,
        targetOrigin: '*',
      }),
    ).toThrow('Inspector targetOrigin must be explicit');
  });

  it('accepts only the bound message channel and resolves click source', () => {
    vi.useFakeTimers();
    const { targetWindow, postMessage } = createTargetWindow();
    const button = createElement('button', 'button-primary', {
      x: 20,
      y: 30,
      width: 140,
      height: 44,
    });
    button.textContent = 'Choose Builder';
    document.body.append(button);
    stubElementFromPoint(button);

    const runtime = createInspectorRuntime({
      projectId,
      channelId,
      targetOrigin,
      targetWindow,
      sourceManifest: createManifest('button-primary', 'PrimaryButton'),
    });
    runtime.start();

    expect(messagesOfType(postMessage, 'inspector:ready')).toHaveLength(1);

    dispatchInspectorMode(targetWindow, true, { origin: 'http://attacker.test' });
    clickAt(30, 40);
    expect(messagesOfType(postMessage, 'inspector:selection')).toHaveLength(0);

    dispatchInspectorMode(targetWindow, true, { channelId: 'other-channel' });
    clickAt(30, 40);
    expect(messagesOfType(postMessage, 'inspector:selection')).toHaveLength(0);

    dispatchInspectorMode(targetWindow, true);
    clickAt(30, 40);

    const selection = messagesOfType(postMessage, 'inspector:selection').at(-1);
    expect(selection?.payload).toMatchObject({
      projectId,
      confidence: 'exact',
      rectangle: { x: 20, y: 30, width: 140, height: 44 },
      sourceCandidates: [
        {
          location: {
            id: 'button-primary',
            componentName: 'PrimaryButton',
            file: 'src/App.tsx',
          },
        },
      ],
    });
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'inspector:selection' }),
      targetOrigin,
    );

    runtime.clearSelection();
    expect(messagesOfType(postMessage, 'inspector:selection-cleared').at(-1)?.payload).toEqual({
      selectionId: selection?.payload.id,
    });

    runtime.stop();
    expect(document.querySelector('[data-patchlens-overlay="true"]')).toBeNull();
  });

  it('supports drag multi-selection and restores context after remount', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    const { targetWindow, postMessage } = createTargetWindow();
    const first = createElement('article', 'card-first', {
      x: 10,
      y: 10,
      width: 80,
      height: 60,
    });
    first.textContent = 'token=first-secret';
    first.setAttribute('aria-label', 'Primary card');
    const second = createElement('article', 'card-second', {
      x: 110,
      y: 10,
      width: 80,
      height: 60,
    });
    second.textContent = 'Second card';
    document.body.append(first, second);

    const runtime = createInspectorRuntime({
      projectId,
      channelId,
      targetOrigin,
      targetWindow,
      enabled: true,
      sourceManifest: {
        ...createManifest('card-first', 'FirstCard'),
        ...createManifest('card-second', 'SecondCard'),
      },
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    runtime.start();

    document.dispatchEvent(pointerEvent('pointerdown', 0, 0));
    document.dispatchEvent(pointerEvent('pointermove', 210, 90));
    document.dispatchEvent(pointerEvent('pointerup', 210, 90));

    const selection = messagesOfType(postMessage, 'inspector:selection').at(-1);
    expect(selection?.payload).toMatchObject({
      projectId,
      confidence: 'likely',
      rectangle: { x: 0, y: 0, width: 210, height: 90 },
    });
    expect(selection?.payload.elements).toHaveLength(2);

    console.error('Bearer runtime-secret');
    const replacement = createElement('article', 'card-first', {
      x: 12,
      y: 14,
      width: 84,
      height: 62,
    });
    replacement.textContent = 'token=replacement-secret';
    first.replaceWith(replacement);
    window.dispatchEvent(new Event('resize'));
    await vi.advanceTimersByTimeAsync(200);

    const context = messagesOfType(postMessage, 'inspector:context').at(-1);
    expect(context?.payload.selection.id).toBe(selection?.payload.id);
    expect(context?.payload.selection.elements).toHaveLength(2);
    expect(context?.payload.sanitizedHtml).not.toContain('replacement-secret');
    expect(context?.payload.consoleEntries).toEqual([
      expect.objectContaining({ level: 'error', message: 'Bearer [REDACTED]' }),
    ]);

    runtime.stop();
    consoleError.mockRestore();
  });
});

function createTargetWindow(): {
  targetWindow: Window;
  postMessage: ReturnType<typeof vi.spyOn<Window, 'postMessage'>>;
} {
  const iframe = document.createElement('iframe');
  document.body.append(iframe);
  const targetWindow = iframe.contentWindow;
  if (!targetWindow) {
    throw new Error('Expected iframe contentWindow');
  }
  const postMessage = vi.spyOn(targetWindow, 'postMessage').mockImplementation(() => undefined);
  return { targetWindow, postMessage };
}

function dispatchInspectorMode(
  targetWindow: Window,
  enabled: boolean,
  overrides: { origin?: string; channelId?: string; projectId?: string } = {},
): void {
  const message: StudioSetInspectorModeMessage = {
    source: PATCHLENS_MESSAGE_SOURCE,
    schemaVersion: PATCHLENS_PROTOCOL_VERSION,
    messageId: 'message-runtime-test',
    channelId: overrides.channelId ?? channelId,
    projectId: overrides.projectId ?? projectId,
    type: 'studio:set-inspector-mode',
    payload: { enabled },
  };
  window.dispatchEvent(
    new MessageEvent('message', {
      data: message,
      origin: overrides.origin ?? targetOrigin,
      source: targetWindow,
    }),
  );
}

function createManifest(id: string, componentName: string): SourceManifest {
  return {
    [id]: {
      id,
      framework: 'react',
      componentName,
      file: 'src/App.tsx',
      line: 42,
      column: 4,
      tagName: 'button',
    },
  };
}

function createElement(
  tagName: string,
  patchlensId: string,
  rectangle: { x: number; y: number; width: number; height: number },
): HTMLElement {
  const element = document.createElement(tagName);
  element.dataset.patchlensId = patchlensId;
  element.getBoundingClientRect = () => createRectangle(rectangle);
  return element;
}

function createRectangle(rectangle: {
  x: number;
  y: number;
  width: number;
  height: number;
}): DOMRect {
  return {
    ...rectangle,
    top: rectangle.y,
    right: rectangle.x + rectangle.width,
    bottom: rectangle.y + rectangle.height,
    left: rectangle.x,
    toJSON: () => rectangle,
  } as DOMRect;
}

function stubElementFromPoint(element: Element): void {
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: vi.fn(() => element),
  });
}

function clickAt(clientX: number, clientY: number): void {
  document.dispatchEvent(
    new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX,
      clientY,
    }),
  );
}

function pointerEvent(type: string, clientX: number, clientY: number): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX,
    clientY,
  });
}

function messagesOfType<Type extends InspectorToStudioMessage['type']>(
  postMessage: ReturnType<typeof vi.spyOn<Window, 'postMessage'>>,
  type: Type,
): Array<Extract<InspectorToStudioMessage, { type: Type }>> {
  return postMessage.mock.calls
    .map(([message]) => message)
    .filter((message): message is Extract<InspectorToStudioMessage, { type: Type }> =>
      Boolean(message && typeof message === 'object' && 'type' in message && message.type === type),
    );
}
