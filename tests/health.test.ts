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

  it('keeps /ping and /health lightweight while validation diagnostics are degraded', async () => {
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
        port: 3102,
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();

      const degradedResponse = await app.inject({
        method: 'POST',
        url: '/diagnostics/runtime/degraded_state',
        payload: {
          mode: 'degraded_seeded_bootstrap',
          reason: 'health liveness degraded diagnostics test',
        },
      });

      expect(degradedResponse.statusCode).toBe(200);

      const providerFailureResponse = await app.inject({
        method: 'POST',
        url: '/diagnostics/runtime/provider_failure',
        payload: {
          active: true,
          reason: 'health liveness provider failure test',
        },
      });

      expect(providerFailureResponse.statusCode).toBe(200);

      const [pingResponse, healthResponse, diagnosticsResponse] = await Promise.all([
        app.inject({
          method: 'GET',
          url: '/ping',
        }),
        app.inject({
          method: 'GET',
          url: '/health',
        }),
        app.inject({
          method: 'GET',
          url: '/diagnostics/runtime',
        }),
      ]);

      expect(pingResponse.statusCode).toBe(200);
      expect(healthResponse.statusCode).toBe(200);
      expect(pingResponse.json()).toEqual(contractFixtures.ping);
      expect(healthResponse.json()).toEqual(contractFixtures.ping);
      expect(diagnosticsResponse.json().data.readiness).toMatchObject({
        state: 'degraded',
        degraded: true,
        validation_override_active: true,
      });
      expect(diagnosticsResponse.json().data.degraded.injected_provider_failure).toEqual({
        active: true,
        reason: 'health liveness provider failure test',
      });
    } finally {
      await app.close();
    }
  });
});
