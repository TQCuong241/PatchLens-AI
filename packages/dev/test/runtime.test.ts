import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PATCHLENS_MESSAGE_SOURCE,
  PATCHLENS_PROTOCOL_VERSION,
  type InspectorToStudioMessage,
} from '@patchlens-ai/agent-protocol';

import { installPatchLensInspector, type InstalledPatchLensInspector } from '../src/runtime.js';

const originalParent = window.parent;
let installation: InstalledPatchLensInspector | undefined;

afterEach(() => {
  installation?.stop();
  installation = undefined;
  Object.defineProperty(window, 'parent', { configurable: true, value: originalParent });
  history.replaceState(null, '', '/');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('PatchLens Inspector bootstrap', () => {
  it('does not install outside an authenticated iframe connection', async () => {
    await expect(installPatchLensInspector()).resolves.toBeUndefined();

    stubParentWindow();
    history.replaceState(
      null,
      '',
      '/?patchlensProjectId=project&patchlensChannelId=channel&patchlensStudioOrigin=*',
    );
    await expect(installPatchLensInspector()).resolves.toBeUndefined();

    history.replaceState(
      null,
      '',
      '/?patchlensProjectId=project&patchlensChannelId=channel&patchlensStudioOrigin=https://studio.example',
    );
    await expect(installPatchLensInspector()).resolves.toBeUndefined();
  });

  it('loads a same-origin manifest and starts one idempotent runtime', async () => {
    const { postMessage } = stubParentWindow();
    setConnectionParameters();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            'button-primary': {
              id: 'button-primary',
              framework: 'react',
              componentName: 'PrimaryButton',
              file: 'src/App.tsx',
              line: 42,
              column: 4,
              tagName: 'button',
            },
            invalid: { file: 'src/Invalid.tsx' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    installation = await installPatchLensInspector({ refreshIntervalMs: 60_000 });
    const repeated = await installPatchLensInspector({ refreshIntervalMs: 60_000 });

    expect(installation).toBeDefined();
    expect(repeated).toBe(installation);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(new URL('/__patchlens/manifest', location.href), {
      cache: 'no-store',
    });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        source: PATCHLENS_MESSAGE_SOURCE,
        schemaVersion: PATCHLENS_PROTOCOL_VERSION,
        type: 'inspector:ready' satisfies InspectorToStudioMessage['type'],
      }),
      'http://127.0.0.1:4310',
    );
    expect(document.querySelector('[data-patchlens-overlay="true"]')).not.toBeNull();

    installation?.stop();
    installation = undefined;
    expect(document.querySelector('[data-patchlens-overlay="true"]')).toBeNull();
  });

  it('rejects unsafe options before starting runtime side effects', async () => {
    stubParentWindow();
    setConnectionParameters();

    await expect(
      installPatchLensInspector({ manifestEndpoint: 'https://attacker.test/manifest' }),
    ).rejects.toThrow('PatchLens manifest endpoint must be same-origin');
    await expect(installPatchLensInspector({ refreshIntervalMs: 100 })).rejects.toThrow(
      'refreshIntervalMs must be between 500 and 60000',
    );
    expect(document.querySelector('[data-patchlens-overlay="true"]')).toBeNull();
  });
});

function stubParentWindow(): { postMessage: ReturnType<typeof vi.fn> } {
  const postMessage = vi.fn();
  Object.defineProperty(window, 'parent', {
    configurable: true,
    value: { postMessage },
  });
  return { postMessage };
}

function setConnectionParameters(): void {
  history.replaceState(
    null,
    '',
    '/?patchlensProjectId=project&patchlensChannelId=channel&patchlensStudioOrigin=http://127.0.0.1:4310',
  );
}
