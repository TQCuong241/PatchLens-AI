import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  PATCHLENS_PROTOCOL_LIMITS,
  PATCHLENS_PROTOCOL_VERSION,
  isInlineScreenshot,
  isSelectionContext,
  parseAgentRequest,
} from '@patchlens-ai/agent-protocol';
import type {
  AgentEvent,
  AgentRequest,
  CodingProvider,
  ProviderId,
  SelectionContext,
} from '@patchlens-ai/agent-protocol';
import {
  PatchTransactionBusyError,
  PatchTransactionStateError,
  UnknownPatchTransactionError,
} from '@patchlens-ai/patch-transaction';
import type { PatchTransactionRecord } from '@patchlens-ai/patch-transaction';
import {
  VisualVerifier,
  createPackageManagerCommandAllowlist,
} from '@patchlens-ai/visual-verifier';

import {
  AgentSessionConflictError,
  AgentSessionRegistry,
  ProviderUnavailableError,
  UnknownAgentSessionError,
} from './agent-session-registry.js';
import {
  InvalidProjectRootError,
  ProjectRegistry,
  UnknownProjectError,
} from './project-registry.js';
import { SelectionStore } from './selection-store.js';
import { SelectionStoreProbe } from './selection-probe.js';
import { UnknownCaptureError } from './capture-store.js';

type ApiError = {
  statusCode: number;
  code: string;
  message?: string;
};

class RequestBodyError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'RequestBodyError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export type DaemonApiOptions = {
  providers?: CodingProvider[];
};

export class DaemonApi {
  readonly projects: ProjectRegistry;
  readonly selections: SelectionStore;
  readonly sessions: AgentSessionRegistry;

  constructor(options: DaemonApiOptions = {}) {
    this.projects = new ProjectRegistry();
    this.selections = new SelectionStore();
    this.sessions = new AgentSessionRegistry(options.providers);
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL,
  ): Promise<boolean> {
    try {
      return await this.#dispatch(request, response, requestUrl);
    } catch (error) {
      if (response.headersSent) {
        throw error;
      }

      const apiError = mapApiError(error);
      if (!apiError) {
        throw error;
      }
      sendJson(response, apiError.statusCode, {
        error: apiError.code,
        ...(apiError.message ? { message: apiError.message } : {}),
      });
      return true;
    }
  }

  async #dispatch(
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL,
  ): Promise<boolean> {
    const segments = requestUrl.pathname.split('/').filter(Boolean);

    if (request.method === 'GET' && requestUrl.pathname === '/api/providers') {
      sendJson(response, 200, await this.sessions.detectProviders());
      return true;
    }

    if (requestUrl.pathname === '/api/projects') {
      return this.#handleProjects(request, response);
    }

    if (
      segments[0] === 'api' &&
      segments[1] === 'projects' &&
      segments[2] &&
      segments[3] === 'captures' &&
      segments[4] === 'content'
    ) {
      return this.#handleCaptureContent(request, response, segments[2], requestUrl);
    }

    if (
      segments[0] === 'api' &&
      segments[1] === 'projects' &&
      segments[2] &&
      segments[3] === 'captures'
    ) {
      return this.#handleCapture(request, response, segments[2]);
    }

    if (
      segments[0] === 'api' &&
      segments[1] === 'projects' &&
      segments[2] &&
      segments[3] === 'selection'
    ) {
      return this.#handleSelection(request, response, segments[2]);
    }

    if (requestUrl.pathname === '/api/sessions') {
      return this.#handleSessions(request, response);
    }

    if (
      segments[0] === 'api' &&
      segments[1] === 'sessions' &&
      segments[2] &&
      segments[3] === 'cancel'
    ) {
      if (request.method !== 'POST') {
        return false;
      }
      await this.sessions.cancel(segments[2]);
      sendJson(response, 200, { ok: true });
      return true;
    }

    if (
      segments[0] === 'api' &&
      segments[1] === 'sessions' &&
      segments[2] &&
      segments.length === 3
    ) {
      if (request.method === 'DELETE') {
        await this.sessions.dispose(segments[2]);
        response.statusCode = 204;
        response.end();
        return true;
      }
      return false;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/agent/requests') {
      await this.#handleAgentRequest(request, response);
      return true;
    }

    if (
      segments[0] === 'api' &&
      segments[1] === 'projects' &&
      segments[2] &&
      segments[3] === 'transactions' &&
      segments[4] &&
      segments[5] === 'revert'
    ) {
      if (request.method !== 'POST') {
        return false;
      }
      const project = this.projects.require(segments[2]);
      const transaction = project.transactions.get(segments[4]);
      if (!transaction) {
        sendJson(response, 404, { error: 'transaction_not_found' });
        return true;
      }
      if (transaction.status !== 'applied') {
        sendJson(response, 409, { error: 'transaction_not_revertible' });
        return true;
      }
      sendJson(response, 200, await project.transactions.revert(segments[4]));
      return true;
    }

    return false;
  }

  async #handleProjects(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (request.method === 'GET') {
      sendJson(response, 200, this.projects.list());
      return true;
    }

    if (request.method !== 'POST') {
      return false;
    }

    const body = await readJson(request);
    if (!isRecord(body) || typeof body.root !== 'string' || !body.root) {
      sendJson(response, 400, { error: 'invalid_project_root' });
      return true;
    }

    sendJson(response, 201, await this.projects.register(body.root));
    return true;
  }

  async #handleSelection(
    request: IncomingMessage,
    response: ServerResponse,
    projectId: string,
  ): Promise<boolean> {
    this.projects.require(projectId);
    if (request.method === 'GET') {
      const context = this.selections.get(projectId);
      sendJson(response, context ? 200 : 404, context ?? { error: 'selection_not_found' });
      return true;
    }

    if (request.method === 'DELETE') {
      this.selections.clear(projectId);
      response.statusCode = 204;
      response.end();
      return true;
    }

    if (request.method !== 'PUT') {
      return false;
    }

    const body = await readJson(request);
    if (!isSelectionContext(body)) {
      sendJson(response, 400, { error: 'invalid_selection_context' });
      return true;
    }

    sendJson(response, 200, this.selections.set(projectId, body));
    return true;
  }

  async #handleCapture(
    request: IncomingMessage,
    response: ServerResponse,
    projectId: string,
  ): Promise<boolean> {
    if (request.method !== 'POST') {
      return false;
    }
    const project = this.projects.require(projectId);
    const body = await readJson(request, 3_000_000);
    if (
      !isRecord(body) ||
      typeof body.selectionId !== 'string' ||
      !body.selectionId ||
      !isInlineScreenshot(body.screenshot)
    ) {
      sendJson(response, 400, { error: 'invalid_capture_payload' });
      return true;
    }
    const activeSelection = this.selections.get(projectId);
    if (!activeSelection || activeSelection.selection.id !== body.selectionId) {
      sendJson(response, 409, { error: 'selection_is_not_active' });
      return true;
    }
    sendJson(response, 201, await project.captures.save(body.selectionId, body.screenshot));
    return true;
  }

  async #handleCaptureContent(
    request: IncomingMessage,
    response: ServerResponse,
    projectId: string,
    requestUrl: URL,
  ): Promise<boolean> {
    if (request.method !== 'GET') {
      return false;
    }
    const path = requestUrl.searchParams.get('path');
    if (!path || path.length > PATCHLENS_PROTOCOL_LIMITS.textLength) {
      sendJson(response, 400, { error: 'invalid_capture_path' });
      return true;
    }
    const capture = await this.projects.require(projectId).captures.read(path);
    response.statusCode = 200;
    response.setHeader('Content-Type', capture.mimeType);
    response.setHeader('Content-Length', String(capture.content.byteLength));
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.end(capture.content);
    return true;
  }

  async #handleSessions(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (request.method !== 'POST') {
      return false;
    }

    const body = await readJson(request);
    if (
      !isRecord(body) ||
      !isBoundedIdentifier(body.projectId) ||
      !isBoundedIdentifier(body.provider) ||
      (body.providerSessionId !== undefined && !isBoundedIdentifier(body.providerSessionId))
    ) {
      sendJson(response, 400, { error: 'invalid_session_request' });
      return true;
    }

    const project = this.projects.require(body.projectId);
    const session = await this.sessions.create(
      body.projectId,
      project.record.root,
      body.provider as ProviderId,
      body.providerSessionId,
    );
    sendJson(response, 201, session);
    return true;
  }

  async #handleAgentRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const parsed = parseAgentRequest(await readJson(request));
    if (!parsed.success) {
      sendJson(response, 400, {
        error: 'invalid_agent_request',
        issues: parsed.issues,
      });
      return;
    }

    const agentRequest = parsed.data;
    if (!agentRequest.sessionId) {
      sendJson(response, 400, { error: 'managed_session_id_required' });
      return;
    }

    const project = this.projects.require(agentRequest.projectId);
    this.sessions.assertRequest(agentRequest);
    const activeSelection = this.selections.get(agentRequest.projectId);
    if (!activeSelection || activeSelection.selection.id !== agentRequest.selectionId) {
      sendJson(response, 409, { error: 'selection_is_not_active' });
      return;
    }

    const plannedFiles = collectPlannedFiles(agentRequest.context);
    const verifier = new VisualVerifier({
      probe: new SelectionStoreProbe({
        store: this.selections,
        projectId: agentRequest.projectId,
        baseline: activeSelection,
      }),
      commandCwd: project.record.root,
      commandAllowlist: createPackageManagerCommandAllowlist(project.packageManager),
    });
    const verificationBaseline = await verifier.captureBaseline({
      route: agentRequest.verification.route,
      selection: activeSelection.selection,
      captureAfterChange: agentRequest.verification.captureAfterChange,
    });
    const transaction = await project.transactions.begin({
      requestId: agentRequest.requestId,
      sessionId: agentRequest.sessionId,
      selectionId: agentRequest.selectionId,
      instruction: agentRequest.instruction,
      files: plannedFiles,
    });
    startSse(response);

    let sequence = 0;
    let completionSummary = 'Agent request completed';
    let providerCompleted = false;
    const reportedScopeFiles = new Set(transaction.scopeExpandedFiles);
    try {
      for await (const providerEvent of this.sessions.stream(agentRequest)) {
        if (providerCompleted) {
          throw new Error('Provider emitted an event after completion');
        }
        if (providerEvent.type === 'complete') {
          providerCompleted = true;
          completionSummary = providerEvent.payload.summary;
          continue;
        }

        if (providerEvent.type === 'files') {
          const expanded = await project.transactions.expand(
            transaction.id,
            providerEvent.payload.files,
          );
          const newScopeFiles = expanded.scopeExpandedFiles.filter(
            (file) => !reportedScopeFiles.has(file),
          );
          if (agentRequest.scopePolicy === 'strict' && newScopeFiles.length > 0) {
            await this.sessions.cancel(agentRequest.sessionId);
            throw new Error(`Strict scope violation: ${newScopeFiles.join(', ')}`);
          }
          writeSseEvent(response, resequenceAgentEvent(providerEvent, agentRequest, sequence++));
          if (newScopeFiles.length > 0) {
            for (const file of newScopeFiles) {
              reportedScopeFiles.add(file);
            }
            const scopeEvent: Extract<AgentEvent, { type: 'status' }> = {
              schemaVersion: PATCHLENS_PROTOCOL_VERSION,
              type: 'status',
              requestId: agentRequest.requestId,
              sessionId: agentRequest.sessionId,
              sequence: sequence++,
              createdAt: new Date().toISOString(),
              payload: {
                status: 'waiting',
                message: `Scope expanded to: ${newScopeFiles.join(', ')}`,
              },
            };
            writeSseEvent(response, scopeEvent);
          }
          continue;
        }

        if (providerEvent.type === 'error' || providerEvent.type === 'cancelled') {
          const failureMessage = sanitizeDaemonError(
            providerEvent.type === 'error'
              ? providerEvent.payload.message
              : (providerEvent.payload.reason ?? 'Agent request cancelled'),
            project.record.root,
          );
          const partial = await project.transactions.finalizeFailure(
            transaction.id,
            failureMessage,
          );
          sequence = writeTransactionDiff(response, agentRequest, partial, sequence);
          const terminalEvent =
            providerEvent.type === 'error'
              ? {
                  ...providerEvent,
                  payload: { ...providerEvent.payload, message: failureMessage },
                }
              : providerEvent;
          writeSseEvent(response, resequenceAgentEvent(terminalEvent, agentRequest, sequence++));
          response.end();
          return;
        }

        writeSseEvent(response, resequenceAgentEvent(providerEvent, agentRequest, sequence++));
      }

      if (!providerCompleted) {
        throw new Error('Provider stream ended without a complete event');
      }

      const applied = await project.transactions.finalize(transaction.id);
      sequence = writeTransactionDiff(response, agentRequest, applied, sequence);

      const verification = await verifier.verifyAfter(verificationBaseline, {
        route: agentRequest.verification.route,
        selection: activeSelection.selection,
        captureAfterChange: agentRequest.verification.captureAfterChange,
        commands: agentRequest.verification.commands,
      });
      const verificationEvent: Extract<AgentEvent, { type: 'verification' }> = {
        schemaVersion: PATCHLENS_PROTOCOL_VERSION,
        type: 'verification',
        requestId: agentRequest.requestId,
        sessionId: agentRequest.sessionId,
        sequence: sequence++,
        createdAt: new Date().toISOString(),
        payload: {
          ok: verification.ok,
          summary: verification.summary,
          commands: verification.commands,
          ...(verification.beforeScreenshot
            ? { beforeScreenshot: verification.beforeScreenshot }
            : {}),
          ...(verification.afterScreenshot
            ? { afterScreenshot: verification.afterScreenshot }
            : {}),
          ...(verification.visualComparison
            ? { visualComparison: verification.visualComparison }
            : {}),
        },
      };
      writeSseEvent(response, verificationEvent);

      const completeEvent: Extract<AgentEvent, { type: 'complete' }> = {
        schemaVersion: PATCHLENS_PROTOCOL_VERSION,
        type: 'complete',
        requestId: agentRequest.requestId,
        sessionId: agentRequest.sessionId,
        sequence: sequence++,
        createdAt: new Date().toISOString(),
        payload: {
          transactionId: transaction.id,
          summary: completionSummary,
        },
      };
      writeSseEvent(response, completeEvent);
      response.end();
    } catch (error) {
      const message = sanitizeDaemonError(error, project.record.root);
      if (project.transactions.get(transaction.id)?.status === 'running') {
        try {
          const partial = await project.transactions.finalizeFailure(transaction.id, message);
          sequence = writeTransactionDiff(response, agentRequest, partial, sequence);
        } catch {
          if (project.transactions.get(transaction.id)?.status === 'running') {
            project.transactions.fail(transaction.id, message);
          }
        }
      }

      const errorEvent: Extract<AgentEvent, { type: 'error' }> = {
        schemaVersion: PATCHLENS_PROTOCOL_VERSION,
        type: 'error',
        requestId: agentRequest.requestId,
        sessionId: agentRequest.sessionId,
        sequence,
        createdAt: new Date().toISOString(),
        payload: { code: 'daemon_request_failed', message, retryable: false },
      };
      writeSseEvent(response, errorEvent);
      response.end();
    }
  }
}

function resequenceAgentEvent(
  event: AgentEvent,
  request: AgentRequest,
  sequence: number,
): AgentEvent {
  return {
    ...event,
    requestId: request.requestId,
    sessionId: request.sessionId ?? event.sessionId,
    sequence,
  };
}

function writeTransactionDiff(
  response: ServerResponse,
  request: AgentRequest,
  transaction: Pick<PatchTransactionRecord, 'id' | 'diff'>,
  sequence: number,
): number {
  if (!transaction.diff) {
    return sequence;
  }
  const diffEvent: Extract<AgentEvent, { type: 'diff' }> = {
    schemaVersion: PATCHLENS_PROTOCOL_VERSION,
    type: 'diff',
    requestId: request.requestId,
    sessionId: request.sessionId ?? '',
    sequence,
    createdAt: new Date().toISOString(),
    payload: { transactionId: transaction.id, diff: transaction.diff },
  };
  writeSseEvent(response, diffEvent);
  return sequence + 1;
}

function collectPlannedFiles(selectionContext: SelectionContext): string[] {
  return [
    ...new Set([
      ...selectionContext.relatedSourceFiles.map((file) => file.path),
      ...selectionContext.selection.sourceCandidates.map((candidate) => candidate.location.file),
    ]),
  ];
}

async function readJson(request: IncomingMessage, maximumBytes = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maximumBytes) {
      throw new RequestBodyError(
        413,
        'request_body_too_large',
        `Request body exceeds ${maximumBytes} byte limit`,
      );
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new RequestBodyError(400, 'invalid_json_body', 'Malformed JSON body');
    }
    throw error;
  }
}

function mapApiError(error: unknown): ApiError | undefined {
  if (error instanceof RequestBodyError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
    };
  }

  if (error instanceof InvalidProjectRootError) {
    return { statusCode: 400, code: 'invalid_project_root' };
  }

  if (error instanceof UnknownProjectError) {
    return { statusCode: 404, code: 'project_not_found' };
  }

  if (error instanceof UnknownCaptureError) {
    return { statusCode: 404, code: 'capture_not_found' };
  }

  if (error instanceof ProviderUnavailableError) {
    return { statusCode: 404, code: 'provider_not_found' };
  }

  if (error instanceof UnknownAgentSessionError) {
    return { statusCode: 404, code: 'session_not_found' };
  }

  if (error instanceof AgentSessionConflictError) {
    return { statusCode: 409, code: 'session_conflict', message: error.message };
  }

  if (error instanceof UnknownPatchTransactionError) {
    return { statusCode: 404, code: 'transaction_not_found' };
  }

  if (error instanceof PatchTransactionStateError || error instanceof PatchTransactionBusyError) {
    return {
      statusCode: 409,
      code: 'transaction_conflict',
      message: error.message,
    };
  }

  return undefined;
}

function startSse(response: ServerResponse): void {
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Connection', 'keep-alive');
  response.flushHeaders();
}

function writeSseEvent(response: ServerResponse, event: AgentEvent): void {
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isBoundedIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= PATCHLENS_PROTOCOL_LIMITS.identifierLength
  );
}

function sanitizeDaemonError(error: unknown, projectRoot: string): string {
  let message = error instanceof Error ? error.message : 'Agent request failed';
  for (const root of new Set([projectRoot, projectRoot.replaceAll('\\', '/')])) {
    if (root) {
      message = message.replaceAll(root, '[PROJECT_ROOT]');
    }
  }
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_API_KEY]')
    .replace(
      /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,})\b/g,
      '[REDACTED_CREDENTIAL]',
    )
    .replace(
      /\b(authorization|cookie|csrf|token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[REDACTED]',
    )
    .slice(0, PATCHLENS_PROTOCOL_LIMITS.textLength);
}
