import { defineConfig } from 'vitest/config';

const repositoryRoot = import.meta.dirname;
const workspaceDirectory = process.cwd().startsWith(repositoryRoot)
  ? process.cwd().slice(repositoryRoot.length).replaceAll('\\', '/').replace(/^\//, '')
  : '';
const workspaceTestPattern = /^(apps|examples|packages)\/[^/]+$/.test(workspaceDirectory)
  ? `${workspaceDirectory}/test/**/*.test.ts`
  : undefined;
const studioDomTestPattern = 'apps/studio/test/*.dom.test.ts';
const domWorkspaceDirectories = new Set([
  'apps/studio',
  'packages/dev',
  'packages/inspector-runtime',
]);
const nodeProject = {
  test: {
    name: 'node',
    environment: 'node',
    include: workspaceTestPattern
      ? [workspaceTestPattern]
      : ['apps/*/test/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'scripts/**/*.test.mjs'],
    exclude: [studioDomTestPattern, 'packages/dev/test/**', 'packages/inspector-runtime/test/**'],
  },
};
const domRuntimeProject = {
  test: {
    name: 'dom-runtime',
    environment: 'jsdom',
    include:
      workspaceDirectory === 'apps/studio'
        ? [studioDomTestPattern]
        : workspaceTestPattern
          ? [workspaceTestPattern]
          : [
              studioDomTestPattern,
              'packages/dev/test/**/*.test.ts',
              'packages/inspector-runtime/test/**/*.test.ts',
            ],
  },
};

export default defineConfig({
  root: repositoryRoot,
  test: {
    projects: domWorkspaceDirectories.has(workspaceDirectory)
      ? workspaceDirectory === 'apps/studio'
        ? [nodeProject, domRuntimeProject]
        : [domRuntimeProject]
      : workspaceTestPattern
        ? [nodeProject]
        : [nodeProject, domRuntimeProject],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: [
        'apps/*/src/**/*.ts',
        'apps/*/src/**/*.tsx',
        'apps/studio/server/**/*.ts',
        'packages/*/src/**/*.ts',
      ],
      thresholds: {
        statements: 68,
        branches: 60,
        functions: 74,
        lines: 69,
      },
    },
  },
});
