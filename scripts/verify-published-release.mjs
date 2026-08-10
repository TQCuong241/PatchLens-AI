import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL, URL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const workspaceRoots = ['apps', 'packages', 'examples'];
const expectedPublishablePackageNames = [
  '@patchlens-ai/agent-protocol',
  '@patchlens-ai/cli',
  '@patchlens-ai/compiler-next',
  '@patchlens-ai/compiler-vite',
  '@patchlens-ai/daemon',
  '@patchlens-ai/daemon-client',
  '@patchlens-ai/dev',
  '@patchlens-ai/inspector-runtime',
  '@patchlens-ai/mcp-server',
  '@patchlens-ai/patch-transaction',
  '@patchlens-ai/provider-claude',
  '@patchlens-ai/provider-codex',
  '@patchlens-ai/provider-mock',
  '@patchlens-ai/selection-engine',
  '@patchlens-ai/source-mapper',
  '@patchlens-ai/studio',
  '@patchlens-ai/visual-verifier',
];
const defaultRegistry = 'https://registry.npmjs.org/';
const defaultTag = 'next';
const defaultTimeoutMs = 300_000;
const defaultPollMs = 5_000;
const requestTimeoutMs = 30_000;
const maxTarballBytes = 25 * 1024 * 1024;

export async function verifyPublishedRelease(options = {}) {
  const registry = normalizeRegistryUrl(
    options.registry ?? process.env.PATCHLENS_NPM_REGISTRY ?? defaultRegistry,
  );
  const tag = assertNonEmpty(options.tag ?? process.env.PATCHLENS_NPM_TAG ?? defaultTag, 'tag');
  const timeoutMs = parsePositiveInteger(
    options.timeoutMs ?? process.env.PATCHLENS_VERIFY_TIMEOUT_MS ?? defaultTimeoutMs,
    'timeoutMs',
  );
  const pollMs = parsePositiveInteger(
    options.pollMs ?? process.env.PATCHLENS_VERIFY_POLL_MS ?? defaultPollMs,
    'pollMs',
  );
  const publishablePackages = await discoverPublishablePackages();
  const versions = new Set(publishablePackages.map(({ manifest }) => manifest.version));
  if (versions.size !== 1) {
    throw new Error(`Publishable packages do not share one version: ${[...versions].join(', ')}`);
  }
  const version = [...versions][0];
  const internalVersions = new Map(
    publishablePackages.map(({ manifest }) => [manifest.name, manifest.version]),
  );
  const packages = [];

  for (const entry of publishablePackages.sort((left, right) =>
    left.manifest.name.localeCompare(right.manifest.name),
  )) {
    packages.push(
      await verifyPackage(entry.manifest, {
        internalVersions,
        pollMs,
        registry,
        tag,
        timeoutMs,
      }),
    );
  }

  return {
    ok: true,
    registry: registry.href,
    tag,
    version,
    packages,
  };
}

async function discoverPublishablePackages() {
  const publishablePackages = [];
  for (const workspaceRoot of workspaceRoots) {
    for (const entry of await readdir(workspaceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const directory = `${workspaceRoot}/${entry.name}`;
      let manifestText;
      try {
        manifestText = await readFile(resolve(directory, 'package.json'), 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') {
          continue;
        }
        throw error;
      }
      const manifest = JSON.parse(manifestText);
      if (manifest.private !== true) {
        publishablePackages.push({ directory, manifest });
      }
    }
  }
  if (publishablePackages.length === 0) {
    throw new Error('No publishable PatchLens packages found');
  }
  assertExpectedPublishablePackages(publishablePackages);
  return publishablePackages;
}

function assertExpectedPublishablePackages(publishablePackages) {
  const packageNames = publishablePackages.map(({ manifest }) => manifest.name);
  const actualNames = new Set(packageNames);
  const duplicateNames = [...actualNames].filter(
    (name) => packageNames.filter((candidate) => candidate === name).length > 1,
  );
  const missingNames = expectedPublishablePackageNames.filter((name) => !actualNames.has(name));
  const unexpectedNames = [...actualNames].filter(
    (name) => !expectedPublishablePackageNames.includes(name),
  );
  if (duplicateNames.length > 0 || missingNames.length > 0 || unexpectedNames.length > 0) {
    throw new Error(
      `Publishable package set mismatch: ${[
        duplicateNames.length > 0 ? `duplicate ${duplicateNames.join(', ')}` : undefined,
        missingNames.length > 0 ? `missing ${missingNames.join(', ')}` : undefined,
        unexpectedNames.length > 0 ? `unexpected ${unexpectedNames.join(', ')}` : undefined,
      ]
        .filter(Boolean)
        .join('; ')}`,
    );
  }
}

async function verifyPackage(manifest, options) {
  const metadataUrl = new URL(encodeURIComponent(manifest.name), options.registry);
  const metadata = await fetchJsonWithRetry(
    metadataUrl,
    `${manifest.name} registry metadata`,
    options,
  );
  const taggedVersion = metadata['dist-tags']?.[options.tag];
  if (taggedVersion !== manifest.version) {
    throw new Error(
      `${manifest.name} dist-tag ${options.tag} is ${String(taggedVersion)}, expected ${manifest.version}`,
    );
  }
  const publishedManifest = metadata.versions?.[manifest.version];
  if (!publishedManifest) {
    throw new Error(`${manifest.name}@${manifest.version} is missing from registry metadata`);
  }
  if (publishedManifest.name !== manifest.name || publishedManifest.version !== manifest.version) {
    throw new Error(`${manifest.name}@${manifest.version} has mismatched registry identity`);
  }
  verifyInternalDependencies(publishedManifest, options.internalVersions);

  const tarballUrl = assertRemoteUrl(
    publishedManifest.dist?.tarball,
    `${manifest.name} tarball URL`,
  );
  const tarball = await fetchBufferWithRetry(tarballUrl, `${manifest.name} tarball`, options);
  if (tarball.length === 0 || tarball.length > maxTarballBytes) {
    throw new Error(
      `${manifest.name} tarball size ${tarball.length} is outside 1-${maxTarballBytes} bytes`,
    );
  }
  const integrityAlgorithm = verifyIntegrity(
    tarball,
    publishedManifest.dist?.integrity,
    manifest.name,
  );
  verifyShasum(tarball, publishedManifest.dist?.shasum, manifest.name);
  const tarEntries = readTarEntries(gunzipSync(tarball));
  const packedManifestEntry = tarEntries.get('package/package.json');
  if (!packedManifestEntry) {
    throw new Error(`${manifest.name} tarball does not contain package/package.json`);
  }
  const packedManifest = JSON.parse(packedManifestEntry.toString('utf8'));
  if (packedManifest.name !== manifest.name || packedManifest.version !== manifest.version) {
    throw new Error(`${manifest.name} tarball contains mismatched package identity`);
  }
  verifyInternalDependencies(packedManifest, options.internalVersions);
  const paths = [...tarEntries.keys()];
  if (!paths.some((path) => path.startsWith('package/dist/'))) {
    throw new Error(`${manifest.name} tarball does not contain built dist files`);
  }
  if (paths.some((path) => path.startsWith('package/src/') || path.startsWith('package/test/'))) {
    throw new Error(`${manifest.name} tarball leaks source or test files`);
  }

  const provenanceUrl = assertRemoteUrl(
    publishedManifest.dist?.attestations?.url,
    `${manifest.name} provenance URL`,
  );
  const provenance = await fetchJsonWithRetry(
    provenanceUrl,
    `${manifest.name} provenance`,
    options,
  );
  const attestationCount = countAttestations(provenance);
  if (attestationCount === 0) {
    throw new Error(`${manifest.name} provenance endpoint contains no attestations`);
  }

  return {
    package: manifest.name,
    version: manifest.version,
    tag: options.tag,
    bytes: tarball.length,
    files: paths.length,
    integrity: integrityAlgorithm,
    attestations: attestationCount,
    provenance: provenanceUrl.href,
  };
}

function verifyInternalDependencies(manifest, internalVersions) {
  for (const dependencyGroup of [manifest.dependencies, manifest.optionalDependencies]) {
    for (const [dependency, range] of Object.entries(dependencyGroup ?? {})) {
      if (!dependency.startsWith('@patchlens-ai/')) {
        continue;
      }
      const expectedVersion = internalVersions.get(dependency);
      if (!expectedVersion) {
        throw new Error(`${manifest.name} depends on unknown internal package ${dependency}`);
      }
      if (range !== expectedVersion) {
        throw new Error(
          `${manifest.name} dependency ${dependency} is ${range}, expected ${expectedVersion}`,
        );
      }
    }
  }
}

function verifyIntegrity(buffer, integrity, packageName) {
  const candidates = String(integrity ?? '')
    .trim()
    .split(/\s+/)
    .map((candidate) => candidate.split('?')[0])
    .map((candidate) => /^(sha512|sha384|sha256|sha1)-(.+)$/.exec(candidate))
    .filter(Boolean);
  for (const [, algorithm, expected] of candidates) {
    const actual = createHash(algorithm).update(buffer).digest('base64');
    if (actual === expected) {
      return algorithm;
    }
  }
  throw new Error(`${packageName} tarball does not match registry integrity`);
}

function verifyShasum(buffer, expected, packageName) {
  if (typeof expected !== 'string' || !/^[a-f0-9]{40}$/i.test(expected)) {
    throw new Error(`${packageName} registry shasum is missing or invalid`);
  }
  const actual = createHash('sha1').update(buffer).digest('hex');
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${packageName} tarball does not match registry shasum`);
  }
}

function countAttestations(value) {
  if (Array.isArray(value)) {
    return value.length;
  }
  if (Array.isArray(value?.attestations)) {
    return value.attestations.length;
  }
  return value && typeof value === 'object' && Object.keys(value).length > 0 ? 1 : 0;
}

async function fetchJsonWithRetry(url, label, options) {
  const response = await fetchWithRetry(url, label, options);
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`${label} did not return valid JSON`, { cause: error });
  }
}

async function fetchBufferWithRetry(url, label, options) {
  const response = await fetchWithRetry(url, label, options);
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxTarballBytes) {
    throw new Error(`${label} content-length ${contentLength} exceeds ${maxTarballBytes}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function fetchWithRetry(url, label, options) {
  const deadline = Date.now() + options.timeoutMs;
  let lastError;
  do {
    try {
      const response = await globalThis.fetch(url, {
        headers: { 'user-agent': 'PatchLens-release-verifier' },
        signal: globalThis.AbortSignal.timeout(Math.min(requestTimeoutMs, options.timeoutMs)),
      });
      if (response.ok) {
        return response;
      }
      const error = new Error(`${label} returned HTTP ${response.status}`);
      error.status = response.status;
      if (!isRetryableStatus(response.status)) {
        throw error;
      }
      lastError = error;
    } catch (error) {
      if (error?.status !== undefined && !isRetryableStatus(error.status)) {
        throw error;
      }
      lastError = error;
    }
    if (Date.now() + options.pollMs > deadline) {
      break;
    }
    await delay(options.pollMs);
  } while (Date.now() < deadline);
  throw new Error(`${label} was not available within ${options.timeoutMs}ms`, {
    cause: lastError,
  });
}

function isRetryableStatus(status) {
  return status === 404 || status === 408 || status === 429 || status >= 500;
}

function normalizeRegistryUrl(value) {
  const url = assertRemoteUrl(value, 'registry URL');
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) {
    url.pathname += '/';
  }
  return url;
}

function assertRemoteUrl(value, label) {
  const text = assertNonEmpty(value, label);
  let url;
  try {
    url = new URL(text);
  } catch (error) {
    throw new Error(`${label} must be an absolute URL`, { cause: error });
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not contain credentials`);
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`${label} must use HTTPS or loopback HTTP`);
  }
  return url;
}

function assertNonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function readTarEntries(buffer) {
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) {
      break;
    }
    const name = readTarText(header, 0, 100);
    const prefix = readTarText(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const sizeText = readTarText(header, 124, 12).trim();
    const size = Number.parseInt(sizeText || '0', 8);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`Invalid tar entry size for ${path}`);
    }
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > buffer.length) {
      throw new Error(`Truncated tar entry: ${path}`);
    }
    entries.set(path, buffer.subarray(contentStart, contentEnd));
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function readTarText(buffer, start, length) {
  const end = buffer.indexOf(0, start);
  const boundedEnd = end === -1 || end > start + length ? start + length : end;
  return buffer.subarray(start, boundedEnd).toString('utf8');
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === '--') {
      continue;
    }
    if (
      argument === '--tag' ||
      argument === '--registry' ||
      argument === '--timeout-ms' ||
      argument === '--poll-ms'
    ) {
      if (next === undefined) {
        throw new Error(`${argument} requires a value`);
      }
      const key =
        argument === '--timeout-ms'
          ? 'timeoutMs'
          : argument === '--poll-ms'
            ? 'pollMs'
            : argument.slice(2);
      options[key] = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryUrl === import.meta.url) {
  verifyPublishedRelease(parseArguments(process.argv.slice(2)))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
