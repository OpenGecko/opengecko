import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import { HttpError } from '../src/http/errors';
import { parseHistoryDate, parseUnixTimestampSeconds } from '../src/modules/coins/helpers';
import historyDateFixtures from './fixtures/params-baseline/parse-history-date.json';
import timestampFixtures from './fixtures/params-baseline/parse-timestamp-seconds.json';
import searchShowMaxFixtures from './fixtures/params-baseline/search-show-max.json';

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn().mockResolvedValue([]),
  fetchExchangeTickers: vi.fn().mockResolvedValue([]),
  fetchExchangeOHLCV: vi.fn().mockResolvedValue([]),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx'].includes(value),
}));

function captureOutcome(action: () => number) {
  try {
    return { value: action() };
  } catch (error) {
    if (error instanceof HttpError) {
      return {
        error: {
          statusCode: error.statusCode,
          code: error.code,
          message: error.message,
        },
      };
    }

    throw error;
  }
}

describe('query parsing characterization fixtures', () => {
  let app: FastifyInstance | undefined;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-params-'));
    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'test.db'),
        logLevel: 'silent',
      },
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('preserves parseUnixTimestampSeconds fixture outcomes', () => {
    for (const fixture of timestampFixtures) {
      expect(captureOutcome(() => parseUnixTimestampSeconds(fixture.input, fixture.fieldName))).toEqual(fixture.outcome);
    }
  });

  it('preserves parseHistoryDate fixture outcomes', () => {
    for (const fixture of historyDateFixtures) {
      expect(captureOutcome(() => parseHistoryDate(fixture.input))).toEqual(fixture.outcome);
    }
  });

  it('preserves search show_max numeric parsing fixture outcomes', async () => {
    for (const fixture of searchShowMaxFixtures) {
      const response = await app!.inject({
        method: 'GET',
        url: `/search/trending?${fixture.queryString}`,
      });

      expect(response.statusCode).toBe(fixture.statusCode);
      if (fixture.statusCode === 200) {
        expect(response.json()).toMatchObject(fixture.body);
      } else {
        expect(response.json()).toEqual(fixture.body);
      }
    }
  });
});
