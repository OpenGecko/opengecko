import { describe, expect, it } from 'vitest';

import { HttpError } from '../../src/http/errors';
import {
  parseBooleanQuery,
  parseCsvQuery,
  parseFiniteNumber,
  parseNonNegativeInt,
  parsePositiveInt,
  parsePrecision,
  parseTimestampSeconds,
} from '../../src/http/params';

function expectHttpError(
  action: () => unknown,
  expected: { statusCode: number; code: string; message: string },
) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject(expected);
    return;
  }

  throw new Error('Expected HttpError to be thrown.');
}

describe('HTTP query parameter helpers', () => {
  it('preserves boolean, CSV, positive integer, and precision helper contracts', () => {
    expect(parseBooleanQuery(undefined)).toBe(false);
    expect(parseBooleanQuery(undefined, true)).toBe(true);
    expect(parseBooleanQuery('true')).toBe(true);
    expect(parseBooleanQuery('false')).toBe(false);
    expectHttpError(() => parseBooleanQuery('yes'), {
      statusCode: 400,
      code: 'invalid_parameter',
      message: 'Invalid boolean query value: yes',
    });

    expect(parseCsvQuery('Bitcoin, ETHEREUM ,, bitcoin')).toEqual(['bitcoin', 'ethereum', 'bitcoin']);
    expect(parseCsvQuery(' , , ')).toEqual([]);
    expect(parseCsvQuery(undefined)).toEqual([]);

    expect(parsePositiveInt(undefined, 7)).toBe(7);
    expect(parsePositiveInt('42', 7)).toBe(42);
    for (const value of ['0', '-1', '1.5', '1e2', 'NaN', '']) {
      expectHttpError(() => parsePositiveInt(value, 7), {
        statusCode: 400,
        code: 'invalid_parameter',
        message: `Invalid integer value: ${value}`,
      });
    }

    for (const value of ['0', '1', '9', '18'] as const) {
      expect(parsePrecision(value)).toBe(Number(value));
    }
    expect(parsePrecision(undefined)).toBe('full');
    expect(parsePrecision('full')).toBe('full');
    for (const value of ['-1', '19', '1.5', 'NaN', '', 'FULL', 'partial']) {
      expectHttpError(() => parsePrecision(value), {
        statusCode: 400,
        code: 'invalid_parameter',
        message: `Invalid precision value: ${value}`,
      });
    }
  });

  it('parses non-negative integers with default and invalid-parameter semantics', () => {
    expect(parseNonNegativeInt(undefined, 3)).toBe(3);
    expect(parseNonNegativeInt('0', 3)).toBe(0);
    expect(parseNonNegativeInt('42', 3)).toBe(42);

    for (const value of ['-1', '1.5', '1e2', 'NaN', '', '   ']) {
      expectHttpError(() => parseNonNegativeInt(value, 3, 'limit'), {
        statusCode: 400,
        code: 'invalid_parameter',
        message: `Invalid limit value: ${value}`,
      });
    }
  });

  it('parses finite numbers with default and invalid-parameter semantics', () => {
    expect(parseFiniteNumber(undefined, 1.25)).toBe(1.25);
    expect(parseFiniteNumber('0', null, 'threshold')).toBe(0);
    expect(parseFiniteNumber('1.5', null, 'threshold')).toBe(1.5);
    expect(parseFiniteNumber('-2.5', null, 'threshold')).toBe(-2.5);
    expect(parseFiniteNumber('1e3', null, 'threshold')).toBe(1000);
    expect(parseFiniteNumber('1.2e-1', null, 'threshold')).toBe(0.12);
    expect(parseFiniteNumber(' 1 ', null, 'threshold')).toBe(1);

    for (const value of ['NaN', 'Infinity', '-Infinity', '', '   ', 'abc']) {
      expectHttpError(() => parseFiniteNumber(value, null, 'threshold'), {
        statusCode: 400,
        code: 'invalid_parameter',
        message: `Invalid threshold value: ${value}`,
      });
    }
  });

  it('parses timestamp seconds with default and invalid-parameter semantics', () => {
    expect(parseTimestampSeconds(undefined, 'before_timestamp', 123)).toBe(123);
    expect(parseTimestampSeconds('1', 'before_timestamp')).toBe(1);
    expect(parseTimestampSeconds('1773446400', 'from')).toBe(1773446400);

    for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', '', '   ']) {
      expectHttpError(() => parseTimestampSeconds(value, 'before_timestamp'), {
        statusCode: 400,
        code: 'invalid_parameter',
        message: `Invalid before_timestamp value: ${value}`,
      });
    }
  });
});
