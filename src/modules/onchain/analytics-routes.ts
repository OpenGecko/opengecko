import type { FastifyInstance } from 'fastify';

import type { AppDatabase } from '../../db/client';
import { sendCacheableJson } from '../../http/cache';
import { HttpError } from '../../http/errors';
import { parseBooleanQuery } from '../../http/params';
import {
  readOnchainHoldersChart,
  readOnchainHoldersChartSourceKind,
  readOnchainHoldersChartSourceMetadata,
  readOnchainTokenHolders,
  readOnchainTokenHolderSourceKind,
  readOnchainTokenHolderSourceMetadata,
  readOnchainTokenTraders,
  readOnchainTokenTraderSourceKind,
  readOnchainTokenTraderSourceMetadata,
} from '../../services/onchain-analytics-ingestion';
import {
  normalizeAddress,
  parseAnalyticsCount,
  parseHoldersChartDays,
  parseTopHoldersIncludes,
  parseTopTraderSort,
} from './helpers';
import { buildOnchainAnalyticsFieldProvenance, ONCHAIN_FIXTURE_VERSION, ONCHAIN_HTTP_CACHE_POLICY } from './meta';
import { buildTopHoldersIncludedResources, collectTokenPools } from './pools';
import {
  holdersChartQuerySchema,
  networkAddressParamsSchema,
  topHoldersQuerySchema,
  topTradersQuerySchema,
} from './query-schemas';
import { requireOnchainNetwork } from './route-helpers';
import {
  buildHoldersChartFixtures,
  buildHoldersChartResource,
  buildTopHolderFixtures,
  buildTopHolderResource,
  buildTopTraderFixtures,
  buildTopTraderResource,
} from './trades';

export function registerOnchainAnalyticsRoutes(app: FastifyInstance, database: AppDatabase) {
  app.get('/onchain/networks/:network/tokens/:address/top_holders', async (request, reply) => {
    const params = networkAddressParamsSchema.parse(request.params);
    const query = topHoldersQuerySchema.parse(request.query);
    const includePnlDetails = parseBooleanQuery(query.include_pnl_details, false);
    const includes = parseTopHoldersIncludes(query.include);
    const holders = parseAnalyticsCount(query.holders, 'holders', 3);
    const tokenAddress = normalizeAddress(params.address);

    requireOnchainNetwork(database, params.network);

    const tokenPools = collectTokenPools(params.network, tokenAddress, database);
    if (tokenPools.length === 0) {
      throw new HttpError(404, 'not_found', `Onchain token not found: ${tokenAddress}`);
    }

    const sourceHolders = readOnchainTokenHolders(database, params.network, tokenAddress);
    const holdersSource = readOnchainTokenHolderSourceKind(database, params.network, tokenAddress) ?? 'fixture';
    const holdersSourceMetadata = readOnchainTokenHolderSourceMetadata(database, params.network, tokenAddress);
    const holdersRows = (sourceHolders.length > 0 ? sourceHolders : buildTopHolderFixtures(params.network, tokenAddress))
      .sort((left, right) => right.balance - left.balance || right.shareOfSupply - left.shareOfSupply || left.address.localeCompare(right.address))
      .slice(0, holders);
    const included = buildTopHoldersIncludedResources(includes, params.network, tokenAddress, tokenPools, database);

    return sendCacheableJson(request, reply, {
      data: holdersRows.map((holder) => buildTopHolderResource(holder, includePnlDetails)),
      ...(included.length > 0 ? { included } : {}),
      meta: {
        fixture: holdersSource !== 'live',
        degraded: true,
        out_of_scope: true,
        network: params.network,
        token_address: tokenAddress,
        holders,
        include_pnl_details: includePnlDetails,
        scope: holdersSource === 'fixture'
          ? 'out-of-scope analytics fixture for USDC only'
          : 'out-of-scope source-attributed token analytics, not live-complete',
        source: holdersSource,
        source_mode: holdersSource,
        source_identifiers: holdersSourceMetadata?.sourceProviders.length
          ? holdersSourceMetadata.sourceProviders
          : ['opengecko.seed.onchain_holder_fixture'],
        source_fetched_at: holdersSourceMetadata?.latestSourceFetchedAt?.toISOString() ?? null,
        latest_source_fetched_at: holdersSourceMetadata?.latestSourceFetchedAt?.toISOString() ?? null,
        fixture_version: holdersSource === 'fixture' ? ONCHAIN_FIXTURE_VERSION : null,
        reason_codes: holdersSource === 'live'
          ? ['paid_indexer_style_analytics_not_live_complete']
          : holdersSource === 'replay'
            ? ['replay_source', 'paid_indexer_style_analytics_not_live_complete']
            : ['fixture_fallback', 'paid_indexer_style_analytics_unavailable'],
        degraded_reason: 'paid_indexer_style_holder_analytics_not_live_complete',
        fallback_reason: holdersSource === 'fixture' ? 'fixture_fallback' : null,
        unavailable_reason: holdersSource === 'fixture' ? 'no_public_complete_holder_indexer_configured' : null,
        no_silent_zero_fill: {
          numeric_fields: ['balance', 'share_of_supply', 'pnl_usd', 'avg_buy_price_usd', 'realized_pnl_usd'],
          policy: 'optional analytics values are source-attributed or fixture-marked; unavailable live values are not reported as live zeros',
          zero_fill_is_marked: true,
        },
        field_provenance: buildOnchainAnalyticsFieldProvenance(holdersSource, [
          'balance',
          'share_of_supply',
          'pnl_usd',
          'avg_buy_price_usd',
          'realized_pnl_usd',
        ]),
        note: holdersSource === 'live'
          ? 'Holder data is source-attributed live provider data for a narrow analytics slice; the surface remains out-of-scope for live-complete coverage'
          : holdersSource === 'replay'
            ? 'Holder data is source-attributed replay, not live; the surface remains out-of-scope for live-complete coverage'
            : 'Holder data is seeded fixture for USDC only; all other tokens return empty arrays and the surface remains out-of-scope',
      },
    }, ONCHAIN_HTTP_CACHE_POLICY);
  });

  app.get('/onchain/networks/:network/tokens/:address/top_traders', async (request, reply) => {
    const params = networkAddressParamsSchema.parse(request.params);
    const query = topTradersQuerySchema.parse(request.query);
    const includeAddressLabel = parseBooleanQuery(query.include_address_label, false);
    const traders = parseAnalyticsCount(query.traders, 'traders', 3);
    const sort = parseTopTraderSort(query.sort);
    const tokenAddress = normalizeAddress(params.address);

    requireOnchainNetwork(database, params.network);

    const tokenPools = collectTokenPools(params.network, tokenAddress, database);
    if (tokenPools.length === 0) {
      throw new HttpError(404, 'not_found', `Onchain token not found: ${tokenAddress}`);
    }

    const sourceTraders = readOnchainTokenTraders(database, params.network, tokenAddress);
    const tradersSource = readOnchainTokenTraderSourceKind(database, params.network, tokenAddress) ?? 'fixture';
    const tradersSourceMetadata = readOnchainTokenTraderSourceMetadata(database, params.network, tokenAddress);
    const tradersRows = (sourceTraders.length > 0 ? sourceTraders : buildTopTraderFixtures(params.network, tokenAddress))
      .sort((left, right) => {
        const primary = sort === 'realized_pnl_usd_desc'
          ? right.realizedPnlUsd - left.realizedPnlUsd
          : right.volumeUsd - left.volumeUsd;

        if (primary !== 0) {
          return primary;
        }

        const secondary = right.volumeUsd - left.volumeUsd;
        if (secondary !== 0) {
          return secondary;
        }

        return left.address.localeCompare(right.address);
      })
      .slice(0, traders);

    return sendCacheableJson(request, reply, {
      data: tradersRows.map((trader) => buildTopTraderResource(trader, includeAddressLabel)),
      meta: {
        fixture: tradersSource !== 'live',
        degraded: true,
        out_of_scope: true,
        network: params.network,
        token_address: tokenAddress,
        traders,
        sort,
        include_address_label: includeAddressLabel,
        scope: tradersSource === 'fixture'
          ? 'out-of-scope analytics fixture for USDC only'
          : 'out-of-scope source-attributed token analytics, not live-complete',
        source: tradersSource,
        source_mode: tradersSource,
        source_identifiers: tradersSourceMetadata?.sourceProviders.length
          ? tradersSourceMetadata.sourceProviders
          : ['opengecko.seed.onchain_trader_fixture'],
        source_fetched_at: tradersSourceMetadata?.latestSourceFetchedAt?.toISOString() ?? null,
        latest_source_fetched_at: tradersSourceMetadata?.latestSourceFetchedAt?.toISOString() ?? null,
        fixture_version: tradersSource === 'fixture' ? ONCHAIN_FIXTURE_VERSION : null,
        reason_codes: tradersSource === 'live'
          ? ['paid_indexer_style_analytics_not_live_complete']
          : tradersSource === 'replay'
            ? ['replay_source', 'paid_indexer_style_analytics_not_live_complete']
            : ['fixture_fallback', 'paid_indexer_style_analytics_unavailable'],
        degraded_reason: 'paid_indexer_style_trader_analytics_not_live_complete',
        fallback_reason: tradersSource === 'fixture' ? 'fixture_fallback' : null,
        unavailable_reason: tradersSource === 'fixture' ? 'no_public_complete_trader_indexer_configured' : null,
        no_silent_zero_fill: {
          numeric_fields: ['volume_usd', 'buy_volume_usd', 'sell_volume_usd', 'realized_pnl_usd', 'trade_count'],
          policy: 'optional analytics values are source-attributed or fixture-marked; unavailable live values are not reported as live zeros',
          zero_fill_is_marked: true,
        },
        field_provenance: buildOnchainAnalyticsFieldProvenance(tradersSource, [
          'volume_usd',
          'buy_volume_usd',
          'sell_volume_usd',
          'realized_pnl_usd',
          'trade_count',
        ]),
        note: tradersSource === 'live'
          ? 'Trader data is source-attributed live provider data for a narrow analytics slice; the surface remains out-of-scope for live-complete coverage'
          : tradersSource === 'replay'
            ? 'Trader data is source-attributed replay, not live; the surface remains out-of-scope for live-complete coverage'
            : 'Trader data is seeded fixture for USDC only; all other tokens return empty arrays and the surface remains out-of-scope',
      },
    }, ONCHAIN_HTTP_CACHE_POLICY);
  });

  app.get('/onchain/networks/:network/tokens/:address/holders_chart', async (request, reply) => {
    const params = networkAddressParamsSchema.parse(request.params);
    const query = holdersChartQuerySchema.parse(request.query);
    const days = parseHoldersChartDays(query.days);
    const tokenAddress = normalizeAddress(params.address);

    requireOnchainNetwork(database, params.network);

    const tokenPools = collectTokenPools(params.network, tokenAddress, database);
    if (tokenPools.length === 0) {
      throw new HttpError(404, 'not_found', `Onchain token not found: ${tokenAddress}`);
    }

    const sourceSeries = readOnchainHoldersChart(database, params.network, tokenAddress);
    const chartSource = readOnchainHoldersChartSourceKind(database, params.network, tokenAddress) ?? 'fixture';
    const chartSourceMetadata = readOnchainHoldersChartSourceMetadata(database, params.network, tokenAddress);
    const fullSeries = (sourceSeries.length > 0 ? sourceSeries : buildHoldersChartFixtures(params.network, tokenAddress))
      .sort((left, right) => left.timestamp - right.timestamp);
    const data = days <= 7 ? fullSeries.slice(-2) : fullSeries;

    return sendCacheableJson(request, reply, {
      data: data.map(buildHoldersChartResource),
      meta: {
        fixture: chartSource !== 'live',
        degraded: true,
        out_of_scope: true,
        network: params.network,
        token_address: tokenAddress,
        days,
        scope: chartSource === 'fixture'
          ? 'out-of-scope analytics fixture for USDC only'
          : 'out-of-scope source-attributed token analytics, not live-complete',
        source: chartSource,
        source_mode: chartSource,
        source_identifiers: chartSourceMetadata?.sourceProviders.length
          ? chartSourceMetadata.sourceProviders
          : ['opengecko.seed.onchain_holders_chart_fixture'],
        source_fetched_at: chartSourceMetadata?.latestSourceFetchedAt?.toISOString() ?? null,
        latest_source_fetched_at: chartSourceMetadata?.latestSourceFetchedAt?.toISOString() ?? null,
        fixture_version: chartSource === 'fixture' ? ONCHAIN_FIXTURE_VERSION : null,
        reason_codes: chartSource === 'live'
          ? ['paid_indexer_style_analytics_not_live_complete']
          : chartSource === 'replay'
            ? ['replay_source', 'paid_indexer_style_analytics_not_live_complete']
            : ['fixture_fallback', 'paid_indexer_style_analytics_unavailable'],
        degraded_reason: 'paid_indexer_style_holders_chart_not_live_complete',
        fallback_reason: chartSource === 'fixture' ? 'fixture_fallback' : null,
        unavailable_reason: chartSource === 'fixture' ? 'no_public_complete_holder_count_indexer_configured' : null,
        no_silent_zero_fill: {
          numeric_fields: ['holder_count'],
          policy: 'holder counts are source-attributed or fixture-marked; unavailable live values are not reported as live zeros',
          zero_fill_is_marked: true,
        },
        field_provenance: buildOnchainAnalyticsFieldProvenance(chartSource, ['holder_count']),
        note: chartSource === 'live'
          ? 'Holders chart data is source-attributed live provider data for a narrow analytics slice; the surface remains out-of-scope for live-complete coverage'
          : chartSource === 'replay'
            ? 'Holders chart data is source-attributed replay, not live; the surface remains out-of-scope for live-complete coverage'
            : 'Holders chart data is seeded fixture for USDC only; all other tokens return empty arrays and the surface remains out-of-scope',
      },
    }, ONCHAIN_HTTP_CACHE_POLICY);
  });

}
