import type {
  AgentEvent,
  AgentRequest,
  AgentSession,
  CodingProvider,
  ProviderAvailability,
  ProviderId,
} from '@patchlens-ai/agent-protocol';
import { ClaudeCodingProvider } from '@patchlens-ai/provider-claude';
import { CodexCodingProvider } from '@patchlens-ai/provider-codex';
import { MockCodingProvider } from '@patchlens-ai/provider-mock';

type RegisteredSession = {
  session: AgentSession;
  provider: CodingProvider;
};

export class ProviderUnavailableError extends Error {
  constructor(providerId: string) {
    super(`Provider is unavailable: ${providerId}`);
    this.name = 'ProviderUnavailableError';
  }
}

export class UnknownAgentSessionError extends Error {
  constructor(sessionId: string) {
    super(`Unknown agent session: ${sessionId}`);
    this.name = 'UnknownAgentSessionError';
  }
}

export class AgentSessionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentSessionConflictError';
  }
}

export class AgentSessionRegistry {
  readonly #providers = new Map<string, CodingProvider>();
  readonly #sessions = new Map<string, RegisteredSession>();

  constructor(
    providers: CodingProvider[] = [
      new MockCodingProvider(),
      new CodexCodingProvider(),
      new ClaudeCodingProvider(),
    ],
  ) {
    for (const provider of providers) {
      this.#providers.set(provider.id, provider);
    }
  }

  async detectProviders(): Promise<ProviderAvailability[]> {
    return Promise.all([...this.#providers.values()].map((provider) => provider.detect()));
  }

  async create(
    projectId: string,
    projectRoot: string,
    providerId: ProviderId,
    providerSessionId?: string,
  ): Promise<AgentSession> {
    const provider = this.#providers.get(providerId);
    if (!provider) {
      throw new ProviderUnavailableError(providerId);
    }

    const session = await provider.createSession({
      projectId,
      projectRoot,
      ...(providerSessionId ? { providerSessionId } : {}),
    });
    this.#sessions.set(session.id, { session, provider });
    return structuredClone(session);
  }

  get(sessionId: string): AgentSession | undefined {
    const registered = this.#sessions.get(sessionId);
    return registered ? structuredClone(registered.session) : undefined;
  }

  stream(request: AgentRequest): AsyncIterable<AgentEvent> {
    const registered = this.#resolveRequest(request);
    return registered.provider.sendMessage(registered.session, request);
  }

  assertRequest(request: AgentRequest): void {
    this.#resolveRequest(request);
  }

  #resolveRequest(request: AgentRequest): RegisteredSession {
    if (!request.sessionId) {
      throw new AgentSessionConflictError('Agent request requires a managed session ID');
    }

    const registered = this.#require(request.sessionId);

    if (registered.session.projectId !== request.projectId) {
      throw new AgentSessionConflictError('Agent session project does not match request project');
    }

    if (registered.session.provider !== request.provider) {
      throw new AgentSessionConflictError('Agent session provider does not match request provider');
    }

    return registered;
  }

  async cancel(sessionId: string): Promise<void> {
    const registered = this.#require(sessionId);
    await registered.provider.cancel(registered.session);
  }

  async dispose(sessionId: string): Promise<void> {
    const registered = this.#require(sessionId);
    await registered.provider.dispose(registered.session);
    this.#sessions.delete(sessionId);
  }

  #require(sessionId: string): RegisteredSession {
    const registered = this.#sessions.get(sessionId);
    if (!registered) {
      throw new UnknownAgentSessionError(sessionId);
    }
    return registered;
  }
}
