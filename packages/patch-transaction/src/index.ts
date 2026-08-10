import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export type PatchTransactionStatus = 'running' | 'applied' | 'reverted' | 'conflicted' | 'failed';

export type PatchTransactionInput = {
  requestId: string;
  sessionId: string;
  selectionId: string;
  instruction: string;
  files: string[];
};

export type PatchTransactionRecord = {
  id: string;
  requestId: string;
  sessionId: string;
  selectionId: string;
  instruction: string;
  files: string[];
  plannedFiles: string[];
  scopeExpandedFiles: string[];
  changedFiles: string[];
  diff: string;
  status: PatchTransactionStatus;
  conflicts: string[];
  failureMessage?: string;
  createdAt: string;
  updatedAt: string;
};

export type PatchTransactionManagerOptions = {
  maximumFileBytes?: number;
  maximumDiffBytes?: number;
  maximumBaselineBytes?: number;
  maximumBaselineFiles?: number;
};

export class UnknownPatchTransactionError extends Error {
  constructor(transactionId: string) {
    super(`Unknown patch transaction: ${transactionId}`);
    this.name = 'UnknownPatchTransactionError';
  }
}

export class PatchTransactionStateError extends Error {
  constructor(transactionId: string, expectedStatus: PatchTransactionStatus) {
    super(`Transaction ${transactionId} is not ${expectedStatus}`);
    this.name = 'PatchTransactionStateError';
  }
}

export class PatchTransactionBusyError extends Error {
  constructor(transactionId: string, operation: string) {
    super(`Transaction ${transactionId} is busy with ${operation}`);
    this.name = 'PatchTransactionBusyError';
  }
}

type FileState = {
  exists: boolean;
  content: Buffer;
  hash: string;
};

type TransactionState = {
  record: PatchTransactionRecord;
  before: Map<string, FileState>;
  after: Map<string, FileState>;
  repositoryBefore: Map<string, FileState>;
  unavailableBefore: Set<string>;
  operation?: string;
};

const ignoredBaselineDirectories = new Set([
  '.git',
  '.next',
  '.patchlens',
  '.turbo',
  '.vite',
  'coverage',
  'dist',
  'node_modules',
]);

export class PatchTransactionManager {
  readonly #projectRoot: string;
  readonly #maximumFileBytes: number;
  readonly #maximumDiffBytes: number;
  readonly #maximumBaselineBytes: number;
  readonly #maximumBaselineFiles: number;
  readonly #transactions = new Map<string, TransactionState>();

  private constructor(projectRoot: string, options: PatchTransactionManagerOptions) {
    this.#projectRoot = projectRoot;
    this.#maximumFileBytes = options.maximumFileBytes ?? 1_000_000;
    this.#maximumDiffBytes = options.maximumDiffBytes ?? 200_000;
    this.#maximumBaselineBytes = options.maximumBaselineBytes ?? 100_000_000;
    this.#maximumBaselineFiles = options.maximumBaselineFiles ?? 20_000;
  }

  static async create(
    projectRoot: string,
    options: PatchTransactionManagerOptions = {},
  ): Promise<PatchTransactionManager> {
    const resolvedRoot = await realpath(resolve(projectRoot));
    return new PatchTransactionManager(resolvedRoot, options);
  }

  async begin(input: PatchTransactionInput): Promise<PatchTransactionRecord> {
    const files = [...new Set(input.files.map(normalizeProjectFile))].sort();
    const repositoryBaseline = await this.#captureRepositoryBaseline();
    const before = new Map<string, FileState>();
    for (const file of files) {
      const captured = repositoryBaseline.files.get(file);
      before.set(file, captured ?? (await this.#capture(file)));
    }

    const now = new Date().toISOString();
    const record: PatchTransactionRecord = {
      id: `transaction-${randomUUID()}`,
      requestId: input.requestId,
      sessionId: input.sessionId,
      selectionId: input.selectionId,
      instruction: input.instruction,
      files,
      plannedFiles: [...files],
      scopeExpandedFiles: [],
      changedFiles: [],
      diff: '',
      status: 'running',
      conflicts: [],
      createdAt: now,
      updatedAt: now,
    };
    this.#transactions.set(record.id, {
      record,
      before,
      after: new Map(),
      repositoryBefore: repositoryBaseline.files,
      unavailableBefore: repositoryBaseline.unavailable,
    });
    return cloneRecord(record);
  }

  async expand(transactionId: string, files: readonly string[]): Promise<PatchTransactionRecord> {
    const transaction = this.#require(transactionId);
    this.#assertStatus(transaction, 'running');
    return this.#runExclusive(transaction, 'scope expansion', async () => {
      for (const file of [...new Set(files.map(normalizeProjectFile))].sort()) {
        if (transaction.before.has(file)) {
          continue;
        }

        const baseline = transaction.repositoryBefore.get(file);
        if (baseline) {
          transaction.before.set(file, baseline);
        } else if (transaction.unavailableBefore.has(file)) {
          throw new Error(`File was not safely captured before scope expansion: ${file}`);
        } else {
          transaction.before.set(file, missingFileState());
        }
        transaction.record.files.push(file);
        transaction.record.scopeExpandedFiles.push(file);
      }

      transaction.record.files.sort();
      transaction.record.scopeExpandedFiles.sort();
      transaction.record.updatedAt = new Date().toISOString();
      return cloneRecord(transaction.record);
    });
  }

  async finalize(transactionId: string): Promise<PatchTransactionRecord> {
    const transaction = this.#require(transactionId);
    this.#assertStatus(transaction, 'running');
    return this.#runExclusive(transaction, 'finalize', async () => {
      await this.#captureChanges(transaction);
      transaction.record.status = 'applied';
      transaction.record.updatedAt = new Date().toISOString();
      return cloneRecord(transaction.record);
    });
  }

  async finalizeFailure(transactionId: string, message: string): Promise<PatchTransactionRecord> {
    const transaction = this.#require(transactionId);
    this.#assertStatus(transaction, 'running');
    return this.#runExclusive(transaction, 'failure finalization', async () => {
      await this.#captureChanges(transaction);
      transaction.record.status = transaction.record.changedFiles.length > 0 ? 'applied' : 'failed';
      transaction.record.failureMessage = message;
      transaction.record.updatedAt = new Date().toISOString();
      return cloneRecord(transaction.record);
    });
  }

  async revert(transactionId: string): Promise<PatchTransactionRecord> {
    const transaction = this.#require(transactionId);
    this.#assertStatus(transaction, 'applied');
    return this.#runExclusive(transaction, 'revert', async () => {
      const conflicts: string[] = [];
      for (const file of transaction.record.changedFiles) {
        const current = await this.#capture(file);
        if (current.hash !== transaction.after.get(file)?.hash) {
          conflicts.push(file);
        }
      }

      if (conflicts.length === 0) {
        for (const file of transaction.record.changedFiles) {
          const restored = await this.#restore(
            file,
            transaction.before.get(file)!,
            transaction.after.get(file)!,
          );
          if (!restored) {
            conflicts.push(file);
            break;
          }
        }
      }

      if (conflicts.length > 0) {
        transaction.record.status = 'conflicted';
        transaction.record.conflicts = conflicts;
        transaction.record.updatedAt = new Date().toISOString();
        return cloneRecord(transaction.record);
      }

      transaction.record.status = 'reverted';
      transaction.record.updatedAt = new Date().toISOString();
      return cloneRecord(transaction.record);
    });
  }

  fail(transactionId: string, message: string): PatchTransactionRecord {
    const transaction = this.#require(transactionId);
    this.#assertStatus(transaction, 'running');
    if (transaction.operation) {
      throw new PatchTransactionBusyError(transactionId, transaction.operation);
    }

    transaction.record.status = 'failed';
    transaction.record.failureMessage = message;
    transaction.record.updatedAt = new Date().toISOString();
    return cloneRecord(transaction.record);
  }

  get(transactionId: string): PatchTransactionRecord | undefined {
    const transaction = this.#transactions.get(transactionId);
    return transaction ? cloneRecord(transaction.record) : undefined;
  }

  async #captureChanges(transaction: TransactionState): Promise<void> {
    const changedFiles: string[] = [];
    const diffs: string[] = [];
    transaction.after.clear();
    for (const file of transaction.record.files) {
      const after = await this.#capture(file);
      transaction.after.set(file, after);
      const before = transaction.before.get(file)!;
      if (after.hash !== before.hash) {
        changedFiles.push(file);
        diffs.push(createFileDiff(file, before, after));
      }
    }

    transaction.record.changedFiles = changedFiles;
    transaction.record.diff = truncateUtf8(diffs.join('\n'), this.#maximumDiffBytes);
  }

  async #captureRepositoryBaseline(): Promise<{
    files: Map<string, FileState>;
    unavailable: Set<string>;
  }> {
    const files = new Map<string, FileState>();
    const unavailable = new Set<string>();
    const directories: Array<{ absolute: string; relative: string }> = [
      { absolute: this.#projectRoot, relative: '' },
    ];
    let totalFiles = 0;
    let totalBytes = 0;

    while (directories.length > 0) {
      const directory = directories.pop()!;
      const entries = await readdir(directory.absolute, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const relativePath = directory.relative
          ? `${directory.relative}/${entry.name}`
          : entry.name;
        const absolutePath = resolve(directory.absolute, entry.name);
        if (entry.isDirectory()) {
          if (!ignoredBaselineDirectories.has(entry.name)) {
            directories.push({ absolute: absolutePath, relative: relativePath });
          }
          continue;
        }
        if (!entry.isFile()) {
          unavailable.add(relativePath);
          continue;
        }

        totalFiles += 1;
        if (totalFiles > this.#maximumBaselineFiles) {
          throw new Error(`Repository baseline exceeds ${this.#maximumBaselineFiles} file limit`);
        }
        const entryStat = await lstat(absolutePath);
        if (entryStat.size > this.#maximumFileBytes) {
          unavailable.add(relativePath);
          continue;
        }
        const content = await readFile(absolutePath);
        if (content.includes(0)) {
          unavailable.add(relativePath);
          continue;
        }
        totalBytes += content.byteLength;
        if (totalBytes > this.#maximumBaselineBytes) {
          throw new Error(`Repository baseline exceeds ${this.#maximumBaselineBytes} byte limit`);
        }
        files.set(relativePath, {
          exists: true,
          content,
          hash: createHash('sha256').update(content).digest('hex'),
        });
      }
    }

    return { files, unavailable };
  }

  async #capture(file: string): Promise<FileState> {
    const target = await this.#resolveSafePath(file);
    const targetStat = await lstatOrUndefined(target);
    if (!targetStat) {
      return { exists: false, content: Buffer.alloc(0), hash: 'missing' };
    }

    if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
      throw new Error(`Patch transaction only supports regular files: ${file}`);
    }

    if (targetStat.size > this.#maximumFileBytes) {
      throw new Error(`File exceeds transaction size limit: ${file}`);
    }

    const content = await readFile(target);
    if (content.includes(0)) {
      throw new Error(`Binary file is not supported by patch transaction: ${file}`);
    }

    return {
      exists: true,
      content,
      hash: createHash('sha256').update(content).digest('hex'),
    };
  }

  async #restore(file: string, state: FileState, expectedCurrent: FileState): Promise<boolean> {
    const target = await this.#resolveSafePath(file);
    const current = await this.#capture(file);
    if (current.hash !== expectedCurrent.hash) {
      return false;
    }

    if (!state.exists) {
      await rm(target, { force: true });
      return true;
    }

    await mkdir(dirname(target), { recursive: true });
    const temporaryPath = `${target}.patchlens-${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, state.content, { flag: 'wx' });
      const lastCheck = await this.#capture(file);
      if (lastCheck.hash !== expectedCurrent.hash) {
        return false;
      }
      await renameReplacing(temporaryPath, target);
      return true;
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async #resolveSafePath(file: string): Promise<string> {
    if (!file || isAbsolute(file)) {
      throw new Error(`Project-relative file path required: ${file}`);
    }

    const target = resolve(this.#projectRoot, file);
    if (!isWithinRoot(this.#projectRoot, target)) {
      throw new Error(`File escapes project root: ${file}`);
    }

    const existingParent = await findExistingParent(dirname(target));
    const resolvedParent = await realpath(existingParent);
    if (!isWithinRoot(this.#projectRoot, resolvedParent)) {
      throw new Error(`File parent escapes project root: ${file}`);
    }

    const targetStat = await lstatOrUndefined(target);
    if (targetStat?.isSymbolicLink()) {
      throw new Error(`Symbolic link targets are not supported: ${file}`);
    }

    if (targetStat) {
      const resolvedTarget = await realpath(target);
      if (!isWithinRoot(this.#projectRoot, resolvedTarget)) {
        throw new Error(`File resolves outside project root: ${file}`);
      }
    }

    return target;
  }

  #require(transactionId: string): TransactionState {
    const transaction = this.#transactions.get(transactionId);
    if (!transaction) {
      throw new UnknownPatchTransactionError(transactionId);
    }
    return transaction;
  }

  #assertStatus(transaction: TransactionState, expectedStatus: PatchTransactionStatus): void {
    if (transaction.record.status !== expectedStatus) {
      throw new PatchTransactionStateError(transaction.record.id, expectedStatus);
    }
  }

  async #runExclusive<Value>(
    transaction: TransactionState,
    operation: string,
    action: () => Promise<Value>,
  ): Promise<Value> {
    if (transaction.operation) {
      throw new PatchTransactionBusyError(transaction.record.id, transaction.operation);
    }

    transaction.operation = operation;
    try {
      return await action();
    } finally {
      delete transaction.operation;
    }
  }
}

async function findExistingParent(path: string): Promise<string> {
  let current = path;
  while (!(await lstatOrUndefined(current))) {
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Cannot resolve parent for path: ${path}`);
    }
    current = parent;
  }
  return current;
}

async function lstatOrUndefined(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function isWithinRoot(projectRoot: string, target: string): boolean {
  const relativePath = relative(projectRoot, target);
  return (
    relativePath === '' ||
    (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

function normalizeProjectFile(file: string): string {
  const normalized = file.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Project-relative file path required: ${file}`);
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`File escapes project root: ${file}`);
  }
  if (
    segments.some(
      (segment) => segment === '' || segment === '.' || ignoredBaselineDirectories.has(segment),
    )
  ) {
    throw new Error(`Unsupported transaction path: ${file}`);
  }
  return normalized;
}

function missingFileState(): FileState {
  return { exists: false, content: Buffer.alloc(0), hash: 'missing' };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function cloneRecord(record: PatchTransactionRecord): PatchTransactionRecord {
  return {
    ...record,
    files: [...record.files],
    plannedFiles: [...record.plannedFiles],
    scopeExpandedFiles: [...record.scopeExpandedFiles],
    changedFiles: [...record.changedFiles],
    conflicts: [...record.conflicts],
  };
}

function createFileDiff(file: string, before: FileState, after: FileState): string {
  const normalizedFile = file.replaceAll('\\', '/');
  const beforePath = before.exists ? `a/${normalizedFile}` : '/dev/null';
  const afterPath = after.exists ? `b/${normalizedFile}` : '/dev/null';
  const operations = createLineOperations(
    before.content.toString('utf8').split('\n'),
    after.content.toString('utf8').split('\n'),
  );
  const hunks = createUnifiedHunks(operations);
  return [
    `--- ${beforePath}`,
    `+++ ${afterPath}`,
    ...(hunks.length > 0 || before.exists === after.exists ? hunks : ['@@ -0,0 +0,0 @@']),
  ].join('\n');
}

type DiffOperation = {
  kind: 'equal' | 'delete' | 'insert';
  line: string;
};

type AnnotatedDiffOperation = DiffOperation & {
  oldLine: number;
  newLine: number;
};

function createLineOperations(beforeLines: string[], afterLines: string[]): DiffOperation[] {
  if (beforeLines.length + afterLines.length <= 2_000) {
    const operations = createMyersOperations(beforeLines, afterLines);
    if (operations) {
      return operations;
    }
  }
  return createCoarseOperations(beforeLines, afterLines);
}

function createMyersOperations(
  beforeLines: string[],
  afterLines: string[],
): DiffOperation[] | undefined {
  const maximumDistance = beforeLines.length + afterLines.length;
  const offset = maximumDistance + 1;
  const frontier = new Int32Array(maximumDistance * 2 + 3);
  frontier.fill(-1);
  frontier[offset + 1] = 0;
  const trace: Int32Array[] = [];
  const distanceLimit = Math.min(maximumDistance, 500);

  for (let distance = 0; distance <= distanceLimit; distance += 1) {
    trace.push(frontier.slice());
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const index = offset + diagonal;
      let beforeIndex: number;
      if (
        diagonal === -distance ||
        (diagonal !== distance && frontier[index - 1]! < frontier[index + 1]!)
      ) {
        beforeIndex = frontier[index + 1]!;
      } else {
        beforeIndex = frontier[index - 1]! + 1;
      }

      let afterIndex = beforeIndex - diagonal;
      while (
        beforeIndex < beforeLines.length &&
        afterIndex < afterLines.length &&
        beforeLines[beforeIndex] === afterLines[afterIndex]
      ) {
        beforeIndex += 1;
        afterIndex += 1;
      }
      frontier[index] = beforeIndex;

      if (beforeIndex >= beforeLines.length && afterIndex >= afterLines.length) {
        return backtrackMyersOperations(beforeLines, afterLines, trace, distance, offset);
      }
    }
  }

  return undefined;
}

function backtrackMyersOperations(
  beforeLines: string[],
  afterLines: string[],
  trace: Int32Array[],
  distance: number,
  offset: number,
): DiffOperation[] {
  const operations: DiffOperation[] = [];
  let beforeIndex = beforeLines.length;
  let afterIndex = afterLines.length;

  for (let currentDistance = distance; currentDistance > 0; currentDistance -= 1) {
    const frontier = trace[currentDistance]!;
    const diagonal = beforeIndex - afterIndex;
    const index = offset + diagonal;
    const previousDiagonal =
      diagonal === -currentDistance ||
      (diagonal !== currentDistance && frontier[index - 1]! < frontier[index + 1]!)
        ? diagonal + 1
        : diagonal - 1;
    const previousBeforeIndex = frontier[offset + previousDiagonal]!;
    const previousAfterIndex = previousBeforeIndex - previousDiagonal;

    while (beforeIndex > previousBeforeIndex && afterIndex > previousAfterIndex) {
      operations.push({ kind: 'equal', line: beforeLines[beforeIndex - 1]! });
      beforeIndex -= 1;
      afterIndex -= 1;
    }

    if (beforeIndex === previousBeforeIndex) {
      operations.push({ kind: 'insert', line: afterLines[afterIndex - 1]! });
      afterIndex -= 1;
    } else {
      operations.push({ kind: 'delete', line: beforeLines[beforeIndex - 1]! });
      beforeIndex -= 1;
    }
  }

  while (beforeIndex > 0 && afterIndex > 0) {
    operations.push({ kind: 'equal', line: beforeLines[beforeIndex - 1]! });
    beforeIndex -= 1;
    afterIndex -= 1;
  }
  while (beforeIndex > 0) {
    operations.push({ kind: 'delete', line: beforeLines[beforeIndex - 1]! });
    beforeIndex -= 1;
  }
  while (afterIndex > 0) {
    operations.push({ kind: 'insert', line: afterLines[afterIndex - 1]! });
    afterIndex -= 1;
  }

  return operations.reverse();
}

function createCoarseOperations(beforeLines: string[], afterLines: string[]): DiffOperation[] {
  let prefixLength = 0;
  while (
    prefixLength < beforeLines.length &&
    prefixLength < afterLines.length &&
    beforeLines[prefixLength] === afterLines[prefixLength]
  ) {
    prefixLength += 1;
  }

  let beforeSuffix = beforeLines.length;
  let afterSuffix = afterLines.length;
  while (
    beforeSuffix > prefixLength &&
    afterSuffix > prefixLength &&
    beforeLines[beforeSuffix - 1] === afterLines[afterSuffix - 1]
  ) {
    beforeSuffix -= 1;
    afterSuffix -= 1;
  }

  return [
    ...beforeLines.slice(0, prefixLength).map((line): DiffOperation => ({ kind: 'equal', line })),
    ...beforeLines
      .slice(prefixLength, beforeSuffix)
      .map((line): DiffOperation => ({ kind: 'delete', line })),
    ...afterLines
      .slice(prefixLength, afterSuffix)
      .map((line): DiffOperation => ({ kind: 'insert', line })),
    ...beforeLines.slice(beforeSuffix).map((line): DiffOperation => ({ kind: 'equal', line })),
  ];
}

function createUnifiedHunks(operations: DiffOperation[]): string[] {
  let oldLine = 1;
  let newLine = 1;
  const annotated: AnnotatedDiffOperation[] = operations.map((operation) => {
    const value = { ...operation, oldLine, newLine };
    if (operation.kind !== 'insert') {
      oldLine += 1;
    }
    if (operation.kind !== 'delete') {
      newLine += 1;
    }
    return value;
  });

  const ranges: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < annotated.length; index += 1) {
    if (annotated[index]!.kind === 'equal') {
      continue;
    }

    const start = Math.max(0, index - 3);
    const end = Math.min(annotated.length, index + 4);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) {
      previous.end = Math.max(previous.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  return ranges.flatMap((range) => {
    const operationsInHunk = annotated.slice(range.start, range.end);
    const first = operationsInHunk[0]!;
    const oldCount = operationsInHunk.filter((operation) => operation.kind !== 'insert').length;
    const newCount = operationsInHunk.filter((operation) => operation.kind !== 'delete').length;
    const oldStart = oldCount === 0 ? Math.max(0, first.oldLine - 1) : first.oldLine;
    const newStart = newCount === 0 ? Math.max(0, first.newLine - 1) : first.newLine;
    return [
      `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      ...operationsInHunk.map((operation) => {
        const prefix = operation.kind === 'equal' ? ' ' : operation.kind === 'delete' ? '-' : '+';
        return `${prefix}${operation.line}`;
      }),
    ];
  });
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const buffer = Buffer.from(value);
  if (buffer.length <= maximumBytes) {
    return value;
  }

  let end = Math.max(0, maximumBytes);
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return buffer.subarray(0, end).toString('utf8');
}

async function renameReplacing(source: string, target: string): Promise<void> {
  try {
    await rename(source, target);
  } catch (error) {
    if (
      process.platform !== 'win32' ||
      !isNodeError(error) ||
      (error.code !== 'EACCES' && error.code !== 'EPERM')
    ) {
      throw error;
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    await rename(source, target);
  }
}
