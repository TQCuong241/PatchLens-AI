import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type {
  PatchFileChange,
  PatchTransaction,
  PatchVerification,
} from "@patchlens-ai/agent-protocol";

export type PatchTransactionManagerOptions = {
  projectRoot: string;
  allowedExtensions?: string[];
  stateFile?: string;
  maxFileBytes?: number;
  maxTransactionBytes?: number;
  maxHistory?: number;
};

export type TextReplacementChange = {
  file: string;
  expectedText: string;
  replacementText: string;
};

export type ApplyTextReplacementsInput = {
  sessionId: string;
  selectionId: string;
  instruction: string;
  changes: TextReplacementChange[];
  selectedFiles?: string[];
  scopePolicy?: "prefer-selection" | "strict" | "allow-related";
  approvedScopeExpansion?: string[];
};

export type ApplyTextReplacementInput = Omit<
  ApplyTextReplacementsInput,
  "changes" | "selectedFiles"
> & TextReplacementChange;

type FileSnapshot = {
  file: string;
  content: string;
  hash: string;
};

type PreparedFileChange = {
  absolutePath: string;
  before: FileSnapshot;
  after: FileSnapshot;
};

type DiffOperation = {
  type: "equal" | "delete" | "insert";
  line: string;
};

type PositionedDiffOperation = DiffOperation & {
  oldLine: number;
  newLine: number;
};

type TransactionRecord = {
  transaction: PatchTransaction;
  before: FileSnapshot[];
  after: FileSnapshot[];
};

type PersistedState = {
  version: 1;
  records: TransactionRecord[];
};

const DEFAULT_ALLOWED_EXTENSIONS = [
  ".css",
  ".html",
  ".js",
  ".jsx",
  ".less",
  ".scss",
  ".svelte",
  ".ts",
  ".tsx",
  ".vue",
];
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TRANSACTION_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_HISTORY = 30;

export class PatchTransactionError extends Error {
  readonly code: string;
  readonly transaction?: PatchTransaction;

  constructor(code: string, message: string, transaction?: PatchTransaction) {
    super(message);
    this.name = "PatchTransactionError";
    this.code = code;
    this.transaction = transaction;
  }
}

export class PatchTransactionConflictError extends PatchTransactionError {
  constructor(message: string, transaction: PatchTransaction) {
    super("transaction_conflict", message, transaction);
    this.name = "PatchTransactionConflictError";
  }
}

export class PatchTransactionManager {
  readonly projectRoot: string;
  readonly stateFile: string;

  private readonly allowedExtensions: Set<string>;
  private readonly maxFileBytes: number;
  private readonly maxTransactionBytes: number;
  private readonly maxHistory: number;
  private projectRootRealPath?: string;
  private readonly records = new Map<string, TransactionRecord>();
  private readonly initialization: Promise<void>;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: PatchTransactionManagerOptions) {
    if (!options.projectRoot) {
      throw new PatchTransactionError(
        "project_root_required",
        "Patch transactions require a configured project root.",
      );
    }
    this.projectRoot = path.resolve(options.projectRoot);
    this.stateFile = resolveStateFile(this.projectRoot, options.stateFile);
    this.allowedExtensions = new Set(
      (options.allowedExtensions ?? DEFAULT_ALLOWED_EXTENSIONS).map((extension) =>
        extension.toLowerCase(),
      ),
    );
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxTransactionBytes =
      options.maxTransactionBytes ?? DEFAULT_MAX_TRANSACTION_BYTES;
    this.maxHistory = options.maxHistory ?? DEFAULT_MAX_HISTORY;
    if (
      !Number.isInteger(this.maxFileBytes) ||
      this.maxFileBytes <= 0 ||
      !Number.isInteger(this.maxTransactionBytes) ||
      this.maxTransactionBytes <= 0 ||
      !Number.isInteger(this.maxHistory) ||
      this.maxHistory <= 0
    ) {
      throw new PatchTransactionError(
        "invalid_transaction_limits",
        "Patch transaction size and history limits must be positive integers.",
      );
    }
    this.initialization = this.loadState();
  }

  async ready(): Promise<void> {
    await this.initialization;
  }

  async applyTextReplacement(
    input: ApplyTextReplacementInput,
  ): Promise<PatchTransaction> {
    return this.applyTextReplacements({
      sessionId: input.sessionId,
      selectionId: input.selectionId,
      instruction: input.instruction,
      changes: [
        {
          file: input.file,
          expectedText: input.expectedText,
          replacementText: input.replacementText,
        },
      ],
      selectedFiles: [input.file],
      scopePolicy: input.scopePolicy,
      approvedScopeExpansion: input.approvedScopeExpansion,
    });
  }

  async applyTextReplacements(
    input: ApplyTextReplacementsInput,
  ): Promise<PatchTransaction> {
    return this.withMutationLock(() => this.applyTextReplacementsUnlocked(input));
  }

  private async applyTextReplacementsUnlocked(
    input: ApplyTextReplacementsInput,
  ): Promise<PatchTransaction> {
    await this.ready();
    validateApplyInput(input);

    const prepared = await this.prepareChanges(input.changes);
    const changedFiles = prepared.map((change) => change.before.file);
    const scopeExpansion = findScopeExpansion(changedFiles, input.selectedFiles ?? []);
    enforceScopePolicy(
      scopeExpansion,
      input.scopePolicy ?? "prefer-selection",
      input.approvedScopeExpansion ?? [],
    );

    await this.verifyBaselines(prepared);

    const now = new Date().toISOString();
    const transaction: PatchTransaction = {
      id: `transaction_${randomUUID()}`,
      sessionId: input.sessionId,
      selectionId: input.selectionId,
      instruction: input.instruction,
      status: "running",
      files: prepared.map((change) => createFileChange(change.before, change.after)),
      scopeExpansion,
      undoAvailable: false,
      createdAt: now,
      updatedAt: now,
    };
    const record: TransactionRecord = {
      transaction,
      before: prepared.map((change) => change.before),
      after: prepared.map((change) => change.after),
    };
    this.records.set(transaction.id, record);
    await this.persistState();

    const applied: PreparedFileChange[] = [];
    try {
      for (const change of prepared) {
        await this.writeAndVerify(
          change.absolutePath,
          change.after,
          change.before.hash,
          () => applied.push(change),
        );
      }

      record.transaction = {
        ...record.transaction,
        status: "applied",
        undoAvailable: true,
        updatedAt: new Date().toISOString(),
      };
      await this.persistState();
      return cloneTransaction(record.transaction);
    } catch (error) {
      const rollbackFailures = await this.restorePreparedChanges(applied, "before");
      const failureReason = formatApplyFailure(error, rollbackFailures);
      record.transaction = {
        ...record.transaction,
        status: rollbackFailures.length > 0 ? "conflicted" : "failed",
        undoAvailable: false,
        failureReason,
        updatedAt: new Date().toISOString(),
      };
      await this.persistStateBestEffort();
      const failed = cloneTransaction(record.transaction);

      if (rollbackFailures.length > 0) {
        throw new PatchTransactionConflictError(failureReason, failed);
      }

      throw new PatchTransactionError(
        "transaction_apply_failed",
        failureReason,
        failed,
      );
    }
  }

  get(transactionId: string): PatchTransaction | undefined {
    const record = this.records.get(transactionId);
    return record ? cloneTransaction(record.transaction) : undefined;
  }

  list(sessionId?: string): PatchTransaction[] {
    return Array.from(this.records.values())
      .filter((record) => !sessionId || record.transaction.sessionId === sessionId)
      .sort((left, right) =>
        right.transaction.createdAt.localeCompare(left.transaction.createdAt),
      )
      .map((record) => cloneTransaction(record.transaction));
  }

  listBySession(sessionId: string): PatchTransaction[] {
    return this.list(sessionId);
  }

  async setVerification(
    transactionId: string,
    verification: PatchVerification,
  ): Promise<PatchTransaction> {
    return this.withMutationLock(() =>
      this.setVerificationUnlocked(transactionId, verification),
    );
  }

  private async setVerificationUnlocked(
    transactionId: string,
    verification: PatchVerification,
  ): Promise<PatchTransaction> {
    await this.ready();
    const record = this.records.get(transactionId);
    if (!record) {
      throw new PatchTransactionError(
        "transaction_not_found",
        `Patch transaction ${transactionId} does not exist.`,
      );
    }
    record.transaction = {
      ...record.transaction,
      verification: cloneVerification(verification),
      updatedAt: new Date().toISOString(),
    };
    await this.persistState();
    return cloneTransaction(record.transaction);
  }

  async undo(transactionId: string): Promise<PatchTransaction> {
    return this.withMutationLock(() => this.undoUnlocked(transactionId));
  }

  private async undoUnlocked(transactionId: string): Promise<PatchTransaction> {
    await this.ready();
    const record = this.records.get(transactionId);
    if (!record) {
      throw new PatchTransactionError(
        "transaction_not_found",
        `Patch transaction ${transactionId} does not exist.`,
      );
    }

    if (record.transaction.status !== "applied" || !record.transaction.undoAvailable) {
      throw new PatchTransactionError(
        "transaction_not_undoable",
        `Patch transaction ${transactionId} is not currently undoable.`,
        cloneTransaction(record.transaction),
      );
    }

    const prepared = await this.prepareStoredChanges(record);
    const conflicts: string[] = [];
    for (const change of prepared) {
      const current = await this.readAuthorizedSnapshot(change.after.file);
      if (current.snapshot.hash !== change.after.hash) {
        conflicts.push(change.after.file);
      }
    }

    if (conflicts.length > 0) {
      record.transaction = {
        ...record.transaction,
        status: "conflicted",
        undoAvailable: false,
        failureReason: `Newer developer edits were found in: ${conflicts.join(", ")}.`,
        updatedAt: new Date().toISOString(),
      };
      await this.persistStateBestEffort();
      const conflicted = cloneTransaction(record.transaction);
      throw new PatchTransactionConflictError(
        `${conflicts.join(", ")} changed after the agent patch. PatchLens refused to overwrite newer developer content.`,
        conflicted,
      );
    }

    const restored: PreparedFileChange[] = [];
    try {
      for (const change of prepared) {
        await this.writeAndVerify(
          change.absolutePath,
          change.before,
          change.after.hash,
          () => restored.push(change),
        );
      }

      record.transaction = {
        ...record.transaction,
        status: "reverted",
        undoAvailable: false,
        failureReason: undefined,
        updatedAt: new Date().toISOString(),
      };
      await this.persistState();
      return cloneTransaction(record.transaction);
    } catch (error) {
      const compensationFailures = await this.restorePreparedChanges(restored, "after");
      const message = compensationFailures.length > 0
        ? `Undo stopped and could not fully restore the applied patch in: ${compensationFailures.join(", ")}.`
        : `Undo stopped safely and the applied patch was restored. ${errorMessage(error)}`;
      record.transaction = {
        ...record.transaction,
        status: compensationFailures.length > 0 ? "conflicted" : "applied",
        undoAvailable: compensationFailures.length === 0,
        failureReason: message,
        updatedAt: new Date().toISOString(),
      };
      await this.persistStateBestEffort();
      const transaction = cloneTransaction(record.transaction);

      if (compensationFailures.length > 0) {
        throw new PatchTransactionConflictError(message, transaction);
      }

      throw new PatchTransactionError("undo_failed", message, transaction);
    }
  }

  private async prepareChanges(
    changes: TextReplacementChange[],
  ): Promise<PreparedFileChange[]> {
    const grouped = new Map<
      string,
      { absolutePath: string; replacements: TextReplacementChange[] }
    >();

    for (const change of changes) {
      validateReplacement(change);
      const authorized = await this.authorizeFile(change.file);
      const existing = grouped.get(authorized.file);
      if (existing) {
        existing.replacements.push(change);
      } else {
        grouped.set(authorized.file, {
          absolutePath: authorized.absolutePath,
          replacements: [change],
        });
      }
    }

    const prepared: PreparedFileChange[] = [];
    let transactionBytes = 0;
    for (const [file, group] of grouped) {
      const beforeResult = await this.readAuthorizedSnapshot(file);
      let afterContent = beforeResult.snapshot.content;

      for (const replacement of group.replacements) {
        const occurrenceCount = countOccurrences(afterContent, replacement.expectedText);
        if (occurrenceCount === 0) {
          throw new PatchTransactionError(
            "source_text_not_found",
            `The expected source text was not found in ${file}.`,
          );
        }
        if (occurrenceCount > 1) {
          throw new PatchTransactionError(
            "ambiguous_source_text",
            `The expected source text appears ${occurrenceCount} times in ${file}; PatchLens will not guess which occurrence to replace.`,
          );
        }
        afterContent = replaceSingleOccurrence(
          afterContent,
          replacement.expectedText,
          replacement.replacementText,
        );
      }

      if (afterContent === beforeResult.snapshot.content) {
        throw new PatchTransactionError(
          "no_change",
          `The proposed replacements would not change ${file}.`,
        );
      }

      const afterBytes = Buffer.byteLength(afterContent, "utf8");
      if (afterBytes > this.maxFileBytes) {
        throw new PatchTransactionError(
          "file_too_large",
          `${file} exceeds the configured patch file-size limit.`,
        );
      }
      transactionBytes += beforeResult.bytes + afterBytes;
      if (transactionBytes > this.maxTransactionBytes) {
        throw new PatchTransactionError(
          "transaction_too_large",
          "The proposed patch exceeds the configured transaction-size limit.",
        );
      }

      prepared.push({
        absolutePath: group.absolutePath,
        before: beforeResult.snapshot,
        after: {
          file,
          content: afterContent,
          hash: hashContent(afterContent),
        },
      });
    }

    return prepared;
  }

  private async prepareStoredChanges(
    record: TransactionRecord,
  ): Promise<PreparedFileChange[]> {
    const beforeByFile = new Map(record.before.map((snapshot) => [snapshot.file, snapshot]));
    const prepared: PreparedFileChange[] = [];

    for (const after of record.after) {
      const before = beforeByFile.get(after.file);
      if (!before) {
        throw new PatchTransactionError(
          "transaction_state_invalid",
          `Patch transaction ${record.transaction.id} is missing its baseline for ${after.file}.`,
          cloneTransaction(record.transaction),
        );
      }
      const authorized = await this.authorizeFile(after.file);
      prepared.push({ absolutePath: authorized.absolutePath, before, after });
    }

    return prepared;
  }

  private async verifyBaselines(prepared: PreparedFileChange[]): Promise<void> {
    for (const change of prepared) {
      const current = await this.readAuthorizedSnapshot(change.before.file);
      if (current.snapshot.hash !== change.before.hash) {
        throw new PatchTransactionError(
          "concurrent_change",
          `${change.before.file} changed while the transaction baseline was being prepared.`,
        );
      }
    }
  }

  private async restorePreparedChanges(
    changes: PreparedFileChange[],
    target: "before" | "after",
  ): Promise<string[]> {
    const failures: string[] = [];
    for (const change of [...changes].reverse()) {
      try {
        const targetSnapshot = change[target];
        const expectedCurrent = target === "before" ? change.after : change.before;
        const current = await this.readAuthorizedSnapshot(expectedCurrent.file);
        if (current.snapshot.hash === targetSnapshot.hash) {
          continue;
        }
        if (current.snapshot.hash !== expectedCurrent.hash) {
          failures.push(change.before.file);
          continue;
        }
        await this.writeAndVerify(
          change.absolutePath,
          targetSnapshot,
          expectedCurrent.hash,
        );
      } catch {
        failures.push(change.before.file);
      }
    }
    return failures;
  }

  private async writeAndVerify(
    absolutePath: string,
    snapshot: FileSnapshot,
    expectedCurrentHash: string,
    onCommitted?: () => void,
  ): Promise<void> {
    const current = await this.readAuthorizedSnapshot(snapshot.file);
    if (current.snapshot.hash !== expectedCurrentHash) {
      throw new PatchTransactionError(
        "concurrent_change",
        `${snapshot.file} changed before PatchLens could write the transaction.`,
      );
    }

    const temporaryFile = path.join(
      path.dirname(absolutePath),
      `.patchlens-${path.basename(absolutePath)}-${randomUUID()}.tmp`,
    );
    try {
      const fileMode = (await stat(absolutePath)).mode;
      await writeFile(temporaryFile, snapshot.content, {
        encoding: "utf8",
        flag: "wx",
        mode: fileMode,
      });

      const lastMomentBaseline = await this.readAuthorizedSnapshot(snapshot.file);
      if (lastMomentBaseline.snapshot.hash !== expectedCurrentHash) {
        throw new PatchTransactionError(
          "concurrent_change",
          `${snapshot.file} changed while PatchLens was preparing the transaction write.`,
        );
      }

      await rename(temporaryFile, absolutePath);
      onCommitted?.();
    } catch (error) {
      await rm(temporaryFile, { force: true }).catch(() => undefined);
      if (error instanceof PatchTransactionError) {
        throw error;
      }
      throw new PatchTransactionError(
        "source_write_failed",
        `${snapshot.file} could not be written by the patch transaction.`,
      );
    }

    const written = await this.readAuthorizedSnapshot(snapshot.file);
    if (written.snapshot.hash !== snapshot.hash) {
      throw new PatchTransactionError(
        "write_verification_failed",
        `${snapshot.file} did not match the content PatchLens attempted to write.`,
      );
    }
  }

  private async readAuthorizedSnapshot(relativeFile: string): Promise<{
    snapshot: FileSnapshot;
    absolutePath: string;
    bytes: number;
  }> {
    const authorized = await this.authorizeFile(relativeFile);
    let bytes: Buffer;
    try {
      bytes = await readFile(authorized.absolutePath);
    } catch {
      throw new PatchTransactionError(
        "source_read_failed",
        `${authorized.file} could not be read by the patch transaction.`,
      );
    }

    if (bytes.byteLength > this.maxFileBytes) {
      throw new PatchTransactionError(
        "file_too_large",
        `${authorized.file} exceeds the configured patch file-size limit.`,
      );
    }

    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new PatchTransactionError(
        "binary_file_rejected",
        `${authorized.file} is not valid UTF-8 source text.`,
      );
    }

    if (content.includes("\0")) {
      throw new PatchTransactionError(
        "binary_file_rejected",
        `${authorized.file} does not appear to be a text file.`,
      );
    }

    return {
      snapshot: {
        file: authorized.file,
        content,
        hash: hashContent(content),
      },
      absolutePath: authorized.absolutePath,
      bytes: bytes.byteLength,
    };
  }

  private async authorizeFile(relativeFile: string): Promise<{
    file: string;
    absolutePath: string;
  }> {
    if (!relativeFile || path.isAbsolute(relativeFile)) {
      throw new PatchTransactionError(
        "invalid_project_path",
        "Patch transactions require a non-empty project-relative file path.",
      );
    }

    const candidate = path.resolve(this.projectRoot, relativeFile);
    assertPathInside(this.projectRoot, candidate, relativeFile, "path_outside_project");

    const extension = path.extname(candidate).toLowerCase();
    if (!this.allowedExtensions.has(extension)) {
      throw new PatchTransactionError(
        "file_type_rejected",
        `${relativeFile} is not an allowed source or style file type.`,
      );
    }

    let projectRootRealPath: string;
    try {
      projectRootRealPath = await this.getProjectRootRealPath();
    } catch {
      throw new PatchTransactionError(
        "project_root_unavailable",
        "The configured project root could not be resolved.",
      );
    }

    let candidateRealPath: string;
    try {
      candidateRealPath = await realpath(candidate);
    } catch {
      throw new PatchTransactionError(
        "source_file_unavailable",
        `${relativeFile} could not be resolved inside the configured project root.`,
      );
    }
    assertPathInside(
      projectRootRealPath,
      candidateRealPath,
      relativeFile,
      "symlink_outside_project",
    );

    return {
      file: path.relative(projectRootRealPath, candidateRealPath).split(path.sep).join("/"),
      absolutePath: candidateRealPath,
    };
  }

  private async getProjectRootRealPath(): Promise<string> {
    if (!this.projectRootRealPath) {
      this.projectRootRealPath = await realpath(this.projectRoot);
    }
    return this.projectRootRealPath;
  }

  private async loadState(): Promise<void> {
    await this.authorizeStatePath();
    let raw: string;
    try {
      raw = await readFile(this.stateFile, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }
      throw new PatchTransactionError(
        "transaction_state_unavailable",
        "The local PatchLens transaction history could not be read.",
      );
    }

    let state: unknown;
    try {
      state = JSON.parse(raw);
    } catch {
      throw new PatchTransactionError(
        "transaction_state_invalid",
        "The local PatchLens transaction history is not valid JSON.",
      );
    }

    if (!isPersistedState(state)) {
      throw new PatchTransactionError(
        "transaction_state_invalid",
        "The local PatchLens transaction history has an unsupported format.",
      );
    }

    for (const record of state.records.slice(-this.maxHistory)) {
      this.records.set(record.transaction.id, cloneRecord(record));
    }

    if (await this.recoverInterruptedTransactions()) {
      await this.persistState();
    }
  }

  private async recoverInterruptedTransactions(): Promise<boolean> {
    let changed = false;
    for (const record of this.records.values()) {
      if (record.transaction.status !== "running") {
        continue;
      }
      changed = true;
      const prepared = await this.prepareStoredChanges(record);
      const states: Array<"before" | "after" | "unknown"> = [];
      for (const change of prepared) {
        const current = await this.readAuthorizedSnapshot(change.before.file);
        states.push(
          current.snapshot.hash === change.before.hash
            ? "before"
            : current.snapshot.hash === change.after.hash
              ? "after"
              : "unknown",
        );
      }

      if (states.every((state) => state === "after")) {
        record.transaction = {
          ...record.transaction,
          status: "applied",
          undoAvailable: true,
          failureReason: undefined,
          updatedAt: new Date().toISOString(),
        };
        continue;
      }
      if (states.every((state) => state === "before")) {
        record.transaction = {
          ...record.transaction,
          status: "failed",
          undoAvailable: false,
          failureReason: "The daemon stopped before this patch was applied.",
          updatedAt: new Date().toISOString(),
        };
        continue;
      }
      if (states.some((state) => state === "unknown")) {
        record.transaction = {
          ...record.transaction,
          status: "conflicted",
          undoAvailable: false,
          failureReason: "The daemon restarted after files changed outside the interrupted transaction.",
          updatedAt: new Date().toISOString(),
        };
        continue;
      }

      const appliedFiles = prepared.filter((_, index) => states[index] === "after");
      const rollbackFailures = await this.restorePreparedChanges(appliedFiles, "before");
      record.transaction = {
        ...record.transaction,
        status: rollbackFailures.length > 0 ? "conflicted" : "failed",
        undoAvailable: false,
        failureReason: rollbackFailures.length > 0
          ? `Restart recovery needs manual review for: ${rollbackFailures.join(", ")}.`
          : "The daemon restarted during the patch, so PatchLens restored every partial write.",
        updatedAt: new Date().toISOString(),
      };
    }
    return changed;
  }

  private async persistState(): Promise<void> {
    trimHistory(this.records, this.maxHistory);
    const directoryRealPath = await this.authorizeStatePath();

    const state: PersistedState = {
      version: 1,
      records: Array.from(this.records.values()).map(cloneRecord),
    };
    const temporaryFile = path.join(
      directoryRealPath,
      `.transactions-${randomUUID()}.tmp`,
    );
    const serialized = `${JSON.stringify(state, null, 2)}\n`;

    try {
      await writeFile(temporaryFile, serialized, { encoding: "utf8", mode: 0o600 });
      try {
        await rename(temporaryFile, this.stateFile);
      } catch (error) {
        if (
          !isNodeError(error) ||
          !error.code ||
          !["EEXIST", "EPERM"].includes(error.code)
        ) {
          throw error;
        }
        // Replace the directory entry instead of following an existing state-file symlink.
        await rm(this.stateFile, { force: true });
        await rename(temporaryFile, this.stateFile);
      }
    } catch {
      await rm(temporaryFile, { force: true }).catch(() => undefined);
      throw new PatchTransactionError(
        "transaction_state_write_failed",
        "The local PatchLens transaction history could not be saved.",
      );
    }
  }

  private async persistStateBestEffort(): Promise<void> {
    try {
      await this.persistState();
    } catch {
      // The primary transaction error remains more actionable than persistence failure.
    }
  }

  private async authorizeStatePath(): Promise<string> {
    const stateDirectory = path.dirname(this.stateFile);
    try {
      await mkdir(stateDirectory, { recursive: true });
    } catch {
      throw new PatchTransactionError(
        "transaction_state_unavailable",
        "The local PatchLens transaction history directory could not be prepared.",
      );
    }

    const rootRealPath = await this.getProjectRootRealPath();
    let directoryRealPath: string;
    try {
      directoryRealPath = await realpath(stateDirectory);
    } catch {
      throw new PatchTransactionError(
        "transaction_state_unavailable",
        "The local PatchLens transaction history directory could not be resolved.",
      );
    }
    assertPathInside(
      rootRealPath,
      directoryRealPath,
      ".patchlens",
      "transaction_state_outside_project",
      true,
    );

    try {
      const stateRealPath = await realpath(this.stateFile);
      assertPathInside(
        rootRealPath,
        stateRealPath,
        ".patchlens/transactions.json",
        "transaction_state_outside_project",
      );
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }

    return directoryRealPath;
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export function createUnifiedDiff(
  file: string,
  beforeContent: string,
  afterContent: string,
  contextLines = 3,
): string {
  if (beforeContent === afterContent) {
    return "";
  }

  const operations = positionDiffOperations(
    createLineDiff(splitLines(beforeContent), splitLines(afterContent)),
  );
  const hunks = createDiffHunks(operations, Math.max(0, contextLines));
  const output = [`--- a/${file}`, `+++ b/${file}`];

  for (const hunk of hunks) {
    const oldCount = hunk.filter((operation) => operation.type !== "insert").length;
    const newCount = hunk.filter((operation) => operation.type !== "delete").length;
    const first = hunk[0]!;
    output.push(
      `@@ -${formatDiffRange(first.oldLine, oldCount)} +${formatDiffRange(first.newLine, newCount)} @@`,
    );
    for (const operation of hunk) {
      const prefix = operation.type === "equal"
        ? " "
        : operation.type === "delete"
          ? "-"
          : "+";
      const hasLineEnding = operation.line.endsWith("\n");
      output.push(
        `${prefix}${hasLineEnding ? operation.line.slice(0, -1) : operation.line}`,
      );
      if (!hasLineEnding) {
        output.push("\\ No newline at end of file");
      }
    }
  }

  return output.join("\n");
}

function validateApplyInput(input: ApplyTextReplacementsInput): void {
  if (
    !input ||
    typeof input.sessionId !== "string" ||
    typeof input.selectionId !== "string" ||
    typeof input.instruction !== "string" ||
    !input.sessionId.trim() ||
    !input.selectionId.trim() ||
    !input.instruction.trim() ||
    input.sessionId.length > 240 ||
    input.selectionId.length > 240 ||
    input.instruction.length > 20_000
  ) {
    throw new PatchTransactionError(
      "invalid_transaction_input",
      "A session, selection, and developer instruction are required.",
    );
  }
  if (!Array.isArray(input.changes) || input.changes.length === 0 || input.changes.length > 64) {
    throw new PatchTransactionError(
      "invalid_transaction_input",
      "A patch transaction requires between 1 and 64 exact replacements.",
    );
  }
  if (
    input.scopePolicy !== undefined &&
    !["prefer-selection", "strict", "allow-related"].includes(input.scopePolicy)
  ) {
    throw new PatchTransactionError(
      "invalid_transaction_input",
      "The patch transaction scope policy is invalid.",
    );
  }
  validateScopeFiles(input.selectedFiles, "selected source scope");
  validateScopeFiles(input.approvedScopeExpansion, "approved scope expansion");
}

function validateScopeFiles(value: string[] | undefined, label: string): void {
  if (value === undefined) {
    return;
  }
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    value.some((file) => {
      if (typeof file !== "string" || !file || file.length > 1_000 || file.includes("\0")) {
        return true;
      }
      const normalized = file.replace(/\\/g, "/");
      return path.isAbsolute(file) || normalized.split("/").includes("..");
    })
  ) {
    throw new PatchTransactionError(
      "invalid_transaction_input",
      `The ${label} contains an invalid project-relative file path.`,
    );
  }
}

function validateReplacement(change: TextReplacementChange): void {
  if (
    !change ||
    typeof change.file !== "string" ||
    typeof change.expectedText !== "string" ||
    typeof change.replacementText !== "string" ||
    !change.file.trim()
  ) {
    throw new PatchTransactionError(
      "invalid_replacement",
      "Every replacement requires a project-relative file and text values.",
    );
  }
  if (change.file.length > 1_000 || change.file.includes("\0")) {
    throw new PatchTransactionError(
      "invalid_project_path",
      "The replacement file path is invalid or too long.",
    );
  }
  if (!change.expectedText) {
    throw new PatchTransactionError(
      "missing_expected_text",
      "Every replacement requires exact source text to match.",
    );
  }
  if (change.expectedText === change.replacementText) {
    throw new PatchTransactionError(
      "no_change",
      `The replacement proposed for ${change.file} would not change the source.`,
    );
  }
}

function enforceScopePolicy(
  expansion: string[],
  policy: "prefer-selection" | "strict" | "allow-related",
  approvedExpansion: string[],
): void {
  if (expansion.length === 0 || policy === "allow-related") {
    return;
  }

  if (policy === "strict") {
    throw new PatchTransactionError(
      "scope_expansion_rejected",
      `Strict scope rejected changes outside the selected source: ${expansion.join(", ")}.`,
    );
  }

  const approved = new Set(approvedExpansion.map(comparePath));
  const pending = expansion.filter((file) => !approved.has(comparePath(file)));
  if (pending.length > 0) {
    throw new PatchTransactionError(
      "scope_approval_required",
      `Approval is required before changing related files: ${pending.join(", ")}.`,
    );
  }
}

function findScopeExpansion(changedFiles: string[], selectedFiles: string[]): string[] {
  const selected = new Set(selectedFiles.map(comparePath));
  return changedFiles.filter((file) => !selected.has(comparePath(file)));
}

function comparePath(file: string): string {
  const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function createFileChange(before: FileSnapshot, after: FileSnapshot): PatchFileChange {
  const changedLines = countChangedLines(before.content, after.content);
  return {
    file: before.file,
    beforeHash: before.hash,
    afterHash: after.hash,
    diff: createUnifiedDiff(before.file, before.content, after.content),
    additions: changedLines.additions,
    deletions: changedLines.deletions,
  };
}

function countChangedLines(
  beforeContent: string,
  afterContent: string,
): { additions: number; deletions: number } {
  const operations = createLineDiff(
    splitLines(beforeContent),
    splitLines(afterContent),
  );
  return operations.reduce(
    (totals, operation) => {
      if (operation.type === "insert") {
        totals.additions += 1;
      } else if (operation.type === "delete") {
        totals.deletions += 1;
      }
      return totals;
    },
    { additions: 0, deletions: 0 },
  );
}

function createLineDiff(before: string[], after: string[]): DiffOperation[] {
  const maximumDistance = before.length + after.length;
  const trace: Array<Map<number, number>> = [];
  const frontier = new Map<number, number>([[1, 0]]);

  for (let distance = 0; distance <= maximumDistance; distance += 1) {
    trace.push(new Map(frontier));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const previousDelete = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
      const previousInsert = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
      let oldIndex: number;

      if (
        diagonal === -distance ||
        (diagonal !== distance && previousDelete < previousInsert)
      ) {
        oldIndex = Math.max(0, previousInsert);
      } else {
        oldIndex = Math.max(0, previousDelete) + 1;
      }

      let newIndex = oldIndex - diagonal;
      while (
        oldIndex < before.length &&
        newIndex < after.length &&
        before[oldIndex] === after[newIndex]
      ) {
        oldIndex += 1;
        newIndex += 1;
      }
      frontier.set(diagonal, oldIndex);

      if (oldIndex >= before.length && newIndex >= after.length) {
        return backtrackLineDiff(trace, before, after);
      }
    }
  }

  return [
    ...before.map((line) => ({ type: "delete" as const, line })),
    ...after.map((line) => ({ type: "insert" as const, line })),
  ];
}

function backtrackLineDiff(
  trace: Array<Map<number, number>>,
  before: string[],
  after: string[],
): DiffOperation[] {
  const operations: DiffOperation[] = [];
  let oldIndex = before.length;
  let newIndex = after.length;

  for (let distance = trace.length - 1; distance >= 0; distance -= 1) {
    const frontier = trace[distance]!;
    const diagonal = oldIndex - newIndex;
    const previousDelete = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
    const previousInsert = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
    const previousDiagonal =
      diagonal === -distance ||
      (diagonal !== distance && previousDelete < previousInsert)
        ? diagonal + 1
        : diagonal - 1;
    const previousOldIndex = Math.max(0, frontier.get(previousDiagonal) ?? 0);
    const previousNewIndex = previousOldIndex - previousDiagonal;

    while (oldIndex > previousOldIndex && newIndex > previousNewIndex) {
      operations.push({ type: "equal", line: before[oldIndex - 1] ?? "" });
      oldIndex -= 1;
      newIndex -= 1;
    }

    if (distance === 0) {
      break;
    }
    if (oldIndex === previousOldIndex) {
      operations.push({ type: "insert", line: after[newIndex - 1] ?? "" });
      newIndex -= 1;
    } else {
      operations.push({ type: "delete", line: before[oldIndex - 1] ?? "" });
      oldIndex -= 1;
    }
  }

  return operations.reverse();
}

function positionDiffOperations(
  operations: DiffOperation[],
): PositionedDiffOperation[] {
  let oldLine = 1;
  let newLine = 1;
  return operations.map((operation) => {
    const positioned = { ...operation, oldLine, newLine };
    if (operation.type !== "insert") {
      oldLine += 1;
    }
    if (operation.type !== "delete") {
      newLine += 1;
    }
    return positioned;
  });
}

function createDiffHunks(
  operations: PositionedDiffOperation[],
  contextLines: number,
): PositionedDiffOperation[][] {
  const changeIndexes = operations
    .map((operation, index) => operation.type === "equal" ? -1 : index)
    .filter((index) => index >= 0);
  const ranges: Array<{ start: number; end: number }> = [];

  for (const index of changeIndexes) {
    const start = Math.max(0, index - contextLines);
    const end = Math.min(operations.length, index + contextLines + 1);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) {
      previous.end = Math.max(previous.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  return ranges.map(({ start, end }) => operations.slice(start, end));
}

function cloneTransaction(transaction: PatchTransaction): PatchTransaction {
  return {
    ...transaction,
    files: transaction.files.map((file) => ({ ...file })),
    scopeExpansion: [...transaction.scopeExpansion],
    verification: transaction.verification
      ? cloneVerification(transaction.verification)
      : undefined,
  };
}

function cloneVerification(verification: PatchVerification): PatchVerification {
  return {
    ...verification,
    viewport: { ...verification.viewport },
    checks: verification.checks.map((check) => ({ ...check })),
  };
}

function cloneRecord(record: TransactionRecord): TransactionRecord {
  return {
    transaction: cloneTransaction(record.transaction),
    before: record.before.map((snapshot) => ({ ...snapshot })),
    after: record.after.map((snapshot) => ({ ...snapshot })),
  };
}

function countOccurrences(content: string, expectedText: string): number {
  let count = 0;
  let offset = 0;

  while (offset <= content.length - expectedText.length) {
    const index = content.indexOf(expectedText, offset);
    if (index === -1) {
      break;
    }
    count += 1;
    offset = index + expectedText.length;
  }

  return count;
}

function replaceSingleOccurrence(
  content: string,
  expectedText: string,
  replacementText: string,
): string {
  const index = content.indexOf(expectedText);
  return `${content.slice(0, index)}${replacementText}${content.slice(index + expectedText.length)}`;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function splitLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n");
  return normalized.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? [];
}

function formatDiffRange(oneBasedStart: number, count: number): string {
  const start = count === 0 ? Math.max(0, oneBasedStart - 1) : oneBasedStart;
  return count === 1 ? `${start}` : `${start},${count}`;
}

function resolveStateFile(projectRoot: string, stateFile: string | undefined): string {
  const resolved = stateFile
    ? path.resolve(projectRoot, stateFile)
    : path.join(projectRoot, ".patchlens", "transactions.json");
  assertPathInside(
    projectRoot,
    resolved,
    stateFile ?? ".patchlens/transactions.json",
    "transaction_state_outside_project",
  );
  return resolved;
}

function assertPathInside(
  root: string,
  candidate: string,
  displayPath: string,
  code: string,
  allowSame = false,
): void {
  const relative = path.relative(root, candidate);
  const outside =
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative);
  if (outside || (!allowSame && !relative)) {
    throw new PatchTransactionError(
      code,
      `${displayPath} resolves outside the configured project root.`,
    );
  }
}

function isPersistedState(value: unknown): value is PersistedState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<PersistedState>;
  return candidate.version === 1 && Array.isArray(candidate.records) &&
    candidate.records.every(isTransactionRecord);
}

function isTransactionRecord(value: unknown): value is TransactionRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<TransactionRecord>;
  return Boolean(
    candidate.transaction &&
    typeof candidate.transaction.id === "string" &&
    Array.isArray(candidate.transaction.files) &&
    Array.isArray(candidate.before) &&
    candidate.before.every(isFileSnapshot) &&
    Array.isArray(candidate.after) &&
    candidate.after.every(isFileSnapshot),
  );
}

function isFileSnapshot(value: unknown): value is FileSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<FileSnapshot>;
  return typeof candidate.file === "string" &&
    typeof candidate.content === "string" &&
    typeof candidate.hash === "string";
}

function trimHistory(records: Map<string, TransactionRecord>, maxHistory: number): void {
  if (records.size <= maxHistory) {
    return;
  }
  const oldest = Array.from(records.values())
    .sort((left, right) =>
      left.transaction.createdAt.localeCompare(right.transaction.createdAt),
    )
    .slice(0, records.size - maxHistory);
  for (const record of oldest) {
    records.delete(record.transaction.id);
  }
}

function formatApplyFailure(error: unknown, rollbackFailures: string[]): string {
  if (rollbackFailures.length > 0) {
    return `The patch failed and rollback needs manual review for: ${rollbackFailures.join(", ")}.`;
  }
  return `The patch failed and all written files were restored. ${errorMessage(error)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unknown transaction error occurred.";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
