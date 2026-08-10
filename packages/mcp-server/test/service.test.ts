import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PATCHLENS_PROTOCOL_VERSION } from '@patchlens-ai/agent-protocol';
import type { DaemonHealth, SelectionContext } from '@patchlens-ai/agent-protocol';

import { PatchLensContextService } from '../src/service.js';
import type { DaemonSelectionClient } from '../src/service.js';
import type { PatchLensSessionDescriptor } from '../src/session.js';

let projectRoot: string | undefined;

afterEach(async () => {
  if (projectRoot) {
    await rm(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  }
});

describe('PatchLensContextService', () => {
  it('reads only source files linked to active selection', async () => {
    projectRoot = await createProject();
    const client = new FakeClient(createContext());
    const service = new PatchLensContextService({
      session: createSession(projectRoot),
      client,
    });

    const files = await service.getSourceContext({
      path: 'src/Component.tsx',
      contextLines: 0,
    });

    expect(files).toEqual([
      expect.objectContaining({
        path: 'src/Component.tsx',
        exists: true,
        startLine: 2,
        endLine: 2,
        content: 'export const Component = () => <button>Start</button>;',
      }),
    ]);
    await expect(service.getSourceContext({ path: 'package.json' })).rejects.toThrow(
      'outside active selection',
    );
    await expect(service.getSourceContext({ path: '../secret.txt' })).rejects.toThrow(
      'Invalid project-relative',
    );
  });

  it('rejects stale active selections', async () => {
    projectRoot = await createProject();
    const context = createContext();
    context.capturedAt = new Date(Date.now() - 60_000).toISOString();
    const service = new PatchLensContextService({
      session: createSession(projectRoot),
      client: new FakeClient(context),
      maximumSelectionAgeMs: 1_000,
    });

    await expect(service.getActiveSelection()).rejects.toThrow('stale');
  });

  it('accepts source directories whose names begin with two dots', async () => {
    projectRoot = await createProject();
    await mkdir(join(projectRoot, '..name'));
    await writeFile(join(projectRoot, '..name', 'Component.tsx'), 'export const dotted = true;\n');
    const context = createContext();
    context.relatedSourceFiles.push({ path: '..name/Component.tsx', startLine: 1, endLine: 1 });
    const service = new PatchLensContextService({
      session: createSession(projectRoot),
      client: new FakeClient(context),
    });

    const files = await service.getSourceContext({
      path: '..name/Component.tsx',
      contextLines: 0,
    });

    expect(files).toEqual([
      expect.objectContaining({
        path: '..name/Component.tsx',
        exists: true,
        content: 'export const dotted = true;',
      }),
    ]);
  });

  it('compares captured baseline with refreshed context', async () => {
    projectRoot = await createProject();
    const before = createContext();
    before.screenshot = screenshot('before.png');
    const client = new FakeClient(before);
    const service = new PatchLensContextService({
      session: createSession(projectRoot),
      client,
      verificationRefreshTimeoutMs: 500,
      verificationPollIntervalMs: 5,
    });
    await service.capturePreview();
    const after = createContext();
    after.capturedAt = new Date(Date.parse(before.capturedAt) + 1_000).toISOString();
    after.screenshot = screenshot('after.png');
    after.consoleEntries.push({
      level: 'error',
      message: 'Render failed',
      createdAt: new Date().toISOString(),
    });
    setTimeout(() => {
      client.context = after;
    }, 10);

    const result = await service.verifyVisualChange();

    expect(result).toMatchObject({
      ok: false,
      complete: true,
      screenshotEvidence: true,
      selectionPresent: true,
    });
    expect(result.summary).toContain('1 new console error');
    expect(client.getSelectionCalls).toBeGreaterThan(2);
  });

  it('does not reuse captured baseline as after-change evidence', async () => {
    projectRoot = await createProject();
    const before = createContext();
    before.screenshot = screenshot('before.png');
    const client = new FakeClient(before);
    const service = new PatchLensContextService({
      session: createSession(projectRoot),
      client,
      verificationRefreshTimeoutMs: 5,
      verificationPollIntervalMs: 1,
    });
    await service.capturePreview();

    const result = await service.verifyVisualChange();

    expect(result).toMatchObject({
      ok: false,
      complete: false,
      screenshotEvidence: false,
      selectionPresent: true,
    });
    expect(result.summary).toContain('did not refresh');
  });
});

class FakeClient implements DaemonSelectionClient {
  context: SelectionContext;
  getSelectionCalls = 0;

  constructor(context: SelectionContext) {
    this.context = context;
  }

  async health(): Promise<DaemonHealth> {
    return {
      ok: true,
      service: 'patchlens-daemon',
      version: '0.0.0',
      protocolVersion: PATCHLENS_PROTOCOL_VERSION,
      providers: [{ id: 'mock', status: 'available' }],
    };
  }

  async getSelection(): Promise<SelectionContext> {
    this.getSelectionCalls += 1;
    return structuredClone(this.context);
  }
}

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'patchlens-mcp-service-'));
  await mkdir(join(root, 'src'));
  await writeFile(
    join(root, 'src', 'Component.tsx'),
    [
      "import { memo } from 'react';",
      'export const Component = () => <button>Start</button>;',
      'export default memo(Component);',
    ].join('\n'),
  );
  return root;
}

function createSession(root: string): PatchLensSessionDescriptor {
  return {
    schemaVersion: 2,
    sessionId: 'bridge-1',
    daemonUrl: 'http://127.0.0.1:4312',
    daemonToken: 'daemon-token',
    projectId: 'project-1',
    projectRoot: root,
    packageManager: 'npm',
    daemonPid: process.pid,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function createContext(): SelectionContext {
  const now = new Date().toISOString();
  return {
    schemaVersion: PATCHLENS_PROTOCOL_VERSION,
    selection: {
      schemaVersion: PATCHLENS_PROTOCOL_VERSION,
      id: 'selection-1',
      projectId: 'project-1',
      route: '/',
      viewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
      rectangle: { x: 10, y: 10, width: 100, height: 50 },
      elements: [
        {
          id: 'element-1',
          patchlensId: 'pl_component',
          tagName: 'button',
          text: 'Start',
          sanitizedHtml: '<button>Start</button>',
          rectangle: { x: 10, y: 10, width: 100, height: 50 },
        },
      ],
      primaryElementId: 'element-1',
      sourceCandidates: [
        {
          location: {
            id: 'pl_component',
            framework: 'react',
            componentName: 'Component',
            file: 'src/Component.tsx',
            line: 2,
            column: 0,
          },
          confidence: 1,
        },
      ],
      confidence: 'exact',
      createdAt: now,
    },
    sanitizedHtml: '<button>Start</button>',
    computedStyles: {},
    relatedSourceFiles: [{ path: 'src/Component.tsx', startLine: 2, endLine: 2 }],
    consoleEntries: [],
    capturedAt: now,
  };
}

function screenshot(path: string) {
  return {
    path,
    mimeType: 'image/png' as const,
    width: 100,
    height: 50,
    byteLength: 500,
  };
}
