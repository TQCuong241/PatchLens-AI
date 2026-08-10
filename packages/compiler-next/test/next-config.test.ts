import { describe, expect, it } from 'vitest';

import patchLensNextLoader from '../src/loader.js';
import { withPatchLensNext } from '../src/next-config.js';

describe('patchLensNextLoader', () => {
  it('instruments development source', () => {
    const output = patchLensNextLoader.call(
      {
        mode: 'development',
        resourcePath: '/workspace/app/page.tsx',
        rootContext: '/workspace',
        getOptions: () => ({ enabled: true, root: '/workspace' }),
      },
      'export default function Page() { return <main>Home</main>; }',
    );

    expect(output).toContain('data-patchlens-id');
    expect(output).toContain('data-patchlens-source');
  });

  it('leaves production source untouched', () => {
    const source = 'export default function Page() { return <main>Home</main>; }';
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const output = patchLensNextLoader.call(
        {
          mode: 'production',
          resourcePath: '/workspace/app/page.tsx',
          rootContext: '/workspace',
        },
        source,
      );
      expect(output).toBe(source);
    } finally {
      if (previous === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previous;
      }
    }
  });
});

describe('withPatchLensNext', () => {
  it('merges Turbopack and webpack development rules', () => {
    const wrapped = withPatchLensNext(
      {
        turbopack: {
          rules: {
            '*.tsx': { loaders: ['existing-loader'], as: '*.js' },
          },
        },
      },
      { root: '/workspace' },
    );
    const turbopackRules = wrapped.turbopack?.rules?.['*.tsx'] as Array<{
      loaders: unknown[];
      as?: string;
      condition?: string;
    }>;
    const jsxRule = wrapped.turbopack?.rules?.['*.jsx'] as {
      loaders: unknown[];
      as?: string;
      condition?: string;
    };
    const webpackConfig = wrapped.webpack?.(
      { module: { rules: ['existing-rule'] } },
      { dev: true, dir: '/workspace' },
    );

    expect(turbopackRules).toHaveLength(2);
    expect(turbopackRules[0]).toMatchObject({ as: '*.js', loaders: ['existing-loader'] });
    expect(turbopackRules[1]).toMatchObject({ condition: 'development' });
    expect(jsxRule).toMatchObject({ condition: 'development' });
    expect(jsxRule).not.toHaveProperty('as');
    expect(webpackConfig?.module?.rules).toHaveLength(2);
  });

  it('does not add webpack instrumentation in production', () => {
    const wrapped = withPatchLensNext({});
    const webpackConfig = wrapped.webpack?.(
      { module: { rules: ['existing-rule'] } },
      { dev: false },
    );

    expect(webpackConfig?.module?.rules).toEqual(['existing-rule']);
  });
});
