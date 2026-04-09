import { describe, expect, it } from 'vitest';

import {
  createStartupProgressTracker,
  INITIAL_STARTUP_STEPS,
} from '../src/services/startup-progress';

describe('startup progress tracker', () => {
  it('prints the ascii logo and structured header on start() and logs progress sections', () => {
    const writes: string[] = [];
    const tracker = createStartupProgressTracker({
      isInteractive: false,
      write: (value: string) => {
        writes.push(value);
      },
    });

    tracker.start({ runtime: 'node', driver: 'better-sqlite3', databaseUrl: '/tmp/opengecko.db' });
    tracker.complete('load_config');
    tracker.begin('sync_exchange_metadata');
    tracker.reportExchangeResult('binance', 'ok');
    tracker.reportCatalogResult('cat_01', 'Coin Catalog', 3937, 373);
    tracker.finish(3000);

    const output = writes.join('');
    expect(output).toContain('░█▀█░█▀█░█▀▀░█▀█░█▀▀░█▀▀░█▀▀░█░█░█▀█');
    expect(output).toContain('System boot initialized');
    expect(output).toMatch(/\[20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\] INFO  System boot initialized/);
    expect(output).toContain('runtime: node | driver: better-sqlite3');
    expect(output).toContain('db: /tmp/opengecko.db');
    expect(output).toContain('PRE-FLIGHT CHECKS');
    expect(output).toContain('INITIAL DATA SYNCHRONIZATION');
    expect(output).toContain('CATALOG DISCOVERY');
    expect(output).toContain('Binance');
    expect(output).toContain('Coin Catalog');
    expect(output).toContain('http://localhost:3000');
  });

  it('renders completed steps with timing or ok markers', () => {
    const writes: string[] = [];
    const tracker = createStartupProgressTracker({
      isInteractive: false,
      write: (value: string) => {
        writes.push(value);
      },
    });

    tracker.start({ runtime: 'node', driver: 'better-sqlite3', databaseUrl: '/tmp/opengecko.db' });
    tracker.complete('connect_database');
    const output = writes.join('');
    expect(output).toContain('Initialize database');
    expect(output).toMatch(/\[(OK|\d+ms|\d+\.\ds)\]/);
  });

  it('exposes the canonical step order used by startup progress', () => {
    expect(INITIAL_STARTUP_STEPS.map((step: { id: string }) => step.id)).toEqual([
      'load_config',
      'connect_database',
      'sync_exchange_metadata',
      'sync_coin_catalog',
      'sync_chain_catalog',
      'build_market_snapshots',
      'start_ohlcv_worker',
      'seed_reference_data',
      'rebuild_search_index',
      'start_http_listener',
    ]);
  });

  it('renders failed steps with an explicit failure marker and message', () => {
    const writes: string[] = [];
    const tracker = createStartupProgressTracker({
      isInteractive: false,
      write: (value: string) => {
        writes.push(value);
      },
    });

    tracker.start({ runtime: 'node', driver: 'better-sqlite3', databaseUrl: '/tmp/opengecko.db' });
    tracker.complete('load_config');
    tracker.begin('connect_database');
    tracker.fail('connect_database', 'sqlite busy');

    const last = writes.at(-1) ?? '';

    expect(last).toContain('sqlite busy');
    expect(last).toContain('Initialize database');
  });

  it('can fail the active step without repeating the step id at call site', () => {
    const writes: string[] = [];
    const tracker = createStartupProgressTracker({
      isInteractive: false,
      write: (value: string) => {
        writes.push(value);
      },
    });

    tracker.start({ runtime: 'node', driver: 'better-sqlite3', databaseUrl: '/tmp/opengecko.db' });
    tracker.complete('load_config');
    tracker.begin('sync_coin_catalog');
    tracker.failCurrent('catalog fetch failed');

    const last = writes.at(-1) ?? '';

    expect(last).toContain('catalog fetch failed');
  });

  it('falls back to the listener step when failing before a step begins', () => {
    const writes: string[] = [];
    const tracker = createStartupProgressTracker({
      isInteractive: false,
      write: (value: string) => {
        writes.push(value);
      },
    });

    tracker.start({ runtime: 'node', driver: 'better-sqlite3', databaseUrl: '/tmp/opengecko.db' });
    tracker.failCurrent('boot failed before listener bind');

    const output = writes.join('');
    expect(output).toContain('Start HTTP listener');
    expect(output).toContain('boot failed before listener bind');
  });

  it('reports warnings and ohlcv progress updates', () => {
    const writes: string[] = [];
    const tracker = createStartupProgressTracker({
      isInteractive: false,
      write: (value: string) => {
        writes.push(value);
      },
    });

    tracker.start({ runtime: 'node', driver: 'better-sqlite3', databaseUrl: '/tmp/opengecko.db' });
    tracker.reportWarning('Using residual stale data while bootstrap is still running');
    tracker.updateOhlcvProgress(124, 386);

    const output = writes.join('');
    expect(output).toContain('Using residual stale data while bootstrap is still running');
    expect(output).toContain('124/386');
  });

  it('can emit informational in-progress status lines', () => {
    const writes: string[] = [];
    const tracker = createStartupProgressTracker({
      isInteractive: false,
      write: (value: string) => {
        writes.push(value);
      },
    });

    tracker.start({ runtime: 'node', driver: 'better-sqlite3', databaseUrl: '/tmp/opengecko.db' });
    tracker.reportStatus('Waiting for Fastify to bind the HTTP listener');

    expect(writes.join('')).toContain('Waiting for Fastify to bind the HTTP listener');
  });

  it('compacts verbose exchange failure messages', () => {
    const writes: string[] = [];
    const tracker = createStartupProgressTracker({
      isInteractive: false,
      write: (value: string) => {
        writes.push(value);
      },
    });

    tracker.start({ runtime: 'node', driver: 'better-sqlite3', databaseUrl: '/tmp/opengecko.db' });
    tracker.begin('sync_exchange_metadata');
    tracker.reportExchangeResult(
      'bybit',
      'failed',
      'bybit GET https://api.bybit.com/v5/market/instruments-info?category=spot 403 Forbidden The Amazon CloudFront distribution is configured to block access from your country.',
    );

    const output = writes.join('');
    expect(output).toContain('403 Forbidden: regional block');
    expect(output).not.toContain('CloudFront distribution is configured');
  });

  it('uses spinner frames for active steps in interactive mode', () => {
    const writes: string[] = [];
    const tracker = createStartupProgressTracker({
      isInteractive: true,
      write: (value: string) => {
        writes.push(value);
      },
    });

    tracker.start({ runtime: 'node', driver: 'better-sqlite3', databaseUrl: '/tmp/opengecko.db' });
    tracker.begin('build_market_snapshots');

    expect(writes.join('')).toContain('Refreshing market snapshots');
    expect(writes.join('')).toContain('\r');
  });
});
