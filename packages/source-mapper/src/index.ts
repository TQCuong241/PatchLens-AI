import type {
  SourceLocation,
  SourceManifest,
  SourceManifestEntry,
} from '@patchlens-ai/agent-protocol';

export class SourceMapper {
  readonly #entries = new Map<string, SourceManifestEntry>();

  constructor(manifest: SourceManifest = {}) {
    this.replace(manifest);
  }

  get size(): number {
    return this.#entries.size;
  }

  replace(manifest: SourceManifest): void {
    this.#entries.clear();
    for (const [id, entry] of Object.entries(manifest)) {
      this.register(id, entry);
    }
  }

  register(id: string, entry: SourceManifestEntry): void {
    if (id !== entry.id) {
      throw new Error(`Manifest key ${id} does not match entry ID ${entry.id}`);
    }

    this.#entries.set(id, { ...entry });
  }

  resolve(id: string): SourceLocation | undefined {
    const entry = this.#entries.get(id);
    return entry ? { ...entry } : undefined;
  }

  resolveAll(ids: readonly string[]): SourceLocation[] {
    const resolved = new Map<string, SourceLocation>();

    for (const id of ids) {
      const location = this.resolve(id);
      if (location) {
        resolved.set(location.id, location);
      }
    }

    return [...resolved.values()];
  }

  toManifest(): SourceManifest {
    return Object.fromEntries(
      [...this.#entries.entries()].map(([id, entry]) => [id, { ...entry }]),
    );
  }
}
