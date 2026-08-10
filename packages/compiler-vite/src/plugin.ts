import type { Plugin } from 'vite';

import { instrumentSource, shouldInstrumentFile } from './instrument.js';
import type { SourceManifest } from '@patchlens-ai/agent-protocol';

const defaultManifestEndpoint = '/__patchlens/manifest';
const publicVirtualModuleId = 'virtual:patchlens-manifest';
const resolvedVirtualModuleId = '\0virtual:patchlens-manifest';

export type PatchLensVitePluginOptions = {
  manifestEndpoint?: string;
  include?: (id: string) => boolean;
};

export function patchLensVitePlugin(options: PatchLensVitePluginOptions = {}): Plugin {
  const registry = new ManifestRegistry();
  const manifestEndpoint = options.manifestEndpoint ?? defaultManifestEndpoint;
  let root = process.cwd();

  return {
    name: 'patchlens:compiler-vite',
    apply: 'serve',
    enforce: 'pre',
    configResolved(config) {
      root = config.root;
    },
    transform(code, id) {
      if (!shouldInstrumentFile(id) || (options.include && !options.include(id))) {
        return null;
      }

      const result = instrumentSource({ code, id, root });
      registry.replaceFile(result.file, result.manifest);
      return result.changed ? { code: result.code, map: null } : null;
    },
    resolveId(id) {
      return id === publicVirtualModuleId ? resolvedVirtualModuleId : null;
    },
    load(id) {
      if (id !== resolvedVirtualModuleId) {
        return null;
      }

      return `export default ${JSON.stringify(registry.snapshot())};`;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const requestUrl = request.url?.split('?', 1)[0];
        if (requestUrl !== manifestEndpoint) {
          next();
          return;
        }

        response.statusCode = 200;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.end(JSON.stringify(registry.snapshot()));
      });
    },
  };
}

class ManifestRegistry {
  readonly #entries = new Map<string, SourceManifest[string]>();
  readonly #fileEntries = new Map<string, Set<string>>();

  replaceFile(file: string, manifest: SourceManifest): void {
    const previousIds = this.#fileEntries.get(file);
    if (previousIds) {
      for (const id of previousIds) {
        this.#entries.delete(id);
      }
    }

    const nextIds = new Set<string>();
    for (const [id, entry] of Object.entries(manifest)) {
      this.#entries.set(id, entry);
      nextIds.add(id);
    }
    this.#fileEntries.set(file, nextIds);
  }

  snapshot(): SourceManifest {
    return Object.fromEntries(this.#entries.entries());
  }
}
