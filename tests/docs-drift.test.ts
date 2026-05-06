import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
      'tests/fixtures/provider-replay/market-charts/ccxt-binance-solana-adapter-response.json',
    );
    expect(marketChartPresets).toContain(
      'tests/fixtures/provider-replay/market-charts/intraday-archive-ethereum-adapter-response.json',
    );
    expect(marketChartPresets).toContain(
      'tests/fixtures/provider-replay/market-charts/intraday-archive-solana-adapter-response.json',
    );
    expect(readme).toContain('retry-only target templates from persisted job state');

    const marketChartExample = readme.match(
      /\*\*Market chart preset example:\*\*([\s\S]*?)## Migrating from CoinGecko/,
    )?.[1];
    const marketChartWorkflow = readFileSync(
      join(process.cwd(), 'docs/reference/market-chart-diagnostics-workflow.md'),
      'utf8',
    );

    expect(marketChartExample).toBeDefined();
    expect(marketChartExample).toContain('docs/reference/market-chart-diagnostics-workflow.md');
    expect(marketChartWorkflow).toContain('Market Chart Diagnostics Workflow');

    for (const expectedReadmeDetail of [
      'MARKET_CHART_BASE_URL',
      'MARKET_CHART_TARGETS',
      'ccxt.binance=bitcoin:1d:usd',
      'bun run market:charts:sync',
      '/diagnostics/market_charts',
      '"summary"',
      'source_backed_configured_targets',
      'status_counts',
      'freshness_counts',
      'production_freshness_counts',
      'depth_counts',
      'response_source_counts',
      'response_source_recent_events',
      'response_source_recent_event_rollups',
      'response_source_target_suggestion_window',
      'response_source_target_suggestion_summary',
      'response_source_fallback_alert',
      'response_source_target_suggestion_operator_summary',
      'response_source_target_suggestion_overflow',
      'response_source_target_suggestion_batch_previews',
      'response_source_target_suggestion_exclusions',
      'response_source_target_suggestions',
      'market_chart_days',
      'ohlc_range',
      'source_backed',
      'canonical',
      'provider_filled',
      'empty',
      'source_backed_events_suppressed',
      'events_eligible_for_suggestion',
      'unique_eligible_targets',
      'suggestions_returned',
      'suggestions_limit',
      'stale_events',
      'source_backed_events',
      'sample_requests',
      '"priority"',
      '"rank"',
      '"pressure_score"',
      '"latest_observed_at"',
      '"route_pressure"',
      '"dominant_route"',
      '"request_kind_pressure"',
      '"dominant_kind"',
      '"range_span_pressure"',
      '"dominant_bucket"',
      '"coverage_target_hint"',
      '"target_history"',
      '"suggested_action"',
      '"daily_history"',
      '"intraday_history"',
      '"suggested_action_counts"',
      '"request_pattern_counts"',
      '"range_window_counts"',
      'omitted_by_suggestion_cap',
      '"basis": "eligible_unique_targets_after_stale_and_source_backed_filtering"',
      '"groups"',
      '"market_chart_targets_template"',
      '<provider>',
      '"preview_source": "response_source_target_suggestions"',
      'configured_pending',
      'live_backed',
      'stale_source_targets',
      'production_stale_source_targets',
      'shallow_source_targets',
      'OPTIONAL_PROVIDER_SYNC_ENABLED',
      'OPTIONAL_PROVIDER_SYNC_INTERVAL_SECONDS',
      'docs/reference/market-chart-provider-presets.json',
    ]) {
      expect(marketChartExample).toContain(expectedReadmeDetail);
    }

    for (const expectedWorkflowDetail of [
      'diagnostics-only',
      'must not appear in public `/coins/:id/market_chart*` or `/coins/:id/ohlc*` responses',
      'response_source_fallback_alert.status',
      '`clear`: no recent chart/OHLC fallback pressure is visible in the diagnostics window',
      '`watch`: fallback pressure is stale-only or already source-backed and suppressed from suggestions',
      '`action_needed`: unresolved recent fallback pressure exists and should be reviewed',
      'summary.partial_failure > 0',
      'last_partial_failure_reason',
      'sanitized `last_partial_failure_samples`',
      'last_partial_failure_retry_targets_template',
      'retry-only `MARKET_CHART_TARGETS` batch',
      'export MARKET_CHART_RETRY_TARGETS=',
      'MARKET_CHART_TARGETS="$MARKET_CHART_RETRY_TARGETS" bun run market:charts:sync',
      'successful source rows are not reprocessed unnecessarily',
      'partial-failure samples exist but the retry template is empty',
      'did not include enough provider, coin, currency, and interval context',
      'inspect the samples or provider logs before retrying a broad batch',
      'gaps.configured_without_source_rows',
      'gaps.stale_source_targets',
      'gaps.shallow_source_targets',
      'coverage.freshness_threshold_seconds=129600',
      'coverage.depth_threshold_days=30',
      'coverage.freshness_threshold_seconds=1800',
      'coverage.depth_threshold_days=1',
      'first-run minimum SLOs',
      'coverage.production_freshness_threshold_seconds=7200',
      'coverage.production_freshness_threshold_seconds=300',
      'summary.production_freshness_counts',
      'gaps.production_stale_source_targets',
      'first-run fresh while production-stale',
      'source-sync recency',
      'retry a fresh sync before expanding the target set',
      'deepen provider history instead of treating the gap as missing provider support',
      'This keeps partial provider errors, stale source rows, shallow history depth, and missing target coverage from being treated as the same problem',
      'response_source_target_suggestion_exclusions.stale_events',
      'response_source_target_suggestion_exclusions.source_backed_events',
      'response_source_target_suggestions',
      'response_source_target_suggestion_operator_summary',
      'mostly `daily_history` or `intraday_history`',
      'response_source_target_suggestion_batch_previews.groups.daily_history.market_chart_targets_template',
      'response_source_target_suggestion_batch_previews.groups.intraday_history.market_chart_targets_template',
      'docs/reference/market-chart-provider-presets.json',
      'The diagnostics route does not choose providers, write `MARKET_CHART_TARGETS`, or apply targets automatically',
      'response_source_target_suggestion_overflow',
      'response_source_target_suggestion_overflow.target_history_counts',
      'daily_omitted: .daily_history.omitted_by_suggestion_cap',
      'intraday_omitted: .intraday_history.omitted_by_suggestion_cap',
      'If `response_source_target_suggestion_overflow.omitted_by_suggestion_cap > 0`',
      'treat the current batch preview as the first page of remediation work',
      'prioritize daily-history backfill, intraday-history backfill, or a smaller provider-specific target set',
      'export MARKET_CHART_TARGET_BATCH=',
      '${MARKET_CHART_TARGET_BATCH//<provider>/ccxt.binance}',
      'jq --arg targets "$MARKET_CHART_TARGETS"',
      '$targets | split(",")',
      '{coin_id, interval, vs_currency, status, coverage}',
      'A target is not CoinGecko-fresh until it is `live_backed`',
      'coverage.freshness=fresh',
    ]) {
      expect(marketChartWorkflow).toContain(expectedWorkflowDetail);
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
