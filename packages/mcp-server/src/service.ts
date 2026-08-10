import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type {
  ConsoleEntry,
  ScreenshotReference,
  SelectionContext,
  VerificationCommandId,
  VisualSelection,
} from '@patchlens-ai/agent-protocol';
import { DaemonClient } from '@patchlens-ai/daemon-client';
import {
  createPackageManagerCommandAllowlist,
  findNewConsoleEntries,
  runAllowedVerificationCommands,
} from '@patchlens-ai/visual-verifier';
import type { VerificationCommandResult } from '@patchlens-ai/visual-verifier';

import type { PatchLensSessionDescriptor } from './session.js';

export type SourceContextFile = {
  path: string;
  exists: boolean;
  startLine?: number;
  endLine?: number;
  content?: string;
  sha256?: string;
  truncated?: boolean;
};

export type CapturedPreview = {
  selectionId: string;
  route: string;
  screenshot?: ScreenshotReference;
  capturedAt: string;
};

export type AttachedVerificationResult = {
  ok: boolean;
  complete: boolean;
  summary: string;
  selectionPresent: boolean;
  routeRendered: boolean;
  screenshotEvidence: boolean;
  newConsoleEntries: ConsoleEntry[];
  missingSourceFiles: string[];
  commandResults: VerificationCommandResult[];
  verifiedAt: string;
};

export type PatchLensContextServiceOptions = {
  session: PatchLensSessionDescriptor;
  client?: DaemonSelectionClient;
  maximumSelectionAgeMs?: number;
  verificationRefreshTimeoutMs?: number;
  verificationPollIntervalMs?: number;
};

export type DaemonSelectionClient = Pick<DaemonClient, 'health' | 'getSelection'>;

type AllowedSourceRange = {
  path: string;
  startLine: number;
  endLine: number;
};

export class PatchLensContextService {
  readonly #session: PatchLensSessionDescriptor;
  readonly #client: DaemonSelectionClient;
  readonly #maximumSelectionAgeMs: number;
  readonly #verificationRefreshTimeoutMs: number;
  readonly #verificationPollIntervalMs: number;
  #verificationBaseline?: SelectionContext;

  constructor(options: PatchLensContextServiceOptions) {
    this.#session = options.session;
    this.#client =
      options.client ??
      new DaemonClient({
        baseUrl: options.session.daemonUrl,
        token: options.session.daemonToken,
      });
    this.#maximumSelectionAgeMs = options.maximumSelectionAgeMs ?? 15 * 60_000;
    this.#verificationRefreshTimeoutMs = normalizeTimingOption(
      options.verificationRefreshTimeoutMs,
      8_000,
      'verificationRefreshTimeoutMs',
    );
    this.#verificationPollIntervalMs = normalizeTimingOption(
      options.verificationPollIntervalMs,
      100,
      'verificationPollIntervalMs',
    );
  }

  async getActiveSelection(): Promise<VisualSelection> {
    return structuredClone((await this.#getFreshContext()).selection);
  }

  async getSelectionContext(): Promise<SelectionContext> {
    return structuredClone(await this.#getFreshContext());
  }

  async getSourceContext(
    options: {
      path?: string;
      contextLines?: number;
    } = {},
  ): Promise<SourceContextFile[]> {
    const context = await this.#getFreshContext();
    return this.#readSourceContext(context, options);
  }

  async #readSourceContext(
    context: SelectionContext,
    options: { path?: string; contextLines?: number } = {},
  ): Promise<SourceContextFile[]> {
    const ranges = collectAllowedSourceRanges(context);
    const contextLines = normalizeContextLines(options.contextLines);
    const selectedRanges = options.path
      ? [requireAllowedRange(ranges, options.path)]
      : [...ranges.values()].slice(0, 20);
    const files: SourceContextFile[] = [];
    let remainingBytes = 200_000;
    for (const range of selectedRanges) {
      const file = await readSourceFile(
        this.#session.projectRoot,
        range,
        contextLines,
        remainingBytes,
      );
      files.push(file);
      remainingBytes -= Buffer.byteLength(file.content ?? '');
      if (remainingBytes <= 0) {
        break;
      }
    }
    return files;
  }

  async getConsoleErrors(): Promise<ConsoleEntry[]> {
    const context = await this.#getFreshContext();
    return context.consoleEntries
      .filter((entry) => entry.level === 'error')
      .map((entry) => ({ ...entry }));
  }

  async capturePreview(): Promise<CapturedPreview> {
    const context = await this.#getFreshContext();
    this.#verificationBaseline = structuredClone(context);
    return {
      selectionId: context.selection.id,
      route: context.selection.route,
      screenshot: context.screenshot,
      capturedAt: context.capturedAt,
    };
  }

  async verifyVisualChange(
    commands: readonly VerificationCommandId[] = [],
  ): Promise<AttachedVerificationResult> {
    const baseline = this.#verificationBaseline;
    if (!baseline) {
      throw new Error('Capture preview before running visual verification');
    }
    const refresh = await this.#waitForVerificationRefresh(baseline);
    const current = refresh.context;
    const selectionPresent = current.selection.id === baseline.selection.id;
    const routeRendered = current.selection.route === baseline.selection.route;
    const screenshotEvidence = Boolean(
      refresh.updated &&
      baseline.screenshot &&
      current.screenshot &&
      current.screenshot.path !== baseline.screenshot.path,
    );
    const newConsoleEntries = findNewConsoleEntries(
      baseline.consoleEntries,
      current.consoleEntries,
    );
    const sourceFiles = await this.#readSourceContext(current);
    const missingSourceFiles = sourceFiles.filter((file) => !file.exists).map((file) => file.path);
    const commandResults = await runAllowedVerificationCommands(commands, {
      cwd: this.#session.projectRoot,
      allowlist: createPackageManagerCommandAllowlist(this.#session.packageManager),
    });
    const failures: string[] = [];
    if (!refresh.updated) {
      failures.push('selection context did not refresh after captured baseline');
    }
    if (!selectionPresent) {
      failures.push('active selection changed or disappeared');
    }
    if (!routeRendered) {
      failures.push('active route changed');
    }
    if (!screenshotEvidence) {
      failures.push('before/after screenshot evidence is unavailable');
    }
    const newErrors = newConsoleEntries.filter((entry) => entry.level === 'error');
    if (newErrors.length > 0) {
      failures.push(`${newErrors.length} new console error(s)`);
    }
    if (missingSourceFiles.length > 0) {
      failures.push(`missing source files: ${missingSourceFiles.join(', ')}`);
    }
    const failedCommands = commandResults.filter((result) => !result.ok);
    if (failedCommands.length > 0) {
      failures.push(`command failure: ${failedCommands.map((result) => result.id).join(', ')}`);
    }

    return {
      ok: failures.length === 0,
      complete: screenshotEvidence,
      summary:
        failures.length === 0
          ? 'Attached visual verification passed'
          : `Attached visual verification failed: ${failures.join('; ')}`,
      selectionPresent,
      routeRendered,
      screenshotEvidence,
      newConsoleEntries,
      missingSourceFiles,
      commandResults,
      verifiedAt: new Date().toISOString(),
    };
  }

  async #getFreshContext(): Promise<SelectionContext> {
    await this.#client.health();
    return this.#getValidatedContext();
  }

  async #waitForVerificationRefresh(
    baseline: SelectionContext,
  ): Promise<{ context: SelectionContext; updated: boolean }> {
    await this.#client.health();
    const deadline = Date.now() + this.#verificationRefreshTimeoutMs;
    let context = await this.#getValidatedContext();
    while (!isVerificationContextUpdated(baseline, context) && Date.now() < deadline) {
      await delay(this.#verificationPollIntervalMs);
      context = await this.#getValidatedContext();
    }
    return {
      context,
      updated: isVerificationContextUpdated(baseline, context),
    };
  }

  async #getValidatedContext(): Promise<SelectionContext> {
    const context = await this.#client.getSelection(this.#session.projectId);
    if (context.selection.projectId !== this.#session.projectId) {
      throw new Error('Daemon returned selection for another project');
    }

    const capturedAt = Date.parse(context.capturedAt);
    const age = Date.now() - capturedAt;
    if (!Number.isFinite(capturedAt) || age < -60_000) {
      throw new Error('Active selection timestamp is invalid');
    }
    if (age > this.#maximumSelectionAgeMs) {
      throw new Error('Active selection is stale; select the component again');
    }
    return context;
  }
}

function collectAllowedSourceRanges(context: SelectionContext): Map<string, AllowedSourceRange> {
  const ranges = new Map<string, AllowedSourceRange>();
  for (const range of context.relatedSourceFiles) {
    const path = normalizeProjectPath(range.path);
    ranges.set(path, { path, startLine: range.startLine, endLine: range.endLine });
  }
  for (const candidate of context.selection.sourceCandidates) {
    const path = normalizeProjectPath(candidate.location.file);
    if (!ranges.has(path)) {
      ranges.set(path, {
        path,
        startLine: candidate.location.line,
        endLine: candidate.location.line,
      });
    }
  }
  return ranges;
}

function requireAllowedRange(
  ranges: ReadonlyMap<string, AllowedSourceRange>,
  requestedPath: string,
): AllowedSourceRange {
  const path = normalizeProjectPath(requestedPath);
  const range = ranges.get(path);
  if (!range) {
    throw new Error(`Source path is outside active selection: ${path}`);
  }
  return range;
}

async function readSourceFile(
  projectRoot: string,
  range: AllowedSourceRange,
  contextLines: number,
  maximumBytes: number,
): Promise<SourceContextFile> {
  const target = resolve(projectRoot, range.path);
  if (!isWithinRoot(projectRoot, target)) {
    throw new Error(`Source path escapes project root: ${range.path}`);
  }

  let targetStat;
  try {
    targetStat = await lstat(target);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { path: range.path, exists: false };
    }
    throw error;
  }
  if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
    throw new Error(`Source context only supports regular files: ${range.path}`);
  }
  const resolvedTarget = await realpath(target);
  if (!isWithinRoot(projectRoot, resolvedTarget)) {
    throw new Error(`Source path resolves outside project root: ${range.path}`);
  }
  if (targetStat.size > 1_000_000) {
    throw new Error(`Source file exceeds 1 MB limit: ${range.path}`);
  }
  const content = await readFile(resolvedTarget);
  if (content.includes(0)) {
    throw new Error(`Binary source file is not supported: ${range.path}`);
  }
  const lines = content.toString('utf8').split('\n');
  const startLine = Math.max(1, range.startLine - contextLines);
  const endLine = Math.min(
    lines.length,
    Math.max(startLine, range.endLine + contextLines),
    startLine + 399,
  );
  const selected = lines.slice(startLine - 1, endLine).join('\n');
  const bounded = truncateUtf8(selected, Math.max(0, maximumBytes));
  return {
    path: range.path,
    exists: true,
    startLine,
    endLine,
    content: bounded,
    sha256: createHash('sha256').update(content).digest('hex'),
    truncated: bounded !== selected,
  };
}

function normalizeProjectPath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (
    !normalized ||
    isAbsolute(normalized) ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').some((part) => part === '..' || part === '')
  ) {
    throw new Error(`Invalid project-relative source path: ${value}`);
  }
  return normalized;
}

function normalizeContextLines(value: number | undefined): number {
  if (value === undefined) {
    return 20;
  }
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error('contextLines must be between 0 and 100');
  }
  return value;
}

function normalizeTimingOption(value: number | undefined, fallback: number, name: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 60_000) {
    throw new Error(`${name} must be between 1 and 60000 ms`);
  }
  return normalized;
}

function isVerificationContextUpdated(
  baseline: SelectionContext,
  current: SelectionContext,
): boolean {
  return (
    current.selection.id !== baseline.selection.id ||
    current.selection.route !== baseline.selection.route ||
    Date.parse(current.capturedAt) > Date.parse(baseline.capturedAt) ||
    current.screenshot?.path !== baseline.screenshot?.path
  );
}

function isWithinRoot(projectRoot: string, target: string): boolean {
  const pathFromRoot = relative(projectRoot, target);
  return (
    pathFromRoot === '' ||
    (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const buffer = Buffer.from(value);
  if (buffer.length <= maximumBytes) {
    return value;
  }
  let end = maximumBytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return buffer.subarray(0, end).toString('utf8');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, timeoutMs));
}
