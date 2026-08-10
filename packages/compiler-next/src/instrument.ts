import { Buffer } from 'node:buffer';

import { isSourceLocation } from '@patchlens-ai/agent-protocol';
import type { SourceLocation, SourceManifest } from '@patchlens-ai/agent-protocol';
import { instrumentSource, shouldInstrumentFile } from '@patchlens-ai/compiler-vite';

export const PATCHLENS_INLINE_SOURCE_ATTRIBUTE = 'data-patchlens-source';

export type NextRenderBoundary = NonNullable<SourceLocation['renderBoundary']>;

export type InstrumentNextSourceInput = {
  code: string;
  id: string;
  root: string;
  enabled?: boolean;
};

export type InstrumentNextSourceResult = {
  code: string;
  file: string;
  manifest: SourceManifest;
  changed: boolean;
  boundary: NextRenderBoundary;
};

export function instrumentNextSource(input: InstrumentNextSourceInput): InstrumentNextSourceResult {
  const boundary = detectNextRenderBoundary(input.code, input.id);
  if (input.enabled === false || !shouldInstrumentNextFile(input.id)) {
    return {
      code: input.code,
      file: normalizeFile(input.id, input.root),
      manifest: {},
      changed: false,
      boundary,
    };
  }

  const instrumented = instrumentSource(input);
  const manifest = Object.fromEntries(
    Object.entries(instrumented.manifest).map(([id, entry]) => [
      id,
      {
        ...entry,
        framework: 'next' as const,
        renderBoundary: boundary,
      },
    ]),
  );
  return {
    ...instrumented,
    manifest,
    code: instrumented.changed
      ? attachInlineSourceMetadata(instrumented.code, manifest)
      : instrumented.code,
    boundary,
  };
}

export function shouldInstrumentNextFile(id: string): boolean {
  const cleanId = id.split('?', 1)[0] ?? id;
  return shouldInstrumentFile(cleanId) && !isNextGeneratedFile(cleanId);
}

export function detectNextRenderBoundary(code: string, id: string): NextRenderBoundary {
  const directive = readModuleDirective(code);
  if (directive === 'use client') {
    return 'client';
  }
  if (directive === 'use server') {
    return 'server';
  }

  const normalized = id.replaceAll('\\', '/').split('?', 1)[0] ?? id;
  return /\/(?:src\/)?app\//.test(normalized) ? 'server' : 'shared';
}

export function encodeInlineSourceLocation(location: SourceLocation): string {
  return Buffer.from(JSON.stringify(location), 'utf8').toString('base64url');
}

export function decodeInlineSourceLocation(value: string): SourceLocation | undefined {
  if (!value || value.length > 4_096) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return isSourceLocation(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function attachInlineSourceMetadata(code: string, manifest: SourceManifest): string {
  let output = code;
  for (const [id, entry] of Object.entries(manifest)) {
    const marker = `data-patchlens-id='${id}'`;
    const replacement = `${marker} ${PATCHLENS_INLINE_SOURCE_ATTRIBUTE}='${encodeInlineSourceLocation(entry)}'`;
    output = output.replace(marker, replacement);
  }
  return output;
}

function readModuleDirective(code: string): 'use client' | 'use server' | undefined {
  const match = code.match(
    /^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*(['"])(use client|use server)\1\s*;?/,
  );
  return match?.[2] as 'use client' | 'use server' | undefined;
}

function isNextGeneratedFile(id: string): boolean {
  const normalized = id.replaceAll('\\', '/');
  return (
    normalized.includes('/.next/') ||
    normalized.includes('/next-env.d.ts') ||
    normalized.includes('/route.tsx') ||
    normalized.includes('/route.jsx')
  );
}

function normalizeFile(id: string, root: string): string {
  const cleanId = id.split('?', 1)[0] ?? id;
  const normalizedRoot = root.replaceAll('\\', '/').replace(/\/$/, '');
  const normalizedId = cleanId.replaceAll('\\', '/');
  return normalizedId.startsWith(`${normalizedRoot}/`)
    ? normalizedId.slice(normalizedRoot.length + 1)
    : normalizedId;
}
