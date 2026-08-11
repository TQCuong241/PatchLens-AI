import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { URL } from 'node:url';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { verifyPublishedRelease } from './verify-published-release.mjs';

const releaseVersion = JSON.parse(
  await readFile(resolve(import.meta.dirname, '..', 'package.json'), 'utf8'),
).version;

describe('verifyPublishedRelease', () => {
  it('verifies every publishable package through registry metadata and tarballs', async () => {
    await withMockRegistry({}, async (registry, expectedCount) => {
      const result = await verifyPublishedRelease({
        registry,
        tag: 'next',
        timeoutMs: 1_000,
        pollMs: 10,
      });

      expect(result).toMatchObject({ ok: true, tag: 'next', version: releaseVersion });
      expect(expectedCount).toBe(17);
      expect(result.packages).toHaveLength(expectedCount);
      expect(result.packages.every((entry) => entry.attestations > 0)).toBe(true);
      expect(result.packages.every((entry) => entry.integrity === 'sha512')).toBe(true);
    });
  });

  it('rejects a package without provenance metadata', async () => {
    await withMockRegistry({ omitFirstProvenance: true }, async (registry) => {
      await expect(
        verifyPublishedRelease({
          registry,
          tag: 'next',
          timeoutMs: 1_000,
          pollMs: 10,
        }),
      ).rejects.toThrow(/provenance URL is required/);
    });
  });
});

async function withMockRegistry(options, assertion) {
  const records = await createPackageRecords();
  const firstPackage = [...records.keys()].sort()[0];
  const server = createServer((request, response) => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      response.writeHead(500).end();
      return;
    }
    const origin = `http://127.0.0.1:${address.port}`;
    const requestUrl = new URL(request.url, origin);

    if (requestUrl.pathname.startsWith('/tarballs/')) {
      const artifactName = decodeURIComponent(requestUrl.pathname.slice('/tarballs/'.length));
      const record = [...records.values()].find(
        (candidate) => candidate.artifactName === artifactName,
      );
      if (!record) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(record.tarball);
      return;
    }

    if (requestUrl.pathname.startsWith('/attestations/')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          attestations: [{ predicateType: 'https://slsa.dev/provenance/v1' }],
        }),
      );
      return;
    }

    const name = decodeURIComponent(requestUrl.pathname.slice(1));
    const record = records.get(name);
    if (!record) {
      response.writeHead(404).end();
      return;
    }
    const dist = {
      tarball: `${origin}/tarballs/${encodeURIComponent(record.artifactName)}`,
      integrity: record.integrity,
      shasum: record.shasum,
    };
    if (!options.omitFirstProvenance || name !== firstPackage) {
      dist.attestations = {
        url: `${origin}/attestations/${encodeURIComponent(name)}`,
      };
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        name,
        'dist-tags': { next: record.manifest.version },
        versions: {
          [record.manifest.version]: {
            ...record.manifest,
            dist,
          },
        },
      }),
    );
  });

  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Mock registry did not bind a TCP port');
    }
    await assertion(`http://127.0.0.1:${address.port}/`, records.size);
  } finally {
    await new Promise((resolvePromise, rejectPromise) =>
      server.close((error) => (error ? rejectPromise(error) : resolvePromise())),
    );
  }
}

async function createPackageRecords() {
  const records = new Map();
  for (const workspaceRoot of ['apps', 'packages', 'examples']) {
    for (const entry of await readdir(workspaceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      let manifest;
      try {
        manifest = JSON.parse(
          await readFile(resolve(workspaceRoot, entry.name, 'package.json'), 'utf8'),
        );
      } catch (error) {
        if (error?.code === 'ENOENT') {
          continue;
        }
        throw error;
      }
      if (manifest.private === true) {
        continue;
      }
      const publishedManifest = globalThis.structuredClone(manifest);
      for (const group of ['dependencies', 'optionalDependencies']) {
        for (const [name, range] of Object.entries(publishedManifest[group] ?? {})) {
          if (range === 'workspace:*') {
            publishedManifest[group][name] = manifest.version;
          }
        }
      }
      const tarball = createTarball(publishedManifest);
      records.set(manifest.name, {
        artifactName: `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`,
        manifest: publishedManifest,
        tarball,
        integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
        shasum: createHash('sha1').update(tarball).digest('hex'),
      });
    }
  }
  return records;
}

function createTarball(manifest) {
  return gzipSync(
    Buffer.concat([
      createTarEntry('package/package.json', `${JSON.stringify(manifest, null, 2)}\n`),
      createTarEntry('package/dist/index.js', 'export {};\n'),
      Buffer.alloc(1024),
    ]),
  );
}

function createTarEntry(name, content) {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  const padding = Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length);
  return Buffer.concat([header, body, padding]);
}
