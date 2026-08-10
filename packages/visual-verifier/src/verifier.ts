import type {
  ConsoleEntry,
  ScreenshotReference,
  VerificationCommandId,
  VisualComparison,
  VisualSelection,
} from '@patchlens-ai/agent-protocol';

import {
  runAllowedVerificationCommands,
  type VerificationCommandAllowlist,
  type VerificationCommandResult,
} from './commands.js';

export type PreviewCaptureInput = {
  route: string;
  selection: VisualSelection;
  captureScreenshot: boolean;
};

export type PreviewSnapshot = {
  capturedAt: string;
  route: string;
  routeRendered: boolean;
  selectionPresent: boolean;
  screenshot?: ScreenshotReference;
  consoleEntries: ConsoleEntry[];
};

export interface PreviewProbe {
  capture(input: PreviewCaptureInput): Promise<PreviewSnapshot>;
}

export type VerificationBaseline = {
  selectionId: string;
  route: string;
  snapshot: PreviewSnapshot;
};

export type VisualVerificationInput = {
  route: string;
  selection: VisualSelection;
  captureAfterChange: boolean;
  commands: readonly VerificationCommandId[];
};

export type VisualVerificationResult = {
  ok: boolean;
  summary: string;
  routeRendered: boolean;
  selectionPresent: boolean;
  beforeScreenshot?: ScreenshotReference;
  afterScreenshot?: ScreenshotReference;
  visualComparison?: VisualComparison;
  newConsoleEntries: ConsoleEntry[];
  commands: VerificationCommandId[];
  commandResults: VerificationCommandResult[];
  verifiedAt: string;
};

export type VisualVerifierOptions = {
  probe: PreviewProbe;
  commandCwd?: string;
  commandAllowlist?: VerificationCommandAllowlist;
  failOnWarnings?: boolean;
  minimumVisualSimilarity?: number;
};

export type { VisualComparison } from '@patchlens-ai/agent-protocol';

export class VisualVerifier {
  readonly #probe: PreviewProbe;
  readonly #commandCwd?: string;
  readonly #commandAllowlist?: VerificationCommandAllowlist;
  readonly #failOnWarnings: boolean;
  readonly #minimumVisualSimilarity?: number;

  constructor(options: VisualVerifierOptions) {
    this.#probe = options.probe;
    this.#commandCwd = options.commandCwd;
    this.#commandAllowlist = options.commandAllowlist;
    this.#failOnWarnings = options.failOnWarnings ?? false;
    if (
      options.minimumVisualSimilarity !== undefined &&
      (!Number.isFinite(options.minimumVisualSimilarity) ||
        options.minimumVisualSimilarity < 0 ||
        options.minimumVisualSimilarity > 1)
    ) {
      throw new Error('minimumVisualSimilarity must be between 0 and 1');
    }
    this.#minimumVisualSimilarity = options.minimumVisualSimilarity;
  }

  async captureBaseline(
    input: Omit<VisualVerificationInput, 'commands'>,
  ): Promise<VerificationBaseline> {
    const snapshot = await this.#probe.capture({
      route: input.route,
      selection: input.selection,
      captureScreenshot: input.captureAfterChange,
    });
    return {
      selectionId: input.selection.id,
      route: input.route,
      snapshot,
    };
  }

  async verifyAfter(
    baseline: VerificationBaseline,
    input: VisualVerificationInput,
  ): Promise<VisualVerificationResult> {
    if (baseline.selectionId !== input.selection.id || baseline.route !== input.route) {
      throw new Error('Verification baseline does not match active selection');
    }

    const commandResults = await this.#runCommands(input.commands);
    const after = await this.#probe.capture({
      route: input.route,
      selection: input.selection,
      captureScreenshot: input.captureAfterChange,
    });
    const newConsoleEntries = findNewConsoleEntries(
      baseline.snapshot.consoleEntries,
      after.consoleEntries,
    );
    const visualComparison = comparePerceptualHashes(
      baseline.snapshot.screenshot?.perceptualHash,
      after.screenshot?.perceptualHash,
    );
    const failures: string[] = [];
    if (input.captureAfterChange && !baseline.snapshot.screenshot) {
      failures.push('before screenshot is missing');
    }
    if (!after.routeRendered || after.route !== input.route) {
      failures.push('route did not render');
    }
    if (!after.selectionPresent) {
      failures.push('selected component is missing');
    }
    if (input.captureAfterChange && !after.screenshot) {
      failures.push('after screenshot is missing');
    }
    if (
      visualComparison &&
      this.#minimumVisualSimilarity !== undefined &&
      visualComparison.similarity < this.#minimumVisualSimilarity
    ) {
      failures.push(
        `visual similarity ${(visualComparison.similarity * 100).toFixed(1)}% is below ${(this.#minimumVisualSimilarity * 100).toFixed(1)}%`,
      );
    }
    const blockingConsoleEntries = newConsoleEntries.filter(
      (entry) => entry.level === 'error' || this.#failOnWarnings,
    );
    if (blockingConsoleEntries.length > 0) {
      failures.push(`${blockingConsoleEntries.length} new console issue(s)`);
    }
    const failedCommands = commandResults.filter((result) => !result.ok);
    if (failedCommands.length > 0) {
      failures.push(`command failure: ${failedCommands.map((result) => result.id).join(', ')}`);
    }

    const visualSummary = visualComparison
      ? `; visual similarity ${(visualComparison.similarity * 100).toFixed(1)}%`
      : '';
    return {
      ok: failures.length === 0,
      summary:
        failures.length === 0
          ? `Visual verification passed${visualSummary}`
          : `Visual verification failed: ${failures.join('; ')}${visualSummary}`,
      routeRendered: after.routeRendered && after.route === input.route,
      selectionPresent: after.selectionPresent,
      beforeScreenshot: baseline.snapshot.screenshot,
      afterScreenshot: after.screenshot,
      visualComparison,
      newConsoleEntries,
      commands: [...new Set(input.commands)],
      commandResults,
      verifiedAt: new Date().toISOString(),
    };
  }

  async #runCommands(
    commands: readonly VerificationCommandId[],
  ): Promise<VerificationCommandResult[]> {
    if (commands.length === 0) {
      return [];
    }
    if (!this.#commandCwd || !this.#commandAllowlist) {
      throw new Error('Verification command runner is not configured');
    }
    return runAllowedVerificationCommands(commands, {
      cwd: this.#commandCwd,
      allowlist: this.#commandAllowlist,
    });
  }
}

export function comparePerceptualHashes(
  before: string | undefined,
  after: string | undefined,
): VisualComparison | undefined {
  if (!before || !after || !/^[a-f0-9]{16}$/.test(before) || !/^[a-f0-9]{16}$/.test(after)) {
    return undefined;
  }
  let difference = BigInt(`0x${before}`) ^ BigInt(`0x${after}`);
  let hammingDistance = 0;
  while (difference > 0n) {
    hammingDistance += Number(difference & 1n);
    difference >>= 1n;
  }
  return {
    hammingDistance,
    similarity: 1 - hammingDistance / 64,
    changed: hammingDistance > 0,
  };
}

export function findNewConsoleEntries(
  before: readonly ConsoleEntry[],
  after: readonly ConsoleEntry[],
): ConsoleEntry[] {
  const remainingBaseline = new Map<string, number>();
  for (const entry of before) {
    const key = consoleEntryKey(entry);
    remainingBaseline.set(key, (remainingBaseline.get(key) ?? 0) + 1);
  }

  const additions: ConsoleEntry[] = [];
  for (const entry of after) {
    const key = consoleEntryKey(entry);
    const remaining = remainingBaseline.get(key) ?? 0;
    if (remaining > 0) {
      remainingBaseline.set(key, remaining - 1);
    } else {
      additions.push({ ...entry });
    }
  }
  return additions;
}

function consoleEntryKey(entry: ConsoleEntry): string {
  return `${entry.level}\u0000${entry.message}`;
}
