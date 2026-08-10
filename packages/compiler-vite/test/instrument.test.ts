import { describe, expect, it } from 'vitest';

import { instrumentSource, shouldInstrumentFile } from '../src/index.js';

const input = `
export function PricingCta() {
  return (
    <section>
      <button>Start now</button>
    </section>
  );
}
`;

describe('instrumentSource', () => {
  it('injects IDs and creates source manifest entries', () => {
    const result = instrumentSource({
      code: input,
      id: '/workspace/src/PricingCta.tsx',
      root: '/workspace',
    });

    expect(result.changed).toBe(true);
    expect(result.code.match(/data-patchlens-id=/g)).toHaveLength(2);
    expect(Object.values(result.manifest)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          componentName: 'PricingCta',
          file: 'src/PricingCta.tsx',
          tagName: 'button',
        }),
      ]),
    );
  });

  it('creates stable IDs for unchanged source locations', () => {
    const first = instrumentSource({
      code: input,
      id: '/workspace/src/PricingCta.tsx',
      root: '/workspace',
    });
    const second = instrumentSource({
      code: input,
      id: '/workspace/src/PricingCta.tsx',
      root: '/workspace',
    });

    expect(Object.keys(first.manifest)).toEqual(Object.keys(second.manifest));
  });

  it('keeps IDs unique across files and source locations', () => {
    const first = instrumentSource({
      code: input,
      id: '/workspace/src/PricingCta.tsx',
      root: '/workspace',
    });
    const second = instrumentSource({
      code: input,
      id: '/workspace/src/SecondaryCta.tsx',
      root: '/workspace',
    });
    const ids = [...Object.keys(first.manifest), ...Object.keys(second.manifest)];

    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not duplicate existing metadata', () => {
    const result = instrumentSource({
      code: `export const App = () => <main data-patchlens-id='manual'>Hi</main>;`,
      id: '/workspace/src/App.tsx',
      root: '/workspace',
    });

    expect(result.changed).toBe(false);
    expect(result.manifest).toEqual({});
  });

  it('does not attach metadata to React fragments', () => {
    const result = instrumentSource({
      code: `
import React, { Fragment, Fragment as AliasFragment } from 'react';

export function App() {
  return (
    <React.Fragment>
      <Fragment>
        <AliasFragment>
          <main>Hi</main>
        </AliasFragment>
      </Fragment>
    </React.Fragment>
  );
}
`,
      id: '/workspace/src/App.tsx',
      root: '/workspace',
    });

    expect(result.code).not.toMatch(/<React\.Fragment data-patchlens-id=/);
    expect(result.code).not.toMatch(/<Fragment data-patchlens-id=/);
    expect(result.code).not.toMatch(/<AliasFragment data-patchlens-id=/);
    expect(result.code.match(/data-patchlens-id=/g)).toHaveLength(1);
    expect(Object.values(result.manifest)).toEqual([expect.objectContaining({ tagName: 'main' })]);
  });
});

describe('shouldInstrumentFile', () => {
  it('accepts JSX and TSX outside node_modules', () => {
    expect(shouldInstrumentFile('/workspace/src/App.jsx')).toBe(true);
    expect(shouldInstrumentFile('/workspace/src/App.tsx?direct')).toBe(true);
  });

  it('rejects non-JSX and dependency files', () => {
    expect(shouldInstrumentFile('/workspace/src/app.ts')).toBe(false);
    expect(shouldInstrumentFile('/workspace/node_modules/pkg/index.tsx')).toBe(false);
  });
});
