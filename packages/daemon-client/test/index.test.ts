import { describe, expect, it } from 'vitest';

import { PATCHLENS_PROTOCOL_VERSION } from '@patchlens-ai/agent-protocol';
import type { AgentRequest } from '@patchlens-ai/agent-protocol';

import { DaemonClient } from '../src/index.js';

describe('DaemonClient', () => {
  it('validates daemon health responses', async () => {
    const client = new DaemonClient({
      baseUrl: 'http://127.0.0.1:4312',
      token: 'test-token',
      fetchImplementation: createFetch(
        new Response(
          JSON.stringify({
            ok: true,
            service: 'patchlens-daemon',
            version: '0.0.0',
            protocolVersion: PATCHLENS_PROTOCOL_VERSION,
            providers: [{ id: 'mock', status: 'available' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    });

    await expect(client.health()).resolves.toMatchObject({ ok: true });
  });

  it('binds the default fetch implementation to globalThis', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async function (this: unknown) {
      expect(this).toBe(globalThis);
      return new Response(
        JSON.stringify({
          ok: true,
          service: 'patchlens-daemon',
          version: '0.0.0',
          protocolVersion: PATCHLENS_PROTOCOL_VERSION,
          providers: [{ id: 'mock', status: 'available' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    } as typeof fetch;

    try {
      const client = new DaemonClient({
        baseUrl: 'http://127.0.0.1:4312',
        token: 'test-token',
      });

      await expect(client.health()).resolves.toMatchObject({ ok: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('validates active selection responses', async () => {
    const client = new DaemonClient({
      baseUrl: 'http://127.0.0.1:4312',
      token: 'test-token',
      fetchImplementation: async () =>
        new Response(JSON.stringify({ invalid: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    await expect(client.getSelection('project-1')).rejects.toThrow('invalid selection context');
  });

  it('uploads screenshot evidence and validates reference', async () => {
    const client = new DaemonClient({
      baseUrl: 'http://127.0.0.1:4312',
      token: 'test-token',
      fetchImplementation: createFetch(
        new Response(
          JSON.stringify({
            path: '.patchlens/captures/selection-1.png',
            mimeType: 'image/png',
            width: 10,
            height: 10,
            byteLength: 8,
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    });

    await expect(
      client.saveCapture('project-1', 'selection-1', {
        dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        mimeType: 'image/png',
        width: 10,
        height: 10,
        byteLength: 8,
      }),
    ).resolves.toMatchObject({ mimeType: 'image/png' });
  });

  it('loads authenticated screenshot evidence and validates bytes', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    const client = new DaemonClient({
      baseUrl: 'http://127.0.0.1:4312',
      token: 'test-token',
      fetchImplementation: (async (input, init) => {
        expect(String(input)).toContain('/captures/content?path=');
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-token');
        return new Response(png, {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      }) as typeof fetch,
    });

    const blob = await client.loadCapture('project-1', {
      path: '.patchlens/captures/selection-1.png',
      mimeType: 'image/png',
      width: 10,
      height: 10,
      byteLength: png.byteLength,
    });

    expect(blob.type).toBe('image/png');
    await expect(blob.arrayBuffer()).resolves.toEqual(png.buffer);
  });

  it('parses chunked SSE Agent events', async () => {
    const event = {
      schemaVersion: PATCHLENS_PROTOCOL_VERSION,
      type: 'complete',
      requestId: 'request-1',
      sessionId: 'session-1',
      sequence: 0,
      createdAt: '2026-08-09T12:00:00.000Z',
      payload: { transactionId: 'transaction-1', summary: 'Done' },
    };
    const encoded = new TextEncoder().encode(`event: complete\ndata: ${JSON.stringify(event)}\n\n`);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 20));
        controller.enqueue(encoded.slice(20));
        controller.close();
      },
    });
    const client = new DaemonClient({
      baseUrl: 'http://127.0.0.1:4312',
      token: 'test-token',
      fetchImplementation: createFetch(
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ),
    });

    const events = [];
    for await (const agentEvent of client.streamRequest({
      requestId: 'request-1',
      sessionId: 'session-1',
    } as AgentRequest)) {
      events.push(agentEvent);
    }

    expect(events).toEqual([event]);
  });

  it('rejects mismatched or non-contiguous SSE Agent events', async () => {
    const events = [
      {
        schemaVersion: PATCHLENS_PROTOCOL_VERSION,
        type: 'status',
        requestId: 'request-other',
        sessionId: 'session-1',
        sequence: 1,
        createdAt: '2026-08-10T12:00:00.000Z',
        payload: { status: 'running', message: 'Working' },
      },
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
          ),
        );
        controller.close();
      },
    });
    const client = new DaemonClient({
      baseUrl: 'http://127.0.0.1:4312',
      token: 'test-token',
      fetchImplementation: createFetch(
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ),
    });

    const consume = async () => {
      for await (const event of client.streamRequest({
        requestId: 'request-1',
        sessionId: 'session-1',
      } as AgentRequest)) {
        void event;
      }
    };

    await expect(consume()).rejects.toThrow('another request or session');
  });
});

function createFetch(response: Response): typeof fetch {
  return (async () => response) as typeof fetch;
}
