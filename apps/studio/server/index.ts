import { timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export type StudioRuntimeConfiguration = {
  daemonUrl: string;
  daemonToken: string;
  projectRoot: string;
  previewUrl: string;
  provider: string;
  projectId: string;
};

export type StudioServerOptions = StudioRuntimeConfiguration & {
  accessToken: string;
  port?: number;
  assetsRoot?: string;
};

export type StudioServer = {
  readonly server: Server;
  start(): Promise<AddressInfo>;
  stop(): Promise<void>;
};

const loopbackHost = '127.0.0.1';
const runtimeConfigElementPattern =
  /(<script id=['"]patchlens-runtime-config['"] type=['"]application\/json['"]>)[\s\S]*?(<\/script>)/;

export function createStudioServer(options: StudioServerOptions): StudioServer {
  if (!options.accessToken) {
    throw new Error('Studio access token is required');
  }

  const assetsRoot = resolve(
    options.assetsRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist'),
  );
  const server = createServer((request, response) => {
    void handleRequest(request, response, assetsRoot, options).catch((error) => {
      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      }
      response.end(error instanceof Error ? error.message : 'Studio request failed');
    });
  });

  return {
    server,
    start() {
      return new Promise((resolveStart, rejectStart) => {
        server.once('error', rejectStart);
        server.listen(options.port ?? 4310, loopbackHost, () => {
          server.off('error', rejectStart);
          resolveStart(server.address() as AddressInfo);
        });
      });
    },
    stop() {
      return new Promise((resolveStop, rejectStop) => {
        if (!server.listening) {
          resolveStop();
          return;
        }
        server.close((error) => {
          if (error) {
            rejectStop(error);
            return;
          }
          resolveStop();
        });
      });
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  assetsRoot: string,
  options: StudioServerOptions,
): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.statusCode = 405;
    response.setHeader('Allow', 'GET, HEAD');
    response.end();
    return;
  }

  const requestUrl = new URL(request.url ?? '/', `http://${loopbackHost}`);
  if (requestUrl.pathname === '/' && hasValidQueryToken(requestUrl, options.accessToken)) {
    response.statusCode = 302;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Set-Cookie',
      `patchlens_studio=${encodeURIComponent(options.accessToken)}; HttpOnly; SameSite=Strict; Path=/`,
    );
    response.setHeader('Location', '/');
    response.end();
    return;
  }

  if (!hasValidCookie(request, options.accessToken)) {
    response.statusCode = 401;
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.end('Studio access token required');
    return;
  }

  const requestedPath = resolveAssetPath(assetsRoot, requestUrl.pathname);
  let assetPath = requestedPath;
  if (!(await isFile(assetPath))) {
    const acceptsHtml = request.headers.accept?.includes('text/html') ?? false;
    if (extname(requestUrl.pathname) || !acceptsHtml) {
      response.statusCode = 404;
      response.end();
      return;
    }
    assetPath = resolve(assetsRoot, 'index.html');
  }

  const extension = extname(assetPath).toLowerCase();
  let content = await readFile(assetPath);
  if (extension === '.html') {
    content = Buffer.from(injectRuntimeConfig(content.toString('utf8'), options));
    response.setHeader('Cache-Control', 'no-store');
  } else {
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
  response.statusCode = 200;
  response.setHeader('Content-Type', contentType(extension));
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'strict-origin');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; frame-src http://127.0.0.1:* http://localhost:*; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
  );
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  response.end(content);
}

function resolveAssetPath(assetsRoot: string, pathname: string): string {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    throw new Error('Invalid Studio asset path');
  }

  if (decodedPath.includes('\\')) {
    throw new Error('Invalid Studio asset path');
  }
  const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.slice(1);
  const target = resolve(assetsRoot, relativePath);
  const pathFromRoot = relative(assetsRoot, target);
  if (isAbsolute(pathFromRoot) || pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`)) {
    throw new Error('Studio asset path escapes root');
  }
  return target;
}

function injectRuntimeConfig(html: string, options: StudioServerOptions): string {
  const configuration: StudioRuntimeConfiguration = {
    daemonUrl: options.daemonUrl,
    daemonToken: options.daemonToken,
    projectRoot: options.projectRoot,
    previewUrl: options.previewUrl,
    provider: options.provider,
    projectId: options.projectId,
  };
  const serialized = JSON.stringify(configuration)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026');
  if (!runtimeConfigElementPattern.test(html)) {
    throw new Error('Studio runtime config marker is missing');
  }
  return html.replace(
    runtimeConfigElementPattern,
    (_match, start: string, end: string) => `${start}${serialized}${end}`,
  );
}

function hasValidQueryToken(requestUrl: URL, expected: string): boolean {
  return safeEqual(requestUrl.searchParams.get('token') ?? '', expected);
}

function hasValidCookie(request: IncomingMessage, expected: string): boolean {
  const cookie = request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('patchlens_studio='));
  if (!cookie) {
    return false;
  }

  try {
    return safeEqual(decodeURIComponent(cookie.slice('patchlens_studio='.length)), expected);
  } catch {
    return false;
  }
}

function safeEqual(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function contentType(extension: string): string {
  switch (extension) {
    case '.css':
      return 'text/css; charset=utf-8';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}
