import { describe, expect, it } from 'vitest';

import {
  PATCHLENS_INLINE_SOURCE_ATTRIBUTE,
  decodeInlineSourceLocation,
  detectNextRenderBoundary,
  instrumentNextSource,
  shouldInstrumentNextFile,
} from '../src/index.js';

const clientInput = `
'use client';

export function PricingCta() {
  return <button>Start now</button>;
}
`;

describe('instrumentNextSource', () => {
  it('adds Next client-boundary metadata inline', () => {
    const result = instrumentNextSource({
      code: clientInput,
      id: '/workspace/app/PricingCta.tsx',
      root: '/workspace',
    });
    const entry = Object.values(result.manifest)[0];
    const encoded = result.code.match(
      new RegExp(`${PATCHLENS_INLINE_SOURCE_ATTRIBUTE}='([^']+)'`),
    )?.[1];

    expect(result.changed).toBe(true);
    expect(result.boundary).toBe('client');
    expect(entry).toMatchObject({
      framework: 'next',
      renderBoundary: 'client',
      file: 'app/PricingCta.tsx',
    });
    expect(encoded).toBeTruthy();
    expect(decodeInlineSourceLocation(encoded!)).toEqual(entry);
  });

  it('classifies App Router components as server by default', () => {
    const result = instrumentNextSource({
      code: 'export default function Page() { return <main>Home</main>; }',
      id: '/workspace/src/app/page.tsx',
      root: '/workspace',
    });

    expect(result.boundary).toBe('server');
    expect(Object.values(result.manifest)[0]?.renderBoundary).toBe('server');
  });

  it('keeps Pages Router modules shared without a directive', () => {
    expect(
      detectNextRenderBoundary(
        'export default function Page() { return <main />; }',
        '/workspace/pages/index.tsx',
      ),
    ).toBe('shared');
  });

  it('does not instrument when disabled for production', () => {
    const result = instrumentNextSource({
      code: clientInput,
      id: '/workspace/app/PricingCta.tsx',
      root: '/workspace',
      enabled: false,
    });

    expect(result.changed).toBe(false);
    expect(result.code).not.toContain('data-patchlens-id');
    expect(result.code).not.toContain(PATCHLENS_INLINE_SOURCE_ATTRIBUTE);
  });
});

describe('shouldInstrumentNextFile', () => {
  it('accepts source JSX and rejects generated files', () => {
    expect(shouldInstrumentNextFile('/workspace/app/page.tsx')).toBe(true);
    expect(shouldInstrumentNextFile('/workspace/.next/server/app/page.tsx')).toBe(false);
    expect(shouldInstrumentNextFile('/workspace/node_modules/pkg/view.tsx')).toBe(false);
  });
});
