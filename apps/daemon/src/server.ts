import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { PATCHLENS_PROTOCOL_VERSION } from '@patchlens-ai/agent-protocol';
import type { CodingProvider, DaemonHealth } from '@patchlens-ai/agent-protocol';

import { DaemonApi } from './api.js';

export type DaemonServerOptions = {
  port?: number;
  allowedOrigins?: string[];
  token?: string;
  providers?: CodingProvider[];
};

export type DaemonServer = {
  readonly token: string;
  readonly server: Server;
  readonly api: DaemonApi;
  start(): Promise<AddressInfo>;
  stop(): Promise<void>;
};

const loopbackHost = '127.0.0.1';

export function createDaemonServer(options: DaemonServerOptions = {}): DaemonServer {
  const token = options.token ?? randomBytes(32).toString('hex');
  const allowedOrigins = new Set(options.allowedOrigins ?? ['http://127.0.0.1:4310']);
  const api = new DaemonApi({ providers: options.providers });
  const server = createServer((request, response) => {
    void handleRequest(request, response, token, allowedOrigins, api).catch(() => {
      if (response.headersSent) {
        response.end();
        return;
      }

      sendJson(response, 500, {
        error: 'daemon_request_failed',
        message: 'Daemon request failed',
      });
    });
  });

  return {
    token,
    server,
    api,
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port ?? 4312, loopbackHost, () => {
          server.off('error', reject);
          resolve(server.address() as AddressInfo);
        });
      });
    },
    stop() {
      return new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }

        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  allowedOrigins: ReadonlySet<string>,
  api: DaemonApi,
): Promise<void> {
  const origin = request.headers.origin;
  if (origin && !allowedOrigins.has(origin)) {
    sendJson(response, 403, { error: 'origin_not_allowed' });
    return;
  }

  if (origin) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
  }

  if (request.method === 'OPTIONS') {
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    response.statusCode = 204;
    response.end();
    return;
  }

  const requestUrl = new URL(request.url ?? '/', `http://${loopbackHost}`);
  if (request.method === 'GET' && requestUrl.pathname === '/health') {
    sendJson(response, 200, await createHealth(api));
    return;
  }

  if (!hasValidToken(request, token)) {
    sendJson(response, 401, { error: 'invalid_session_token' });
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/health') {
    sendJson(response, 200, await createHealth(api));
    return;
  }

  if (await api.handle(request, response, requestUrl)) {
    return;
  }

  sendJson(response, 404, { error: 'not_found' });
}

function hasValidToken(request: IncomingMessage, token: string): boolean {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) {
    return false;
  }

  const provided = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function createHealth(api: DaemonApi): Promise<DaemonHealth> {
  const providers = await api.sessions.detectProviders();
  return {
    ok: true,
    service: 'patchlens-daemon',
    version: '0.1.0',
    protocolVersion: PATCHLENS_PROTOCOL_VERSION,
    providers: providers.map(({ id, status }) => ({ id, status })),
  };
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(value));
}
