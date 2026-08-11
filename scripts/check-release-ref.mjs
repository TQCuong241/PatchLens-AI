import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function verifyReleaseRef(input, runGit = runGitCommand) {
  const expectedVersion = assertNonEmpty(input.expectedVersion, 'expectedVersion');
  const refType = assertNonEmpty(input.refType, 'GITHUB_REF_TYPE');
  const refName = assertNonEmpty(input.refName, 'GITHUB_REF_NAME');
  const sha = assertNonEmpty(input.sha, 'GITHUB_SHA').toLowerCase();
  const expectedTag = `v${expectedVersion}`;

  if (refType !== 'tag') {
    throw new Error(`Release workflow must run from a tag, received ${refType}`);
  }
  if (refName !== expectedTag) {
    throw new Error(`Release tag ${refName} does not match package version ${expectedVersion}`);
  }
  if (!/^[a-f0-9]{40,64}$/.test(sha)) {
    throw new Error('GITHUB_SHA must be a full hexadecimal commit ID');
  }

  const tagRef = `refs/tags/${refName}`;
  const objectType = runGit(['cat-file', '-t', tagRef]);
  if (objectType !== 'tag') {
    throw new Error(`Release tag ${refName} must be annotated, received ${objectType}`);
  }
  const resolvedCommit = runGit(['rev-parse', `${tagRef}^{commit}`]).toLowerCase();
  if (resolvedCommit !== sha) {
    throw new Error(`Release tag ${refName} resolves to ${resolvedCommit}, expected ${sha}`);
  }

  return { ok: true, tag: refName, version: expectedVersion, commit: sha };
}

function runGitCommand(arguments_) {
  const result = spawnSync('git', arguments_, {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? (result.stderr.trim() || result.stdout.trim());
    throw new Error(`git ${arguments_.join(' ')} failed: ${detail}`, { cause: result.error });
  }
  return result.stdout.trim();
}

function assertNonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryUrl === import.meta.url) {
  const rootManifest = JSON.parse(
    await readFile(resolve(import.meta.dirname, '..', 'package.json')),
  );
  const result = verifyReleaseRef({
    expectedVersion: rootManifest.version,
    refType: process.env.GITHUB_REF_TYPE,
    refName: process.env.GITHUB_REF_NAME,
    sha: process.env.GITHUB_SHA,
  });
  console.log(JSON.stringify(result, null, 2));
}
