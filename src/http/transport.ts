import { gzip, gzipSync } from 'node:zlib';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

type TransportOptions = {
  responseCompressionThresholdBytes: number;
};

const MAX_SYNC_GZIP_BYTES = 2 * 1024 * 1024;

function shouldCompress(request: FastifyRequest, reply: FastifyReply) {
  const acceptEncoding = request.headers['accept-encoding'];
  const contentType = reply.getHeader('content-type');

  return typeof acceptEncoding === 'string'
    && /\bgzip\b/.test(acceptEncoding)
    && typeof contentType === 'string'
    && contentType.includes('application/json')
    && !reply.hasHeader('content-encoding');
}

export function registerTransportControls(app: FastifyInstance, options: TransportOptions) {
  app.addHook('onSend', async (request, reply, payload) => {
    if (typeof payload !== 'string') {
      return payload;
    }

    if (!shouldCompress(request, reply)) {
      return payload;
    }

    const payloadBytes = Buffer.byteLength(payload);
    if (payloadBytes < options.responseCompressionThresholdBytes) {
      return payload;
    }

    const compressed = payloadBytes > MAX_SYNC_GZIP_BYTES
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
    reply.header('content-encoding', 'gzip');
    reply.header('vary', 'Accept-Encoding');
    reply.header('content-length', String(compressed.byteLength));
    return compressed;
  });
}
