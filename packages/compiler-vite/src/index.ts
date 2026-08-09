import { createHash } from "node:crypto";
import path from "node:path";

import type { SourceManifestEntry } from "@patchlens-ai/agent-protocol";
import ts from "typescript";
import type { Plugin, ResolvedConfig } from "vite";

export type PatchLensViteOptions = {
  manifestPath?: string;
  include?: RegExp;
  exclude?: RegExp;
};

type Insertion = {
  position: number;
  text: string;
};

const DEFAULT_MANIFEST_PATH = "/__patchlens/manifest";
const DEFAULT_INCLUDE = /\.[jt]sx$/;
const DEFAULT_EXCLUDE = /(?:^|[/\\])node_modules(?:[/\\]|$)/;

export function patchLens(options: PatchLensViteOptions = {}): Plugin {
  const manifest = new Map<string, SourceManifestEntry>();
  const idsByFile = new Map<string, string[]>();
  const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST_PATH;
  const include = options.include ?? DEFAULT_INCLUDE;
  const exclude = options.exclude ?? DEFAULT_EXCLUDE;
  let config: ResolvedConfig;

  return {
    name: "patchlens-ai:source-metadata",
    enforce: "pre",
    apply: "serve",

    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },

    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const requestUrl = request.url?.split("?", 1)[0];
        if (requestUrl !== manifestPath) {
          next();
          return;
        }

        response.statusCode = 200;
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Access-Control-Allow-Origin", "*");
        response.end(JSON.stringify(Object.fromEntries(manifest), null, 2));
      });
    },

    transform(code, id) {
      const cleanId = id.split("?", 1)[0] ?? id;
      if (!include.test(cleanId) || exclude.test(cleanId)) {
        return null;
      }

      const sourceFile = ts.createSourceFile(
        cleanId,
        code,
        ts.ScriptTarget.Latest,
        true,
        cleanId.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.JSX,
      );
      const relativeFile = normalizePath(path.relative(config.root, cleanId));
      const insertions: Insertion[] = [];
      const entries: SourceManifestEntry[] = [];

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
            const patchlensId = createPatchLensId(
              `${relativeFile}:${line}:${column}:${tagName}:${componentName}`,
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
  for (const previousId of idsByFile.get(file) ?? []) {
    manifest.delete(previousId);
  }

  const nextIds: string[] = [];
  for (const entry of entries) {
    manifest.set(entry.id, entry);
    nextIds.push(entry.id);
  }

  idsByFile.set(file, nextIds);
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
