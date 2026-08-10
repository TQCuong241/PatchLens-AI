import { isSourceLocation } from '@patchlens-ai/agent-protocol';
import type { SourceManifest } from '@patchlens-ai/agent-protocol';
import { createInspectorRuntime } from '@patchlens-ai/inspector-runtime';
import type { InspectorRuntime } from '@patchlens-ai/inspector-runtime';

export type InstallPatchLensInspectorOptions = {
  manifestEndpoint?: string | false;
  refreshIntervalMs?: number;
};

export type InstalledPatchLensInspector = {
  stop(): void;
};

let activeInstallation: InstalledPatchLensInspector | undefined;

export async function installPatchLensInspector(
  options: InstallPatchLensInspectorOptions = {},
): Promise<InstalledPatchLensInspector | undefined> {
  if (activeInstallation) {
    return activeInstallation;
  }

  const connection = readConnectionParameters();
  if (!connection) {
    return undefined;
  }

  const manifestEndpoint = options.manifestEndpoint ?? '/__patchlens/manifest';
  const manifestUrl =
    manifestEndpoint === false ? undefined : new URL(manifestEndpoint, location.href);
  if (manifestUrl && manifestUrl.origin !== location.origin) {
    throw new Error('PatchLens manifest endpoint must be same-origin');
  }
  const refreshIntervalMs = normalizeRefreshInterval(options.refreshIntervalMs);

  const runtime = createInspectorRuntime({
    projectId: connection.projectId,
    channelId: connection.channelId,
    targetOrigin: connection.studioOrigin,
    targetWindow: window.parent,
    sourceManifest: manifestUrl ? await loadManifest(manifestUrl) : {},
  });
  runtime.start();

  const refreshTimer = manifestUrl
    ? window.setInterval(() => {
        void refreshManifest(runtime, manifestUrl);
      }, refreshIntervalMs)
    : undefined;
  let stopped = false;
  activeInstallation = {
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      if (refreshTimer !== undefined) {
        window.clearInterval(refreshTimer);
      }
      runtime.stop();
      activeInstallation = undefined;
    },
  };
  window.addEventListener('beforeunload', () => activeInstallation?.stop(), {
    once: true,
  });
  return activeInstallation;
}

type ConnectionParameters = {
  projectId: string;
  channelId: string;
  studioOrigin: string;
};

function readConnectionParameters(): ConnectionParameters | undefined {
  if (window.parent === window) {
    return undefined;
  }
  const parameters = new URLSearchParams(location.search);
  const projectId = parameters.get('patchlensProjectId');
  const channelId = parameters.get('patchlensChannelId');
  const studioOrigin = parameters.get('patchlensStudioOrigin');
  if (!projectId || !channelId || !studioOrigin || studioOrigin === '*') {
    return undefined;
  }
  if (projectId.length > 256 || channelId.length > 256) {
    return undefined;
  }

  let parsedStudioOrigin: URL;
  try {
    parsedStudioOrigin = new URL(studioOrigin);
  } catch {
    return undefined;
  }
  if (
    parsedStudioOrigin.protocol !== 'http:' ||
    (parsedStudioOrigin.hostname !== '127.0.0.1' && parsedStudioOrigin.hostname !== 'localhost') ||
    parsedStudioOrigin.origin !== studioOrigin
  ) {
    return undefined;
  }

  if (document.referrer) {
    try {
      if (new URL(document.referrer).origin !== studioOrigin) {
        return undefined;
      }
    } catch {
      return undefined;
    }
  }
  return { projectId, channelId, studioOrigin };
}

async function refreshManifest(runtime: InspectorRuntime, manifestUrl: URL): Promise<void> {
  runtime.replaceSourceManifest(await loadManifest(manifestUrl));
}

async function loadManifest(manifestUrl: URL): Promise<SourceManifest> {
  try {
    const response = await fetch(manifestUrl, { cache: 'no-store' });
    if (!response.ok) {
      return {};
    }
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    const manifest: SourceManifest = {};
    for (const [id, entry] of Object.entries(value)) {
      if (isSourceLocation(entry) && entry.id === id) {
        manifest[id] = entry;
      }
    }
    return manifest;
  } catch {
    return {};
  }
}

function normalizeRefreshInterval(value: number | undefined): number {
  if (value === undefined) {
    return 2_000;
  }
  if (!Number.isFinite(value) || value < 500 || value > 60_000) {
    throw new Error('refreshIntervalMs must be between 500 and 60000');
  }
  return Math.round(value);
}
