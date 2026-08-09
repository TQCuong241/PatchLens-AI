import {
  PATCHLENS_MESSAGE_SOURCE,
  type InspectorToStudioMessage,
  type Rectangle,
  type SelectedElement,
  type SourceManifest,
  type SourceManifestEntry,
  type StudioToInspectorMessage,
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
const DEFAULT_MANIFEST_URL = "/__patchlens/manifest";
const DRAG_THRESHOLD = 7;

export function installPatchLensInspector(
  options: InspectorOptions = {},
): InspectorController {
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
  let activeElement: HTMLElement | undefined;
  let activeSelection: VisualSelection | undefined;
  let suppressNextClick = false;
  let frameRequest = 0;
  let manifestPromise: Promise<SourceManifest> | undefined;

  const targetOrigin = options.studioOrigin ?? "*";
  const manifestUrl = options.manifestUrl ?? DEFAULT_MANIFEST_URL;

  function send(message: InspectorToStudioMessage): void {
    if (window.parent !== window) {
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
    if (!enabled) {
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
    suppressNextClick = true;
    dragBox.style.display = "none";
    event.preventDefault();
    event.stopPropagation();
  }

  async function handlePointerUp(event: PointerEvent): Promise<void> {
    if (!enabled || !pointerStart) {
      return;
    }

    const end = { x: event.clientX, y: event.clientY };
    const start = pointerStart;
    pointerStart = undefined;
    pointerCurrent = undefined;
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

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape" && enabled) {
      clearSelection();
    }
  }

  function handleWindowMessage(event: MessageEvent<StudioToInspectorMessage>): void {
    const message = event.data;
    if (!message || message.source !== PATCHLENS_MESSAGE_SOURCE) {
      return;
    }

    if (message.type === "studio:set-inspector-mode") {
      enabled = message.payload.enabled;
      if (!enabled) {
        hoverBox.style.display = "none";
        dragBox.style.display = "none";
      }
    }

    if (message.type === "studio:clear-selection") {
      clearSelection();
    }
  }

  async function selectElement(element: HTMLElement): Promise<void> {
    manifestPromise = undefined;
    const manifest = await loadManifest();
    const selected = toSelectedElement(element, manifest);
    const selection = createSelection(
      [selected],
      selected,
      selected.rectangle,
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

    const selection = createSelection(elements, primaryElement, rectangle);
    publishSelection(selection, primaryCandidate.element);
  }

  function createSelection(
    elements: SelectedElement[],
    primaryElement: SelectedElement,
    rectangle: Rectangle,
  ): VisualSelection {
    const hasExactSource = Boolean(primaryElement.patchlensId && primaryElement.source);
    const hasAnySource = elements.some((element) => element.source);

    return {
      id: createSelectionId(),
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
    hoverBox.style.display = "none";
    renderActiveSelection();
    options.onSelection?.(selection);
    send({
      source: PATCHLENS_MESSAGE_SOURCE,
      type: "inspector:selection",
      payload: selection,
    });
  }

  function renderActiveSelection(): void {
    const element = resolveActiveElement();
    if (!element || !activeSelection) {
      selectionBox.style.display = "none";
      label.style.display = "none";
      return;
    }

    const rectangle = rectToRectangle(element.getBoundingClientRect());
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
      renderActiveSelection();

      if (!activeElement || !activeElement.isConnected || !activeSelection) {
        return;
      }

      const rectangle = rectToRectangle(activeElement.getBoundingClientRect());
      const primaryElement = {
        ...activeSelection.primaryElement,
        rectangle,
      };
      activeSelection = {
        ...activeSelection,
        viewport: readViewport(),
        rectangle,
        primaryElement,
        elements: activeSelection.elements.map((element, index) =>
          index === 0 ? primaryElement : element,
        ),
      };
      options.onSelection?.(activeSelection);
      send({
        source: PATCHLENS_MESSAGE_SOURCE,
        type: "inspector:selection",
        payload: activeSelection,
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
    return activeElement;
  }

  function clearSelection(): void {
    activeElement = undefined;
    activeSelection = undefined;
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
    hoverBox.style.display = "none";
    dragBox.style.display = "none";
  }

  function destroy(): void {
    window.cancelAnimationFrame(frameRequest);
    window.removeEventListener("pointermove", handlePointerMove, true);
    window.removeEventListener("pointerdown", handlePointerDown, true);
    window.removeEventListener("pointerup", handlePointerUp, true);
    window.removeEventListener("click", handleClick, true);
    window.removeEventListener("keydown", handleKeyDown, true);
    window.removeEventListener("message", handleWindowMessage);
    window.removeEventListener("scroll", scheduleSelectionRender, true);
    window.removeEventListener("resize", scheduleSelectionRender);
    overlayHost.remove();
  }

  window.addEventListener("pointermove", handlePointerMove, true);
  window.addEventListener("pointerdown", handlePointerDown, true);
  window.addEventListener("pointerup", handlePointerUp, true);
  window.addEventListener("click", handleClick, true);
  window.addEventListener("keydown", handleKeyDown, true);
  window.addEventListener("message", handleWindowMessage);
  window.addEventListener("scroll", scheduleSelectionRender, true);
  window.addEventListener("resize", scheduleSelectionRender);

  send({
    source: PATCHLENS_MESSAGE_SOURCE,
    type: "inspector:ready",
    payload: {
      route: `${window.location.pathname}${window.location.search}`,
    },
  });

  return {
    enable,
    disable,
    clear: clearSelection,
    destroy,
    isEnabled: () => enabled,
  };
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
    html: sanitizeHtml(element),
    rectangle: rectToRectangle(element.getBoundingClientRect()),
    source,
  };
}

function sanitizeHtml(element: HTMLElement): string {
  const clone = element.cloneNode(true) as HTMLElement;

  if (clone instanceof HTMLInputElement) {
    clone.removeAttribute("value");
  }

  if (clone instanceof HTMLTextAreaElement) {
    clone.textContent = "";
  }

  for (const attribute of [...clone.attributes]) {
    if (/^(value|data-token|data-secret|data-password)$/i.test(attribute.name)) {
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
      if (/^(value|data-token|data-secret|data-password)$/i.test(attribute.name)) {
        node.removeAttribute(attribute.name);
      }
    }
  }

  return clone.outerHTML.slice(0, 4000);
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
  if (typeof crypto.randomUUID === "function") {
    return `sel_${crypto.randomUUID()}`;
  }

  return `sel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}
