import { describe, expect, it } from 'vitest';

import { SourceMapper } from '../src/index.js';

const entry = {
  id: 'pl_abc123',
  framework: 'react' as const,
  componentName: 'PricingCta',
  file: 'src/components/PricingCta.tsx',
  line: 42,
  column: 8,
  tagName: 'button',
};

describe('SourceMapper', () => {
  it('resolves manifest entries without exposing internal state', () => {
    const mapper = new SourceMapper({ [entry.id]: entry });
    const resolved = mapper.resolve(entry.id);

    expect(resolved).toEqual(entry);
    expect(resolved).not.toBe(entry);
  });

  it('deduplicates resolveAll results', () => {
    const mapper = new SourceMapper({ [entry.id]: entry });

    expect(mapper.resolveAll([entry.id, entry.id])).toEqual([entry]);
  });

  it('rejects a mismatched manifest key', () => {
    expect(() => new SourceMapper({ wrong: entry })).toThrow(
      'Manifest key wrong does not match entry ID pl_abc123',
    );
  });
});
