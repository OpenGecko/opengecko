import type { FastifyInstance } from 'fastify';

import { sendCacheableJson } from '../http/cache';
import { buildRouteInventoryDiagnostics } from '../services/route-inventory';

export function registerApiInventoryRoutes(app: FastifyInstance) {
  app.get('/apis', async (request, reply) => {
    return sendCacheableJson(request, reply, {
      data: buildRouteInventoryDiagnostics(app.routeInventory),
    }, {
      maxAgeSeconds: 60,
      staleWhileRevalidateSeconds: 60,
    });
  });
}
