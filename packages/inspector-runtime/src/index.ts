import {
  isStudioMessage,
  PATCHLENS_MESSAGE_SOURCE,
  type InspectorToStudioMessage,
  type Rectangle,
  type SelectedElement,
  type SelectionContext,
  type SourceManifest,
  type SourceManifestEntry,
  type VisualSelection,
} from "@patchlens-ai/agent-protocol";

export type InspectorOptions = {
  enabled?: boolean;
  manifestUrl?: string;
  studioOrigin?: string;
  onSelection?: (selection: VisualSelection) => void;
};

export type InspectorController = {
  enable(): void;
  disable(): void;
  clear(): void;
  destroy(): void;
  isEnabled(): boolean;
};

type Point = {
  x: number;
  y: number;
};

type Candidate = {
  element: HTMLElement;
  rectangle: Rectangle;
  score: number;
};

const OVERLAY_ID = "patchlens-inspector-overlay";
const INSPECTOR_INSTANCE_KEY = "__PATCHLENS_AI_INSPECTOR__";
const SOURCE_MANIFEST_UPDATED_EVENT = "patchlens:source-manifest-updated";
const DEFAULT_MANIFEST_URL = "/__patchlens/manifest";
const DRAG_THRESHOLD = 7;
const MAX_ELEMENT_HTML_CHARACTERS = 4000;
const MAX_CONTEXT_HTML_CHARACTERS = 6000;
const MAX_RUNTIME_ERRORS = 10;
const MAX_RUNTIME_ERROR_CHARACTERS = 500;
const COMPUTED_STYLE_PROPERTIES = [
  "display",
  "position",
  "inset",
  "z-index",
  "box-sizing",
  "width",
  "height",
  "min-width",
  "max-width",
  "min-height",
  "max-height",
  "margin",
  "padding",
  "gap",
  "grid-template-columns",
  "grid-template-rows",
  "flex-direction",
  "flex-wrap",
  "align-items",
  "justify-content",
  "overflow",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "text-align",
  "color",
  "background-color",
  "border",
  "border-radius",
  "box-shadow",
  "opacity",
  "transform",
] as const;

export function installPatchLensInspector(
  options: InspectorOptions = {},
): InspectorController {
  const globalWindow = window as Window & {
    [INSPECTOR_INSTANCE_KEY]?: InspectorController;
  };
  const previousController = globalWindow[INSPECTOR_INSTANCE_KEY];
  if (previousController && typeof previousController.destroy === "function") {
    try {
      previousController.destroy();
    } catch {
      delete globalWindow[INSPECTOR_INSTANCE_KEY];
    }
  }

  const existing = document.getElementById(OVERLAY_ID);
  existing?.remove();

  const overlayHost = document.createElement("div");
  overlayHost.id = OVERLAY_ID;
  overlayHost.style.position = "fixed";
  overlayHost.style.inset = "0";
  overlayHost.style.zIndex = "2147483646";
  overlayHost.style.pointerEvents = "none";
  overlayHost.setAttribute("aria-hidden", "true");

  const shadowRoot = overlayHost.attachShadow({ mode: "open" });
  shadowRoot.innerHTML = `
    <style>
      :host { all: initial; }
      .patchlens-box {
        position: fixed;
        display: none;
        pointer-events: none;
        border: 2px solid #f0642f;
        background: rgba(240, 100, 47, 0.13);
        box-shadow: 0 0 0 1px rgba(255,255,255,0.72) inset;
        box-sizing: border-box;
      }
      .patchlens-box[data-kind="drag"] {
        border-style: dashed;
        background: rgba(240, 100, 47, 0.08);
      }
      .patchlens-label {
        position: fixed;
        display: none;
        max-width: min(420px, calc(100vw - 20px));
        padding: 5px 8px;
        color: #fffaf6;
        background: #e85d2a;
        border-radius: 6px;
        font: 500 11px/1.3 ui-monospace, SFMono-Regular, Consolas, monospace;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        box-shadow: 0 5px 16px rgba(56, 27, 15, 0.22);
        pointer-events: none;
      }
    </style>
    <div class="patchlens-box" data-role="hover"></div>
    <div class="patchlens-box" data-role="selection"></div>
    <div class="patchlens-box" data-role="drag" data-kind="drag"></div>
    <div class="patchlens-label" data-role="label"></div>
  `;

  document.documentElement.appendChild(overlayHost);

  const hoverBox = getShadowElement<HTMLDivElement>(shadowRoot, "hover");
  const selectionBox = getShadowElement<HTMLDivElement>(shadowRoot, "selection");
  const dragBox = getShadowElement<HTMLDivElement>(shadowRoot, "drag");
  const label = getShadowElement<HTMLDivElement>(shadowRoot, "label");

  let enabled = options.enabled ?? true;
  let pointerStart: Point | undefined;
  let pointerCurrent: Point | undefined;
  let activePointerId: number | undefined;
  let activeElement: HTMLElement | undefined;
  let activeSelection: VisualSelection | undefined;
  let suppressNextClick = false;
  let frameRequest = 0;
  let manifestPromise: Promise<SourceManifest> | undefined;
  let sourceRefreshPending = false;
  const runtimeErrors: string[] = [];
  let controller!: InspectorController;

  const configuredStudioOrigin = normalizeOrigin(options.studioOrigin);
  if (options.studioOrigin && !configuredStudioOrigin) {
    throw new Error("PatchLens studioOrigin must be a valid HTTP(S) origin.");
  }
  const trustedStudioOrigin = configuredStudioOrigin ?? readParentOrigin();
  const targetOrigin = trustedStudioOrigin;
  const manifestUrl = options.manifestUrl ?? DEFAULT_MANIFEST_URL;
  // Older embedded previews may not expose observer APIs; selection still works without them.
  const selectionResizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => scheduleSelectionRender())
    : undefined;
  const mutationObserver = typeof MutationObserver === "function"
    ? new MutationObserver(() => scheduleSelectionRender())
    : undefined;

  function send(message: InspectorToStudioMessage): void {
    if (window.parent !== window && targetOrigin) {
      window.parent.postMessage(message, targetOrigin);
    }
  }

  function loadManifest(): Promise<SourceManifest> {
    manifestPromise ??= fetch(manifestUrl, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`PatchLens manifest returned ${response.status}`);
        }

        return (await response.json()) as SourceManifest;
      })
      .catch((error: unknown) => {
        console.warn("[PatchLens] Source manifest is unavailable.", error);
        return {};
      });

    return manifestPromise;
  }

  function handlePointerMove(event: PointerEvent): void {
    if (!enabled || (activePointerId !== undefined && event.pointerId !== activePointerId)) {
      return;
    }

    pointerCurrent = { x: event.clientX, y: event.clientY };

    if (pointerStart) {
      event.preventDefault();
      event.stopPropagation();
      drawBox(dragBox, rectangleFromPoints(pointerStart, pointerCurrent));
      hoverBox.style.display = "none";
      label.style.display = "none";
      return;
    }

    const element = findSelectableElement(event.clientX, event.clientY, overlayHost);
    if (!element) {
      hoverBox.style.display = "none";
      return;
    }

    drawBox(hoverBox, rectToRectangle(element.getBoundingClientRect()));
  }

  function handlePointerDown(event: PointerEvent): void {
    if (!enabled || event.button !== 0) {
      return;
    }

    if (!findSelectableElement(event.clientX, event.clientY, overlayHost)) {
      return;
    }

    pointerStart = { x: event.clientX, y: event.clientY };
    pointerCurrent = pointerStart;
    activePointerId = event.pointerId;
    suppressNextClick = true;
    dragBox.style.display = "none";
    event.preventDefault();
    event.stopPropagation();
  }

  async function handlePointerUp(event: PointerEvent): Promise<void> {
    if (
      !enabled ||
      !pointerStart ||
      (activePointerId !== undefined && event.pointerId !== activePointerId)
    ) {
      return;
    }

    const end = { x: event.clientX, y: event.clientY };
    const start = pointerStart;
    pointerStart = undefined;
    pointerCurrent = undefined;
    activePointerId = undefined;
    dragBox.style.display = "none";
    event.preventDefault();
    event.stopPropagation();
    window.setTimeout(() => {
      suppressNextClick = false;
    }, 0);

    const moved = Math.hypot(end.x - start.x, end.y - start.y);
    if (moved >= DRAG_THRESHOLD) {
      await selectRectangle(rectangleFromPoints(start, end));
      return;
    }

    const element = findSelectableElement(end.x, end.y, overlayHost);
    if (element) {
      await selectElement(element);
    }
  }

  function handleClick(event: MouseEvent): void {
    if (!enabled || !suppressNextClick) {
      return;
    }

    suppressNextClick = false;
    event.preventDefault();
    event.stopPropagation();
  }

  function cancelPointerSelection(): void {
    pointerStart = undefined;
    pointerCurrent = undefined;
    activePointerId = undefined;
    suppressNextClick = false;
    dragBox.style.display = "none";
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape" && enabled) {
      clearSelection();
    }
  }

  function handleWindowMessage(event: MessageEvent<unknown>): void {
    if (
      event.source !== window.parent ||
      !trustedStudioOrigin ||
      event.origin !== trustedStudioOrigin ||
      !isStudioMessage(event.data)
    ) {
      return;
    }
    const message = event.data;

    if (message.type === "studio:set-inspector-mode") {
      if (message.payload.enabled) {
        enable();
      } else {
        disable();
      }
    }

    if (message.type === "studio:clear-selection") {
      clearSelection();
    }
  }

  function handleRuntimeError(event: ErrorEvent): void {
    rememberRuntimeError(
      runtimeErrors,
      [event.message, event.filename, event.lineno ? `line ${event.lineno}` : ""]
        .filter(Boolean)
        .join(" at "),
    );
  }

  function handleUnhandledRejection(event: PromiseRejectionEvent): void {
    const reason = event.reason instanceof Error
      ? `${event.reason.name}: ${event.reason.message}`
      : String(event.reason ?? "Unhandled promise rejection");
    rememberRuntimeError(runtimeErrors, reason);
  }

  async function selectElement(element: HTMLElement): Promise<void> {
    manifestPromise = undefined;
    const manifest = await loadManifest();
    const selected = toSelectedElement(element, manifest);
    const selection = createSelection(
      [selected],
      selected,
      selected.rectangle,
      "element",
    );

    publishSelection(selection, element);
  }

  async function selectRectangle(rectangle: Rectangle): Promise<void> {
    manifestPromise = undefined;
    const manifest = await loadManifest();
    const candidates = collectCandidates(rectangle, overlayHost);

    if (candidates.length === 0) {
      const fallback = findSelectableElement(
        rectangle.x + rectangle.width / 2,
        rectangle.y + rectangle.height / 2,
        overlayHost,
      );

      if (fallback) {
        await selectElement(fallback);
      }
      return;
    }

    const elements = candidates
      .slice(0, 8)
      .map((candidate) => toSelectedElement(candidate.element, manifest));
    const primaryCandidate = candidates[0];
    const primaryElement = elements[0];

    if (!primaryCandidate || !primaryElement) {
      return;
    }

    const selection = createSelection(elements, primaryElement, rectangle, "region");
    publishSelection(selection, primaryCandidate.element);
  }

  function createSelection(
    elements: SelectedElement[],
    primaryElement: SelectedElement,
    rectangle: Rectangle,
    kind: VisualSelection["kind"],
  ): VisualSelection {
    const hasExactSource = Boolean(primaryElement.patchlensId && primaryElement.source);
    const hasAnySource = elements.some((element) => element.source);

    return {
      id: createSelectionId(),
      kind,
      route: `${window.location.pathname}${window.location.search}`,
      viewport: readViewport(),
      rectangle,
      elements,
      primaryElement,
      confidence: hasExactSource ? "exact" : hasAnySource ? "likely" : "visual-only",
      createdAt: new Date().toISOString(),
    };
  }

  function publishSelection(
    selection: VisualSelection,
    element: HTMLElement,
  ): void {
    activeElement = element;
    activeSelection = selection;
    selectionResizeObserver?.disconnect();
    selectionResizeObserver?.observe(element);
    hoverBox.style.display = "none";
    renderActiveSelection();
    options.onSelection?.(selection);
    send({
      source: PATCHLENS_MESSAGE_SOURCE,
      type: "inspector:selection",
      payload: selection,
    });
    send({
      source: PATCHLENS_MESSAGE_SOURCE,
      type: "inspector:selection-context",
      payload: buildSelectionContext(selection, element, runtimeErrors),
    });
  }

  function renderActiveSelection(): void {
    const element = resolveActiveElement();
    if (!element || !activeSelection) {
      selectionBox.style.display = "none";
      label.style.display = "none";
      return;
    }

    const rectangle = activeSelection.kind === "region"
      ? activeSelection.rectangle
      : rectToRectangle(element.getBoundingClientRect());
    drawBox(selectionBox, rectangle);

    const source = activeSelection.primaryElement.source;
    label.textContent = source
      ? `${source.componentName ?? source.tagName ?? "Element"} · ${source.file}:${source.line}`
      : `${activeSelection.primaryElement.tagName} · visual selection`;
    positionLabel(label, rectangle);
  }

  function scheduleSelectionRender(): void {
    window.cancelAnimationFrame(frameRequest);
    frameRequest = window.requestAnimationFrame(() => {
      const currentElement = resolveActiveElement();
      const currentSelection = activeSelection;
      if (!currentElement || !currentElement.isConnected || !currentSelection) {
        renderActiveSelection();
        return;
      }

      const primaryRectangle = rectToRectangle(currentElement.getBoundingClientRect());
      const primaryElement = {
        ...currentSelection.primaryElement,
        rectangle: primaryRectangle,
      };
      const elements = currentSelection.elements.map((element, index) => {
        if (index === 0) {
          return primaryElement;
        }
        const current = resolveSelectedElement(element);
        return current
          ? { ...element, rectangle: rectToRectangle(current.getBoundingClientRect()) }
          : element;
      });
      const rectangle = currentSelection.kind === "region"
        ? boundingRectangle(elements.map((element) => element.rectangle))
          ?? currentSelection.rectangle
        : primaryRectangle;
      const nextSelection: VisualSelection = {
        ...currentSelection,
        viewport: readViewport(),
        rectangle,
        primaryElement,
        elements,
      };
      activeSelection = nextSelection;
      renderActiveSelection();
      options.onSelection?.(nextSelection);
      send({
        source: PATCHLENS_MESSAGE_SOURCE,
        type: "inspector:selection",
        payload: nextSelection,
      });
      send({
        source: PATCHLENS_MESSAGE_SOURCE,
        type: "inspector:selection-context",
        payload: buildSelectionContext(nextSelection, currentElement, runtimeErrors),
      });
    });
  }

  function resolveActiveElement(): HTMLElement | undefined {
    if (activeElement?.isConnected) {
      return activeElement;
    }

    const patchlensId = activeSelection?.primaryElement.patchlensId;
    if (!patchlensId) {
      return undefined;
    }

    activeElement = Array.from(
      document.querySelectorAll<HTMLElement>("[data-patchlens-id]"),
    ).find((element) => element.dataset.patchlensId === patchlensId);
    if (activeElement) {
      selectionResizeObserver?.disconnect();
      selectionResizeObserver?.observe(activeElement);
      scheduleSourceManifestRefresh();
    }
    return activeElement;
  }

  function resolveSelectedElement(element: SelectedElement): HTMLElement | undefined {
    if (!element.patchlensId) {
      return undefined;
    }
    return Array.from(
      document.querySelectorAll<HTMLElement>("[data-patchlens-id]"),
    ).find((candidate) => candidate.dataset.patchlensId === element.patchlensId);
  }

  function scheduleSourceManifestRefresh(): void {
    if (sourceRefreshPending || !activeSelection) {
      return;
    }
    sourceRefreshPending = true;
    manifestPromise = undefined;
    void loadManifest()
      .then((manifest) => {
        const currentSelection = activeSelection;
        if (!currentSelection) {
          return;
        }
        const elements = currentSelection.elements.map((element) => ({
          ...element,
          source: element.patchlensId
            ? manifest[element.patchlensId] ?? element.source
            : element.source,
        }));
        const primaryElement = {
          ...currentSelection.primaryElement,
          source: currentSelection.primaryElement.patchlensId
            ? manifest[currentSelection.primaryElement.patchlensId]
              ?? currentSelection.primaryElement.source
            : currentSelection.primaryElement.source,
        };
        activeSelection = {
          ...currentSelection,
          primaryElement,
          elements: elements.map((element, index) =>
            index === 0 ? primaryElement : element,
          ),
        };
        scheduleSelectionRender();
      })
      .finally(() => {
        sourceRefreshPending = false;
      });
  }

  function handleSourceManifestUpdated(): void {
    scheduleSourceManifestRefresh();
  }

  function clearSelection(): void {
    activeElement = undefined;
    activeSelection = undefined;
    selectionResizeObserver?.disconnect();
    selectionBox.style.display = "none";
    label.style.display = "none";
    send({
      source: PATCHLENS_MESSAGE_SOURCE,
      type: "inspector:selection-cleared",
    });
  }

  function enable(): void {
    enabled = true;
  }

  function disable(): void {
    enabled = false;
    cancelPointerSelection();
    hoverBox.style.display = "none";
  }

  function destroy(): void {
    window.cancelAnimationFrame(frameRequest);
    window.removeEventListener("pointermove", handlePointerMove, true);
    window.removeEventListener("pointerdown", handlePointerDown, true);
    window.removeEventListener("pointerup", handlePointerUp, true);
    window.removeEventListener("pointercancel", cancelPointerSelection, true);
    window.removeEventListener("click", handleClick, true);
    window.removeEventListener("keydown", handleKeyDown, true);
    window.removeEventListener("message", handleWindowMessage);
    window.removeEventListener("error", handleRuntimeError);
    window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    window.removeEventListener("scroll", scheduleSelectionRender, true);
    window.removeEventListener("resize", scheduleSelectionRender);
    window.removeEventListener("blur", cancelPointerSelection);
    window.removeEventListener(SOURCE_MANIFEST_UPDATED_EVENT, handleSourceManifestUpdated);
    selectionResizeObserver?.disconnect();
    mutationObserver?.disconnect();
    overlayHost.remove();
    if (globalWindow[INSPECTOR_INSTANCE_KEY] === controller) {
      delete globalWindow[INSPECTOR_INSTANCE_KEY];
    }
  }

  window.addEventListener("pointermove", handlePointerMove, true);
  window.addEventListener("pointerdown", handlePointerDown, true);
  window.addEventListener("pointerup", handlePointerUp, true);
  window.addEventListener("pointercancel", cancelPointerSelection, true);
  window.addEventListener("click", handleClick, true);
  window.addEventListener("keydown", handleKeyDown, true);
  window.addEventListener("message", handleWindowMessage);
  window.addEventListener("error", handleRuntimeError);
  window.addEventListener("unhandledrejection", handleUnhandledRejection);
  window.addEventListener("scroll", scheduleSelectionRender, true);
  window.addEventListener("resize", scheduleSelectionRender);
  window.addEventListener("blur", cancelPointerSelection);
  window.addEventListener(SOURCE_MANIFEST_UPDATED_EVENT, handleSourceManifestUpdated);
  mutationObserver?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "hidden", "style"],
    childList: true,
    characterData: true,
    subtree: true,
  });

  send({
    source: PATCHLENS_MESSAGE_SOURCE,
    type: "inspector:ready",
    payload: {
      route: `${window.location.pathname}${window.location.search}`,
    },
  });

  controller = {
    enable,
    disable,
    clear: clearSelection,
    destroy,
    isEnabled: () => enabled,
  };
  globalWindow[INSPECTOR_INSTANCE_KEY] = controller;
  return controller;
}

function readViewport(): VisualSelection["viewport"] {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    deviceScaleFactor: window.devicePixelRatio,
  };
}

function getShadowElement<T extends HTMLElement>(
  root: ShadowRoot,
  role: string,
): T {
  const element = root.querySelector<T>(`[data-role="${role}"]`);
  if (!element) {
    throw new Error(`PatchLens overlay element "${role}" is missing.`);
  }

  return element;
}

function findSelectableElement(
  x: number,
  y: number,
  overlayHost: HTMLElement,
): HTMLElement | undefined {
  const elements = document.elementsFromPoint(x, y);

  for (const candidate of elements) {
    if (!(candidate instanceof HTMLElement) || candidate === overlayHost) {
      continue;
    }

    const instrumented = candidate.closest<HTMLElement>("[data-patchlens-id]");
    if (instrumented && instrumented !== overlayHost) {
      return instrumented;
    }

    if (!candidate.closest(`#${OVERLAY_ID}`)) {
      return candidate;
    }
  }

  return undefined;
}

function collectCandidates(
  selection: Rectangle,
  overlayHost: HTMLElement,
): Candidate[] {
  const selectionArea = Math.max(1, selection.width * selection.height);
  const candidates: Candidate[] = [];

  for (const element of document.querySelectorAll<HTMLElement>("[data-patchlens-id]")) {
    if (element === overlayHost || !element.isConnected) {
      continue;
    }

    const rectangle = rectToRectangle(element.getBoundingClientRect());
    if (rectangle.width <= 1 || rectangle.height <= 1) {
      continue;
    }

    const overlap = intersectionArea(selection, rectangle);
    if (overlap <= 0) {
      continue;
    }

    const elementArea = rectangle.width * rectangle.height;
    const elementCoverage = overlap / elementArea;
    const selectionCoverage = overlap / selectionArea;
    const score = elementCoverage * 0.68 + selectionCoverage * 0.32;

    candidates.push({ element, rectangle, score });
  }

  return candidates.sort((left, right) => {
    if (Math.abs(right.score - left.score) > 0.01) {
      return right.score - left.score;
    }

    const leftArea = left.rectangle.width * left.rectangle.height;
    const rightArea = right.rectangle.width * right.rectangle.height;
    return rightArea - leftArea;
  });
}

function toSelectedElement(
  element: HTMLElement,
  manifest: SourceManifest,
): SelectedElement {
  const patchlensId = element.dataset.patchlensId;
  const source = patchlensId ? manifest[patchlensId] : undefined;

  return {
    patchlensId,
    tagName: element.tagName.toLowerCase(),
    text: collapseWhitespace(element.innerText).slice(0, 180),
    directText: getDirectText(element),
    html: sanitizeHtml(element, MAX_ELEMENT_HTML_CHARACTERS),
    rectangle: rectToRectangle(element.getBoundingClientRect()),
    source,
  };
}

function getDirectText(element: HTMLElement): string {
  const text = Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? "")
    .join(" ");

  return collapseWhitespace(text).slice(0, 180);
}

function sanitizeHtml(element: HTMLElement, maxCharacters: number): string {
  const clone = element.cloneNode(true) as HTMLElement;

  for (const unsafe of clone.querySelectorAll(
    "script, style, noscript, iframe, object, embed",
  )) {
    unsafe.remove();
  }

  if (clone instanceof HTMLInputElement) {
    clone.removeAttribute("value");
  }

  if (clone instanceof HTMLTextAreaElement) {
    clone.textContent = "";
  }

  for (const attribute of [...clone.attributes]) {
    if (isSensitiveAttribute(attribute.name)) {
      clone.removeAttribute(attribute.name);
    }
  }

  for (const sensitive of clone.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    "input, textarea",
  )) {
    sensitive.removeAttribute("value");
    sensitive.textContent = "";
  }

  for (const node of clone.querySelectorAll<HTMLElement>("*")) {
    for (const attribute of [...node.attributes]) {
      if (isSensitiveAttribute(attribute.name)) {
        node.removeAttribute(attribute.name);
      }
    }
  }

  return clone.outerHTML.slice(0, maxCharacters);
}

function buildSelectionContext(
  selection: VisualSelection,
  element: HTMLElement,
  runtimeErrors: string[],
): SelectionContext {
  const boundedHtml = sanitizeHtml(element, MAX_CONTEXT_HTML_CHARACTERS + 1);
  const sanitizedHtml = boundedHtml.slice(0, MAX_CONTEXT_HTML_CHARACTERS);
  const computedStyles = readComputedStyles(element);
  const contextWithoutSize = {
    selection,
    sanitizedHtml,
    computedStyles,
    accessibilitySummary: buildAccessibilitySummary(element),
    consoleErrors: runtimeErrors.slice(-MAX_RUNTIME_ERRORS),
    capturedAt: new Date().toISOString(),
    truncated: {
      html: boundedHtml.length > MAX_CONTEXT_HTML_CHARACTERS,
      styles: false,
      consoleErrors: runtimeErrors.length > MAX_RUNTIME_ERRORS,
    },
  };

  const serialized = JSON.stringify(contextWithoutSize);
  const approximateBytes = typeof TextEncoder === "function"
    ? new TextEncoder().encode(serialized).byteLength
    : serialized.length;

  return {
    ...contextWithoutSize,
    approximateBytes,
  };
}

function readComputedStyles(element: HTMLElement): Record<string, string> {
  const styles = window.getComputedStyle(element);
  return Object.fromEntries(
    COMPUTED_STYLE_PROPERTIES.map((property) => [
      property,
      collapseWhitespace(styles.getPropertyValue(property)).slice(0, 240),
    ]).filter((entry) => Boolean(entry[1])),
  );
}

function buildAccessibilitySummary(element: HTMLElement): string {
  const explicitRole = element.getAttribute("role");
  const implicitRole = inferImplicitRole(element);
  const name = readAccessibleName(element);
  const states = [
    element.hasAttribute("disabled") ? "disabled" : "",
    formatAriaState(element, "aria-expanded"),
    formatAriaState(element, "aria-selected"),
    formatAriaState(element, "aria-checked"),
    element.tabIndex >= 0 ? `tabindex=${element.tabIndex}` : "",
  ].filter(Boolean);

  return [
    `role=${explicitRole ?? implicitRole ?? "generic"}`,
    name ? `name=${JSON.stringify(name.slice(0, 240))}` : "name=unavailable",
    states.length > 0 ? `state=${states.join(", ")}` : "",
  ].filter(Boolean).join("; ");
}

function inferImplicitRole(element: HTMLElement): string | undefined {
  if (element instanceof HTMLButtonElement) {
    return "button";
  }
  if (element instanceof HTMLAnchorElement && element.hasAttribute("href")) {
    return "link";
  }
  if (element instanceof HTMLInputElement) {
    return element.type === "checkbox" ? "checkbox" : "textbox";
  }
  if (element instanceof HTMLSelectElement) {
    return "combobox";
  }
  if (element instanceof HTMLTextAreaElement) {
    return "textbox";
  }
  if (/^H[1-6]$/.test(element.tagName)) {
    return "heading";
  }
  return undefined;
}

function readAccessibleName(element: HTMLElement): string {
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) {
    return collapseWhitespace(ariaLabel);
  }

  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const value = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    if (collapseWhitespace(value)) {
      return collapseWhitespace(value);
    }
  }

  if (element instanceof HTMLImageElement && element.alt) {
    return collapseWhitespace(element.alt);
  }
  if (element instanceof HTMLInputElement && element.labels?.length) {
    return collapseWhitespace(
      Array.from(element.labels).map((label) => label.innerText).join(" "),
    );
  }

  return collapseWhitespace(element.innerText || element.title || "");
}

function formatAriaState(element: HTMLElement, attribute: string): string {
  const value = element.getAttribute(attribute);
  return value === null ? "" : `${attribute.replace("aria-", "")}=${value}`;
}

function isSensitiveAttribute(name: string): boolean {
  return /^(?:on.+|value|style|src|srcset|href|action|formaction|poster|xlink:href|srcdoc|nonce|data-(?:token|secret|password|api-key))$/i.test(
    name,
  );
}

function rememberRuntimeError(errors: string[], message: string): void {
  const normalized = sanitizeRuntimeError(message).slice(0, MAX_RUNTIME_ERROR_CHARACTERS);
  if (!normalized) {
    return;
  }
  errors.push(normalized);
  if (errors.length > MAX_RUNTIME_ERRORS * 2) {
    errors.splice(0, errors.length - MAX_RUNTIME_ERRORS * 2);
  }
}

function sanitizeRuntimeError(message: string): string {
  return collapseWhitespace(message)
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{12,}\b/g, "[redacted-key]")
    .replace(/[A-Za-z]:\\[^\s]+/g, "[local path]")
    .replace(/(?:^|\s)\/(?:Users|home|private|var|tmp)\/[^\s]+/g, "$1[local path]")
    .replace(/https?:\/\/[^\s?#]+(?:\?[^\s#]*)?(?:#[^\s]*)?/g, (url) =>
      url.replace(/[?#].*$/, ""),
    );
}

function rectangleFromPoints(start: Point, end: Point): Rectangle {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

function rectToRectangle(rectangle: DOMRect): Rectangle {
  return {
    x: rectangle.left,
    y: rectangle.top,
    width: rectangle.width,
    height: rectangle.height,
  };
}

function intersectionArea(left: Rectangle, right: Rectangle): number {
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
  );
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
  );
  return width * height;
}

function boundingRectangle(rectangles: Rectangle[]): Rectangle | undefined {
  const visible = rectangles.filter((rectangle) =>
    rectangle.width > 0 && rectangle.height > 0
  );
  if (visible.length === 0) {
    return undefined;
  }
  const left = Math.min(...visible.map((rectangle) => rectangle.x));
  const top = Math.min(...visible.map((rectangle) => rectangle.y));
  const right = Math.max(...visible.map((rectangle) => rectangle.x + rectangle.width));
  const bottom = Math.max(...visible.map((rectangle) => rectangle.y + rectangle.height));
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

function drawBox(element: HTMLElement, rectangle: Rectangle): void {
  element.style.display = "block";
  element.style.left = `${rectangle.x}px`;
  element.style.top = `${rectangle.y}px`;
  element.style.width = `${rectangle.width}px`;
  element.style.height = `${rectangle.height}px`;
}

function positionLabel(label: HTMLElement, rectangle: Rectangle): void {
  const top = rectangle.y >= 34 ? rectangle.y - 29 : rectangle.y + rectangle.height + 5;
  label.style.display = "block";
  label.style.left = `${Math.max(8, rectangle.x)}px`;
  label.style.top = `${Math.max(5, top)}px`;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function createSelectionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `sel_${crypto.randomUUID()}`;
  }

  return `sel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function readParentOrigin(): string | undefined {
  if (window.parent === window) {
    return undefined;
  }

  const ancestorOrigins = (window.location as Location & {
    ancestorOrigins?: DOMStringList;
  }).ancestorOrigins;
  const ancestorOrigin = ancestorOrigins?.item(0);
  if (ancestorOrigin) {
    return normalizeOrigin(ancestorOrigin);
  }

  return normalizeOrigin(document.referrer);
}

function normalizeOrigin(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    if (url.username || url.password) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}
