import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';
import contractFixtures from './fixtures/contract-fixtures.json';

describe('health routes', () => {
  it('serves the CoinGecko-compatible ping response', async () => {
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
        url: '/ping',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(contractFixtures.ping);
    } finally {
      await app.close();
    }
  });

  it('serves /health with the same canonical liveness payload as /ping', async () => {
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      const [healthResponse, pingResponse] = await Promise.all([
        app.inject({
          method: 'GET',
          url: '/health',
        }),
        app.inject({
          method: 'GET',
          url: '/ping',
        }),
      ]);

      expect(healthResponse.statusCode).toBe(200);
      expect(healthResponse.json()).toEqual(contractFixtures.ping);
      expect(healthResponse.json()).toEqual(pingResponse.json());
    } finally {
      await app.close();
    }
  });
});
