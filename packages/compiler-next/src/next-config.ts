import { fileURLToPath } from 'node:url';

export type PatchLensNextOptions = {
  enabled?: boolean;
  root?: string;
};

export type NextConfigLike = {
  turbopack?: {
    rules?: Record<string, unknown>;
    [key: string]: unknown;
  };
  webpack?: (
    config: WebpackConfigLike,
    context: WebpackContextLike,
  ) => WebpackConfigLike | undefined;
  [key: string]: unknown;
};

type WebpackConfigLike = {
  module?: {
    rules?: unknown[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type WebpackContextLike = {
  dev: boolean;
  dir?: string;
  [key: string]: unknown;
};

export function withPatchLensNext<Config extends NextConfigLike>(
  config: Config,
  options: PatchLensNextOptions = {},
): Config {
  const loader = fileURLToPath(new URL('./loader.js', import.meta.url));
  const root = options.root ?? process.cwd();
  const loaderEntry = {
    loader,
    options: { enabled: options.enabled ?? true, root },
  };
  const existingRules = config.turbopack?.rules ?? {};
  const webpack = config.webpack;

  return {
    ...config,
    turbopack: {
      ...config.turbopack,
      rules: {
        ...existingRules,
        '*.jsx': mergeTurbopackRule(existingRules['*.jsx'], loaderEntry),
        '*.tsx': mergeTurbopackRule(existingRules['*.tsx'], loaderEntry),
      },
    },
    webpack(nextConfig, context) {
      const configured = webpack?.(nextConfig, context) ?? nextConfig;
      if (!context.dev || options.enabled === false) {
        return configured;
      }
      const module = configured.module ?? {};
      const rules = module.rules ?? [];
      return {
        ...configured,
        module: {
          ...module,
          rules: [
            {
              test: /\.[jt]sx$/,
              exclude: /node_modules/,
              use: [
                {
                  loader,
                  options: {
                    enabled: true,
                    root: options.root ?? context.dir ?? root,
                  },
                },
              ],
            },
            ...rules,
          ],
        },
      };
    },
  } as Config;
}

function mergeTurbopackRule(
  existing: unknown,
  loader: { loader: string; options: Record<string, unknown> },
): unknown {
  const patchLensRule = { loaders: [loader], condition: 'development' };
  if (Array.isArray(existing)) {
    return [...existing, patchLensRule];
  }
  return isRecord(existing) ? [existing, patchLensRule] : patchLensRule;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
