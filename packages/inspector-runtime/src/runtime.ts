import {
  PATCHLENS_MESSAGE_SOURCE,
  PATCHLENS_PROTOCOL_LIMITS,
  PATCHLENS_PROTOCOL_VERSION,
  isSourceLocation,
  parseStudioMessage,
} from '@patchlens-ai/agent-protocol';
import type {
  ConsoleEntry,
  InlineScreenshot,
  InspectorContextMessage,
  InspectorReadyMessage,
  InspectorSelectionContext,
  InspectorSelectionClearedMessage,
  InspectorSelectionMessage,
  Rectangle,
  SourceManifest,
  StudioToInspectorMessage,
  VisualSelection,
} from '@patchlens-ai/agent-protocol';
import {
  intersectionArea,
  rankDragSources,
  resolveClickSource,
} from '@patchlens-ai/selection-engine';
import type { ElementSelectionInput } from '@patchlens-ai/selection-engine';
import { SourceMapper } from '@patchlens-ai/source-mapper';

import { extractElementText, redactSensitiveText, sanitizeElementHtml } from './sanitize.js';
import { captureSelectionScreenshot } from './capture.js';

export type InspectorRuntimeOptions = {
  projectId: string;
  channelId: string;
  targetOrigin: string;
  targetWindow?: Window;
  sourceManifest?: SourceManifest;
  enabled?: boolean;
};

export type InspectorRuntime = {
  start(): void;
  stop(): void;
  setEnabled(enabled: boolean): void;
  clearSelection(): void;
  replaceSourceManifest(manifest: SourceManifest): void;
};

type Overlay = {
  host: HTMLDivElement;
  frame: HTMLDivElement;
  label: HTMLDivElement;
};

type DragState = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  dragging: boolean;
};

export function createInspectorRuntime(options: InspectorRuntimeOptions): InspectorRuntime {
  if (!options.targetOrigin || options.targetOrigin === '*') {
    throw new Error('Inspector targetOrigin must be explicit');
  }

  const targetWindow = options.targetWindow ?? window.parent;
  const mapper = new SourceMapper(options.sourceManifest);
  const overlay = createOverlay();
  const mutationObserver = new MutationObserver(refreshOverlay);
  const consoleEntries: ConsoleEntry[] = [];
  let enabled = options.enabled ?? false;
  let started = false;
  let activeElement: Element | undefined;
  let activeElements: Element[] = [];
  let activeSelection: VisualSelection | undefined;
  let dragState: DragState | undefined;
  let suppressNextClick = false;
  let contextCaptureTimer: number | undefined;
  let contextCaptureGeneration = 0;
  let contextCaptureNeedsScreenshot = false;
  let restoreConsoleCapture: (() => void) | undefined;

  function start(): void {
    if (started) {
      return;
    }

    started = true;
    restoreConsoleCapture = installConsoleCapture(recordConsoleEntry);
    document.documentElement.append(overlay.host);
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('pointermove', handlePointerMove, true);
    document.addEventListener('pointerup', handlePointerUp, true);
    document.addEventListener('pointercancel', handlePointerCancel, true);
    document.addEventListener('click', handleClick, true);
    window.addEventListener('message', handleMessage);
    window.addEventListener('resize', refreshOverlay);
    window.addEventListener('scroll', refreshOverlay, true);
    mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    updateOverlayVisibility();
    sendReady();
  }

  function stop(): void {
    if (!started) {
      return;
    }

    started = false;
    mutationObserver.disconnect();
    restoreConsoleCapture?.();
    restoreConsoleCapture = undefined;
    if (contextCaptureTimer !== undefined) {
      window.clearTimeout(contextCaptureTimer);
      contextCaptureTimer = undefined;
    }
    document.removeEventListener('pointerdown', handlePointerDown, true);
    document.removeEventListener('pointermove', handlePointerMove, true);
    document.removeEventListener('pointerup', handlePointerUp, true);
    document.removeEventListener('pointercancel', handlePointerCancel, true);
    document.removeEventListener('click', handleClick, true);
    window.removeEventListener('message', handleMessage);
    window.removeEventListener('resize', refreshOverlay);
    window.removeEventListener('scroll', refreshOverlay, true);
    overlay.host.remove();
    activeElement = undefined;
    activeElements = [];
    activeSelection = undefined;
    dragState = undefined;
    contextCaptureGeneration += 1;
  }

  function setEnabled(nextEnabled: boolean): void {
    enabled = nextEnabled;
    if (!enabled) {
      activeElement = undefined;
    }
    updateOverlayVisibility();
  }

  function clearSelection(): void {
    clearSelectionState(true);
  }

  function replaceSourceManifest(manifest: SourceManifest): void {
    mapper.replace(manifest);
  }

  function handlePointerMove(event: PointerEvent): void {
    if (!enabled) {
      return;
    }

    if (dragState) {
      dragState.currentX = event.clientX;
      dragState.currentY = event.clientY;
      dragState.dragging =
        dragState.dragging ||
        Math.hypot(dragState.currentX - dragState.startX, dragState.currentY - dragState.startY) >=
          6;

      if (dragState.dragging) {
        event.preventDefault();
        renderRectangle(normalizeDragRectangle(dragState), 'Select region');
      }
      return;
    }

    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (!element || element === overlay.host) {
      activeElement = undefined;
      updateOverlayVisibility();
      return;
    }

    activeElement = element;
    activeSelection = undefined;
    renderOverlay(element, 'Select element');
  }

  function handlePointerDown(event: PointerEvent): void {
    if (!enabled || event.button !== 0) {
      return;
    }

    dragState = {
      startX: event.clientX,
      startY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
      dragging: false,
    };
  }

  function handlePointerUp(event: PointerEvent): void {
    if (!dragState) {
      return;
    }

    const completedDrag = dragState;
    dragState = undefined;
    if (!completedDrag.dragging) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    suppressNextClick = true;
    selectRectangle(normalizeDragRectangle(completedDrag));
  }

  function handlePointerCancel(): void {
    dragState = undefined;
    updateOverlayVisibility();
  }

  function handleClick(event: MouseEvent): void {
    if (suppressNextClick) {
      suppressNextClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    if (!enabled || event.button !== 0) {
      return;
    }

    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (!element || element === overlay.host) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    selectElement(element, event.shiftKey);
  }

  function handleMessage(event: MessageEvent<unknown>): void {
    if (event.source !== targetWindow || event.origin !== options.targetOrigin) {
      return;
    }

    const parsed = parseStudioMessage(event.data);
    if (!parsed.success) {
      return;
    }

    const message = parsed.data;
    if (message.channelId !== options.channelId || message.projectId !== options.projectId) {
      return;
    }

    applyStudioMessage(message);
  }

  function applyStudioMessage(message: StudioToInspectorMessage): void {
    if (message.type === 'studio:set-inspector-mode') {
      setEnabled(message.payload.enabled);
      return;
    }

    clearSelectionState(true);
  }

  function selectElement(element: Element, additive = false): void {
    if (additive) {
      const elements = activeElements.includes(element)
        ? activeElements.filter((active) => active !== element)
        : [...activeElements, element];
      if (elements.length === 0) {
        clearSelectionState(true);
        return;
      }
      if (elements.length > 1) {
        selectElementGroup(elements, element);
        return;
      }
      element = elements[0]!;
    }
    registerInlineSources(element);
    const patchlensIds = collectPatchlensIds(element);
    const sourceCandidate = resolveClickSource(patchlensIds, mapper);
    const patchlensId = patchlensIds[0];
    const selectedElement = createSelectedElement(element, patchlensId, sourceCandidate?.location);
    const rectangle = toRectangle(element.getBoundingClientRect());
    const selection: VisualSelection = {
      schemaVersion: PATCHLENS_PROTOCOL_VERSION,
      id: createId('selection'),
      projectId: options.projectId,
      route: currentRoute(),
      viewport: currentViewport(),
      rectangle,
      elements: [selectedElement],
      primaryElementId: selectedElement.id,
      sourceCandidates: sourceCandidate ? [sourceCandidate] : [],
      confidence: sourceCandidate ? 'exact' : 'visual-only',
      createdAt: new Date().toISOString(),
    };

    activeElement = element;
    activeElements = [element];
    activeSelection = selection;
    renderOverlay(
      element,
      sourceCandidate?.location.componentName ?? element.tagName.toLowerCase(),
    );
    sendSelection(selection);
    scheduleContextCapture(true);
  }

  function selectElementGroup(elements: readonly Element[], primary: Element): void {
    for (const element of elements) {
      registerInlineSources(element);
    }
    const selectedElements = elements.map((element) => {
      const patchlensIds = collectPatchlensIds(element);
      const sourceCandidate = resolveClickSource(patchlensIds, mapper);
      return createSelectedElement(element, patchlensIds[0], sourceCandidate?.location);
    });
    const sourceCandidates = [
      ...new Map(
        selectedElements.flatMap((element) =>
          element.source
            ? [[element.source.id, { location: element.source, confidence: 1 }] as const]
            : [],
        ),
      ).values(),
    ];
    const primaryIndex = Math.max(0, elements.indexOf(primary));
    const primaryElement = selectedElements[primaryIndex] ?? selectedElements[0]!;
    const rectangle = unionRectangles(
      elements.map((element) => toRectangle(element.getBoundingClientRect())),
    );
    const selection: VisualSelection = {
      schemaVersion: PATCHLENS_PROTOCOL_VERSION,
      id: createId('selection'),
      projectId: options.projectId,
      route: currentRoute(),
      viewport: currentViewport(),
      rectangle,
      elements: selectedElements,
      primaryElementId: primaryElement.id,
      sourceCandidates,
      confidence:
        sourceCandidates.length === 0
          ? 'visual-only'
          : sourceCandidates.length === 1
            ? 'exact'
            : 'likely',
      createdAt: new Date().toISOString(),
    };

    activeElement = primary;
    activeElements = [...elements];
    activeSelection = selection;
    renderRectangle(rectangle, `${selectedElements.length} selected elements`);
    sendSelection(selection);
    scheduleContextCapture(true);
  }

  function selectRectangle(rectangle: Rectangle): void {
    const matchedElements = collectElementsInRectangle(rectangle).slice(
      0,
      PATCHLENS_PROTOCOL_LIMITS.elements,
    );
    if (matchedElements.length === 0) {
      updateOverlayVisibility();
      return;
    }
    for (const element of matchedElements) {
      registerInlineSources(element);
    }

    const rankingInputs: ElementSelectionInput[] = matchedElements.map((element) => ({
      elementId: createId('candidate'),
      patchlensId: element.getAttribute('data-patchlens-id') ?? undefined,
      rectangle: toRectangle(element.getBoundingClientRect()),
      depth: getElementDepth(element),
      visible: isVisibleElement(element),
    }));
    const sourceCandidates = rankDragSources(rectangle, rankingInputs, mapper);
    const selectedElements = matchedElements.map((element) => {
      const patchlensId = element.getAttribute('data-patchlens-id') ?? undefined;
      return createSelectedElement(
        element,
        patchlensId,
        patchlensId ? mapper.resolve(patchlensId) : undefined,
      );
    });
    const primarySourceId = sourceCandidates[0]?.location.id;
    const primaryElement =
      selectedElements.find((element) => element.patchlensId === primarySourceId) ??
      selectedElements[0]!;
    const selection: VisualSelection = {
      schemaVersion: PATCHLENS_PROTOCOL_VERSION,
      id: createId('selection'),
      projectId: options.projectId,
      route: currentRoute(),
      viewport: currentViewport(),
      rectangle,
      elements: selectedElements,
      primaryElementId: primaryElement.id,
      sourceCandidates,
      confidence:
        sourceCandidates.length === 0
          ? 'visual-only'
          : sourceCandidates.length === 1
            ? 'exact'
            : 'likely',
      createdAt: new Date().toISOString(),
    };

    activeElement =
      matchedElements.find(
        (element) => element.getAttribute('data-patchlens-id') === primarySourceId,
      ) ?? matchedElements[0];
    activeElements = matchedElements;
    activeSelection = selection;
    renderRectangle(
      rectangle,
      sourceCandidates[0]?.location.componentName ?? `${selectedElements.length} elements`,
    );
    sendSelection(selection);
    scheduleContextCapture(true);
  }

  function createSelectedElement(
    element: Element,
    patchlensId: string | undefined,
    source: ReturnType<SourceMapper['resolve']>,
  ) {
    return {
      id: createId('element'),
      patchlensId,
      tagName: element.tagName.toLowerCase(),
      text: extractElementText(element),
      sanitizedHtml: sanitizeElementHtml(element),
      rectangle: toRectangle(element.getBoundingClientRect()),
      source,
    };
  }

  function registerInlineSources(element: Element): void {
    let current: Element | null = element;
    while (current) {
      const id = current.getAttribute('data-patchlens-id');
      const encoded = current.getAttribute('data-patchlens-source');
      const source = encoded ? decodeInlineSourceLocation(encoded) : undefined;
      if (id && source?.id === id) {
        mapper.register(id, source);
      }
      current = current.parentElement;
    }
  }

  function clearSelectionState(notify: boolean): void {
    const selectionId = activeSelection?.id;
    contextCaptureGeneration += 1;
    contextCaptureNeedsScreenshot = false;
    if (contextCaptureTimer !== undefined) {
      window.clearTimeout(contextCaptureTimer);
      contextCaptureTimer = undefined;
    }
    activeElement = undefined;
    activeElements = [];
    activeSelection = undefined;
    updateOverlayVisibility();

    if (notify) {
      const message: InspectorSelectionClearedMessage = {
        source: PATCHLENS_MESSAGE_SOURCE,
        schemaVersion: PATCHLENS_PROTOCOL_VERSION,
        messageId: createId('message'),
        channelId: options.channelId,
        projectId: options.projectId,
        type: 'inspector:selection-cleared',
        payload: { selectionId },
      };
      sendMessage(message);
    }
  }

  function sendReady(): void {
    const message: InspectorReadyMessage = {
      source: PATCHLENS_MESSAGE_SOURCE,
      schemaVersion: PATCHLENS_PROTOCOL_VERSION,
      messageId: createId('message'),
      channelId: options.channelId,
      projectId: options.projectId,
      type: 'inspector:ready',
      payload: {
        route: currentRoute(),
        viewport: currentViewport(),
      },
    };
    sendMessage(message);
  }

  function sendSelection(selection: VisualSelection): void {
    const message: InspectorSelectionMessage = {
      source: PATCHLENS_MESSAGE_SOURCE,
      schemaVersion: PATCHLENS_PROTOCOL_VERSION,
      messageId: createId('message'),
      channelId: options.channelId,
      projectId: options.projectId,
      type: 'inspector:selection',
      payload: selection,
    };
    sendMessage(message);
  }

  function scheduleContextCapture(includeScreenshot: boolean): void {
    if (!activeSelection) {
      return;
    }
    contextCaptureNeedsScreenshot = contextCaptureNeedsScreenshot || includeScreenshot;
    contextCaptureGeneration += 1;
    const generation = contextCaptureGeneration;
    if (contextCaptureTimer !== undefined) {
      window.clearTimeout(contextCaptureTimer);
    }
    contextCaptureTimer = window.setTimeout(() => {
      contextCaptureTimer = undefined;
      const shouldCaptureScreenshot = contextCaptureNeedsScreenshot;
      contextCaptureNeedsScreenshot = false;
      void sendSelectionContext(generation, shouldCaptureScreenshot);
    }, 180);
  }

  async function sendSelectionContext(
    generation: number,
    includeScreenshot: boolean,
  ): Promise<void> {
    const selection = refreshSelectionSnapshot();
    if (!selection) {
      return;
    }
    const selectionId = selection.id;
    const screenshot = includeScreenshot
      ? await captureSelectionScreenshot(activeElements, selection.rectangle)
      : undefined;
    if (generation !== contextCaptureGeneration || activeSelection?.id !== selectionId) {
      return;
    }

    const context = createInspectorSelectionContext(
      selection,
      activeElements,
      consoleEntries,
      screenshot,
    );
    const message: InspectorContextMessage = {
      source: PATCHLENS_MESSAGE_SOURCE,
      schemaVersion: PATCHLENS_PROTOCOL_VERSION,
      messageId: createId('message'),
      channelId: options.channelId,
      projectId: options.projectId,
      type: 'inspector:context',
      payload: context,
    };
    sendMessage(message);
  }

  function sendMessage(
    message:
      | InspectorReadyMessage
      | InspectorSelectionMessage
      | InspectorContextMessage
      | InspectorSelectionClearedMessage,
  ): void {
    targetWindow.postMessage(message, options.targetOrigin);
  }

  function refreshOverlay(): void {
    if (!activeElement) {
      updateOverlayVisibility();
      return;
    }

    if (!activeElement.isConnected) {
      if (!restoreSelectionAfterRemount()) {
        clearSelectionState(Boolean(activeSelection));
        return;
      }
    }

    if (activeSelection && activeElements.length > 1) {
      const connectedElements = activeElements.filter((element) => element.isConnected);
      if (connectedElements.length === 0) {
        clearSelectionState(true);
        return;
      }

      activeElements = connectedElements;
      renderRectangle(
        unionRectangles(
          connectedElements.map((element) => toRectangle(element.getBoundingClientRect())),
        ),
        activeSelection.sourceCandidates[0]?.location.componentName ??
          `${connectedElements.length} elements`,
      );
      scheduleContextCapture(true);
      return;
    }

    renderOverlay(
      activeElement,
      activeSelection?.sourceCandidates[0]?.location.componentName ??
        activeElement.tagName.toLowerCase(),
    );
    scheduleContextCapture(true);
  }

  function refreshSelectionSnapshot(): VisualSelection | undefined {
    const selection = activeSelection;
    if (!selection || activeElements.length === 0) {
      return undefined;
    }
    const connectedElements = activeElements.filter((element) => element.isConnected);
    if (connectedElements.length === 0) {
      return undefined;
    }
    activeElements = connectedElements;
    activeElement = connectedElements[0];
    selection.route = currentRoute();
    selection.viewport = currentViewport();
    selection.rectangle = unionRectangles(
      connectedElements.map((element) => toRectangle(element.getBoundingClientRect())),
    );
    selection.elements = connectedElements.map((element, index) => {
      const existing = selection.elements[index];
      const patchlensId = element.getAttribute('data-patchlens-id') ?? existing?.patchlensId;
      return {
        id: existing?.id ?? createId('element'),
        ...(patchlensId ? { patchlensId } : {}),
        tagName: element.tagName.toLowerCase(),
        text: extractElementText(element),
        sanitizedHtml: sanitizeElementHtml(element),
        rectangle: toRectangle(element.getBoundingClientRect()),
        ...(existing?.source ? { source: existing.source } : {}),
      };
    });
    if (!selection.elements.some((element) => element.id === selection.primaryElementId)) {
      selection.primaryElementId = selection.elements[0]!.id;
    }
    return structuredClone(selection);
  }

  function restoreSelectionAfterRemount(): boolean {
    if (!activeSelection) {
      return false;
    }
    const restored = activeSelection.elements
      .map((element) =>
        element.patchlensId
          ? document.querySelector(`[data-patchlens-id="${CSS.escape(element.patchlensId)}"]`)
          : undefined,
      )
      .filter((element): element is Element => Boolean(element));
    if (restored.length === 0) {
      return false;
    }
    activeElements = restored;
    activeElement = restored[0];
    return true;
  }

  function recordConsoleEntry(entry: ConsoleEntry): void {
    consoleEntries.push(entry);
    if (consoleEntries.length > PATCHLENS_PROTOCOL_LIMITS.consoleEntries) {
      consoleEntries.splice(0, consoleEntries.length - PATCHLENS_PROTOCOL_LIMITS.consoleEntries);
    }
    scheduleContextCapture(false);
  }

  function renderOverlay(element: Element, label: string): void {
    renderRectangle(toRectangle(element.getBoundingClientRect()), label);
  }

  function renderRectangle(rectangle: Rectangle, label: string): void {
    overlay.host.hidden = false;
    overlay.frame.style.transform = `translate(${rectangle.x}px, ${rectangle.y}px)`;
    overlay.frame.style.width = `${rectangle.width}px`;
    overlay.frame.style.height = `${rectangle.height}px`;
    overlay.label.textContent = label;
  }

  function updateOverlayVisibility(): void {
    overlay.host.hidden = !enabled || !activeElement;
  }

  return {
    start,
    stop,
    setEnabled,
    clearSelection,
    replaceSourceManifest,
  };
}

const computedStyleProperties = [
  'display',
  'position',
  'width',
  'height',
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'text-align',
  'margin',
  'padding',
  'gap',
  'border',
  'border-radius',
  'box-shadow',
  'opacity',
  'overflow',
  'z-index',
  'flex-direction',
  'align-items',
  'justify-content',
  'grid-template-columns',
  'transform',
] as const;

function createInspectorSelectionContext(
  selection: VisualSelection,
  elements: readonly Element[],
  consoleEntries: readonly ConsoleEntry[],
  screenshot: InlineScreenshot | undefined,
): InspectorSelectionContext {
  const primaryIndex = Math.max(
    0,
    selection.elements.findIndex((element) => element.id === selection.primaryElementId),
  );
  const primaryElement = elements[primaryIndex] ?? elements[0];
  const relatedSourceFiles = [
    ...new Map(
      selection.sourceCandidates.map((candidate) => [
        candidate.location.file,
        {
          path: candidate.location.file,
          startLine: Math.max(1, candidate.location.line - 12),
          endLine: candidate.location.line + 24,
        },
      ]),
    ).values(),
  ];
  const accessibilitySummary = primaryElement
    ? createAccessibilitySummary(primaryElement)
    : undefined;
  return {
    schemaVersion: PATCHLENS_PROTOCOL_VERSION,
    selection,
    ...(screenshot ? { screenshot } : {}),
    sanitizedHtml: selection.elements
      .map((element) => element.sanitizedHtml)
      .join('\n')
      .slice(0, PATCHLENS_PROTOCOL_LIMITS.htmlLength),
    computedStyles: primaryElement ? collectComputedStyles(primaryElement) : {},
    ...(primaryElement ? { designTokens: collectDesignTokens(primaryElement) } : {}),
    ...(accessibilitySummary ? { accessibilitySummary } : {}),
    relatedSourceFiles,
    consoleEntries: consoleEntries.map((entry) => ({ ...entry })),
    capturedAt: new Date().toISOString(),
  };
}

function collectComputedStyles(element: Element): Record<string, string> {
  const style = getComputedStyle(element);
  return Object.fromEntries(
    computedStyleProperties
      .map((property) => [property, style.getPropertyValue(property).trim()] as const)
      .filter((entry) => entry[1].length > 0),
  );
}

function collectDesignTokens(element: Element): Record<string, string> {
  const style = getComputedStyle(element);
  const tokens: Array<[string, string]> = [];
  for (let index = 0; index < style.length; index += 1) {
    const property = style.item(index);
    if (!property.startsWith('--')) {
      continue;
    }
    const value = redactSensitiveText(style.getPropertyValue(property).trim());
    if (value) {
      tokens.push([property, value]);
    }
    if (tokens.length >= PATCHLENS_PROTOCOL_LIMITS.computedStyles) {
      break;
    }
  }
  return Object.fromEntries(tokens);
}

function createAccessibilitySummary(element: Element): string {
  const values = [
    element.getAttribute('role') ? `role=${element.getAttribute('role')}` : undefined,
    element.getAttribute('aria-label')
      ? `aria-label=${element.getAttribute('aria-label')}`
      : undefined,
    element.getAttribute('alt') ? `alt=${element.getAttribute('alt')}` : undefined,
    element.getAttribute('title') ? `title=${element.getAttribute('title')}` : undefined,
    extractElementText(element) ? `text=${extractElementText(element)}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return redactSensitiveText(values.join('; ')).slice(0, PATCHLENS_PROTOCOL_LIMITS.textLength);
}

function installConsoleCapture(record: (entry: ConsoleEntry) => void): () => void {
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  const wrappedWarn = (...values: unknown[]) => {
    record(createConsoleEntry('warning', values));
    originalWarn(...values);
  };
  const wrappedError = (...values: unknown[]) => {
    record(createConsoleEntry('error', values));
    originalError(...values);
  };
  console.warn = wrappedWarn;
  console.error = wrappedError;

  const handleWindowError = (event: ErrorEvent) => {
    record(
      createConsoleEntry('error', [
        event.message,
        event.error instanceof Error ? event.error.message : undefined,
      ]),
    );
  };
  const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    record(createConsoleEntry('error', ['Unhandled promise rejection', event.reason]));
  };
  window.addEventListener('error', handleWindowError);
  window.addEventListener('unhandledrejection', handleUnhandledRejection);

  return () => {
    if (console.warn === wrappedWarn) {
      console.warn = originalWarn;
    }
    if (console.error === wrappedError) {
      console.error = originalError;
    }
    window.removeEventListener('error', handleWindowError);
    window.removeEventListener('unhandledrejection', handleUnhandledRejection);
  };
}

function createConsoleEntry(
  level: ConsoleEntry['level'],
  values: readonly unknown[],
): ConsoleEntry {
  return {
    level,
    message: redactSensitiveText(
      values
        .filter((value) => value !== undefined)
        .map(formatConsoleValue)
        .join(' '),
    ).slice(0, PATCHLENS_PROTOCOL_LIMITS.textLength),
    createdAt: new Date().toISOString(),
  };
}

function formatConsoleValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function createOverlay(): Overlay {
  const host = document.createElement('div');
  host.dataset.patchlensOverlay = 'true';
  host.style.position = 'fixed';
  host.style.inset = '0';
  host.style.pointerEvents = 'none';
  host.style.zIndex = '2147483647';

  const shadowRoot = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    .frame {
      position: fixed;
      box-sizing: border-box;
      border: 2px solid #e85d2a;
      background: rgb(232 93 42 / 10%);
      border-radius: 4px;
      pointer-events: none;
    }
    .label {
      position: absolute;
      left: -2px;
      bottom: 100%;
      max-width: 320px;
      padding: 4px 7px;
      overflow: hidden;
      color: #fff;
      background: #18201d;
      border-radius: 4px 4px 0 0;
      font: 600 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `;

  const frame = document.createElement('div');
  frame.className = 'frame';
  const label = document.createElement('div');
  label.className = 'label';
  frame.append(label);
  shadowRoot.append(style, frame);

  return { host, frame, label };
}

function collectPatchlensIds(element: Element): string[] {
  const ids: string[] = [];
  let current: Element | null = element;

  while (current) {
    const id = current.getAttribute('data-patchlens-id');
    if (id) {
      ids.push(id);
    }
    current = current.parentElement;
  }

  return ids;
}

function decodeInlineSourceLocation(value: string) {
  if (!value || value.length > 4_096) {
    return undefined;
  }
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isSourceLocation(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function collectElementsInRectangle(rectangle: Rectangle): Element[] {
  return [...document.querySelectorAll('[data-patchlens-id]')].filter((element) => {
    const elementRectangle = toRectangle(element.getBoundingClientRect());
    return isVisibleElement(element) && intersectionArea(rectangle, elementRectangle) > 0;
  });
}

function isVisibleElement(element: Element): boolean {
  const rectangle = element.getBoundingClientRect();
  if (rectangle.width <= 1 || rectangle.height <= 1) {
    return false;
  }

  const style = getComputedStyle(element);
  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    Number.parseFloat(style.opacity || '1') > 0
  );
}

function getElementDepth(element: Element): number {
  let depth = 0;
  let current = element.parentElement;
  while (current) {
    depth += 1;
    current = current.parentElement;
  }
  return depth;
}

function normalizeDragRectangle(state: DragState): Rectangle {
  const x = Math.min(state.startX, state.currentX);
  const y = Math.min(state.startY, state.currentY);
  return {
    x,
    y,
    width: Math.abs(state.currentX - state.startX),
    height: Math.abs(state.currentY - state.startY),
  };
}

function unionRectangles(rectangles: readonly Rectangle[]): Rectangle {
  const first = rectangles[0];
  if (!first) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  let left = first.x;
  let top = first.y;
  let right = first.x + first.width;
  let bottom = first.y + first.height;

  for (const rectangle of rectangles.slice(1)) {
    left = Math.min(left, rectangle.x);
    top = Math.min(top, rectangle.y);
    right = Math.max(right, rectangle.x + rectangle.width);
    bottom = Math.max(bottom, rectangle.y + rectangle.height);
  }

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

function currentRoute(): string {
  return `${location.pathname}${location.search}${location.hash}`;
}

function currentViewport() {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    deviceScaleFactor: window.devicePixelRatio,
  };
}

function toRectangle(rectangle: DOMRect): Rectangle {
  return {
    x: rectangle.x,
    y: rectangle.y,
    width: rectangle.width,
    height: rectangle.height,
  };
}

function createId(prefix: string): string {
  const value = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `${prefix}-${value}`;
}
