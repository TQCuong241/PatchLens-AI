import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PATCHLENS_PROTOCOL_VERSION } from '@patchlens-ai/agent-protocol';
import type {
  AgentRequest,
  AgentSession,
  CodingProvider,
  SelectionContext,
} from '@patchlens-ai/agent-protocol';
import {
  CodexCodingProvider,
  type CodexClientLike,
  type CodexThreadLike,
} from '@patchlens-ai/provider-codex';
import { afterEach, describe, expect, it } from 'vitest';

import { createDaemonServer } from '../src/server.js';
import type { DaemonServer } from '../src/server.js';

let activeServer: DaemonServer | undefined;
let projectRoot: string | undefined;
const fakeNpmToken = ['npm', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('_');

afterEach(async () => {
  await activeServer?.stop();
  activeServer = undefined;
  if (projectRoot) {
    await rm(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  }
});

describe('PatchLens daemon security boundary', () => {
  it('binds to loopback and exposes public health', async () => {
    activeServer = createDaemonServer({ port: 0 });
    const address = await activeServer.start();
    const response = await fetch(`http://${address.address}:${address.port}/health`);

    expect(address.address).toBe('127.0.0.1');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: 'patchlens-daemon',
      protocolVersion: 1,
    });
  });

  it('rejects protected routes without a session token', async () => {
    activeServer = createDaemonServer({ port: 0, token: 'test-token' });
    const address = await activeServer.start();
    const response = await fetch(`http://${address.address}:${address.port}/api/health`);

    expect(response.status).toBe(401);
  });

  it('accepts protected routes with a valid token', async () => {
    activeServer = createDaemonServer({ port: 0, token: 'test-token' });
    const address = await activeServer.start();
    const response = await fetch(`http://${address.address}:${address.port}/api/health`, {
      headers: { Authorization: 'Bearer test-token' },
    });

    expect(response.status).toBe(200);
  });

  it('rejects untrusted browser origins before token validation', async () => {
    activeServer = createDaemonServer({
      port: 0,
      token: 'test-token',
      allowedOrigins: ['http://127.0.0.1:4310'],
    });
    const address = await activeServer.start();
    const response = await fetch(`http://${address.address}:${address.port}/api/health`, {
      headers: {
        Authorization: 'Bearer test-token',
        Origin: 'http://malicious.example',
      },
    });

    expect(response.status).toBe(403);
  });

  it('maps malformed JSON to a client error', async () => {
    activeServer = createDaemonServer({ port: 0, token: 'test-token' });
    const address = await activeServer.start();
    const response = await authenticatedFetch(
      `http://${address.address}:${address.port}/api/projects`,
      { method: 'POST', body: '{' },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_json_body',
    });
  });

  it('maps unknown projects and providers to not found', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-daemon-'));
    activeServer = createDaemonServer({ port: 0, token: 'test-token' });
    const address = await activeServer.start();
    const baseUrl = `http://${address.address}:${address.port}`;

    const projectResponse = await authenticatedFetch(
      `${baseUrl}/api/projects/project-missing/selection`,
    );
    const registeredProjectResponse = await authenticatedFetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      body: JSON.stringify({ root: projectRoot }),
    });
    const registeredProject = (await registeredProjectResponse.json()) as {
      id: string;
    };
    const providerResponse = await authenticatedFetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        projectId: registeredProject.id,
        provider: 'missing',
      }),
    });

    expect(projectResponse.status).toBe(404);
    expect(providerResponse.status).toBe(404);
  });

  it('rejects an oversized managed provider session ID', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-daemon-'));
    activeServer = createDaemonServer({ port: 0, token: 'test-token' });
    const address = await activeServer.start();
    const baseUrl = `http://${address.address}:${address.port}`;
    const projectResponse = await authenticatedFetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      body: JSON.stringify({ root: projectRoot }),
    });
    const project = (await projectResponse.json()) as { id: string };

    const response = await authenticatedFetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        projectId: project.id,
        provider: 'codex',
        providerSessionId: 'x'.repeat(129),
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_session_request',
    });
  });

  it('stores screenshot evidence only for active selection', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-daemon-'));
    activeServer = createDaemonServer({ port: 0, token: 'test-token' });
    const address = await activeServer.start();
    const baseUrl = `http://${address.address}:${address.port}`;
    const projectResponse = await authenticatedFetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      body: JSON.stringify({ root: projectRoot }),
    });
    const project = (await projectResponse.json()) as { id: string };
    const context = createSelectionContext(project.id);
    await authenticatedFetch(`${baseUrl}/api/projects/${project.id}/selection`, {
      method: 'PUT',
      body: JSON.stringify(context),
    });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const screenshot = {
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      mimeType: 'image/png',
      width: 10,
      height: 10,
      byteLength: png.byteLength,
    };

    const rejected = await authenticatedFetch(`${baseUrl}/api/projects/${project.id}/captures`, {
      method: 'POST',
      body: JSON.stringify({ selectionId: 'selection-other', screenshot }),
    });
    const accepted = await authenticatedFetch(`${baseUrl}/api/projects/${project.id}/captures`, {
      method: 'POST',
      body: JSON.stringify({ selectionId: context.selection.id, screenshot }),
    });

    expect(rejected.status).toBe(409);
    expect(accepted.status).toBe(201);
    const reference = (await accepted.json()) as {
      path: string;
      mimeType: string;
      byteLength: number;
    };
    expect(reference).toMatchObject({
      path: expect.stringMatching(/^\.patchlens\/captures\//),
      mimeType: 'image/png',
      byteLength: png.byteLength,
    });
    const content = await authenticatedFetch(
      `${baseUrl}/api/projects/${project.id}/captures/content?path=${encodeURIComponent(reference.path)}`,
    );
    expect(content.status).toBe(200);
    expect(content.headers.get('Content-Type')).toBe('image/png');
    await expect(content.arrayBuffer()).resolves.toEqual(
      png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
    );
  });

  it('streams mock agent events through a tracked transaction', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-daemon-'));
    await writeFile(join(projectRoot, 'component.tsx'), 'export const App = () => null;\n');
    activeServer = createDaemonServer({ port: 0, token: 'test-token' });
    const address = await activeServer.start();
    const baseUrl = `http://${address.address}:${address.port}`;

    const projectResponse = await authenticatedFetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      body: JSON.stringify({ root: projectRoot }),
    });
    const project = (await projectResponse.json()) as { id: string };
    const context = createSelectionContext(project.id);

    const selectionResponse = await authenticatedFetch(
      `${baseUrl}/api/projects/${project.id}/selection`,
      {
        method: 'PUT',
        body: JSON.stringify(context),
      },
    );
    expect(selectionResponse.status).toBe(200);

    const sessionResponse = await authenticatedFetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      body: JSON.stringify({ projectId: project.id, provider: 'mock' }),
    });
    const session = (await sessionResponse.json()) as AgentSession;
    const agentRequest = createAgentRequest(context, session.id);

    const streamResponse = await authenticatedFetch(`${baseUrl}/api/agent/requests`, {
      method: 'POST',
      body: JSON.stringify(agentRequest),
    });
    await authenticatedFetch(`${baseUrl}/api/projects/${project.id}/selection`, {
      method: 'PUT',
      body: JSON.stringify(createRefreshedContext(context)),
    });
    const events = parseSseEvents(await streamResponse.text());
    const complete = events.find((event) => event.type === 'complete');

    expect(streamResponse.status).toBe(200);
    expect(events.map((event) => event.type)).toEqual([
      'status',
      'message',
      'files',
      'verification',
      'complete',
    ]);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(complete?.payload).toMatchObject({ transactionId: expect.any(String) });

    const transactionId = String(complete?.payload.transactionId);
    const revertResponse = await authenticatedFetch(
      `${baseUrl}/api/projects/${project.id}/transactions/${transactionId}/revert`,
      { method: 'POST' },
    );
    await expect(revertResponse.json()).resolves.toMatchObject({ status: 'reverted' });

    const repeatedRevertResponse = await authenticatedFetch(
      `${baseUrl}/api/projects/${project.id}/transactions/${transactionId}/revert`,
      { method: 'POST' },
    );
    const missingRevertResponse = await authenticatedFetch(
      `${baseUrl}/api/projects/${project.id}/transactions/transaction-missing/revert`,
      { method: 'POST' },
    );
    expect(repeatedRevertResponse.status).toBe(409);
    expect(missingRevertResponse.status).toBe(404);
  });

  it('streams a Codex managed edit through a tracked transaction', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-daemon-codex-'));
    const componentPath = join(projectRoot, 'component.tsx');
    await writeFile(componentPath, 'export const App = () => null;\n');
    const provider = new CodexCodingProvider({
      codex: createEditingCodexClient(componentPath),
    });
    activeServer = createDaemonServer({
      port: 0,
      token: 'test-token',
      providers: [provider],
    });
    const address = await activeServer.start();
    const baseUrl = `http://${address.address}:${address.port}`;

    const projectResponse = await authenticatedFetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      body: JSON.stringify({ root: projectRoot }),
    });
    const project = (await projectResponse.json()) as { id: string };
    const context = createSelectionContext(project.id);
    await authenticatedFetch(`${baseUrl}/api/projects/${project.id}/selection`, {
      method: 'PUT',
      body: JSON.stringify(context),
    });
    const sessionResponse = await authenticatedFetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      body: JSON.stringify({ projectId: project.id, provider: 'codex' }),
    });
    const session = (await sessionResponse.json()) as AgentSession;

    const streamResponse = await authenticatedFetch(`${baseUrl}/api/agent/requests`, {
      method: 'POST',
      body: JSON.stringify(createAgentRequest(context, session.id, 'codex')),
    });
    await authenticatedFetch(`${baseUrl}/api/projects/${project.id}/selection`, {
      method: 'PUT',
      body: JSON.stringify(createRefreshedContext(context)),
    });
    const events = parseSseEvents(await streamResponse.text());
    const diff = events.find((event) => event.type === 'diff');
    const complete = events.find((event) => event.type === 'complete');

    expect(streamResponse.status).toBe(200);
    expect(events.map((event) => event.type)).toContain('session');
    expect(events.map((event) => event.type)).toContain('files');
    expect(diff?.payload.diff).toContain('Updated');
    expect(complete?.payload.transactionId).toEqual(expect.any(String));
    await expect(readFile(componentPath, 'utf8')).resolves.toContain('Updated');
  });

  it('redacts project paths and credentials from daemon stream errors', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-daemon-redaction-'));
    await writeFile(join(projectRoot, 'component.tsx'), 'export const App = () => null;\n');
    activeServer = createDaemonServer({
      port: 0,
      token: 'test-token',
      providers: [createFailingProvider(projectRoot)],
    });
    const address = await activeServer.start();
    const baseUrl = `http://${address.address}:${address.port}`;
    const projectResponse = await authenticatedFetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      body: JSON.stringify({ root: projectRoot }),
    });
    const project = (await projectResponse.json()) as { id: string };
    const context = createSelectionContext(project.id);
    await authenticatedFetch(`${baseUrl}/api/projects/${project.id}/selection`, {
      method: 'PUT',
      body: JSON.stringify(context),
    });
    const sessionResponse = await authenticatedFetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      body: JSON.stringify({ projectId: project.id, provider: 'failing' }),
    });
    const session = (await sessionResponse.json()) as AgentSession;

    const streamResponse = await authenticatedFetch(`${baseUrl}/api/agent/requests`, {
      method: 'POST',
      body: JSON.stringify(createAgentRequest(context, session.id, 'failing')),
    });
    const body = await streamResponse.text();

    expect(body).toContain('[PROJECT_ROOT]');
    expect(body).toContain('Bearer [REDACTED]');
    expect(body).not.toContain(projectRoot);
    expect(body).not.toContain('provider-secret-value');
    expect(body).not.toContain(fakeNpmToken);
  });

  it('keeps partial provider edits revertible after a terminal error', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-daemon-partial-'));
    const componentPath = join(projectRoot, 'component.tsx');
    await writeFile(componentPath, 'export const App = () => null;\n');
    activeServer = createDaemonServer({
      port: 0,
      token: 'test-token',
      providers: [createPartialFailingProvider(projectRoot)],
    });
    const address = await activeServer.start();
    const baseUrl = `http://${address.address}:${address.port}`;
    const projectResponse = await authenticatedFetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      body: JSON.stringify({ root: projectRoot }),
    });
    const project = (await projectResponse.json()) as { id: string };
    const context = createSelectionContext(project.id);
    await authenticatedFetch(`${baseUrl}/api/projects/${project.id}/selection`, {
      method: 'PUT',
      body: JSON.stringify(context),
    });
    const sessionResponse = await authenticatedFetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      body: JSON.stringify({ projectId: project.id, provider: 'partial' }),
    });
    const session = (await sessionResponse.json()) as AgentSession;

    const streamResponse = await authenticatedFetch(`${baseUrl}/api/agent/requests`, {
      method: 'POST',
      body: JSON.stringify(createAgentRequest(context, session.id, 'partial')),
    });
    const events = parseSseEvents(await streamResponse.text());
    const diff = events.find((event) => event.type === 'diff');

    expect(events.map((event) => event.type)).toEqual(['files', 'diff', 'error']);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2]);
    expect(diff?.payload.diff).toContain('Partial');
    await expect(readFile(componentPath, 'utf8')).resolves.toContain('Partial');

    const transactionId = String(diff?.payload.transactionId);
    const revertResponse = await authenticatedFetch(
      `${baseUrl}/api/projects/${project.id}/transactions/${transactionId}/revert`,
      { method: 'POST' },
    );

    await expect(revertResponse.json()).resolves.toMatchObject({ status: 'reverted' });
    await expect(readFile(componentPath, 'utf8')).resolves.toBe('export const App = () => null;\n');
  });

  it('rejects strict scope expansion while keeping the edit revertible', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-daemon-strict-'));
    const componentPath = join(projectRoot, 'component.tsx');
    const relatedPath = join(projectRoot, 'related.ts');
    await writeFile(componentPath, 'export const App = () => null;\n');
    await writeFile(relatedPath, 'export const related = false;\n');
    activeServer = createDaemonServer({
      port: 0,
      token: 'test-token',
      providers: [createScopeExpandingProvider(projectRoot)],
    });
    const address = await activeServer.start();
    const baseUrl = `http://${address.address}:${address.port}`;
    const projectResponse = await authenticatedFetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      body: JSON.stringify({ root: projectRoot }),
    });
    const project = (await projectResponse.json()) as { id: string };
    const context = createSelectionContext(project.id);
    await authenticatedFetch(`${baseUrl}/api/projects/${project.id}/selection`, {
      method: 'PUT',
      body: JSON.stringify(context),
    });
    const sessionResponse = await authenticatedFetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      body: JSON.stringify({ projectId: project.id, provider: 'strict-test' }),
    });
    const session = (await sessionResponse.json()) as AgentSession;
    const request = createAgentRequest(context, session.id, 'strict-test');
    request.scopePolicy = 'strict';

    const streamResponse = await authenticatedFetch(`${baseUrl}/api/agent/requests`, {
      method: 'POST',
      body: JSON.stringify(request),
    });
    const events = parseSseEvents(await streamResponse.text());
    const diff = events.find((event) => event.type === 'diff');
    const error = events.find((event) => event.type === 'error');

    expect(events.map((event) => event.type)).toEqual(['diff', 'error']);
    expect(diff?.payload.diff).toContain('related = true');
    expect(error?.payload.message).toContain('Strict scope violation: related.ts');
    await expect(readFile(relatedPath, 'utf8')).resolves.toContain('related = true');

    const transactionId = String(diff?.payload.transactionId);
    const revertResponse = await authenticatedFetch(
      `${baseUrl}/api/projects/${project.id}/transactions/${transactionId}/revert`,
      { method: 'POST' },
    );

    await expect(revertResponse.json()).resolves.toMatchObject({ status: 'reverted' });
    await expect(readFile(relatedPath, 'utf8')).resolves.toBe('export const related = false;\n');
  });
});

function authenticatedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', 'Bearer test-token');
  if (init.body) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(url, { ...init, headers });
}

function createSelectionContext(projectId: string): SelectionContext {
  const createdAt = '2026-08-09T12:00:00.000Z';
  return {
    schemaVersion: PATCHLENS_PROTOCOL_VERSION,
    selection: {
      schemaVersion: PATCHLENS_PROTOCOL_VERSION,
      id: 'selection-1',
      projectId,
      route: '/',
      viewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
      rectangle: { x: 10, y: 10, width: 100, height: 40 },
      elements: [
        {
          id: 'element-1',
          patchlensId: 'pl_component',
          tagName: 'button',
          text: 'Start',
          sanitizedHtml: '<button>Start</button>',
          rectangle: { x: 10, y: 10, width: 100, height: 40 },
        },
      ],
      primaryElementId: 'element-1',
      sourceCandidates: [
        {
          location: {
            id: 'pl_component',
            framework: 'react',
            componentName: 'App',
            file: 'component.tsx',
            line: 1,
            column: 0,
          },
          confidence: 1,
        },
      ],
      confidence: 'exact',
      createdAt,
    },
    sanitizedHtml: '<button>Start</button>',
    computedStyles: {},
    relatedSourceFiles: [{ path: 'component.tsx', startLine: 1, endLine: 1 }],
    consoleEntries: [],
    capturedAt: createdAt,
  };
}

function createAgentRequest(
  context: SelectionContext,
  sessionId: string,
  provider: AgentRequest['provider'] = 'mock',
): AgentRequest {
  return {
    schemaVersion: PATCHLENS_PROTOCOL_VERSION,
    requestId: 'request-1',
    projectId: context.selection.projectId,
    sessionId,
    selectionId: context.selection.id,
    provider,
    instruction: 'Update selected component',
    context,
    scopePolicy: 'prefer-selection',
    verification: { route: '/', captureAfterChange: false, commands: [] },
    createdAt: '2026-08-09T12:00:01.000Z',
  };
}

function createRefreshedContext(context: SelectionContext): SelectionContext {
  const refreshed = structuredClone(context);
  refreshed.capturedAt = new Date(Date.parse(context.capturedAt) + 1_000).toISOString();
  return refreshed;
}

function createEditingCodexClient(componentPath: string): CodexClientLike {
  const thread = {
    id: null,
    async runStreamed() {
      await writeFile(componentPath, 'export const App = () => <button>Updated</button>;\n');
      const result = {
        events: (async function* () {
          yield { type: 'thread.started', thread_id: 'thread-daemon-test' };
          yield {
            type: 'item.completed',
            item: {
              id: 'item-file',
              type: 'file_change',
              changes: [{ path: 'component.tsx', kind: 'update', diff: '@@ -1 +1 @@' }],
              status: 'completed',
            },
          };
          yield {
            type: 'turn.completed',
            usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
          };
        })(),
      };
      return result as Awaited<ReturnType<CodexThreadLike['runStreamed']>>;
    },
  } satisfies CodexThreadLike;
  return {
    startThread: () => thread,
    resumeThread: () => thread,
  };
}

function createFailingProvider(root: string): CodingProvider {
  return {
    id: 'failing',
    async detect() {
      return { id: 'failing', status: 'available' };
    },
    async createSession(input) {
      const createdAt = '2026-08-09T12:00:00.000Z';
      return {
        schemaVersion: PATCHLENS_PROTOCOL_VERSION,
        id: 'session-failing',
        projectId: input.projectId,
        provider: 'failing',
        status: 'idle',
        createdAt,
        updatedAt: createdAt,
      };
    },
    async *sendMessage() {
      yield* [];
      throw new Error(`${root.replaceAll('\\', '/')} Bearer provider-secret-value ${fakeNpmToken}`);
    },
    async cancel() {},
    async dispose() {},
  };
}

function createPartialFailingProvider(root: string): CodingProvider {
  return {
    id: 'partial',
    async detect() {
      return { id: 'partial', status: 'available' };
    },
    async createSession(input) {
      const createdAt = '2026-08-10T12:00:00.000Z';
      return {
        schemaVersion: PATCHLENS_PROTOCOL_VERSION,
        id: 'session-partial',
        projectId: input.projectId,
        provider: 'partial',
        status: 'idle',
        createdAt,
        updatedAt: createdAt,
      };
    },
    async *sendMessage(_session, request) {
      await writeFile(
        join(root, 'component.tsx'),
        'export const App = () => <button>Partial</button>;\n',
      );
      yield {
        schemaVersion: PATCHLENS_PROTOCOL_VERSION,
        type: 'files',
        requestId: request.requestId,
        sessionId: request.sessionId ?? 'session-partial',
        sequence: 9,
        createdAt: '2026-08-10T12:00:01.000Z',
        payload: { files: ['component.tsx'] },
      };
      yield {
        schemaVersion: PATCHLENS_PROTOCOL_VERSION,
        type: 'error',
        requestId: request.requestId,
        sessionId: request.sessionId ?? 'session-partial',
        sequence: 2,
        createdAt: '2026-08-10T12:00:02.000Z',
        payload: { code: 'partial_failure', message: 'Provider failed', retryable: false },
      };
    },
    async cancel() {},
    async dispose() {},
  };
}

function createScopeExpandingProvider(root: string): CodingProvider {
  return {
    id: 'strict-test',
    async detect() {
      return { id: 'strict-test', status: 'available' };
    },
    async createSession(input) {
      const createdAt = '2026-08-10T12:00:00.000Z';
      return {
        schemaVersion: PATCHLENS_PROTOCOL_VERSION,
        id: 'session-strict-test',
        projectId: input.projectId,
        provider: 'strict-test',
        status: 'idle',
        createdAt,
        updatedAt: createdAt,
      };
    },
    async *sendMessage(_session, request) {
      await writeFile(join(root, 'related.ts'), 'export const related = true;\n');
      yield {
        schemaVersion: PATCHLENS_PROTOCOL_VERSION,
        type: 'files',
        requestId: request.requestId,
        sessionId: request.sessionId ?? 'session-strict-test',
        sequence: 0,
        createdAt: '2026-08-10T12:00:01.000Z',
        payload: { files: ['related.ts'] },
      };
      yield {
        schemaVersion: PATCHLENS_PROTOCOL_VERSION,
        type: 'complete',
        requestId: request.requestId,
        sessionId: request.sessionId ?? 'session-strict-test',
        sequence: 1,
        createdAt: '2026-08-10T12:00:02.000Z',
        payload: { summary: 'Expanded scope' },
      };
    },
    async cancel() {},
    async dispose() {},
  };
}

function parseSseEvents(
  value: string,
): Array<{ type: string; sequence: number; payload: Record<string, unknown> }> {
  return value
    .split('\n\n')
    .map((block) => block.split('\n').find((line) => line.startsWith('data: ')))
    .filter((line): line is string => Boolean(line))
    .map(
      (line) =>
        JSON.parse(line.slice(6)) as {
          type: string;
          sequence: number;
          payload: Record<string, unknown>;
        },
    );
}
