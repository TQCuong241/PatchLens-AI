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
  html: string;
  rectangle: Rectangle;
  source?: SourceLocation;
};

export type VisualSelection = {
  id: string;
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

export type InspectorSelectionClearedMessage = {
  source: typeof PATCHLENS_MESSAGE_SOURCE;
  type: "inspector:selection-cleared";
};

export type InspectorToStudioMessage =
  | InspectorReadyMessage
  | InspectorSelectionMessage
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
  scopePolicy: "prefer-selection" | "strict" | "allow-related";
};

export type AgentEvent =
  | { type: "session"; session: AgentSession }
  | { type: "status"; status: AgentSession["status"]; message: string }
  | { type: "message"; role: "assistant"; content: string }
  | { type: "files"; files: string[] }
  | { type: "complete"; sessionId: string };

export type AgentChatResponse = {
  session: AgentSession;
  reply: string;
  sourceSummary: string;
  plannedFiles: string[];
};

export type DaemonHealth = {
  ok: true;
  service: "patchlens-daemon";
  version: string;
  providers: Array<{
    id: ProviderId;
    status: "available" | "planned" | "unavailable";
  }>;
};

export function isInspectorMessage(value: unknown): value is InspectorToStudioMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<InspectorToStudioMessage>;
  return (
    candidate.source === PATCHLENS_MESSAGE_SOURCE &&
    typeof candidate.type === "string" &&
    candidate.type.startsWith("inspector:")
  );
}
