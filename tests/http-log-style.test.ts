import { describe, expect, it } from 'vitest';

import { formatHttpCompactPLog } from '../src/http/http-log-style';

describe('http log style', () => {
  it('formats compact emoji logs with slow marker when threshold is exceeded', () => {
    const message = formatHttpCompactPLog({
      timestamp: new Date('2026-03-23T09:46:27.340Z'),
      method: 'GET',
      url: '/coins/markets?vs_currency=usd',
      statusCode: 200,
      durationMs: 7118.184,
      reqId: 'req-t',
      slowThresholdMs: 1000,
    });

    expect(message).toContain('GET /coins/markets?vs_currency=usd');
    expect(message).toContain('| 200 | ⏱ 7118ms | 🆔 req-t | 🐢SLOW');
    expect(message).toContain('🟢 GET /coins/markets?vs_currency=usd');
  });

  it('uses status traffic emoji based on response class', () => {
    const warningMessage = formatHttpCompactPLog({
      timestamp: new Date('2026-03-23T09:46:27.340Z'),
      method: 'GET',
      url: '/coins/not-a-coin',
      statusCode: 404,
      durationMs: 35,
      reqId: 'req-q',
      slowThresholdMs: 1000,
    });
    const errorMessage = formatHttpCompactPLog({
      timestamp: new Date('2026-03-23T09:46:27.340Z'),
      method: 'GET',
      url: '/boom',
      statusCode: 500,
      durationMs: 99,
      reqId: 'req-z',
      slowThresholdMs: 1000,
    });

    expect(warningMessage).toContain('🟥 GET /coins/not-a-coin | 404 |');
    expect(errorMessage).toContain('🚩 GET /boom | 500 |');
    expect(warningMessage).not.toContain('🐢SLOW');
  });
});
