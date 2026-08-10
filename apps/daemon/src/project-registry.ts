import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { PatchTransactionManager } from '@patchlens-ai/patch-transaction';

import { ProjectCaptureStore } from './capture-store.js';

export class InvalidProjectRootError extends Error {
  constructor(projectRoot: string) {
    super(`Invalid project root: ${projectRoot}`);
    this.name = 'InvalidProjectRootError';
  }
}

export class UnknownProjectError extends Error {
  constructor(projectId: string) {
    super(`Unknown project: ${projectId}`);
    this.name = 'UnknownProjectError';
  }
}

export type ProjectRecord = {
  id: string;
  root: string;
  createdAt: string;
};

export type ProjectRuntime = {
  record: ProjectRecord;
  transactions: PatchTransactionManager;
  captures: ProjectCaptureStore;
  packageManager: string;
};

export class ProjectRegistry {
  readonly #projects = new Map<string, ProjectRuntime>();
  readonly #projectIdsByRoot = new Map<string, string>();

  async register(projectRoot: string): Promise<ProjectRecord> {
    let root: string;
    try {
      root = await realpath(resolve(projectRoot));
      const rootStat = await stat(root);
      if (!rootStat.isDirectory()) {
        throw new InvalidProjectRootError(projectRoot);
      }
    } catch (error) {
      if (error instanceof InvalidProjectRootError) {
        throw error;
      }
      throw new InvalidProjectRootError(projectRoot);
    }

    const existingId = this.#projectIdsByRoot.get(root);
    if (existingId) {
      return { ...this.#projects.get(existingId)!.record };
    }

    const record: ProjectRecord = {
      id: `project-${randomUUID()}`,
      root,
      createdAt: new Date().toISOString(),
    };
    const transactions = await PatchTransactionManager.create(root);
    const captures = await ProjectCaptureStore.create(root);
    const packageManager = await detectPackageManager(root);
    this.#projects.set(record.id, {
      record,
      transactions,
      captures,
      packageManager,
    });
    this.#projectIdsByRoot.set(root, record.id);
    return { ...record };
  }

  list(): ProjectRecord[] {
    return [...this.#projects.values()].map(({ record }) => ({ ...record }));
  }

  get(projectId: string): ProjectRuntime | undefined {
    return this.#projects.get(projectId);
  }

  require(projectId: string): ProjectRuntime {
    const project = this.get(projectId);
    if (!project) {
      throw new UnknownProjectError(projectId);
    }
    return project;
  }
}

async function detectPackageManager(projectRoot: string): Promise<string> {
  try {
    const value: unknown = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'));
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      'packageManager' in value &&
      typeof value.packageManager === 'string' &&
      value.packageManager
    ) {
      return value.packageManager;
    }
  } catch {
    return 'npm';
  }
  return 'npm';
}
