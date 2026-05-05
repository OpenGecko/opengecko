import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readRepoFile(path: string) {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('documentation drift guards', () => {
  it('keeps the improvement guide route-coverage claim aligned with the compatibility audit', () => {
    const guide = readRepoFile('docs/plans/2026-05-05-opengecko-improvement-guide.md');
    const audit = readRepoFile('docs/status/compatibility-audit.md');

    const guideCoverage = guide.match(/(\d+)\s*\/\s*(\d+) active non-NFT CoinGecko-compatible routes/);
    const auditCoverage = audit.match(/Active non-NFT parity:\s*(\d+)\s*\/\s*(\d+)/);

    expect(guideCoverage?.slice(1, 3)).toEqual(auditCoverage?.slice(1, 3));
  });

  it('keeps live-data and fixture claims explicit across guide and tracker docs', () => {
    const guide = readRepoFile('docs/plans/2026-05-05-opengecko-improvement-guide.md');
    const tracker = readRepoFile('docs/status/implementation-tracker.md');

    expect(tracker).toMatch(/\bLive\b\**\s*\(~55%\)/);
    expect(guide).toContain('Live data coverage');
    expect(guide).toContain('fixture-backed');

    for (const fixtureSurface of ['derivatives', 'treasury', 'onchain analytics', 'supply charts']) {
      expect(guide).toContain(fixtureSurface);
    }
  });

  it('keeps release-readiness gate claims aligned with actual CI and coverage config', () => {
    const guide = readRepoFile('docs/plans/2026-05-05-opengecko-improvement-guide.md');
    const workflow = readRepoFile('.github/workflows/test.yml');
    const packageJson = readRepoFile('package.json');
    const vitestConfig = readRepoFile('vitest.config.ts');

    for (const command of [
      'bun run lint',
      'bun run typecheck',
      'bun run build',
      'bun run test:coverage',
      'docker build -t opengecko-test .',
    ]) {
      expect(workflow).toContain(command);
      expect(guide).toContain(command);
    }

    expect(packageJson).toContain('"test:coverage": "vitest run --coverage"');
    expect(packageJson).toContain('"@vitest/coverage-v8"');
    expect(vitestConfig).toContain('statements: 90');
    expect(vitestConfig).toContain('branches: 82');
    expect(vitestConfig).toContain('functions: 92');
    expect(vitestConfig).toContain('lines: 90');
    expect(vitestConfig).not.toContain('statements: 0');
    expect(guide).toContain('coverage-backed tests');
  });

  it('keeps the optional provider operator guide aligned with config, commands, and diagnostics routes', () => {
    const readme = readRepoFile('README.md');
    const envConfig = readRepoFile('src/config/env.ts');
    const packageJson = readRepoFile('package.json');
    const diagnosticsRoutes = readRepoFile('src/modules/diagnostics.ts');

    for (const envVar of [
      'COIN_HISTORY_TARGETS',
      'COIN_HISTORY_BASE_URL',
      'EXCHANGE_VOLUME_TARGETS',
      'EXCHANGE_VOLUME_BASE_URL',
      'MARKET_CHART_TARGETS',
      'MARKET_CHART_BASE_URL',
      'ONCHAIN_ANALYTICS_TARGETS',
      'ONCHAIN_ANALYTICS_BASE_URL',
      'ONCHAIN_TRADE_TARGETS',
      'ONCHAIN_TRADE_BASE_URL',
      'SUPPLY_CHART_TARGETS',
      'SUPPLY_CHART_BASE_URL',
      'OPTIONAL_PROVIDER_SYNC_ENABLED',
      'OPTIONAL_PROVIDER_SYNC_INTERVAL_SECONDS',
    ]) {
      expect(readme).toContain(envVar);
    }

    for (const configuredEnvVar of [
      'COIN_HISTORY_TARGETS',
      'EXCHANGE_VOLUME_TARGETS',
      'MARKET_CHART_TARGETS',
      'ONCHAIN_ANALYTICS_TARGETS',
      'ONCHAIN_TRADE_TARGETS',
      'SUPPLY_CHART_TARGETS',
      'OPTIONAL_PROVIDER_SYNC_ENABLED',
      'OPTIONAL_PROVIDER_SYNC_INTERVAL_SECONDS',
    ]) {
      expect(envConfig).toContain(configuredEnvVar);
    }

    for (const command of [
      'bun run coin:history:sync',
      'bun run exchange:volumes:sync',
      'bun run market:charts:sync',
      'bun run onchain:analytics:sync',
      'bun run onchain:trades:sync',
      'bun run supply:charts:sync',
    ]) {
      expect(readme).toContain(command);
      expect(packageJson).toContain(command.replace('bun run ', ''));
    }

    for (const route of [
      '/diagnostics/jobs',
      '/diagnostics/market_charts',
      '/diagnostics/coin_history',
      '/diagnostics/exchange_volumes',
      '/diagnostics/onchain_analytics',
      '/diagnostics/onchain_trades',
      '/diagnostics/supply_charts',
    ]) {
      expect(readme).toContain(route);
      expect(diagnosticsRoutes).toContain(route);
    }
  });
});
