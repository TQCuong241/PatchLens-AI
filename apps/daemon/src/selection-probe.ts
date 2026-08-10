import type { SelectionContext, VisualSelection } from '@patchlens-ai/agent-protocol';
import type {
  PreviewCaptureInput,
  PreviewProbe,
  PreviewSnapshot,
} from '@patchlens-ai/visual-verifier';

import type { SelectionStore } from './selection-store.js';

export type SelectionStoreProbeOptions = {
  store: SelectionStore;
  projectId: string;
  baseline: SelectionContext;
  refreshTimeoutMs?: number;
  pollIntervalMs?: number;
};

export class SelectionStoreProbe implements PreviewProbe {
  readonly #store: SelectionStore;
  readonly #projectId: string;
  readonly #baseline: SelectionContext;
  readonly #refreshTimeoutMs: number;
  readonly #pollIntervalMs: number;
  #captureCount = 0;

  constructor(options: SelectionStoreProbeOptions) {
    this.#store = options.store;
    this.#projectId = options.projectId;
    this.#baseline = structuredClone(options.baseline);
    this.#refreshTimeoutMs = options.refreshTimeoutMs ?? 8_000;
    this.#pollIntervalMs = options.pollIntervalMs ?? 100;
  }

  async capture(request: PreviewCaptureInput): Promise<PreviewSnapshot> {
    this.#captureCount += 1;
    if (this.#captureCount === 1) {
      return contextToSnapshot(this.#baseline, request.selection, request.captureScreenshot);
    }

    const refreshed = await this.#waitForRefresh(request.selection, request.captureScreenshot);
    const current = refreshed.context ?? this.#store.get(this.#projectId);
    return contextToSnapshot(
      current,
      request.selection,
      request.captureScreenshot && refreshed.updated,
    );
  }

  async #waitForRefresh(
    selection: VisualSelection,
    requireNewScreenshot: boolean,
  ): Promise<{ context?: SelectionContext; updated: boolean }> {
    const deadline = Date.now() + this.#refreshTimeoutMs;
    while (Date.now() < deadline) {
      const current = this.#store.get(this.#projectId);
      if (!current) {
        return { updated: true };
      }
      if (
        current.selection.id !== selection.id ||
        current.selection.route !== this.#baseline.selection.route
      ) {
        return { context: current, updated: true };
      }
      if (!requireNewScreenshot && current.capturedAt !== this.#baseline.capturedAt) {
        return { context: current, updated: true };
      }
      if (
        requireNewScreenshot &&
        current.screenshot &&
        current.screenshot.path !== this.#baseline.screenshot?.path
      ) {
        return { context: current, updated: true };
      }
      await delay(this.#pollIntervalMs);
    }
    return { context: this.#store.get(this.#projectId), updated: false };
  }
}

function contextToSnapshot(
  context: SelectionContext | undefined,
  expectedSelection: VisualSelection,
  includeScreenshot: boolean,
): PreviewSnapshot {
  return {
    capturedAt: context?.capturedAt ?? new Date().toISOString(),
    route: context?.selection.route ?? expectedSelection.route,
    routeRendered: Boolean(context),
    selectionPresent: context?.selection.id === expectedSelection.id,
    screenshot: includeScreenshot ? context?.screenshot : undefined,
    consoleEntries: context?.consoleEntries.map((entry) => ({ ...entry })) ?? [],
  };
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, timeoutMs));
}
