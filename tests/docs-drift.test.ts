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
    const marketChartPresets = readRepoFile('docs/reference/market-chart-provider-presets.json');

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

    expect(readme).toContain('docs/reference/market-chart-provider-presets.json');
    expect(marketChartPresets).toContain('MARKET_CHART_BASE_URL');
    expect(marketChartPresets).toContain('MARKET_CHART_TARGETS');
    expect(marketChartPresets).toContain('/providers/{provider}/coins/{coin_id}/market_chart');
    expect(marketChartPresets).toContain(
      'tests/fixtures/provider-replay/market-charts/ccxt-binance-bitcoin-adapter-response.json',
    );
    expect(marketChartPresets).toContain(
      'tests/fixtures/provider-replay/market-charts/intraday-archive-ethereum-adapter-response.json',
    );

    const marketChartExample = readme.match(
      /\*\*Market chart preset example:\*\*([\s\S]*?)## Migrating from CoinGecko/,
    )?.[1];

    expect(marketChartExample).toBeDefined();
    for (const expectedExampleDetail of [
      'MARKET_CHART_BASE_URL',
      'MARKET_CHART_TARGETS',
      'ccxt.binance=bitcoin:1d:usd',
      'bun run market:charts:sync',
      '/diagnostics/market_charts',
      '"summary"',
      'source_backed_configured_targets',
      'status_counts',
      'freshness_counts',
      'depth_counts',
      'response_source_counts',
      'response_source_recent_events',
      'response_source_recent_event_rollups',
      'response_source_target_suggestion_window',
      'response_source_target_suggestion_summary',
      'response_source_target_suggestion_exclusions',
      'response_source_target_suggestions',
      'market_chart_days',
      'ohlc_range',
      'source_backed',
      'canonical',
      'provider_filled',
      'empty',
      'durable counters',
      'survive process restarts',
      'diagnostics-only',
      '50 most recent',
      'sanitized route, coin, currency, interval, and days/range request context',
      'groups fallback pressure by route and by coin',
      'prioritize source-backed target expansion',
      'UTC-day-bucketed seven-day cutoff used for suggestions',
      'stale fallback events were ignored',
      'reconciles the suggestion pipeline',
      'source_backed_events_suppressed',
      'events_eligible_for_suggestion',
      'unique_eligible_targets',
      'suggestions_returned',
      'suggestions_limit',
      'stale_events',
      'source_backed_events',
      'capped sanitized examples of stale ignored events and source-backed suppressed events',
      'old fallback pressure from already-solved targets',
      'sample_requests',
      'up to three sanitized `sample_requests`',
      'sorted by newest observed fallback event',
      'representative route/range pressure',
      '<provider>=coin:interval:vs_currency',
      'without choosing a provider or writing operator config',
      'unresolved fallback pressure',
      'Targets that already have `live_backed` or `replay_backed` source coverage are suppressed from suggestions',
      'Applying suggested chart targets',
      '.data.response_source_target_suggestions[0].target_template',
      'Pick a provider ID from docs/reference/market-chart-provider-presets.json',
      'ccxt.binance=bitcoin:1d:usd',
      'jq \'.data.coins[] | select(.coin_id == "bitcoin" and .interval == "1d") | {status, coverage}\'',
      'Only replace `<provider>` with a provider ID that your adapter supports',
      'do not treat the suggestion itself as proof of live CoinGecko-level freshness',
      'short-term fallback signal',
      'configured_pending',
      'live_backed',
      'coverage.freshness=fresh',
      'stale_source_targets',
      'shallow_source_targets',
      'OPTIONAL_PROVIDER_SYNC_ENABLED',
      'OPTIONAL_PROVIDER_SYNC_INTERVAL_SECONDS',
      'docs/reference/market-chart-targets.json',
      'docs/reference/market-chart-provider-presets.json',
    ]) {
      expect(marketChartExample).toContain(expectedExampleDetail);
    }
  });

  it('keeps documented OHLCV history-depth defaults aligned with runtime policy', () => {
    const readme = readRepoFile('README.md');
    const runtimePolicy = readRepoFile('src/config/runtime-policy.ts');
    const ohlcvSync = readRepoFile('src/services/ohlcv-sync.ts');

    expect(runtimePolicy).toContain('DEFAULT_OHLCV_TARGET_HISTORY_DAYS = 1825');
    expect(runtimePolicy).toContain('DEFAULT_OHLCV_RETENTION_DAYS = 1825');
    expect(ohlcvSync).toContain('HISTORICAL_DEEPEN_CHUNK_DAYS = 180');
    expect(ohlcvSync).toContain('HISTORICAL_DEEPEN_OVERLAP_DAYS = 2');
    expect(readme).toContain('| `OHLCV_TARGET_HISTORY_DAYS` | `1825` |');
    expect(readme).toContain('| `OHLCV_RETENTION_DAYS` | `1825` |');
    expect(readme).toContain('estimated remaining history backfill chunks');
    expect(readme).toContain('most-behind target samples');

    const ohlcvInterpretation = readme.match(
      /\*\*OHLCV completion interpretation:\*\*([\s\S]*?)\*\*Optional provider scheduler playbook:\*\*/,
    )?.[1];

    expect(ohlcvInterpretation).toBeDefined();
    for (const expectedOhlcvDetail of [
      '/diagnostics/ohlcv_sync',
      'completion_estimate',
      'chunk_days',
      'overlap_days',
      'remaining_depth_days',
      'estimated_remaining_chunks',
      'max_remaining_depth_days',
      'by_tier',
      'depth_status_counts',
      'retry_recovery_counts',
      'retry_recovery_counts.due',
      'retry_starvation_counts',
      'retry_starvation_counts.starved',
      'retry_starvation_thresholds.due_age_seconds',
      'queue_priority_summary',
      'eligible_for_lease',
      'retry_due_failed',
      'retry_backoff_failed',
      'incomplete_depth',
      'complete_depth',
      'running',
      'starved_retry_due',
      'coarse totals and per-tier buckets',
      'next likely retry/backfill classes',
      'exact provider-call schedule',
      'next_retry_at',
      'backoff',
      'depth_alert_thresholds',
      'complete_remaining_depth_days',
      'catching_up_min_remaining_depth_days',
      'blocked_statuses',
      'depth_status_counts.complete',
      'catching_up',
      'blocked',
      'most_behind_samples',
      'blocked_target_samples',
      'failure_count',
      'retry_in_seconds',
      'last_attempt_at',
      'last_success_at',
      'last_error',
      'sanitized `last_error`',
      'sorted by retry cursor then remaining depth',
      'OHLCV worker lease order',
      'top100',
      'requested',
      'long_tail',
      'retry-due failed targets',
      'remaining_depth_days',
      'last_success_at',
      'coin ID',
      'deterministic tie-breaking',
      'provider call on every tick',
      '/coins/{id}/ohlc/range',
      '/coins/{id}/market_chart',
      '/coins/{id}/market_chart/range',
      'source-backed rows first',
      'canonical OHLCV storage',
      'configured ticker provider',
      'OHLCV close prices as chart prices',
      'stable market-cap and volume arrays',
      'persisted into canonical OHLCV storage',
      'same day window or range can be served locally',
      'hourly ranges remain storage-backed only',
      'target_history_days',
      'oldest_synced_at',
      'latest_synced_at',
      'OHLCV_TARGET_HISTORY_DAYS',
      '180-day historical chunk size',
      'two-day overlap',
      'capped per tier',
      'sorted by highest `remaining_depth_days`',
      'public chart or OHLC response shapes',
    ]) {
      expect(ohlcvInterpretation).toContain(expectedOhlcvDetail);
    }
  });
});
