import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Input, ThreadEvent, ThreadOptions, TurnOptions } from '@openai/codex-sdk';
import { PATCHLENS_PROTOCOL_VERSION } from '@patchlens-ai/agent-protocol';
import type { AgentRequest } from '@patchlens-ai/agent-protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CodexCodingProvider,
  buildCodexPrompt,
  type CodexClientLike,
  type CodexThreadLike,
} from '../src/index.js';

let projectRoot: string | undefined;

afterEach(async () => {
  if (projectRoot) {
    await rm(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  }
});

describe('CodexCodingProvider', () => {
  it('maps streamed items and uses safe thread options', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-codex-'));
    const thread = new FakeThread([
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.started' },
      {
        type: 'item.completed',
        item: { id: 'item-1', type: 'agent_message', text: 'Updated button.' },
      },
      {
        type: 'item.completed',
        item: {
          id: 'item-2',
          type: 'file_change',
          changes: [{ path: 'src/Button.tsx', kind: 'update', diff: '@@ -1 +1 @@' }],
          status: 'completed',
        },
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
      },
    ] as ThreadEvent[]);
    const client = new FakeCodexClient(thread);
    const provider = new CodexCodingProvider({ codex: client });
    const session = await provider.createSession({
      projectId: 'project-1',
      projectRoot,
    });

    const events = await collect(provider.sendMessage(session, createRequest()));

    expect(events.map((event) => event.type)).toEqual([
      'status',
      'session',
      'status',
      'message',
      'files',
      'session',
      'complete',
    ]);
    expect(session.providerSessionId).toBe('thread-1');
    expect(client.startOptions).toMatchObject({
      workingDirectory: projectRoot,
      sandboxMode: 'workspace-write',
      networkAccessEnabled: false,
      approvalPolicy: 'never',
      webSearchMode: 'disabled',
    });
    expect(String(thread.input)).toContain('Make button blue');
  });

  it('resumes an existing thread ID', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-codex-'));
    const thread = new FakeThread([
      { type: 'thread.started', thread_id: 'thread-existing' },
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      },
    ] as ThreadEvent[]);
    const client = new FakeCodexClient(thread);
    const provider = new CodexCodingProvider({ codex: client });
    const session = await provider.createSession({
      projectId: 'project-1',
      projectRoot,
      providerSessionId: 'thread-existing',
    });

    await collect(provider.sendMessage(session, createRequest()));

    expect(client.resumedThreadId).toBe('thread-existing');
  });

  it('rejects an invalid provider session ID', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-codex-'));
    const provider = new CodexCodingProvider({
      codex: new FakeCodexClient(new FakeThread([])),
    });

    await expect(
      provider.createSession({
        projectId: 'project-1',
        projectRoot,
        providerSessionId: 'x'.repeat(129),
      }),
    ).rejects.toThrow('provider session ID is invalid');
  });

  it('maps AbortSignal cancellation to cancelled event', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-codex-'));
    const provider = new CodexCodingProvider({
      codex: new FakeCodexClient(new BlockingThread()),
    });
    const session = await provider.createSession({
      projectId: 'project-1',
      projectRoot,
    });
    const iterator = provider.sendMessage(session, createRequest())[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    const blocked = iterator.next();

    await provider.cancel(session);

    await expect(blocked).resolves.toMatchObject({ value: { type: 'cancelled' } });
    expect(session.status).toBe('idle');
    expect(session.activeSelectionId).toBeUndefined();
  });

  it('preserves disposed state when aborting an active turn', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-codex-'));
    const provider = new CodexCodingProvider({
      codex: new FakeCodexClient(new BlockingThread()),
    });
    const session = await provider.createSession({
      projectId: 'project-1',
      projectRoot,
    });
    const iterator = provider.sendMessage(session, createRequest())[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    const blocked = iterator.next();

    await provider.dispose(session);

    await expect(blocked).resolves.toMatchObject({
      value: { type: 'cancelled', payload: { reason: 'Codex session disposed' } },
    });
    expect(session.status).toBe('disposed');
    expect(session.activeSelectionId).toBeUndefined();
  });

  it('maps auth failure and redacts project root', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-codex-'));
    const provider = new CodexCodingProvider({
      codex: new FakeCodexClient(new FailingThread(`401 Unauthorized at ${projectRoot}`)),
    });
    const session = await provider.createSession({
      projectId: 'project-1',
      projectRoot,
    });

    const events = await collect(provider.sendMessage(session, createRequest()));
    const error = events.find((event) => event.type === 'error');

    expect(error).toMatchObject({ payload: { code: 'codex_auth_failed' } });
    expect(JSON.stringify(error)).not.toContain(projectRoot);
    expect(session.activeSelectionId).toBeUndefined();
  });

  it('rejects file reports outside project root', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-codex-'));
    const thread = new FakeThread([
      { type: 'thread.started', thread_id: 'thread-1' },
      {
        type: 'item.completed',
        item: {
          id: 'item-scope',
          type: 'file_change',
          changes: [{ path: '../secret.txt', kind: 'update', diff: '' }],
          status: 'completed',
        },
      },
    ] as ThreadEvent[]);
    const provider = new CodexCodingProvider({
      codex: new FakeCodexClient(thread),
    });
    const session = await provider.createSession({
      projectId: 'project-1',
      projectRoot,
    });

    const events = await collect(provider.sendMessage(session, createRequest()));

    expect(events.find((event) => event.type === 'error')).toMatchObject({
      payload: { code: 'codex_scope_violation', retryable: false },
    });
  });

  it('accepts reported paths whose segments begin with two dots', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-codex-'));
    const thread = new FakeThread([
      { type: 'thread.started', thread_id: 'thread-1' },
      {
        type: 'item.completed',
        item: {
          id: 'item-dotted-path',
          type: 'file_change',
          changes: [{ path: '..name/Button.tsx', kind: 'update', diff: '' }],
          status: 'completed',
        },
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      },
    ] as ThreadEvent[]);
    const provider = new CodexCodingProvider({
      codex: new FakeCodexClient(thread),
    });
    const session = await provider.createSession({
      projectId: 'project-1',
      projectRoot,
    });

    const events = await collect(provider.sendMessage(session, createRequest()));

    expect(events.find((event) => event.type === 'files')).toMatchObject({
      payload: { files: ['..name/Button.tsx'] },
    });
  });

  it.each(['.env', 'src/dist/generated.js'])('rejects protected file report %s', async (path) => {
    projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-codex-'));
    const thread = new FakeThread([
      { type: 'thread.started', thread_id: 'thread-1' },
      {
        type: 'item.completed',
        item: {
          id: 'item-protected',
          type: 'file_change',
          changes: [{ path, kind: 'update', diff: '' }],
          status: 'completed',
        },
      },
    ] as ThreadEvent[]);
    const provider = new CodexCodingProvider({
      codex: new FakeCodexClient(thread),
    });
    const session = await provider.createSession({
      projectId: 'project-1',
      projectRoot,
    });

    const events = await collect(provider.sendMessage(session, createRequest()));

    expect(events.find((event) => event.type === 'error')).toMatchObject({
      payload: { code: 'codex_scope_violation', retryable: false },
    });
  });
});

describe('buildCodexPrompt', () => {
  it('marks captured content as untrusted and includes scope', () => {
    const prompt = buildCodexPrompt(createRequest());
    expect(prompt).toContain('untrusted data');
    expect(prompt).toContain('src/Button.tsx');
    expect(prompt).toContain('Make button blue');
  });
});

class FakeThread implements CodexThreadLike {
  readonly id: string | null = null;
  readonly #events: ThreadEvent[];
  input?: Input;

  constructor(events: ThreadEvent[]) {
    this.#events = events;
  }

  async runStreamed(input: Input): Promise<{ events: AsyncGenerator<ThreadEvent> }> {
    this.input = input;
    const events = [...this.#events];
    return {
      events: (async function* () {
        yield* events;
      })(),
    };
  }
}

class BlockingThread implements CodexThreadLike {
  readonly id: string | null = null;

  async runStreamed(
    _input: Input,
    options?: TurnOptions,
  ): Promise<{ events: AsyncGenerator<ThreadEvent> }> {
    const signal = options?.signal;
    return {
      events: (async function* () {
        yield { type: 'thread.started', thread_id: 'thread-1' } as ThreadEvent;
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      })(),
    };
  }
}

class FailingThread implements CodexThreadLike {
  readonly id: string | null = null;
  readonly #message: string;

  constructor(message: string) {
    this.#message = message;
  }

  async runStreamed(): Promise<{ events: AsyncGenerator<ThreadEvent> }> {
    throw new Error(this.#message);
  }
}

class FakeCodexClient implements CodexClientLike {
  readonly #thread: CodexThreadLike;
  startOptions?: ThreadOptions;
  resumedThreadId?: string;

  constructor(thread: CodexThreadLike) {
    this.#thread = thread;
  }

  startThread(options: ThreadOptions): CodexThreadLike {
    this.startOptions = options;
    return this.#thread;
  }

  resumeThread(id: string, options: ThreadOptions): CodexThreadLike {
    this.resumedThreadId = id;
    this.startOptions = options;
    return this.#thread;
  }
}

async function collect<Value>(iterable: AsyncIterable<Value>): Promise<Value[]> {
  const values: Value[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

function createRequest(): AgentRequest {
  const createdAt = new Date().toISOString();
  return {
    schemaVersion: PATCHLENS_PROTOCOL_VERSION,
    requestId: 'request-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    selectionId: 'selection-1',
    provider: 'codex',
    instruction: 'Make button blue',
    context: {
      schemaVersion: PATCHLENS_PROTOCOL_VERSION,
      selection: {
        schemaVersion: PATCHLENS_PROTOCOL_VERSION,
        id: 'selection-1',
        projectId: 'project-1',
        route: '/',
        viewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
        rectangle: { x: 10, y: 10, width: 100, height: 40 },
        elements: [
          {
            id: 'element-1',
            patchlensId: 'pl_button',
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
              id: 'pl_button',
              framework: 'react',
              componentName: 'Button',
              file: 'src/Button.tsx',
              line: 10,
              column: 2,
            },
            confidence: 1,
          },
        ],
        confidence: 'exact',
        createdAt,
      },
      sanitizedHtml: '<button>Start</button>',
      computedStyles: { color: 'black' },
      relatedSourceFiles: [{ path: 'src/Button.tsx', startLine: 1, endLine: 30 }],
      consoleEntries: [],
      capturedAt: createdAt,
    },
    scopePolicy: 'prefer-selection',
    verification: { route: '/', captureAfterChange: true, commands: [] },
    createdAt,
  };
}
