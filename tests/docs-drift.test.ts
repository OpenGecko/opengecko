import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase, seedStaticReferenceData } from '../src/db/client';
import {
  DEFAULT_OHLCV_RETENTION_DAYS,
  DEFAULT_OHLCV_TARGET_HISTORY_DAYS,
} from '../src/config/runtime-policy';
import { buildCoverageMatrix, type DataOwnershipClass } from '../src/services/coverage-matrix';
import { DEFAULT_SNAPSHOT_RETENTION_DAYS } from '../src/services/snapshot-retention';
import {
  extractReadmeApiCoverageGetRoutes,
  normalizeRouteTemplate,
  readRepoFile,
  uniqueSorted,
} from './helpers/readme-routes';

const coverageOwnershipClasses: DataOwnershipClass[] = [
  'live',
  'hybrid',
  'seeded',
  'synthetic',
  'fixture',
  'unavailable',
];

const intentionallyUndocumentedPublicRoutes = new Set([
  '/health',
  '/metrics',
]);

const readmeConfigEnvAllowlist = new Set([
  'COIN_HISTORY_BASE_URL',
  'EXCHANGE_VOLUME_BASE_URL',
  'MARKET_CHART_BASE_URL',
  'ONCHAIN_ANALYTICS_BASE_URL',
  'ONCHAIN_TRADE_BASE_URL',
  'SUPPLY_CHART_BASE_URL',
]);

function extractEnvTsReferencedEnvVars() {
  const envConfig = readRepoFile('src/config/env.ts');
  const schemaBody = envConfig.match(/const envSchema = z\.object\(\{([\s\S]*?)\n\}\);/)?.[1];

  expect(schemaBody).toBeDefined();

  return uniqueSorted([
    ...[...schemaBody!.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):/gm)].map((match) => match[1]),
    ...[...envConfig.matchAll(/\benv\.([A-Z][A-Z0-9_]+)\b/g)].map((match) => match[1]),
  ]);
}

function extractReadmeConfigEnvVars() {
  const readme = readRepoFile('README.md');
  const configSection = readme.match(/## Configuration([\s\S]*?)## Diagnostics & Operations/)?.[1];

  expect(configSection).toBeDefined();

  return uniqueSorted(
    [...configSection!.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \|/gm)]
      .map((match) => match[1]),
  );
}

function extractReadmeConfigDefault(envVar: string) {
  const readme = readRepoFile('README.md');
  const match = readme.match(new RegExp(`^\\| \`${escapeRegExp(envVar)}\` \\| \`([^\\\`]+)\\\` \\|`, 'm'));

  expect(match).toBeDefined();

  return match![1];
}

function extractPackageJsonScripts() {
  const packageJson = JSON.parse(readRepoFile('package.json')) as { scripts: Record<string, string> };

  return uniqueSorted(Object.keys(packageJson.scripts));
}

function extractReadmeBunRunScripts() {
  const readme = readRepoFile('README.md');

  return uniqueSorted(
    [...readme.matchAll(/\bbun run ([a-z0-9][a-z0-9:-]*)\b/g)]
      .map((match) => match[1]),
  );
}

function sourceTreeContains(value: string, directory = resolve(process.cwd(), 'src')): boolean {
  return readdirSync(directory, { withFileTypes: true }).some((entry) => {
    const entryPath = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      return sourceTreeContains(value, entryPath);
    }

    return entry.isFile() && entry.name.endsWith('.ts') && readFileSync(entryPath, 'utf8').includes(value);
  });
}

function extractRegisteredCoinGeckoGetRoutes() {
  const modulesDir = resolve(process.cwd(), 'src/modules');
  const registeredRoutes = readdirSync(modulesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .flatMap((entry) => {
      const source = readFileSync(resolve(modulesDir, entry.name), 'utf8');
      return [...source.matchAll(/app\.get\(\s*['`]([^'`]+)['`]/g)].map((match) => match[1]);
    })
    .filter((route) => !route.startsWith('/diagnostics/'))
    .filter((route) => !intentionallyUndocumentedPublicRoutes.has(route))
    .map(normalizeRouteTemplate);

  return uniqueSorted(registeredRoutes);
}

function extractCompatibilityAuditImplementedRoutes() {
  const audit = readRepoFile('docs/status/compatibility-audit.md');

  return uniqueSorted(
    [...audit.matchAll(/^\| `([^`]+)` \| (?!NFT \(removed\))[^|]+ \| implemented \|/gm)]
      .map((match) => normalizeRouteTemplate(match[1])),
  );
}

function buildDocsCoverageMatrixEntries() {
  const database = createDatabase(':memory:');

  try {
    migrateDatabase(database);
    seedStaticReferenceData(database, { includeSeededExchanges: true });

    return buildCoverageMatrix(database, new Date('2026-05-12T00:00:00.000Z')).entries;
  } finally {
    database.client.close();
  }
}

function calculateCoverageOwnershipSummary(entries: ReturnType<typeof buildDocsCoverageMatrixEntries>) {
  const total = entries.length;
  const counts = new Map<string, number>();

  for (const ownershipClass of coverageOwnershipClasses) {
    counts.set(ownershipClass, entries.filter((entry) => entry.ownership_class === ownershipClass).length);
  }

  counts.set(
    'live_or_hybrid',
    entries.filter((entry) => ['live', 'hybrid'].includes(entry.ownership_class)).length,
  );

  return [...counts.entries()].map(([ownershipClass, count]) => ({
    ownershipClass,
    count,
    total,
    percentage: total === 0 ? 0 : Math.round((count / total) * 100),
  }));
}

function extractTrackerCoverageOwnershipSummary(tracker: string) {
  return new Map(
    [...tracker.matchAll(/^\| `([^`]+)` \| (\d+) \/ (\d+) \| (\d+)% \|$/gm)]
      .map((match) => [
        match[1],
        {
          count: Number(match[2]),
          total: Number(match[3]),
          percentage: Number(match[4]),
        },
      ]),
  );
}

function extractTrackerFamilyOwnershipClaims(tracker: string) {
  return new Map(
    [...tracker.matchAll(/^\| `([^`]+)` \| `([^`]+)` \| \d+ \|$/gm)]
      .map((match) => [match[1], match[2]]),
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildTrackerClaimBlocks(tracker: string) {
  const blocks: string[] = [];
  let proseBlock: string[] = [];

  for (const line of tracker.split(/\r?\n/)) {
    const trimmedLine = line.trim();

    if (!trimmedLine) {
      if (proseBlock.length > 0) {
        blocks.push(proseBlock.join(' '));
        proseBlock = [];
      }
      continue;
    }

    if (trimmedLine.startsWith('|') || trimmedLine.startsWith('- ') || trimmedLine.startsWith('#')) {
      if (proseBlock.length > 0) {
        blocks.push(proseBlock.join(' '));
        proseBlock = [];
      }
      blocks.push(trimmedLine);
      continue;
    }

    proseBlock.push(trimmedLine);
  }

  if (proseBlock.length > 0) {
    blocks.push(proseBlock.join(' '));
  }

  return blocks;
}

function routeAliasesForTrackerScan(route: string) {
  const aliases = new Set([route]);
  const [rootSegment] = route.split('/').filter(Boolean);

  aliases.add(route.replace(/:([A-Za-z0-9_]+)/g, '{$1}'));
  aliases.add(route.replace(/:([A-Za-z0-9_]+)/g, '*'));
  aliases.add(route.replace(/\/:([A-Za-z0-9_]+)/g, '/*'));

  if (rootSegment) {
    aliases.add(`/${rootSegment}/*`);
  }

  return [...aliases];
}

function familyAliasesForTrackerScan(entry: ReturnType<typeof buildDocsCoverageMatrixEntries>[number]) {
  return uniqueSorted([
    entry.family,
    entry.family.replace(/_/g, ' '),
    entry.family.replace(/_/g, '-'),
    ...entry.representative_routes.flatMap(routeAliasesForTrackerScan),
  ]);
}

function containsTrackerLiveClaim(block: string) {
  const normalized = block.toLowerCase();

  if (/\b(?:not|never|without|unless|until|before|rather than|instead of)\b[^.?!|]{0,120}\blive\b/.test(normalized)) {
    return false;
  }

  if (/\blive\b[^.?!|]{0,80}\b(?:only when|when|if|once|after|until|requires?|would|should|could|can)\b/.test(normalized)) {
    return false;
  }

  if (/\b(?:if|when|once|after|until)\b[^.?!|]{0,80}\blive\b/.test(normalized)) {
    return false;
  }

  if (/\b(?:should|could|would|can)\b[^.?!|]{0,80}\blive\b/.test(normalized)) {
    return false;
  }

  return [
    /\|\s*`?live`?\s*\|/,
    /:\s*`?live`?\s*(?:$|[\s|,.;)])/,
    /\bfully\s+live\b/,
    /\bfull\s+live\b/,
    /\blive[-\s]?backed\b/,
    /\blive[-\s]?owned\b/,
    /\blive[-\s]?data\b/,
    /\blive[-\s]?coverage\b/,
    /\blive[-\s]?fidelity\b/,
    /\blive[-\s]?parity\b/,
    /\blive[-\s]?source\b/,
    /\blive[-\s]?pipeline\b/,
    /\blive\s+(?:provider|providers|rows|ingestion|refresh|snapshot|snapshots)\b/,
    /\b(?:is|are|as|currently|now|reports?|labels?)\s+[^.?!|]{0,80}\blive\b/,
  ].some((pattern) => pattern.test(normalized));
}

function extractTrackerLiveClaimsByFamily(
  tracker: string,
  matrixEntries: ReturnType<typeof buildDocsCoverageMatrixEntries>,
) {
  const blocks = buildTrackerClaimBlocks(tracker);

  return matrixEntries.flatMap((entry) => {
    const aliasPatterns = familyAliasesForTrackerScan(entry)
      .map((alias) => new RegExp(`(?:^|[^A-Za-z0-9_/-])${escapeRegExp(alias)}(?:$|[^A-Za-z0-9_/-])`, 'i'));

    return blocks
      .filter((block) => containsTrackerLiveClaim(block))
      .filter((block) => aliasPatterns.some((pattern) => pattern.test(block)))
      .map((block) => ({
        family: entry.family,
        ownershipClass: entry.ownership_class,
        claim: block,
      }));
  });
}

describe('documentation drift guards', () => {
  it('keeps the README endpoint table aligned with registered CoinGecko-compatible GET routes', () => {
    expect(extractReadmeApiCoverageGetRoutes()).toEqual(extractRegisteredCoinGeckoGetRoutes());
  });

  it('keeps the compatibility audit active endpoint count aligned with registered routes', () => {
    const audit = readRepoFile('docs/status/compatibility-audit.md');
    const auditCoverage = audit.match(/Active non-NFT parity:\s*(\d+)\s*\/\s*(\d+)/);
    const registeredRoutes = extractRegisteredCoinGeckoGetRoutes();

    expect(auditCoverage).toBeDefined();
    expect(auditCoverage?.slice(1, 3).map(Number)).toEqual([registeredRoutes.length, registeredRoutes.length]);
    expect(extractCompatibilityAuditImplementedRoutes()).toEqual(registeredRoutes);
  });

  it('keeps README configuration variables aligned with src/config/env.ts', () => {
    const envTsVars = extractEnvTsReferencedEnvVars();
    const readmeVars = extractReadmeConfigEnvVars();
    const allowedReadmeOnlyVars = readmeVars.filter((envVar) => readmeConfigEnvAllowlist.has(envVar));

    for (const envVar of allowedReadmeOnlyVars) {
      expect(sourceTreeContains(envVar)).toBe(true);
    }

    expect(readmeVars.filter((envVar) => !readmeConfigEnvAllowlist.has(envVar))).toEqual(envTsVars);
    expect(envTsVars.filter((envVar) => !readmeVars.includes(envVar))).toEqual([]);
  });

  it('keeps README bun run script references aligned with package.json scripts', () => {
    expect(extractReadmeBunRunScripts()).toEqual(extractPackageJsonScripts());
  });

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

    expect(tracker).toContain('/diagnostics/coverage_matrix');
    expect(guide).toContain('Live data coverage');
    expect(guide).toContain('fixture-backed');

    for (const fixtureSurface of ['derivatives', 'treasury', 'onchain analytics', 'supply charts']) {
      expect(guide).toContain(fixtureSurface);
    }
  });

  it('keeps implementation tracker coverage percentages derived from the coverage matrix builder', () => {
    const tracker = readRepoFile('docs/status/implementation-tracker.md');
    const matrixEntries = buildDocsCoverageMatrixEntries();
    const trackerSummary = extractTrackerCoverageOwnershipSummary(tracker);
    const trackerFamilyClaims = Object.fromEntries(extractTrackerFamilyOwnershipClaims(tracker));

    expect(tracker).toContain('/diagnostics/coverage_matrix');
    expect(tracker).toContain('src/services/coverage-matrix.ts');

    for (const expected of calculateCoverageOwnershipSummary(matrixEntries)) {
      const actual = trackerSummary.get(expected.ownershipClass);

      expect(actual).toBeDefined();
      expect(actual?.count).toBe(expected.count);
      expect(actual?.total).toBe(expected.total);
      expect(Math.abs((actual?.percentage ?? Number.NaN) - expected.percentage)).toBeLessThanOrEqual(1);
    }

    expect(trackerFamilyClaims).toEqual(Object.fromEntries(
      matrixEntries.map((entry) => [entry.family, entry.ownership_class]),
    ));
  });

  it('prevents tracker family live claims from contradicting the coverage matrix', () => {
    const trackerFamilyClaims = extractTrackerFamilyOwnershipClaims(
      readRepoFile('docs/status/implementation-tracker.md'),
    );
    const matrixOwnershipByFamily = new Map(
      buildDocsCoverageMatrixEntries().map((entry) => [entry.family, entry.ownership_class]),
    );

    for (const [family, claimedOwnership] of trackerFamilyClaims) {
      expect(matrixOwnershipByFamily.get(family)).toBeDefined();

      if (claimedOwnership === 'live') {
        expect(matrixOwnershipByFamily.get(family)).toBe('live');
      }
    }
  });

  it('prevents tracker prose live claims from contradicting the coverage matrix', () => {
    const tracker = readRepoFile('docs/status/implementation-tracker.md');
    const matrixEntries = buildDocsCoverageMatrixEntries();
    const proseLiveClaims = extractTrackerLiveClaimsByFamily(tracker, matrixEntries);

    expect(proseLiveClaims.filter((claim) => claim.ownershipClass !== 'live')).toEqual([]);
  });

  it('detects bare tracker live table-cell claims for non-live coverage families', () => {
    const matrixEntries = buildDocsCoverageMatrixEntries();
    const claims = extractTrackerLiveClaimsByFamily(
      '| Family | Data quality |\n| --- | --- |\n| `/derivatives/*` | live |',
      matrixEntries,
    );

    expect(claims).toEqual(expect.arrayContaining([
      expect.objectContaining({
        family: 'derivatives',
        ownershipClass: 'fixture',
        claim: '| `/derivatives/*` | live |',
      }),
    ]));
  });

  it('detects bare tracker colon live claims for non-live coverage families', () => {
    const matrixEntries = buildDocsCoverageMatrixEntries();
    const claims = extractTrackerLiveClaimsByFamily(
      '- `/derivatives/*`: live',
      matrixEntries,
    );

    expect(claims).toEqual(expect.arrayContaining([
      expect.objectContaining({
        family: 'derivatives',
        ownershipClass: 'fixture',
        claim: '- `/derivatives/*`: live',
      }),
    ]));
  });

  it('detects matrix-family ownership snippets that claim non-live families are live', () => {
    const matrixEntries = buildDocsCoverageMatrixEntries();
    const claims = extractTrackerLiveClaimsByFamily(
      'derivatives: live',
      matrixEntries,
    );

    expect(claims).toEqual(expect.arrayContaining([
      expect.objectContaining({
        family: 'derivatives',
        ownershipClass: 'fixture',
        claim: 'derivatives: live',
      }),
    ]));
  });

  it('maps tracker wildcard endpoint-family rows to their coverage-matrix families', () => {
    const matrixEntries = buildDocsCoverageMatrixEntries();
    const claims = extractTrackerLiveClaimsByFamily(
      [
        '| Family | Data quality |',
        '| --- | --- |',
        '| `/simple/*` | live |',
        '| `/exchanges/*` | live |',
        '| `/derivatives/*` | live |',
      ].join('\n'),
      matrixEntries,
    );

    expect(claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: 'simple', ownershipClass: 'seeded' }),
      expect.objectContaining({ family: 'exchanges', ownershipClass: 'seeded' }),
      expect.objectContaining({ family: 'derivatives', ownershipClass: 'fixture' }),
    ]));
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
    const providerTargetPresets = readRepoFile('docs/reference/provider-target-presets.json');

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
    expect(readme).toContain('docs/reference/provider-target-presets.json');
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

    for (const expectedPresetDetail of [
      'opengecko-source-backed-provider-target-presets',
      'exchange-volumes.major-cex.daily',
      'EXCHANGE_VOLUME_TARGETS',
      'tests/fixtures/provider-replay/exchange-volumes/binance-volume.json',
      'derivatives.ccxt-major-futures',
      'DERIVATIVES_CCXT_EXCHANGES',
      'tests/fixtures/provider-replay/ccxt-derivatives/binance-futures-tickers.json',
      'tests/fixtures/provider-replay/ccxt-derivatives/binance-funding-open-interest.json',
      'onchain-trades.ethereum-bluechip-pools',
      'ONCHAIN_TRADE_TARGETS',
      'tests/fixtures/provider-replay/onchain-trades/eth-usdc-weth-pool-trades.json',
      'market-charts.coverage-plan.default',
      'MARKET_CHART_USE_COVERAGE_PLAN',
      'docs/reference/default-coverage-targets.json',
      'Do not interpret replay fixtures as live production coverage',
    ]) {
      expect(providerTargetPresets).toContain(expectedPresetDetail);
    }
    expect(readme).toContain('exchange-volumes.major-cex.daily');
    expect(readme).toContain('derivatives.ccxt-major-futures');
    expect(readme).toContain('onchain-trades.ethereum-bluechip-pools');
    expect(readme).toContain('market-charts.coverage-plan.default');
    expect(readme).toContain('retry-only target templates from persisted job state');
    expect(readme).toContain('production_freshness_cadence');

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
      'market_charts.production_freshness_cadence',
      '`scheduler_disabled`',
      '`interval_slower_than_production_freshness`',
      '`cadence_within_production_freshness`',
      'strictest_production_freshness_seconds',
      'OPTIONAL_PROVIDER_SYNC_INTERVAL_SECONDS',
      'provider latency',
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
    expect(extractReadmeConfigDefault('OHLCV_TARGET_HISTORY_DAYS')).toBe(String(DEFAULT_OHLCV_TARGET_HISTORY_DAYS));
    expect(extractReadmeConfigDefault('OHLCV_RETENTION_DAYS')).toBe(String(DEFAULT_OHLCV_RETENTION_DAYS));
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
      'target_depth_days',
      'coverage_ratio',
      'slo_status',
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

  it('keeps the README snapshot-retention contract aligned with runtime pruning defaults', () => {
    const readme = readRepoFile('README.md');
    const snapshotRetention = readRepoFile('src/services/snapshot-retention.ts');
    const retentionContract = readme.match(
      /\*\*Snapshot retention contract:\*\*([\s\S]*?)\*\*Optional provider scheduler playbook:\*\*/,
    )?.[1];

    expect(retentionContract).toBeDefined();
    expect(snapshotRetention).toContain(`DEFAULT_SNAPSHOT_RETENTION_DAYS = ${DEFAULT_SNAPSHOT_RETENTION_DAYS}`);
    expect(retentionContract).toContain(`default snapshot retention horizon is ${DEFAULT_SNAPSHOT_RETENTION_DAYS} days`);
    expect(retentionContract).toContain(
      `canonical OHLCV candles follow \`OHLCV_RETENTION_DAYS=${DEFAULT_OHLCV_RETENTION_DAYS}\``,
    );
    expect(retentionContract).toContain(
      `generated daily history targets use \`OHLCV_TARGET_HISTORY_DAYS=${DEFAULT_OHLCV_TARGET_HISTORY_DAYS}\``,
    );

    for (const tableName of [
      'market_chart_source_points',
      'exchange_volume_source_points',
      'onchain_pool_trades',
      'supply_chart_points',
      'coin_history_snapshots',
    ]) {
      expect(retentionContract).toContain(tableName);
      expect(snapshotRetention).toContain(tableName.split('_').map((part, index) => (
        index === 0 ? part : `${part[0]?.toUpperCase()}${part.slice(1)}`
      )).join(''));
    }

    for (const expectedContractDetail of [
      'append-style source table',
      'sourceFetchedAt',
      'enforceSnapshotRetention()',
      '/diagnostics/jobs',
      'retention/sweep outcomes',
      'retained history, not infinite history',
      'public CoinGecko-compatible response shapes',
    ]) {
      expect(retentionContract).toContain(expectedContractDetail);
    }
  });

  it('keeps resolved TODO follow-ups out of the review queue', () => {
    const todos = readRepoFile('TODOS.md');
    const reviewSection = todos.match(/## Review([\s\S]*?)(?=\n## |$)/)?.[1] ?? '';
    const completedSection = todos.match(/## Completed([\s\S]*?)(?=\n## |$)/)?.[1] ?? '';
    const deferredSection = todos.match(/## Deferred with rationale([\s\S]*?)(?=\n## |$)/)?.[1] ?? '';
    const resolvedTodoTitles = [
      'Add plan/tracker drift guard tests',
      'Add onchain TTL cache reliability tests',
      'Time-box renewable enrichment source evaluation',
    ];

    for (const title of resolvedTodoTitles) {
      expect(reviewSection).not.toContain(title);
      expect(todos).toContain(`### ${title}`);
    }

    expect(completedSection).toContain('Add plan/tracker drift guard tests');
    expect(completedSection).toContain('tests/docs-drift.test.ts');
    expect(completedSection).toContain('docs/status/implementation-tracker.md');
    expect(completedSection).toContain('docs/status/compatibility-audit.md');

    expect(deferredSection).toContain('Add onchain TTL cache reliability tests');
    expect(deferredSection).toContain('src/modules/onchain.ts');
    expect(deferredSection).toContain('buildLiveOnchainCatalog()');
    expect(deferredSection).toContain('Time-box renewable enrichment source evaluation');
    expect(deferredSection).toContain('docs/plans/2026-05-05-opengecko-improvement-guide.md');
  });
});
