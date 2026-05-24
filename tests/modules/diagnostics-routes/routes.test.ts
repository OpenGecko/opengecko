import { describe, expect, it } from 'vitest';

import { buildApp } from '../../../src/app';

describe('API route inventory', () => {
  it('lists the endpoints OpenGecko provides', async () => {
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/apis',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      const routes = body.data.routes as Array<{ method: string; path: string }>;
      const routeCount = body.data.route_count;

      expect(body).toMatchObject({
        data: {
          schema_version: 1,
          generated_at: expect.any(String),
          route_count: expect.any(Number),
          methods: expect.arrayContaining(['GET']),
          routes: expect.arrayContaining([
            expect.objectContaining({
              method: 'GET',
              path: '/apis',
              family: 'apis',
              scope: 'opengecko_operational',
            }),
            expect.objectContaining({
              method: 'GET',
              path: '/simple/price',
              family: 'simple',
              scope: 'coingecko_compatible',
            }),
            expect.objectContaining({
              method: 'GET',
              path: '/coins/:id',
              family: 'coins',
              scope: 'coingecko_compatible',
            }),
            expect.objectContaining({
              method: 'GET',
              path: '/metrics',
              family: 'metrics',
              scope: 'opengecko_operational',
            }),
          ]),
        },
      });

      expect(routeCount).toBe(routes.length);
      expect(new Set(routes.map((route) => `${route.method} ${route.path}`)).size).toBe(routes.length);
    } finally {
      await app.close();
    }
  });
});
