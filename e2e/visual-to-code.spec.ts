import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';
import {
  PATCHLENS_PROTOCOL_VERSION,
  type AgentEvent,
  type AgentRequest,
} from '@patchlens-ai/agent-protocol';
import {
  CodexCodingProvider,
  type CodexClientLike,
  type CodexThreadLike,
} from '@patchlens-ai/provider-codex';

type HarnessMessage = { type?: string; payload?: unknown };

declare global {
  interface Window {
    enablePatchLens(): void;
    patchLensMessages: HarnessMessage[];
  }
}

const demoRoot = resolve('examples/react-vite-demo');
const hmrFixturePath = resolve(demoRoot, 'src/HmrFixture.tsx');

test('click selection resolves component source location', async ({ page }) => {
  const frame = await openHarness(page);

  await frame.getByRole('button', { name: 'Choose Builder' }).click();
  const message = await waitForHarnessMessage(page, 'inspector:selection');
  const payload = message.payload as {
    sourceCandidates: Array<{
      location: { componentName?: string; file: string; line: number; column: number };
    }>;
  };

  expect(payload.sourceCandidates[0]?.location).toMatchObject({
    componentName: 'PrimaryButton',
    file: 'src/App.tsx',
  });
  expect(payload.sourceCandidates[0]?.location.line).toBeGreaterThan(0);
  expect(payload.sourceCandidates[0]?.location.column).toBeGreaterThanOrEqual(0);
});

test('Codex managed edit reaches preview through Vite HMR', async ({ page }) => {
  const frame = await openHarness(page);
  const original = await readFile(hmrFixturePath, 'utf8');
  const updated = original.replace('HMR baseline', 'HMR updated');
  const provider = new CodexCodingProvider({
    codex: createEditingCodexClient(updated),
  });
  const session = await provider.createSession({
    projectId: 'e2e-project',
    projectRoot: demoRoot,
  });

  try {
    const events: AgentEvent[] = [];
    for await (const event of provider.sendMessage(session, createHmrAgentRequest(session.id))) {
      events.push(event);
    }

    expect(events.some((event) => event.type === 'files')).toBe(true);
    expect(events.at(-1)?.type).toBe('complete');
    await expect(frame.getByTestId('hmr-fixture')).toHaveText('HMR updated');
  } finally {
    await provider.dispose(session);
    await writeFile(hmrFixturePath, original);
  }
});

async function openHarness(page: Page) {
  await page.goto('/e2e-harness.html');
  await waitForHarnessMessage(page, 'inspector:ready');
  await page.evaluate(() => {
    window.enablePatchLens();
  });
  return page.frameLocator('#preview');
}

async function waitForHarnessMessage(
  page: Page,
  type: string,
): Promise<{ type: string; payload: unknown }> {
  await page.waitForFunction((messageType) => {
    return window.patchLensMessages.some((message) => message.type === messageType);
  }, type);
  return page.evaluate((messageType) => {
    const message = window.patchLensMessages.find((entry) => entry.type === messageType);
    if (!message?.type) {
      throw new Error(`Harness message not found: ${messageType}`);
    }
    return { type: message.type, payload: message.payload };
  }, type);
}

function createEditingCodexClient(updatedSource: string): CodexClientLike {
  const thread = {
    id: null,
    async runStreamed() {
      await writeFile(hmrFixturePath, updatedSource);
      return {
        events: (async function* () {
          yield { type: 'thread.started', thread_id: 'thread-e2e-hmr' };
          yield {
            type: 'item.completed',
            item: {
              id: 'item-hmr-file',
              type: 'file_change',
              changes: [
                {
                  path: 'src/HmrFixture.tsx',
                  kind: 'update',
                  diff: '@@ -1 +1 @@',
                },
              ],
              status: 'completed',
            },
          };
          yield {
            type: 'turn.completed',
            usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
          };
        })(),
      } as Awaited<ReturnType<CodexThreadLike['runStreamed']>>;
    },
  } satisfies CodexThreadLike;
  return {
    startThread: () => thread,
    resumeThread: () => thread,
  };
}

function createHmrAgentRequest(sessionId: string): AgentRequest {
  const createdAt = '2026-08-09T12:00:00.000Z';
  return {
    schemaVersion: PATCHLENS_PROTOCOL_VERSION,
    requestId: 'request-e2e-hmr',
    projectId: 'e2e-project',
    sessionId,
    selectionId: 'selection-e2e-hmr',
    provider: 'codex',
    instruction: 'Update HMR fixture text',
    context: {
      schemaVersion: PATCHLENS_PROTOCOL_VERSION,
      selection: {
        schemaVersion: PATCHLENS_PROTOCOL_VERSION,
        id: 'selection-e2e-hmr',
        projectId: 'e2e-project',
        route: '/',
        viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
        rectangle: { x: 10, y: 10, width: 200, height: 40 },
        elements: [
          {
            id: 'element-e2e-hmr',
            patchlensId: 'pl_e2e_hmr',
            tagName: 'p',
            text: 'HMR baseline',
            sanitizedHtml: '<p>HMR baseline</p>',
            rectangle: { x: 10, y: 10, width: 200, height: 40 },
          },
        ],
        primaryElementId: 'element-e2e-hmr',
        sourceCandidates: [
          {
            location: {
              id: 'pl_e2e_hmr',
              framework: 'react',
              componentName: 'HmrFixture',
              file: 'src/HmrFixture.tsx',
              line: 2,
              column: 10,
            },
            confidence: 1,
          },
        ],
        confidence: 'exact',
        createdAt,
      },
      sanitizedHtml: '<p>HMR baseline</p>',
      computedStyles: {},
      relatedSourceFiles: [{ path: 'src/HmrFixture.tsx', startLine: 1, endLine: 3 }],
      consoleEntries: [],
      capturedAt: createdAt,
    },
    scopePolicy: 'strict',
    verification: { route: '/', captureAfterChange: false, commands: [] },
    createdAt,
  };
}
