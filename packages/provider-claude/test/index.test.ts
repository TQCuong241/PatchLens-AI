import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { PATCHLENS_PROTOCOL_VERSION } from '@patchlens-ai/agent-protocol';
import type { AgentRequest } from '@patchlens-ai/agent-protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ClaudeCodingProvider,
  buildClaudePrompt,
  type ClaudeQueryFunction,
  type ClaudeQueryInput,
} from '../src/index.js';

let projectRoot: string | undefined;

afterEach(async () => {
  if (projectRoot) {
    await rm(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  }
});

describe('ClaudeCodingProvider', () => {
  it('maps messages, reports files, and uses locked-down options', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-claude-'));
    await mkdir(join(projectRoot, 'src'));
    const fake = createFakeQuery([
      createMessage({
        type: 'system',
        subtype: 'init',
        session_id: 'claude-session-1',
      }),
      createMessage({
        type: 'assistant',
        session_id: 'claude-session-1',
        message: {
          content: [
            { type: 'text', text: 'Updated button.' },
            {
              type: 'tool_use',
              name: 'Edit',
              input: { file_path: 'src/Button.tsx' },
            },
          ],
        },
      }),
      createMessage({
        type: 'result',
        subtype: 'success',
        session_id: 'claude-session-1',
        result: 'Done.',
      }),
    ]);
    const provider = new ClaudeCodingProvider({ query: fake.query });
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
    expect(session.providerSessionId).toBe('claude-session-1');
    expect(fake.inputs[0]?.options).toMatchObject({
      cwd: projectRoot,
      permissionMode: 'default',
      settingSources: [],
      strictMcpConfig: true,
      tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
    });
    expect(fake.inputs[0]?.options?.disallowedTools).toContain('Bash');
  });

  it('resumes a captured Claude session', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-claude-'));
    const fake = createFakeQuery([
      createMessage({
        type: 'result',
        subtype: 'success',
        session_id: 'claude-existing',
        result: 'Done.',
      }),
    ]);
    const provider = new ClaudeCodingProvider({ query: fake.query });
    const session = await provider.createSession({
      projectId: 'project-1',
      projectRoot,
      providerSessionId: 'claude-existing',
    });

    await collect(provider.sendMessage(session, createRequest()));

    expect(fake.inputs[0]?.options?.resume).toBe('claude-existing');
  });

  it('denies tool paths outside project root', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-claude-'));
    const fake = createFakeQuery([
      createMessage({
        type: 'result',
        subtype: 'success',
        session_id: 'claude-session-1',
        result: 'Done.',
      }),
    ]);
    const provider = new ClaudeCodingProvider({ query: fake.query });
    const session = await provider.createSession({
      projectId: 'project-1',
      projectRoot,
    });

    await collect(provider.sendMessage(session, createRequest()));
    const decision = await fake.inputs[0]?.options?.canUseTool?.(
      'Write',
      { file_path: '../secret.txt', content: 'no' },
      {} as never,
    );

    expect(decision).toMatchObject({ behavior: 'deny' });
  });

  it('requires explicit project paths for search tools', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-claude-'));
    await mkdir(join(projectRoot, 'src'));
    await mkdir(join(projectRoot, '..name'));
    const fake = createFakeQuery([
      createMessage({
        type: 'result',
        subtype: 'success',
        session_id: 'claude-session-1',
        result: 'Done.',
      }),
    ]);
    const provider = new ClaudeCodingProvider({ query: fake.query });
    const session = await provider.createSession({
      projectId: 'project-1',
      projectRoot,
    });

    await collect(provider.sendMessage(session, createRequest()));
    const missingPath = await fake.inputs[0]?.options?.canUseTool?.(
      'Grep',
      { pattern: 'Button' },
      {} as never,
    );
    const safePath = await fake.inputs[0]?.options?.canUseTool?.(
      'Glob',
      { pattern: '**/*.ts', path: 'src' },
      {} as never,
    );
    const dottedPath = await fake.inputs[0]?.options?.canUseTool?.(
      'Glob',
      { pattern: '**/*.ts', path: '..name' },
      {} as never,
    );

    expect(missingPath).toMatchObject({ behavior: 'deny' });
    expect(safePath).toMatchObject({ behavior: 'allow' });
    expect(dottedPath).toMatchObject({ behavior: 'allow' });
  });

  it('maps cancellation to a cancelled event', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-claude-'));
    const provider = new ClaudeCodingProvider({ query: createBlockingQuery() });
    const session = await provider.createSession({
      projectId: 'project-1',
      projectRoot,
    });
    const iterator = provider.sendMessage(session, createRequest())[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    await iterator.next();
    const blocked = iterator.next();

    await provider.cancel(session);

    await expect(blocked).resolves.toMatchObject({ value: { type: 'cancelled' } });
    expect(session.status).toBe('idle');
    expect(session.activeSelectionId).toBeUndefined();
  });

  it('preserves disposed state when aborting an active turn', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-claude-'));
    const provider = new ClaudeCodingProvider({ query: createBlockingQuery() });
    const session = await provider.createSession({
      projectId: 'project-1',
      projectRoot,
    });
    const iterator = provider.sendMessage(session, createRequest())[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    await iterator.next();
    const blocked = iterator.next();

    await provider.dispose(session);

    await expect(blocked).resolves.toMatchObject({
      value: { type: 'cancelled', payload: { reason: 'Claude session disposed' } },
    });
    expect(session.status).toBe('disposed');
    expect(session.activeSelectionId).toBeUndefined();
  });

  it('maps auth failures and redacts project root', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-claude-'));
    const fakeGithubToken = ['github', 'pat', 'abcdefghijklmnopqrstuvwxyz123456'].join('_');
    const normalizedRoot = projectRoot.replaceAll('\\', '/');
    const provider = new ClaudeCodingProvider({
      query: () => {
        throw new Error(
          `authentication_failed at ${normalizedRoot} password=secret ${fakeGithubToken}`,
        );
      },
    });
    const session = await provider.createSession({
      projectId: 'project-1',
      projectRoot,
    });

    const events = await collect(provider.sendMessage(session, createRequest()));
    const error = events.find((event) => event.type === 'error');

    expect(error).toMatchObject({ payload: { code: 'claude_auth_failed' } });
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain(projectRoot);
    expect(serialized).not.toContain(normalizedRoot);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain(fakeGithubToken);
    expect(session.activeSelectionId).toBeUndefined();
  });

  it('rejects reported files outside project root', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-claude-'));
    const fake = createFakeQuery([
      createMessage({
        type: 'assistant',
        session_id: 'claude-session-1',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Write',
              input: { file_path: '../secret.txt' },
            },
          ],
        },
      }),
    ]);
    const provider = new ClaudeCodingProvider({ query: fake.query });
    const session = await provider.createSession({
      projectId: 'project-1',
      projectRoot,
    });

    const events = await collect(provider.sendMessage(session, createRequest()));

    expect(events.find((event) => event.type === 'error')).toMatchObject({
      payload: { code: 'claude_scope_violation', retryable: false },
    });
  });
});

describe('buildClaudePrompt', () => {
  it('marks captured content as untrusted and includes scope', () => {
    const prompt = buildClaudePrompt(createRequest());
    expect(prompt).toContain('untrusted data');
    expect(prompt).toContain('src/Button.tsx');
    expect(prompt).toContain('Make button blue');
    expect(prompt).toContain('Never request Bash');
    expect(prompt).toContain('explicit project-relative path');
  });
});

function createFakeQuery(messages: SDKMessage[]): {
  query: ClaudeQueryFunction;
  inputs: ClaudeQueryInput[];
} {
  const inputs: ClaudeQueryInput[] = [];
  return {
    inputs,
    query(input) {
      inputs.push(input);
      const values = [...messages];
      return (async function* () {
        yield* values;
      })();
    },
  };
}

function createBlockingQuery(): ClaudeQueryFunction {
  return (input) =>
    (async function* () {
      yield createMessage({
        type: 'system',
        subtype: 'init',
        session_id: 'claude-session-1',
      });
      await new Promise<void>((_resolve, reject) => {
        input.options?.abortController?.signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    })();
}

function createMessage(value: Record<string, unknown>): SDKMessage {
  return value as SDKMessage;
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
    provider: 'claude',
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
