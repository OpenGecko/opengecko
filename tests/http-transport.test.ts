import Fastify from 'fastify';
import * as zlib from 'node:zlib';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerTransportControls } from '../src/http/transport';

vi.mock('node:zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:zlib')>();

  return {
    ...actual,
    brotliCompress: vi.fn(actual.brotliCompress),
    brotliCompressSync: vi.fn(actual.brotliCompressSync),
    gzip: vi.fn(actual.gzip),
    gzipSync: vi.fn(actual.gzipSync),
  };
});

function buildTransportTestApp() {
  const app = Fastify({ logger: false });
  registerTransportControls(app, { responseCompressionThresholdBytes: 64 });

  app.get('/json', async () => ({
    data: 'x'.repeat(2048),
  }));

  app.get('/large-json', async () => ({
    data: 'x'.repeat(2 * 1024 * 1024 + 1),
  }));

  app.get('/small-json', async () => ({
    ok: true,
  }));

  app.get('/text', async (_request, reply) => {
    reply.type('text/plain');
    return 'x'.repeat(2048);
  });

  app.get('/pre-encoded', async (_request, reply) => {
    reply.type('application/json');
    reply.header('content-encoding', 'gzip');
    return JSON.stringify({ data: 'x'.repeat(2048) });
  });

  return app;
}

function decodePayload(payload: Buffer, encoding: string | undefined) {
  if (encoding === 'br') {
    return zlib.brotliDecompressSync(payload).toString('utf8');
  }

  if (encoding === 'gzip') {
    return zlib.gunzipSync(payload).toString('utf8');
  }

  return payload.toString('utf8');
}

describe('HTTP transport compression negotiation', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['gzip, br', 'br'],
    ['gzip', 'gzip'],
    ['br;q=0, gzip', 'gzip'],
    ['br;q=0, gzip;q=0', undefined],
    ['br;q=0.2, gzip;q=0.9', 'gzip'],
    ['br;q=0.9, gzip;q=0.2', 'br'],
    ['*', 'br'],
    ['*;q=0', undefined],
    ['gzip;q=1, *;q=0', 'gzip'],
    ['identity', undefined],
    ['identity;q=1, *;q=0', undefined],
    ['zstd, deflate', undefined],
    ['Br', 'br'],
    ['BR', 'br'],
    ['GZIP', 'gzip'],
    ['Br;Q=1', 'br'],
  ])('selects %s -> %s', async (acceptEncoding, expectedEncoding) => {
    const app = buildTransportTestApp();
    const baselineResponse = await app.inject({
      method: 'GET',
      url: '/json',
    });
    const response = await app.inject({
      method: 'GET',
      url: '/json',
      headers: {
        'accept-encoding': acceptEncoding,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-encoding']).toBe(expectedEncoding);

    if (expectedEncoding) {
      expect(String(response.headers.vary ?? '')).toContain('Accept-Encoding');
      expect(Number(response.headers['content-length'])).toBe(response.rawPayload.byteLength);
    }

    expect(JSON.parse(decodePayload(response.rawPayload, expectedEncoding))).toEqual(baselineResponse.json());
    await app.close();
  });

  it.each(['', ',,,', 'br;q=', 'br;q=NaN', 'gzip;q=2.0', ';;'])(
    'does not fail malformed Accept-Encoding value %j',
    async (acceptEncoding) => {
      const app = buildTransportTestApp();
      const response = await app.inject({
        method: 'GET',
        url: '/json',
        headers: {
          'accept-encoding': acceptEncoding,
        },
      });

      expect(response.statusCode).toBe(200);
      expect([undefined, 'br', 'gzip']).toContain(response.headers['content-encoding']);
      await app.close();
    },
  );

  it('bypasses compression for sub-threshold, non-JSON, missing header, and pre-encoded responses', async () => {
    const app = buildTransportTestApp();

    const [smallResponse, textResponse, missingHeaderResponse, preEncodedResponse] = await Promise.all([
      app.inject({
        method: 'GET',
        url: '/small-json',
        headers: { 'accept-encoding': 'br' },
      }),
      app.inject({
        method: 'GET',
        url: '/text',
        headers: { 'accept-encoding': 'br' },
      }),
      app.inject({
        method: 'GET',
        url: '/json',
      }),
      app.inject({
        method: 'GET',
        url: '/pre-encoded',
        headers: { 'accept-encoding': 'br' },
      }),
    ]);

    expect(smallResponse.headers['content-encoding']).toBeUndefined();
    expect(textResponse.headers['content-encoding']).toBeUndefined();
    expect(missingHeaderResponse.headers['content-encoding']).toBeUndefined();
    expect(preEncodedResponse.headers['content-encoding']).toBe('gzip');
    expect(preEncodedResponse.rawPayload.toString('utf8')).toBe(JSON.stringify({ data: 'x'.repeat(2048) }));
    await app.close();
  });

  it('preserves sync and async compression dispatch thresholds', async () => {
    const app = buildTransportTestApp();

    const smallBrotliResponse = await app.inject({
      method: 'GET',
      url: '/json',
      headers: { 'accept-encoding': 'br' },
    });
    expect(smallBrotliResponse.headers['content-encoding']).toBe('br');
    expect(zlib.brotliCompressSync).toHaveBeenCalledTimes(1);
    expect(zlib.brotliCompress).not.toHaveBeenCalled();

    vi.clearAllMocks();
    const largeBrotliResponse = await app.inject({
      method: 'GET',
      url: '/large-json',
      headers: { 'accept-encoding': 'br' },
    });
    expect(largeBrotliResponse.headers['content-encoding']).toBe('br');
    expect(zlib.brotliCompress).toHaveBeenCalledTimes(1);
    expect(zlib.brotliCompressSync).not.toHaveBeenCalled();

    vi.clearAllMocks();
    const smallGzipResponse = await app.inject({
      method: 'GET',
      url: '/json',
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(smallGzipResponse.headers['content-encoding']).toBe('gzip');
    expect(zlib.gzipSync).toHaveBeenCalledTimes(1);
    expect(zlib.gzip).not.toHaveBeenCalled();

    vi.clearAllMocks();
    const largeGzipResponse = await app.inject({
      method: 'GET',
      url: '/large-json',
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(largeGzipResponse.headers['content-encoding']).toBe('gzip');
    expect(zlib.gzip).toHaveBeenCalledTimes(1);
    expect(zlib.gzipSync).not.toHaveBeenCalled();

    expect(JSON.parse(decodePayload(smallBrotliResponse.rawPayload, 'br')).data).toHaveLength(2048);
    expect(JSON.parse(decodePayload(largeBrotliResponse.rawPayload, 'br')).data).toHaveLength(2 * 1024 * 1024 + 1);
    expect(JSON.parse(decodePayload(smallGzipResponse.rawPayload, 'gzip')).data).toHaveLength(2048);
    expect(JSON.parse(decodePayload(largeGzipResponse.rawPayload, 'gzip')).data).toHaveLength(2 * 1024 * 1024 + 1);
    await app.close();
  });

  it('does not leave partially-mutated headers when compression fails', async () => {
    const brotliCompressSync = vi.mocked(zlib.brotliCompressSync);
    brotliCompressSync.mockImplementationOnce(() => {
      throw new Error('native brotli failure\n    at node_modules/brotli/index.js:1:1');
    });
    const app = buildTransportTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/json',
      headers: { 'accept-encoding': 'br' },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(['br', undefined]).toContain(response.headers['content-encoding']);

    const body = decodePayload(response.rawPayload, response.headers['content-encoding'] as string | undefined);
    expect(body).not.toContain('node_modules');
    await app.close();
  });
});
