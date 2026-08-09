export const PATCHLENS_MESSAGE_SOURCE = "patchlens-ai" as const;

export type Rectangle = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ViewportPreset = "desktop" | "tablet" | "mobile" | "custom";
export type ViewportOrientation = "portrait" | "landscape";

export type Viewport = {
  width: number;
  height: number;
  deviceScaleFactor: number;
  preset?: ViewportPreset;
  orientation?: ViewportOrientation;
};

export type SourceLocation = {
  id: string;
  framework: "react" | "next" | "unknown";
  componentName?: string;
  file: string;
  line: number;
  column: number;
  tagName?: string;
};

export type SourceManifestEntry = SourceLocation;

export type SourceManifest = Record<string, SourceManifestEntry>;

export type SelectionConfidence = "exact" | "likely" | "visual-only";

export type SelectedElement = {
  patchlensId?: string;
  tagName: string;
  text: string;
  directText?: string;
  html: string;
  rectangle: Rectangle;
  source?: SourceLocation;
};

export type VisualSelection = {
  id: string;
  kind: "element" | "region";
  route: string;
  viewport: Viewport;
  rectangle: Rectangle;
  elements: SelectedElement[];
  primaryElement: SelectedElement;
  confidence: SelectionConfidence;
  createdAt: string;
};

export type SelectionContext = {
  selection: VisualSelection;
  sanitizedHtml: string;
  computedStyles: Record<string, string>;
  accessibilitySummary?: string;
  consoleErrors: string[];
  capturedAt: string;
  approximateBytes: number;
  truncated: {
    html: boolean;
    styles: boolean;
    consoleErrors: boolean;
  };
};

export type ActiveSelectionSnapshot = {
  selection: VisualSelection;
  context?: SelectionContext;
  updatedAt: string;
};

export type InspectorReadyMessage = {
  source: typeof PATCHLENS_MESSAGE_SOURCE;
  type: "inspector:ready";
  payload: {
    route: string;
  };
};

export type InspectorSelectionMessage = {
  source: typeof PATCHLENS_MESSAGE_SOURCE;
  type: "inspector:selection";
  payload: VisualSelection;
};

export type InspectorSelectionContextMessage = {
  source: typeof PATCHLENS_MESSAGE_SOURCE;
  type: "inspector:selection-context";
  payload: SelectionContext;
};

export type InspectorSelectionClearedMessage = {
  source: typeof PATCHLENS_MESSAGE_SOURCE;
  type: "inspector:selection-cleared";
};

export type InspectorToStudioMessage =
  | InspectorReadyMessage
  | InspectorSelectionMessage
  | InspectorSelectionContextMessage
  | InspectorSelectionClearedMessage;

export type StudioSetInspectorModeMessage = {
  source: typeof PATCHLENS_MESSAGE_SOURCE;
  type: "studio:set-inspector-mode";
  payload: {
    enabled: boolean;
  };
};

export type StudioClearSelectionMessage = {
  source: typeof PATCHLENS_MESSAGE_SOURCE;
  type: "studio:clear-selection";
};

export type StudioToInspectorMessage =
  | StudioSetInspectorModeMessage
  | StudioClearSelectionMessage;

export type ProviderId = "mock" | "codex" | "claude" | string;

export type AgentSession = {
  id: string;
  projectId: string;
  provider: ProviderId;
  providerSessionId?: string;
  status: "idle" | "running" | "waiting" | "failed";
  activeSelectionId?: string;
  createdAt: string;
};

export type AgentRequest = {
  sessionId?: string;
  provider: ProviderId;
  instruction: string;
  selection: VisualSelection;
  context?: SelectionContext;
  conversation?: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
  scopePolicy: "prefer-selection" | "strict" | "allow-related";
  approvedScopeExpansion?: string[];
};

export type AgentEvent =
  | { type: "session"; session: AgentSession }
  | { type: "status"; status: AgentSession["status"]; message: string }
  | { type: "message"; role: "assistant"; content: string }
  | { type: "files"; files: string[] }
  | { type: "transaction"; transaction: PatchTransaction }
  | { type: "complete"; sessionId: string };

export type PatchTransactionStatus =
  | "running"
  | "applied"
  | "reverted"
  | "conflicted"
  | "failed";

export type PatchFileChange = {
  file: string;
  beforeHash: string;
  afterHash: string;
  diff: string;
  additions: number;
  deletions: number;
};

export type PatchVerification = {
  status: "passed" | "partial" | "failed" | "skipped";
  route: string;
  viewport: Viewport;
  checks: Array<{
    name: string;
    status: "passed" | "failed" | "skipped";
    detail: string;
  }>;
  checkedAt: string;
};

export type PatchTransaction = {
  id: string;
  sessionId: string;
  selectionId: string;
  instruction: string;
  status: PatchTransactionStatus;
  files: PatchFileChange[];
  scopeExpansion: string[];
  undoAvailable: boolean;
  failureReason?: string;
  verification?: PatchVerification;
  createdAt: string;
  updatedAt: string;
};

export type AgentChatResponse = {
  session: AgentSession;
  reply: string;
  sourceSummary: string;
  plannedFiles: string[];
  transaction?: PatchTransaction;
  scopeExpansionRequired?: string[];
};

export type PatchTransactionHistoryResponse = {
  transactions: PatchTransaction[];
};

export type UndoPatchTransactionResponse = {
  transaction: PatchTransaction;
  message: string;
};

export type DaemonHealth = {
  ok: true;
  service: "patchlens-daemon";
  version: string;
  authentication: {
    browserSession: true;
    bearerToken: true;
  };
  providers: Array<{
    id: ProviderId;
    status: "available" | "planned" | "unavailable";
    detail?: string;
  }>;
};

export type DaemonProjectInfo = {
  projectId: string;
  previewUrl: string;
  transactionHistory: boolean;
};

export function isInspectorMessage(value: unknown): value is InspectorToStudioMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (
    candidate.source !== PATCHLENS_MESSAGE_SOURCE ||
    typeof candidate.type !== "string" ||
    !candidate.type.startsWith("inspector:")
  ) {
    return false;
  }

  switch (candidate.type) {
    case "inspector:ready":
      return isRecord(candidate.payload) &&
        typeof candidate.payload.route === "string" &&
        candidate.payload.route.length <= 2_000;
    case "inspector:selection":
      return isVisualSelection(candidate.payload);
    case "inspector:selection-context":
      return isSelectionContext(candidate.payload);
    case "inspector:selection-cleared":
      return candidate.payload === undefined;
    default:
      return false;
  }
}

export function isStudioMessage(value: unknown): value is StudioToInspectorMessage {
  if (!isRecord(value) || value.source !== PATCHLENS_MESSAGE_SOURCE) {
    return false;
  }

  switch (value.type) {
    case "studio:set-inspector-mode":
      return isRecord(value.payload) && typeof value.payload.enabled === "boolean";
    case "studio:clear-selection":
      return value.payload === undefined;
    default:
      return false;
  }
}

export function isVisualSelection(value: unknown): value is VisualSelection {
  if (!isRecord(value)) {
    return false;
  }
  const elements = value.elements;
  const primaryElement = value.primaryElement;
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 240 ||
    (value.kind !== "element" && value.kind !== "region") ||
    typeof value.route !== "string" ||
    value.route.length > 2_000 ||
    !isViewport(value.viewport) ||
    !isRectangle(value.rectangle) ||
    !Array.isArray(elements) ||
    elements.length === 0 ||
    elements.length > 16 ||
    !isSelectedElement(primaryElement) ||
    !isSelectionConfidence(value.confidence) ||
    typeof value.createdAt !== "string" ||
    value.createdAt.length > 100
  ) {
    return false;
  }

  const selectedElements = elements.filter(isSelectedElement);
  return selectedElements.length === elements.length &&
    selectedElements.some((element) => representsSameElement(element, primaryElement));
}

export function isSelectionContext(value: unknown): value is SelectionContext {
  if (!isRecord(value) || !isVisualSelection(value.selection)) {
    return false;
  }
  if (
    typeof value.sanitizedHtml !== "string" ||
    value.sanitizedHtml.length > 12_000 ||
    !isRecord(value.computedStyles) ||
    Object.keys(value.computedStyles).length > 100 ||
    !Array.isArray(value.consoleErrors) ||
    value.consoleErrors.length > 20 ||
    typeof value.capturedAt !== "string" ||
    value.capturedAt.length > 100 ||
    typeof value.approximateBytes !== "number" ||
    !Number.isFinite(value.approximateBytes) ||
    value.approximateBytes < 0 ||
    value.approximateBytes > 320 * 1_024 ||
    (value.accessibilitySummary !== undefined &&
      (typeof value.accessibilitySummary !== "string" ||
        value.accessibilitySummary.length > 2_000)) ||
    !isRecord(value.truncated)
  ) {
    return false;
  }

  if (
    value.selection.id.length === 0 ||
    Object.entries(value.computedStyles).some(([name, style]) =>
      name.length > 120 || typeof style !== "string" || style.length > 500
    ) ||
    value.consoleErrors.some((error) =>
      typeof error !== "string" || error.length > 1_000
    ) ||
    typeof value.truncated.html !== "boolean" ||
    typeof value.truncated.styles !== "boolean" ||
    typeof value.truncated.consoleErrors !== "boolean"
  ) {
    return false;
  }

  return true;
}

function isSelectedElement(value: unknown): value is SelectedElement {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value.patchlensId === undefined ||
      (typeof value.patchlensId === "string" &&
        value.patchlensId.length > 0 &&
        value.patchlensId.length <= 240)) &&
    typeof value.tagName === "string" &&
    value.tagName.length > 0 &&
    value.tagName.length <= 120 &&
    typeof value.text === "string" &&
    value.text.length <= 2_000 &&
    (value.directText === undefined ||
      (typeof value.directText === "string" && value.directText.length <= 2_000)) &&
    typeof value.html === "string" &&
    value.html.length <= 8_000 &&
    isRectangle(value.rectangle) &&
    (value.source === undefined || isSourceLocation(value.source))
  );
}

function isSourceLocation(value: unknown): value is SourceLocation {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 240 &&
    (value.framework === "react" || value.framework === "next" || value.framework === "unknown") &&
    typeof value.file === "string" &&
    value.file.length > 0 &&
    value.file.length <= 1_000 &&
    !value.file.includes("\0") &&
    typeof value.line === "number" &&
    Number.isInteger(value.line) &&
    value.line > 0 &&
    typeof value.column === "number" &&
    Number.isInteger(value.column) &&
    value.column > 0 &&
    (value.componentName === undefined ||
      (typeof value.componentName === "string" && value.componentName.length <= 240)) &&
    (value.tagName === undefined ||
      (typeof value.tagName === "string" && value.tagName.length <= 120))
  );
}

function isSelectionConfidence(value: unknown): value is SelectionConfidence {
  return value === "exact" || value === "likely" || value === "visual-only";
}

function isRectangle(value: unknown): value is Rectangle {
  if (!isRecord(value)) {
    return false;
  }
  const { x, y, width, height } = value;
  return isBoundedNumber(x, 100_000) &&
    isBoundedNumber(y, 100_000) &&
    isBoundedNumber(width, 100_000) &&
    isBoundedNumber(height, 100_000) &&
    width >= 0 &&
    height >= 0;
}

function isViewport(value: unknown): value is Viewport {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.width === "number" &&
    typeof value.height === "number" &&
    typeof value.deviceScaleFactor === "number" &&
    Number.isFinite(value.width) &&
    Number.isFinite(value.height) &&
    Number.isFinite(value.deviceScaleFactor) &&
    value.width > 0 &&
    value.width <= 20_000 &&
    value.height > 0 &&
    value.height <= 20_000 &&
    value.deviceScaleFactor > 0 &&
    value.deviceScaleFactor <= 10 &&
    (value.preset === undefined ||
      value.preset === "desktop" ||
      value.preset === "tablet" ||
      value.preset === "mobile" ||
      value.preset === "custom") &&
    (value.orientation === undefined ||
      value.orientation === "portrait" ||
      value.orientation === "landscape")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isBoundedNumber(value: unknown, absoluteLimit: number): value is number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= absoluteLimit;
}

function representsSameElement(left: SelectedElement, right: SelectedElement): boolean {
  return left.patchlensId === right.patchlensId &&
    left.tagName === right.tagName &&
    left.text === right.text &&
    left.directText === right.directText &&
    left.html === right.html &&
    rectanglesMatch(left.rectangle, right.rectangle) &&
    sourceLocationsMatch(left.source, right.source);
}

function rectanglesMatch(left: Rectangle, right: Rectangle): boolean {
  return left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height;
}

function sourceLocationsMatch(
  left: SourceLocation | undefined,
  right: SourceLocation | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return left.id === right.id &&
    left.framework === right.framework &&
    left.componentName === right.componentName &&
    left.file === right.file &&
    left.line === right.line &&
    left.column === right.column &&
    left.tagName === right.tagName;
}
