import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PatchTransactionManager } from '../src/index.js';

let projectRoot: string;
let manager: PatchTransactionManager;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'patchlens-transaction-'));
  manager = await PatchTransactionManager.create(projectRoot);
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

describe('PatchTransactionManager', () => {
  it('restores the baseline for an applied text-file change', async () => {
    await writeFile(join(projectRoot, 'component.tsx'), 'before\n');
    const transaction = await manager.begin(createInput(['component.tsx']));
    await writeFile(join(projectRoot, 'component.tsx'), 'after\n');

    const applied = await manager.finalize(transaction.id);
    const reverted = await manager.revert(transaction.id);

    expect(applied.changedFiles).toEqual(['component.tsx']);
    expect(applied.diff).toContain('--- a/component.tsx');
    expect(applied.diff).toContain('+after');
    expect(reverted.status).toBe('reverted');
    await expect(readFile(join(projectRoot, 'component.tsx'), 'utf8')).resolves.toBe('before\n');
  });

  it('does not overwrite user changes created after finalize', async () => {
    await writeFile(join(projectRoot, 'component.tsx'), 'before\n');
    const transaction = await manager.begin(createInput(['component.tsx']));
    await writeFile(join(projectRoot, 'component.tsx'), 'agent\n');
    await manager.finalize(transaction.id);
    await writeFile(join(projectRoot, 'component.tsx'), 'user\n');

    const reverted = await manager.revert(transaction.id);

    expect(reverted.status).toBe('conflicted');
    expect(reverted.conflicts).toEqual(['component.tsx']);
    await expect(readFile(join(projectRoot, 'component.tsx'), 'utf8')).resolves.toBe('user\n');
  });

  it('removes a file created by the transaction', async () => {
    const transaction = await manager.begin(createInput(['new-file.ts']));
    await writeFile(join(projectRoot, 'new-file.ts'), 'created\n');
    await manager.finalize(transaction.id);

    await manager.revert(transaction.id);

    await expect(readFile(join(projectRoot, 'new-file.ts'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('keeps a partial failed change revertible', async () => {
    await writeFile(join(projectRoot, 'component.tsx'), 'before\n');
    const transaction = await manager.begin(createInput(['component.tsx']));
    await writeFile(join(projectRoot, 'component.tsx'), 'partial\n');

    const failed = await manager.finalizeFailure(transaction.id, 'Provider failed');
    const reverted = await manager.revert(transaction.id);

    expect(failed).toMatchObject({
      status: 'applied',
      failureMessage: 'Provider failed',
      changedFiles: ['component.tsx'],
    });
    expect(failed.diff).toContain('+partial');
    expect(reverted.status).toBe('reverted');
    await expect(readFile(join(projectRoot, 'component.tsx'), 'utf8')).resolves.toBe('before\n');
  });

  it('marks a failed transaction without changes as failed', async () => {
    await writeFile(join(projectRoot, 'component.tsx'), 'before\n');
    const transaction = await manager.begin(createInput(['component.tsx']));

    const failed = await manager.finalizeFailure(transaction.id, 'Provider failed');

    expect(failed).toMatchObject({
      status: 'failed',
      failureMessage: 'Provider failed',
      changedFiles: [],
      diff: '',
    });
  });

  it('rejects traversal outside project root', async () => {
    await expect(manager.begin(createInput(['../outside.ts']))).rejects.toThrow(
      'File escapes project root',
    );
  });

  it('accepts path segments whose names begin with two dots', async () => {
    await mkdir(join(projectRoot, '..name'));
    await writeFile(join(projectRoot, '..name', 'component.tsx'), 'before\n');
    const transaction = await manager.begin(createInput(['..name/component.tsx']));
    await writeFile(join(projectRoot, '..name', 'component.tsx'), 'after\n');

    const applied = await manager.finalize(transaction.id);

    expect(applied.changedFiles).toEqual(['..name/component.tsx']);
  });

  it('rejects ignored generated directories at any depth', async () => {
    await expect(manager.begin(createInput(['src/dist/generated.ts']))).rejects.toThrow(
      'Unsupported transaction path',
    );
  });

  it('rejects binary files', async () => {
    await writeFile(join(projectRoot, 'image.bin'), Buffer.from([1, 0, 2]));

    await expect(manager.begin(createInput(['image.bin']))).rejects.toThrow(
      'Binary file is not supported',
    );
  });

  it('captures baseline before accepting scope expansion', async () => {
    await writeFile(join(projectRoot, 'planned.ts'), 'planned before\n');
    await writeFile(join(projectRoot, 'related.ts'), 'related before\n');
    const transaction = await manager.begin(createInput(['planned.ts']));
    const expanded = await manager.expand(transaction.id, ['related.ts']);
    await writeFile(join(projectRoot, 'planned.ts'), 'planned after\n');
    await writeFile(join(projectRoot, 'related.ts'), 'related after\n');
    await manager.finalize(transaction.id);

    await manager.revert(transaction.id);

    expect(expanded.scopeExpandedFiles).toEqual(['related.ts']);
    await expect(readFile(join(projectRoot, 'planned.ts'), 'utf8')).resolves.toBe(
      'planned before\n',
    );
    await expect(readFile(join(projectRoot, 'related.ts'), 'utf8')).resolves.toBe(
      'related before\n',
    );
  });

  it('uses repository baseline when scope expansion is reported after editing', async () => {
    await writeFile(join(projectRoot, 'planned.ts'), 'planned before\n');
    await writeFile(join(projectRoot, 'related.ts'), 'related before\n');
    const transaction = await manager.begin(createInput(['planned.ts']));
    await writeFile(join(projectRoot, 'related.ts'), 'related after\n');

    await manager.expand(transaction.id, ['related.ts']);
    const applied = await manager.finalize(transaction.id);
    await manager.revert(transaction.id);

    expect(applied.changedFiles).toEqual(['related.ts']);
    expect(applied.diff).toContain('-related before');
    expect(applied.diff).toContain('+related after');
    await expect(readFile(join(projectRoot, 'related.ts'), 'utf8')).resolves.toBe(
      'related before\n',
    );
  });

  it('treats a newly reported scope file as missing in repository baseline', async () => {
    await writeFile(join(projectRoot, 'planned.ts'), 'planned before\n');
    const transaction = await manager.begin(createInput(['planned.ts']));
    await writeFile(join(projectRoot, 'created.ts'), 'created by agent\n');

    await manager.expand(transaction.id, ['created.ts']);
    await manager.finalize(transaction.id);
    await manager.revert(transaction.id);

    await expect(readFile(join(projectRoot, 'created.ts'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('creates focused unified hunks instead of full-file output', async () => {
    const before = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`);
    const after = [...before];
    after[6] = 'line-seven-updated';
    await writeFile(join(projectRoot, 'component.tsx'), `${before.join('\n')}\n`);
    const transaction = await manager.begin(createInput(['component.tsx']));
    await writeFile(join(projectRoot, 'component.tsx'), `${after.join('\n')}\n`);

    const applied = await manager.finalize(transaction.id);

    expect(applied.diff).toContain('@@ -4,7 +4,7 @@');
    expect(applied.diff).toContain('-line-7');
    expect(applied.diff).toContain('+line-seven-updated');
    expect(applied.diff).not.toContain('-line-1\n');
    expect(applied.diff).not.toContain('@@ full-file @@');
  });

  it('restores a file deleted by the transaction', async () => {
    await writeFile(join(projectRoot, 'component.tsx'), 'before\n');
    const transaction = await manager.begin(createInput(['component.tsx']));
    await rm(join(projectRoot, 'component.tsx'));
    await manager.finalize(transaction.id);

    const reverted = await manager.revert(transaction.id);

    expect(reverted.status).toBe('reverted');
    await expect(readFile(join(projectRoot, 'component.tsx'), 'utf8')).resolves.toBe('before\n');
  });

  it('treats a rename after finalize as a conflict', async () => {
    await writeFile(join(projectRoot, 'component.tsx'), 'before\n');
    const transaction = await manager.begin(createInput(['component.tsx']));
    await writeFile(join(projectRoot, 'component.tsx'), 'agent\n');
    await manager.finalize(transaction.id);
    await rename(join(projectRoot, 'component.tsx'), join(projectRoot, 'component-renamed.tsx'));

    const reverted = await manager.revert(transaction.id);

    expect(reverted.status).toBe('conflicted');
    expect(reverted.conflicts).toEqual(['component.tsx']);
    await expect(readFile(join(projectRoot, 'component-renamed.tsx'), 'utf8')).resolves.toBe(
      'agent\n',
    );
  });

  it('does not touch dirty files outside the transaction', async () => {
    await writeFile(join(projectRoot, 'component.tsx'), 'before\n');
    await writeFile(join(projectRoot, 'dirty.ts'), 'user work\n');
    const transaction = await manager.begin(createInput(['component.tsx']));
    await writeFile(join(projectRoot, 'component.tsx'), 'agent\n');
    await manager.finalize(transaction.id);

    await manager.revert(transaction.id);

    await expect(readFile(join(projectRoot, 'dirty.ts'), 'utf8')).resolves.toBe('user work\n');
  });

  it('serializes concurrent transaction operations', async () => {
    await writeFile(join(projectRoot, 'component.tsx'), 'before\n');
    const transaction = await manager.begin(createInput(['component.tsx']));
    await writeFile(join(projectRoot, 'component.tsx'), 'after\n');

    const results = await Promise.allSettled([
      manager.finalize(transaction.id),
      manager.finalize(transaction.id),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });
});

function createInput(files: string[]) {
  return {
    requestId: 'request-1',
    sessionId: 'session-1',
    selectionId: 'selection-1',
    instruction: 'Update selected component',
    files,
  };
}
