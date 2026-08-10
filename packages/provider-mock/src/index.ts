import { PATCHLENS_PROTOCOL_VERSION } from '@patchlens-ai/agent-protocol';
import type {
  AgentEvent,
  AgentRequest,
  AgentSession,
  CodingProvider,
  CreateAgentSessionInput,
  ProviderAvailability,
} from '@patchlens-ai/agent-protocol';

export type MockProviderOptions = {
  delayMs?: number;
  createReply?: (request: AgentRequest) => string;
};

type SessionState = {
  cancelled: boolean;
  disposed: boolean;
};

export class MockCodingProvider implements CodingProvider {
  readonly id = 'mock' as const;
  readonly #delayMs: number;
  readonly #createReply: (request: AgentRequest) => string;
  readonly #sessions = new Map<string, SessionState>();

  constructor(options: MockProviderOptions = {}) {
    this.#delayMs = options.delayMs ?? 120;
    this.#createReply = options.createReply ?? createDefaultReply;
  }

  async detect(): Promise<ProviderAvailability> {
    return { id: this.id, status: 'available' };
  }

  async createSession(input: CreateAgentSessionInput): Promise<AgentSession> {
    const now = new Date().toISOString();
    const session: AgentSession = {
      schemaVersion: PATCHLENS_PROTOCOL_VERSION,
      id: createId('session'),
      projectId: input.projectId,
      provider: this.id,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
    };
    this.#sessions.set(session.id, { cancelled: false, disposed: false });
    return session;
  }

  async *sendMessage(session: AgentSession, request: AgentRequest): AsyncIterable<AgentEvent> {
    const state = this.#requireSession(session);
    if (session.projectId !== request.projectId) {
      throw new Error('Agent request project does not match session project');
    }

    let sequence = 0;
    const event = <Type extends AgentEvent['type']>(value: Extract<AgentEvent, { type: Type }>) =>
      value;

    if (state.cancelled) {
      yield event({
        schemaVersion: PATCHLENS_PROTOCOL_VERSION,
        type: 'cancelled',
        requestId: request.requestId,
        sessionId: session.id,
        sequence,
        createdAt: new Date().toISOString(),
        payload: { reason: 'Cancelled before execution' },
      });
      return;
    }

    yield event({
      schemaVersion: PATCHLENS_PROTOCOL_VERSION,
      type: 'status',
      requestId: request.requestId,
      sessionId: session.id,
      sequence: sequence++,
      createdAt: new Date().toISOString(),
      payload: { status: 'running', message: 'Reading selected source context' },
    });
    await wait(this.#delayMs);

    if (state.cancelled) {
      yield event({
        schemaVersion: PATCHLENS_PROTOCOL_VERSION,
        type: 'cancelled',
        requestId: request.requestId,
        sessionId: session.id,
        sequence,
        createdAt: new Date().toISOString(),
        payload: { reason: 'Cancelled during execution' },
      });
      return;
    }

    yield event({
      schemaVersion: PATCHLENS_PROTOCOL_VERSION,
      type: 'message',
      requestId: request.requestId,
      sessionId: session.id,
      sequence: sequence++,
      createdAt: new Date().toISOString(),
      payload: { role: 'assistant', content: this.#createReply(request) },
    });

    const files = [
      ...new Set(
        request.context.selection.sourceCandidates.map((candidate) => candidate.location.file),
      ),
    ];
    yield event({
      schemaVersion: PATCHLENS_PROTOCOL_VERSION,
      type: 'files',
      requestId: request.requestId,
      sessionId: session.id,
      sequence: sequence++,
      createdAt: new Date().toISOString(),
      payload: { files },
    });
    yield event({
      schemaVersion: PATCHLENS_PROTOCOL_VERSION,
      type: 'complete',
      requestId: request.requestId,
      sessionId: session.id,
      sequence,
      createdAt: new Date().toISOString(),
      payload: { summary: 'Mock request completed without changing files' },
    });
  }

  async cancel(session: AgentSession): Promise<void> {
    this.#requireSession(session).cancelled = true;
  }

  async dispose(session: AgentSession): Promise<void> {
    const state = this.#requireSession(session);
    state.disposed = true;
    this.#sessions.delete(session.id);
  }

  #requireSession(session: AgentSession): SessionState {
    const state = this.#sessions.get(session.id);
    if (!state || state.disposed) {
      throw new Error(`Unknown mock session: ${session.id}`);
    }
    return state;
  }
}

function createDefaultReply(request: AgentRequest): string {
  const source = request.context.selection.sourceCandidates[0]?.location;
  const target = source?.componentName ?? source?.tagName ?? 'selected region';
  return `Mock provider received request for ${target}: ${request.instruction}`;
}

function wait(delayMs: number): Promise<void> {
  return delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, delayMs)) : Promise.resolve();
}

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
