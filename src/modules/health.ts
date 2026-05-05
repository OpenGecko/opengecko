import type { FastifyInstance } from 'fastify';

import { sendCacheableJson } from '../http/cache';

export function registerHealthRoutes(app: FastifyInstance) {
  const livenessPayload = () => ({
    gecko_says: '(V3) To the Moon!',
  });

  app.get('/ping', async (request, reply) => sendCacheableJson(
    request,
    reply,
    livenessPayload(),
    {
      maxAgeSeconds: 60,
      staleWhileRevalidateSeconds: 30,
    },
  ));
  app.get('/health', async (request, reply) => sendCacheableJson(
    request,
    reply,
    livenessPayload(),
    {
      maxAgeSeconds: 60,
      staleWhileRevalidateSeconds: 30,
    },
  ));
}
