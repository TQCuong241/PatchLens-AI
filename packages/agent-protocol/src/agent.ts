import type { ProtocolVersion, ScreenshotReference, SelectionContext } from './selection.js';

type LiteralUnion<Literal extends string> = Literal | (string & Record<never, never>);

export type ProviderId = LiteralUnion<'mock' | 'codex' | 'claude'>;

export type AgentSessionStatus = 'idle' | 'running' | 'waiting' | 'failed' | 'disposed';

export type AgentSession = {
  schemaVersion: ProtocolVersion;
  id: string;
  projectId: string;
  provider: ProviderId;
  providerSessionId?: string;
  status: AgentSessionStatus;
  activeSelectionId?: string;
  createdAt: string;
  updatedAt: string;
};

export type ScopePolicy = 'prefer-selection' | 'strict' | 'allow-related';
export type VerificationCommandId = 'typecheck' | 'lint' | 'test' | 'build';

export type VerificationRequest = {
  route: string;
  captureAfterChange: boolean;
  commands: VerificationCommandId[];
};

export type VisualComparison = {
  hammingDistance: number;
  similarity: number;
  changed: boolean;
};

export type AgentRequest = {
  schemaVersion: ProtocolVersion;
  requestId: string;
  projectId: string;
  sessionId?: string;
  selectionId: string;
  provider: ProviderId;
  instruction: string;
  context: SelectionContext;
  scopePolicy: ScopePolicy;
  verification: VerificationRequest;
  createdAt: string;
};

export type AgentRequestStatus =
  'queued' | 'running' | 'waiting' | 'completed' | 'cancelled' | 'failed';

type AgentEventEnvelope<Type extends string, Payload> = {
  schemaVersion: ProtocolVersion;
  type: Type;
  requestId: string;
  sessionId: string;
  sequence: number;
  createdAt: string;
  payload: Payload;
};

export type AgentEvent =
  | AgentEventEnvelope<'session', { session: AgentSession }>
  | AgentEventEnvelope<'status', { status: AgentRequestStatus; message: string }>
  | AgentEventEnvelope<'message', { role: 'assistant'; content: string }>
  | AgentEventEnvelope<'files', { files: string[] }>
  | AgentEventEnvelope<'diff', { transactionId: string; diff: string }>
  | AgentEventEnvelope<
      'verification',
      {
        ok: boolean;
        summary: string;
        commands: VerificationCommandId[];
        beforeScreenshot?: ScreenshotReference;
        afterScreenshot?: ScreenshotReference;
        visualComparison?: VisualComparison;
      }
    >
  | AgentEventEnvelope<'error', { code: string; message: string; retryable: boolean }>
  | AgentEventEnvelope<'cancelled', { reason?: string }>
  | AgentEventEnvelope<'complete', { transactionId?: string; summary: string }>;

export type AgentChatResponse = {
  schemaVersion: ProtocolVersion;
  requestId: string;
  session: AgentSession;
  reply: string;
  sourceSummary: string;
  plannedFiles: string[];
};

export type DaemonHealth = {
  ok: true;
  service: 'patchlens-daemon';
  version: string;
  protocolVersion: ProtocolVersion;
  providers: Array<{
    id: ProviderId;
    status: 'available' | 'planned' | 'unavailable';
  }>;
};

export type ProviderAvailability = {
  id: ProviderId;
  status: 'available' | 'planned' | 'unavailable';
  message?: string;
};

export type CreateAgentSessionInput = {
  projectId: string;
  projectRoot?: string;
  providerSessionId?: string;
};

export interface CodingProvider {
  readonly id: ProviderId;
  detect(): Promise<ProviderAvailability>;
  createSession(input: CreateAgentSessionInput): Promise<AgentSession>;
  sendMessage(session: AgentSession, request: AgentRequest): AsyncIterable<AgentEvent>;
  cancel(session: AgentSession): Promise<void>;
  dispose(session: AgentSession): Promise<void>;
}
