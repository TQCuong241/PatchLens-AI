import { createHash } from "node:crypto";
import path from "node:path";

import type { SourceManifestEntry } from "@patchlens-ai/agent-protocol";
import ts from "typescript";
import type { Plugin, ResolvedConfig } from "vite";

export type PatchLensViteOptions = {
  manifestPath?: string;
  include?: RegExp;
  exclude?: RegExp;
  inspector?: boolean;
  studioOrigin?: string;
};

type Insertion = {
  position: number;
  text: string;
};

const DEFAULT_MANIFEST_PATH = "/__patchlens/manifest";
const DEFAULT_INCLUDE = /\.[jt]sx$/;
const DEFAULT_EXCLUDE = /(?:^|[/\\])node_modules(?:[/\\]|$)/;
const VIRTUAL_INSPECTOR_ID = "virtual:patchlens-ai/inspector";
const RESOLVED_VIRTUAL_INSPECTOR_ID = `\0${VIRTUAL_INSPECTOR_ID}`;

export function patchLens(options: PatchLensViteOptions = {}): Plugin {
  const manifest = new Map<string, SourceManifestEntry>();
  const idsByFile = new Map<string, string[]>();
  const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST_PATH;
  const include = options.include ?? DEFAULT_INCLUDE;
  const exclude = options.exclude ?? DEFAULT_EXCLUDE;
  const injectInspector = options.inspector ?? true;
  let config: ResolvedConfig;

  return {
    name: "patchlens-ai:source-metadata",
    enforce: "pre",
    apply: "serve",

    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },

    resolveId(id) {
      return id === VIRTUAL_INSPECTOR_ID ? RESOLVED_VIRTUAL_INSPECTOR_ID : null;
    },

    load(id) {
      if (id !== RESOLVED_VIRTUAL_INSPECTOR_ID) {
        return null;
      }
      const inspectorOptions = options.studioOrigin
        ? `{ studioOrigin: ${JSON.stringify(options.studioOrigin)} }`
        : "{}";
      return [
        'import { installPatchLensInspector } from "@patchlens-ai/inspector-runtime";',
        `installPatchLensInspector(${inspectorOptions});`,
        "if (import.meta.hot) {",
        "  import.meta.hot.on('vite:afterUpdate', () => {",
        "    window.dispatchEvent(new Event('patchlens:source-manifest-updated'));",
        "  });",
        "}",
      ].join("\n");
    },

    transformIndexHtml() {
      if (!injectInspector) {
        return undefined;
      }
      return [{
        tag: "script",
        attrs: { type: "module" },
        children: `import ${JSON.stringify(VIRTUAL_INSPECTOR_ID)};`,
        injectTo: "body",
      }];
    },

    configureServer(server) {
      server.watcher.on("unlink", (file) => {
        replaceFileEntries(path.resolve(file), [], manifest, idsByFile);
      });
      server.middlewares.use((request, response, next) => {
        const requestUrl = request.url?.split("?", 1)[0];
        if (requestUrl !== manifestPath) {
          next();
          return;
        }

        response.statusCode = 200;
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.end(JSON.stringify(Object.fromEntries(manifest), null, 2));
      });
    },

    transform(code, id) {
      const cleanId = id.split("?", 1)[0] ?? id;
      if (!matches(include, cleanId) || matches(exclude, cleanId)) {
        return null;
      }

      const sourceFile = ts.createSourceFile(
        cleanId,
        code,
        ts.ScriptTarget.Latest,
        true,
        cleanId.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.JSX,
      );
      const projectRelativeFile = path.relative(config.root, cleanId);
      if (
        projectRelativeFile === ".." ||
        projectRelativeFile.startsWith(`..${path.sep}`) ||
        path.isAbsolute(projectRelativeFile)
      ) {
        return null;
      }
      const relativeFile = normalizePath(projectRelativeFile);
      const insertions: Insertion[] = [];
      const entries: SourceManifestEntry[] = [];
      const elementOrdinals = new Map<string, number>();

      function visit(node: ts.Node): void {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const tagName = node.tagName.getText(sourceFile);
          const isIntrinsic = /^[a-z]/.test(tagName);
          const alreadyInstrumented = node.attributes.properties.some(
            (attribute) =>
              ts.isJsxAttribute(attribute) &&
              attribute.name.getText(sourceFile) === "data-patchlens-id",
          );

          if (isIntrinsic && !alreadyInstrumented) {
            const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
            const line = start.line + 1;
            const column = start.character + 1;
            const componentName = inferComponentName(node, sourceFile, cleanId);
            const componentOrdinal = elementOrdinals.get(componentName) ?? 0;
            elementOrdinals.set(componentName, componentOrdinal + 1);
            const patchlensId = createPatchLensId(
              `${relativeFile}:${componentName}:${componentOrdinal}:${tagName}`,
            );

            insertions.push({
              position: node.tagName.end,
              text: ` data-patchlens-id="${patchlensId}"`,
            });
            entries.push({
              id: patchlensId,
              framework: "react",
              componentName,
              file: relativeFile,
              line,
              column,
              tagName,
            });
          }
        }

        ts.forEachChild(node, visit);
      }

      visit(sourceFile);
      replaceFileEntries(cleanId, entries, manifest, idsByFile);

      if (insertions.length === 0) {
        return null;
      }

      const transformed = insertions
        .sort((left, right) => right.position - left.position)
        .reduce(
          (current, insertion) =>
            `${current.slice(0, insertion.position)}${insertion.text}${current.slice(insertion.position)}`,
          code,
        );

      return {
        code: transformed,
        map: null,
      };
    },
  };
}

export default patchLens;

function replaceFileEntries(
  file: string,
  entries: SourceManifestEntry[],
  manifest: Map<string, SourceManifestEntry>,
  idsByFile: Map<string, string[]>,
): void {
  const fileKey = normalizeFileKey(file);
  for (const previousId of idsByFile.get(fileKey) ?? []) {
    manifest.delete(previousId);
  }

  const nextIds: string[] = [];
  for (const entry of entries) {
    manifest.set(entry.id, entry);
    nextIds.push(entry.id);
  }

  idsByFile.set(fileKey, nextIds);
}

function inferComponentName(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  file: string,
): string {
  let current: ts.Node | undefined = node.parent;

  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) {
      return current.name.text;
    }

    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }

    if (ts.isMethodDeclaration(current) && current.name) {
      return current.name.getText(sourceFile);
    }

    if (ts.isClassDeclaration(current) && current.name) {
      return current.name.text;
    }

    current = current.parent;
  }

  return path.basename(file, path.extname(file));
}

function createPatchLensId(input: string): string {
  return `pl_${createHash("sha1").update(input).digest("hex").slice(0, 12)}`;
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function normalizeFileKey(value: string): string {
  return path.normalize(path.resolve(value));
}

function matches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}
