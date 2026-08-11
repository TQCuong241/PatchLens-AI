import { describe, expect, it } from 'vitest';

import { verifyReleaseRef } from './check-release-ref.mjs';

const commit = 'a'.repeat(40);

describe('verifyReleaseRef', () => {
  it('accepts an annotated version tag resolving to the workflow commit', () => {
    const calls = [];
    const result = verifyReleaseRef(
      {
        expectedVersion: '1.2.3',
        refType: 'tag',
        refName: 'v1.2.3',
        sha: commit,
      },
      (arguments_) => {
        calls.push(arguments_);
        return arguments_[1] === '-t' ? 'tag' : commit;
      },
    );

    expect(result).toEqual({ ok: true, tag: 'v1.2.3', version: '1.2.3', commit });
    expect(calls).toEqual([
      ['cat-file', '-t', 'refs/tags/v1.2.3'],
      ['rev-parse', 'refs/tags/v1.2.3^{commit}'],
    ]);
  });

  it('rejects branch workflow dispatches', () => {
    expect(() =>
      verifyReleaseRef({
        expectedVersion: '1.2.3',
        refType: 'branch',
        refName: 'main',
        sha: commit,
      }),
    ).toThrow(/must run from a tag/);
  });

  it('rejects tags that do not match the package version', () => {
    expect(() =>
      verifyReleaseRef({
        expectedVersion: '1.2.3',
        refType: 'tag',
        refName: 'v0.2.0',
        sha: commit,
      }),
    ).toThrow(/does not match package version/);
  });

  it('rejects lightweight tags and commit mismatches', () => {
    expect(() =>
      verifyReleaseRef(
        {
          expectedVersion: '1.2.3',
          refType: 'tag',
          refName: 'v1.2.3',
          sha: commit,
        },
        () => 'commit',
      ),
    ).toThrow(/must be annotated/);

    expect(() =>
      verifyReleaseRef(
        {
          expectedVersion: '1.2.3',
          refType: 'tag',
          refName: 'v1.2.3',
          sha: commit,
        },
        (arguments_) =>
          arguments_[1] === '-t' ? 'tag' : 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      ),
    ).toThrow(/resolves to/);
  });
});
