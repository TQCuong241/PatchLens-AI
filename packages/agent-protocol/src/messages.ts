import type { PATCHLENS_MESSAGE_SOURCE } from './constants.js';
import type {
  InspectorSelectionContext,
  ProtocolVersion,
  Viewport,
  VisualSelection,
} from './selection.js';

type ProtocolMessage<Type extends string, Payload> = {
  source: typeof PATCHLENS_MESSAGE_SOURCE;
  schemaVersion: ProtocolVersion;
  messageId: string;
  channelId: string;
  projectId: string;
  type: Type;
  payload: Payload;
};

export type InspectorReadyMessage = ProtocolMessage<
  'inspector:ready',
  {
    route: string;
    viewport: Viewport;
  }
>;

export type InspectorSelectionMessage = ProtocolMessage<'inspector:selection', VisualSelection>;

export type InspectorSelectionClearedMessage = ProtocolMessage<
  'inspector:selection-cleared',
  {
    selectionId?: string;
  }
>;

export type InspectorContextMessage = ProtocolMessage<
  'inspector:context',
  InspectorSelectionContext
>;

export type InspectorToStudioMessage =
  | InspectorReadyMessage
  | InspectorSelectionMessage
  | InspectorContextMessage
  | InspectorSelectionClearedMessage;

export type StudioSetInspectorModeMessage = ProtocolMessage<
  'studio:set-inspector-mode',
  {
    enabled: boolean;
  }
>;

export type StudioClearSelectionMessage = ProtocolMessage<
  'studio:clear-selection',
  {
    selectionId?: string;
  }
>;

export type StudioToInspectorMessage = StudioSetInspectorModeMessage | StudioClearSelectionMessage;
