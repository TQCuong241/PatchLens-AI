import {
  isAgentSession,
  isScreenshotReference,
  isSelectionContext,
  parseAgentEvent,
  parseDaemonHealth,
} from '@patchlens-ai/agent-protocol';
import type {
  AgentEvent,
  AgentRequest,
  AgentSession,
  DaemonHealth,
  InlineScreenshot,
  ProviderId,
  ScreenshotReference,
  SelectionContext,
} from '@patchlens-ai/agent-protocol';

export type DaemonClientOptions = {
  baseUrl: string;
  token: string;
  fetchImplementation?: typeof fetch;
};

export type DaemonProject = {
  id: string;
  root: string;
  createdAt: string;
};

export type DaemonTransaction = {
  id: string;
  requestId: string;
  sessionId: string;
  selectionId: string;
  files: string[];
  plannedFiles: string[];
  scopeExpandedFiles: string[];
  changedFiles: string[];
  diff: string;
  status: 'running' | 'applied' | 'reverted' | 'conflicted' | 'failed';
  conflicts: string[];
  createdAt: string;
  updatedAt: string;
};

export class DaemonClientError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`PatchLens daemon request failed with status ${status}`);
    this.name = 'DaemonClientError';
    this.status = status;
    this.body = body;
  }
}

export class DaemonClient {
  readonly #baseUrl: URL;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(options: DaemonClientOptions) {
    this.#baseUrl = new URL(options.baseUrl);
    if (!options.token) {
      throw new Error('Daemon session token is required');
    }
    this.#token = options.token;
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async health(): Promise<DaemonHealth> {
    const value = await this.#requestJson('/api/health');
    const parsed = parseDaemonHealth(value);
    if (!parsed.success) {
      throw new Error('Daemon returned invalid health payload');
    }
    return parsed.data;
  }

  async registerProject(root: string): Promise<DaemonProject> {
    const value = await this.#requestJson('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ root }),
    });
    if (!isProject(value)) {
      throw new Error('Daemon returned invalid project payload');
    }
    return value;
  }

  async setSelection(projectId: string, context: SelectionContext): Promise<SelectionContext> {
    const value = await this.#requestJson(`/api/projects/${projectId}/selection`, {
      method: 'PUT',
      body: JSON.stringify(context),
    });
    if (!isSelectionContext(value)) {
      throw new Error('Daemon returned invalid selection context');
    }
    return value;
  }

  async getSelection(projectId: string): Promise<SelectionContext> {
    const value = await this.#requestJson(`/api/projects/${projectId}/selection`);
    if (!isSelectionContext(value)) {
      throw new Error('Daemon returned invalid selection context');
    }
    return value;
  }

  async clearSelection(projectId: string): Promise<void> {
    await this.#request(`/api/projects/${projectId}/selection`, {
      method: 'DELETE',
    });
  }

  async saveCapture(
    projectId: string,
    selectionId: string,
    screenshot: InlineScreenshot,
  ): Promise<ScreenshotReference> {
    const value = await this.#requestJson(`/api/projects/${projectId}/captures`, {
      method: 'POST',
      body: JSON.stringify({ selectionId, screenshot }),
    });
    if (!isScreenshotReference(value)) {
      throw new Error('Daemon returned invalid screenshot reference');
    }
    return value;
  }

  async loadCapture(projectId: string, screenshot: ScreenshotReference): Promise<Blob> {
    const response = await this.#request(
      `/api/projects/${projectId}/captures/content?path=${encodeURIComponent(screenshot.path)}`,
      { headers: { Accept: screenshot.mimeType } },
    );
    const contentType = response.headers.get('Content-Type')?.split(';', 1)[0];
    if (contentType !== screenshot.mimeType) {
      throw new Error('Daemon capture MIME type does not match reference');
    }
    const blob = await response.blob();
    if (blob.size !== screenshot.byteLength) {
      throw new Error('Daemon capture byte length does not match reference');
    }
    return blob;
  }

  async createSession(
    projectId: string,
    provider: ProviderId,
    providerSessionId?: string,
  ): Promise<AgentSession> {
    const value = await this.#requestJson('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        provider,
        ...(providerSessionId ? { providerSessionId } : {}),
      }),
    });
    if (!isAgentSession(value)) {
      throw new Error('Daemon returned invalid Agent session');
    }
    return value;
  }

  async cancelSession(sessionId: string): Promise<void> {
    await this.#request(`/api/sessions/${sessionId}/cancel`, { method: 'POST' });
  }

  async disposeSession(sessionId: string): Promise<void> {
    await this.#request(`/api/sessions/${sessionId}`, { method: 'DELETE' });
  }

  async *streamRequest(request: AgentRequest): AsyncIterable<AgentEvent> {
    if (!request.sessionId) {
      throw new Error('Managed daemon request requires a session ID');
    }
    const response = await this.#request('/api/agent/requests', {
      method: 'POST',
      body: JSON.stringify(request),
      headers: { Accept: 'text/event-stream' },
    });
    if (!response.body) {
      throw new Error('Daemon stream response has no body');
    }

    let expectedSequence = 0;
    let terminalEventReceived = false;
    for await (const event of parseEventStream(response.body)) {
      if (terminalEventReceived) {
        throw new Error('Daemon returned an event after terminal state');
      }
      if (event.requestId !== request.requestId || event.sessionId !== request.sessionId) {
        throw new Error('Daemon returned an Agent event for another request or session');
      }
      if (event.sequence !== expectedSequence) {
        throw new Error(`Daemon Agent event sequence mismatch: expected ${expectedSequence}`);
      }
      expectedSequence += 1;
      terminalEventReceived =
        event.type === 'complete' || event.type === 'error' || event.type === 'cancelled';
      yield event;
    }
    if (!terminalEventReceived) {
      throw new Error('Daemon Agent event stream ended without terminal state');
    }
  }

  async revert(projectId: string, transactionId: string): Promise<DaemonTransaction> {
    const value = await this.#requestJson(
      `/api/projects/${projectId}/transactions/${transactionId}/revert`,
      { method: 'POST' },
    );
    if (!isTransaction(value)) {
      throw new Error('Daemon returned invalid transaction payload');
    }
    return value;
  }

  async #requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.#request(path, init);
    return response.status === 204 ? undefined : response.json();
  }

  async #request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.#token}`);
    if (init.body) {
      headers.set('Content-Type', 'application/json');
    }

    const response = await this.#fetch(new URL(path, this.#baseUrl), {
      ...init,
      headers,
    });
    if (!response.ok) {
      throw new DaemonClientError(response.status, await readErrorBody(response));
    }
    return response;
  }
}

async function* parseEventStream(stream: ReadableStream<Uint8Array>): AsyncIterable<AgentEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    buffer = `${buffer}${decoder.decode(value, { stream: !done })}`.replaceAll('\r\n', '\n');

    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) {
        const parsed = parseAgentEvent(JSON.parse(data) as unknown);
        if (!parsed.success) {
          throw new Error('Daemon returned invalid Agent event');
        }
        yield parsed.data;
      }
      boundary = buffer.indexOf('\n\n');
    }

    if (done) {
      break;
    }
  }
}

async function readErrorBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('Content-Type') ?? '';
  return contentType.includes('application/json')
    ? response.json().catch(() => undefined)
    : response.text().catch(() => undefined);
}

function isProject(value: unknown): value is DaemonProject {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.root === 'string' &&
    value.root.length > 0 &&
    isTimestamp(value.createdAt)
  );
}

function isTransaction(value: unknown): value is DaemonTransaction {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.requestId === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.selectionId === 'string' &&
    Array.isArray(value.files) &&
    value.files.every((file) => typeof file === 'string') &&
    Array.isArray(value.plannedFiles) &&
    value.plannedFiles.every((file) => typeof file === 'string') &&
    Array.isArray(value.scopeExpandedFiles) &&
    value.scopeExpandedFiles.every((file) => typeof file === 'string') &&
    Array.isArray(value.changedFiles) &&
    value.changedFiles.every((file) => typeof file === 'string') &&
    typeof value.diff === 'string' &&
    typeof value.status === 'string' &&
    ['running', 'applied', 'reverted', 'conflicted', 'failed'].includes(value.status) &&
    Array.isArray(value.conflicts) &&
    value.conflicts.every((file) => typeof file === 'string') &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt)
  );
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
