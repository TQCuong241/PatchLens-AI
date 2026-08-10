import { createHash } from 'node:crypto';
import { relative } from 'node:path';

import { parse } from '@babel/parser';
import type { ParserPlugin } from '@babel/parser';
import type { SourceManifest, SourceManifestEntry } from '@patchlens-ai/agent-protocol';

type AstNode = {
  type: string;
  start?: number | null;
  end?: number | null;
  loc?: {
    start: {
      line: number;
      column: number;
    };
  } | null;
  [key: string]: unknown;
};

type Insertion = {
  index: number;
  text: string;
};

export type InstrumentSourceInput = {
  code: string;
  id: string;
  root: string;
};

export type InstrumentSourceResult = {
  code: string;
  file: string;
  manifest: SourceManifest;
  changed: boolean;
};

export function instrumentSource(input: InstrumentSourceInput): InstrumentSourceResult {
  const cleanId = stripQuery(input.id);
  const file = normalizePath(relative(input.root, cleanId));
  const plugins: ParserPlugin[] = ['jsx'];
  if (/\.tsx?$/.test(cleanId)) {
    plugins.push('typescript');
  }

  const ast = parse(input.code, {
    sourceType: 'module',
    plugins,
  }) as unknown as AstNode;
  const insertions: Insertion[] = [];
  const manifest: SourceManifest = {};
  const reactFragmentTags = collectReactFragmentTags(ast);

  walkAst(ast, undefined, (node, componentName) => {
    const tagName = getJsxName(asAstNode(node.name));
    if (tagName && reactFragmentTags.has(tagName)) {
      return;
    }

    const source = createManifestEntry(node, componentName, file);
    if (!source || hasPatchLensAttribute(node)) {
      return;
    }

    const name = asAstNode(node.name);
    if (!name || typeof name.end !== 'number') {
      return;
    }

    insertions.push({
      index: name.end,
      text: ` data-patchlens-id='${source.id}'`,
    });
    manifest[source.id] = source;
  });

  return {
    code: applyInsertions(input.code, insertions),
    file,
    manifest,
    changed: insertions.length > 0,
  };
}

export function shouldInstrumentFile(id: string): boolean {
  const cleanId = normalizePath(stripQuery(id));
  return /\.[jt]sx$/.test(cleanId) && !cleanId.includes('/node_modules/');
}

function walkAst(
  node: AstNode,
  parentComponentName: string | undefined,
  onOpeningElement: (node: AstNode, componentName: string | undefined) => void,
): void {
  const componentName = getComponentName(node) ?? parentComponentName;
  if (node.type === 'JSXOpeningElement') {
    onOpeningElement(node, componentName);
  }

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const child = asAstNode(item);
        if (child) {
          walkAst(child, componentName, onOpeningElement);
        }
      }
      continue;
    }

    const child = asAstNode(value);
    if (child) {
      walkAst(child, componentName, onOpeningElement);
    }
  }
}

function createManifestEntry(
  node: AstNode,
  componentName: string | undefined,
  file: string,
): SourceManifestEntry | undefined {
  if (!node.loc) {
    return undefined;
  }

  const tagName = getJsxName(asAstNode(node.name));
  if (!tagName) {
    return undefined;
  }

  const line = node.loc.start.line;
  const column = node.loc.start.column;
  const id = createPatchLensId(file, line, column, tagName);
  return {
    id,
    framework: 'react',
    componentName,
    file,
    line,
    column,
    tagName,
  };
}

function getComponentName(node: AstNode): string | undefined {
  if (
    node.type === 'FunctionDeclaration' ||
    node.type === 'ClassDeclaration' ||
    node.type === 'ClassExpression'
  ) {
    return getComponentIdentifier(node.id);
  }

  if (node.type !== 'VariableDeclarator' || !isComponentInitializer(node.init)) {
    return undefined;
  }

  return getComponentIdentifier(node.id);
}

function getComponentIdentifier(value: unknown): string | undefined {
  const node = asAstNode(value);
  if (!node || node.type !== 'Identifier' || typeof node.name !== 'string') {
    return undefined;
  }

  return /^[A-Z]/.test(node.name) ? node.name : undefined;
}

function isComponentInitializer(value: unknown): boolean {
  const node = asAstNode(value);
  return (
    node?.type === 'ArrowFunctionExpression' ||
    node?.type === 'FunctionExpression' ||
    node?.type === 'CallExpression'
  );
}

function collectReactFragmentTags(ast: AstNode): Set<string> {
  const tags = new Set<string>();
  const program = asAstNode(ast.program);
  const body = Array.isArray(program?.body) ? program.body : [];

  for (const statement of body) {
    const declaration = asAstNode(statement);
    if (
      declaration?.type !== 'ImportDeclaration' ||
      getStringLiteralValue(declaration.source) !== 'react' ||
      !Array.isArray(declaration.specifiers)
    ) {
      continue;
    }

    for (const value of declaration.specifiers) {
      const specifier = asAstNode(value);
      const localName = getIdentifierName(specifier?.local);
      if (!specifier || !localName) {
        continue;
      }

      if (
        specifier.type === 'ImportSpecifier' &&
        getIdentifierName(specifier.imported) === 'Fragment'
      ) {
        tags.add(localName);
      } else if (
        specifier.type === 'ImportDefaultSpecifier' ||
        specifier.type === 'ImportNamespaceSpecifier'
      ) {
        tags.add(`${localName}.Fragment`);
      }
    }
  }

  return tags;
}

function getIdentifierName(value: unknown): string | undefined {
  const node = asAstNode(value);
  return node?.type === 'Identifier' && typeof node.name === 'string' ? node.name : undefined;
}

function getStringLiteralValue(value: unknown): string | undefined {
  const node = asAstNode(value);
  return node?.type === 'StringLiteral' && typeof node.value === 'string' ? node.value : undefined;
}

function hasPatchLensAttribute(node: AstNode): boolean {
  return (
    Array.isArray(node.attributes) &&
    node.attributes.some((attribute) => {
      const attributeNode = asAstNode(attribute);
      return (
        attributeNode?.type === 'JSXAttribute' &&
        getJsxName(asAstNode(attributeNode.name)) === 'data-patchlens-id'
      );
    })
  );
}

function getJsxName(node: AstNode | undefined): string | undefined {
  if (!node) {
    return undefined;
  }

  if (node.type === 'JSXIdentifier' && typeof node.name === 'string') {
    return node.name;
  }

  if (node.type === 'JSXMemberExpression') {
    const objectName = getJsxName(asAstNode(node.object));
    const propertyName = getJsxName(asAstNode(node.property));
    return objectName && propertyName ? `${objectName}.${propertyName}` : undefined;
  }

  if (node.type === 'JSXNamespacedName') {
    const namespace = getJsxName(asAstNode(node.namespace));
    const name = getJsxName(asAstNode(node.name));
    return namespace && name ? `${namespace}:${name}` : undefined;
  }

  return undefined;
}

function applyInsertions(code: string, insertions: Insertion[]): string {
  let output = code;
  for (const insertion of [...insertions].sort((left, right) => right.index - left.index)) {
    output = `${output.slice(0, insertion.index)}${insertion.text}${output.slice(insertion.index)}`;
  }
  return output;
}

function createPatchLensId(file: string, line: number, column: number, tagName: string): string {
  const digest = createHash('sha256')
    .update(`${file}:${line}:${column}:${tagName}`)
    .digest('hex')
    .slice(0, 12);
  return `pl_${digest}`;
}

function asAstNode(value: unknown): AstNode | undefined {
  if (!value || typeof value !== 'object' || !('type' in value)) {
    return undefined;
  }

  return typeof value.type === 'string' ? (value as AstNode) : undefined;
}

function stripQuery(id: string): string {
  return id.split('?', 1)[0] ?? id;
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}
