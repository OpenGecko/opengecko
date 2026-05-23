import { brotliCompress, brotliCompressSync, gzip, gzipSync } from 'node:zlib';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { selectAcceptedContentEncoding, type SupportedContentEncoding } from './accept-encoding';

type TransportOptions = {
  responseCompressionThresholdBytes: number;
};

const MAX_SYNC_COMPRESSION_BYTES = 2 * 1024 * 1024;

function getAcceptedContentEncoding(request: FastifyRequest, reply: FastifyReply): SupportedContentEncoding | null {
  const acceptEncoding = request.headers['accept-encoding'];
  const contentType = reply.getHeader('content-type');

  if (
    typeof acceptEncoding !== 'string'
    || typeof contentType !== 'string'
    || !contentType.includes('application/json')
    || reply.hasHeader('content-encoding')
  ) {
    return null;
  }

  return selectAcceptedContentEncoding(acceptEncoding);
}

async function compressPayload(payload: string, payloadBytes: number, encoding: SupportedContentEncoding) {
  if (encoding === 'br') {
    return payloadBytes > MAX_SYNC_COMPRESSION_BYTES
      ? await new Promise<Buffer>((resolve, reject) => {
          brotliCompress(payload, (error, result) => {
            if (error) {
              reject(error);
              return;
            }

            resolve(result);
          });
        })
      : brotliCompressSync(payload);
  }

  return payloadBytes > MAX_SYNC_COMPRESSION_BYTES
    ? await new Promise<Buffer>((resolve, reject) => {
        gzip(payload, (error, result) => {
          if (error) {
            reject(error);
            return;
          }

          resolve(result);
        });
      })
    : gzipSync(payload);
}

export function registerTransportControls(app: FastifyInstance, options: TransportOptions) {
  app.addHook('onSend', async (request, reply, payload) => {
    if (typeof payload !== 'string') {
      return payload;
    }

    const encoding = getAcceptedContentEncoding(request, reply);
    if (!encoding) {
      return payload;
    }

    const payloadBytes = Buffer.byteLength(payload);
    if (payloadBytes < options.responseCompressionThresholdBytes) {
      return payload;
    }

    let compressed: Buffer;
    try {
      compressed = await compressPayload(payload, payloadBytes, encoding);
    } catch {
      throw new Error('Response compression failed');
    }

    reply.header('content-encoding', encoding);
    reply.header('vary', 'Accept-Encoding');
    reply.header('content-length', String(compressed.byteLength));
    return compressed;
  });
}
