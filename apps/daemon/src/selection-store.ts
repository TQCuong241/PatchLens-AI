import type { SelectionContext } from '@patchlens-ai/agent-protocol';

export class SelectionStore {
  readonly #activeByProject = new Map<string, SelectionContext>();

  set(projectId: string, context: SelectionContext): SelectionContext {
    if (context.selection.projectId !== projectId) {
      throw new Error('Selection project does not match route project');
    }

    const active = this.#activeByProject.get(projectId);
    if (active && Date.parse(context.capturedAt) < Date.parse(active.capturedAt)) {
      return structuredClone(active);
    }

    const stored = structuredClone(context);
    this.#activeByProject.set(projectId, stored);
    return structuredClone(stored);
  }

  get(projectId: string): SelectionContext | undefined {
    const context = this.#activeByProject.get(projectId);
    return context ? structuredClone(context) : undefined;
  }

  clear(projectId: string): void {
    this.#activeByProject.delete(projectId);
  }
}
