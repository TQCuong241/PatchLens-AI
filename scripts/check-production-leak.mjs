import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'dist');
const forbidden = [
  'data-patchlens-id',
  'data-patchlens-source',
  '@patchlens-ai/dev/runtime',
  'patchlensStudioOrigin',
];

if (!(await exists(root))) {
  throw new Error(`Production output does not exist: ${root}`);
}

for (const file of await collectFiles(root)) {
  if (!/\.(?:css|html|js|json|mjs|txt)$/.test(file)) {
    continue;
  }
  const content = await readFile(file, 'utf8');
  const match = forbidden.find((value) => content.includes(value));
  if (match) {
    throw new Error(`PatchLens production leak found in ${file}: ${match}`);
  }
}

async function collectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

async function exists(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
