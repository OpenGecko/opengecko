<script lang="ts">
  import { browser } from '$app/environment';
  import { page } from '$app/stores';
  import { onDestroy } from 'svelte';
  import { Activity, ArrowLeft, BarChart3, DatabaseZap, ExternalLink, LoaderCircle, RefreshCw, Server, ShieldCheck, Star, TrendingUp } from 'lucide-svelte';
  import { fetchJson, OpenGeckoApiError, rawApiUrl } from '$lib/api';
  import { money, numberText, percent, safeImageUrl, sparkPath } from '$lib/format';

  type CoinImage = string | { thumb?: string | null; small?: string | null; large?: string | null } | null;
  type CoinDetail = {
    id?: string;
    name?: string | null;
    symbol?: string | null;
    image?: CoinImage;
    market_cap_rank?: number | null;
    description?: { en?: string | null } | null;
    hashing_algorithm?: string | null;
    genesis_date?: string | null;
    categories?: string[] | null;
    links?: {
      homepage?: string[] | null;
      repos_url?: { github?: string[] | null } | null;
      blockchain_site?: string[] | null;
    } | null;
    market_data?: {
      current_price?: Record<string, number | null> | null;
      market_cap?: Record<string, number | null> | null;
      total_volume?: Record<string, number | null> | null;
      high_24h?: Record<string, number | null> | null;
      low_24h?: Record<string, number | null> | null;
      price_change_percentage_24h?: number | null;
    } | null;
  };
  type MarketCoin = {
    id: string;
    symbol?: string | null;
    name?: string | null;
    image?: string | null;
    current_price?: number | null;
    market_cap_rank?: number | null;
    market_cap?: number | null;
    total_volume?: number | null;
    high_24h?: number | null;
    low_24h?: number | null;
    price_change_percentage_24h?: number | null;
    sparkline_in_7d?: { price?: number[] };
  };
  type MarketChart = {
    prices?: Array<[number, number]>;
    market_caps?: Array<[number, number]>;
    total_volumes?: Array<[number, number]>;
  };
  type CoinTicker = {
    base?: string | null;
    target?: string | null;
    market?: { name?: string | null; identifier?: string | null } | null;
    last?: number | null;
    volume?: number | null;
    trust_score?: string | null;
    converted_last?: Record<string, number | null> | null;
    converted_volume?: Record<string, number | null> | null;
  };
  type TickersPayload = {
    name?: string | null;
    tickers?: CoinTicker[];
  };

  let coin: CoinDetail | null = null;
  let marketCoin: MarketCoin | null = null;
  let chart: MarketChart | null = null;
  let tickers: CoinTicker[] = [];
  let loading = true;
  let notFound = false;
  let error = '';
  let partialWarnings: string[] = [];
  let loadedId = '';
  let requestToken = 0;

  $: routeId = $page.params.id ?? '';
  $: rawCoinPath = routeId ? `/coins/${routeId}` : '/coins/{id}';
  $: rawChartPath = routeId ? `/coins/${routeId}/market_chart?vs_currency=usd&days=7` : '/coins/{id}/market_chart';
  $: rawTickersPath = routeId ? `/coins/${routeId}/tickers` : '/coins/{id}/tickers';
  $: displayName = coin?.name ?? marketCoin?.name ?? titleize(routeId);
  $: displaySymbol = (coin?.symbol ?? marketCoin?.symbol ?? routeId).toUpperCase();
  $: displayImage = coinImage(coin?.image) ?? marketCoin?.image ?? null;
  $: currentPrice = marketCoin?.current_price ?? coin?.market_data?.current_price?.usd ?? null;
  $: marketCap = marketCoin?.market_cap ?? coin?.market_data?.market_cap?.usd ?? null;
  $: volume = marketCoin?.total_volume ?? coin?.market_data?.total_volume?.usd ?? null;
  $: high24h = marketCoin?.high_24h ?? coin?.market_data?.high_24h?.usd ?? null;
  $: low24h = marketCoin?.low_24h ?? coin?.market_data?.low_24h?.usd ?? null;
  $: rank = marketCoin?.market_cap_rank ?? coin?.market_cap_rank ?? null;
  $: change24h = marketCoin?.price_change_percentage_24h ?? coin?.market_data?.price_change_percentage_24h ?? null;
  $: chartValues = chart?.prices?.map(([, value]) => value) ?? marketCoin?.sparkline_in_7d?.price ?? [];
  $: latestChartPrice = chart?.prices?.at(-1)?.[1] ?? null;
  $: cleanedDescription = cleanText(coin?.description?.en);
  $: homepage = firstUsableUrl(coin?.links?.homepage);
  $: github = firstUsableUrl(coin?.links?.repos_url?.github);
  $: explorer = firstUsableUrl(coin?.links?.blockchain_site);

  $: if (browser && routeId && routeId !== loadedId) {
    void loadCoin(routeId);
  }

  onDestroy(() => {
    requestToken += 1;
  });

  function titleize(value: string) {
    return value
      .split('-')
      .filter(Boolean)
      .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
      .join(' ') || 'Unknown coin';
  }

  function cleanText(value: string | null | undefined) {
    return value?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() ?? '';
  }

  function coinImage(value: CoinImage | undefined) {
    if (typeof value === 'string') return value;
    return value?.large ?? value?.small ?? value?.thumb ?? null;
  }

  function firstUsableUrl(values: string[] | null | undefined) {
    return values?.find((value) => safeImageUrl(value) || value.startsWith('https://')) ?? null;
  }

  function errorText(value: unknown) {
    return value instanceof Error ? value.message : 'request failed';
  }

  function isNotFound(value: unknown) {
    return value instanceof OpenGeckoApiError && value.status === 404;
  }

  function resultValue<T>(result: PromiseSettledResult<T>) {
    return result.status === 'fulfilled' ? result.value : null;
  }

  function resultWarning<T>(label: string, result: PromiseSettledResult<T>) {
    return result.status === 'rejected' ? `${label}: ${errorText(result.reason)}` : null;
  }

  async function loadCoin(id = routeId) {
    const token = ++requestToken;
    loadedId = id;
    loading = true;
    notFound = false;
    error = '';
    partialWarnings = [];
    coin = null;
    marketCoin = null;
    chart = null;
    tickers = [];

    const marketPath = `/coins/markets?vs_currency=usd&ids=${encodeURIComponent(id)}&per_page=1&page=1&sparkline=true&price_change_percentage=1h,24h,7d,30d`;

    const [detailResult, marketResult, chartResult, tickersResult] = await Promise.allSettled([
      fetchJson<CoinDetail>(`/coins/${id}`),
      fetchJson<MarketCoin[]>(marketPath),
      fetchJson<MarketChart>(`/coins/${id}/market_chart?vs_currency=usd&days=7`),
      fetchJson<TickersPayload>(`/coins/${id}/tickers`)
    ]);

    if (token !== requestToken) return;

    const detail = resultValue(detailResult);
    const marketRows = resultValue(marketResult) ?? [];
    const chartPayload = resultValue(chartResult);
    const tickersPayload = resultValue(tickersResult);

    const detailReason = detailResult.status === 'rejected' ? detailResult.reason : null;
    const allRequestsFailed = detailResult.status === 'rejected' && marketResult.status === 'rejected' && chartResult.status === 'rejected' && tickersResult.status === 'rejected';

    if (allRequestsFailed && !isNotFound(detailReason)) {
      error = `Coin detail could not load from the OpenGecko API. ${errorText(detailResult.status === 'rejected' ? detailResult.reason : undefined)}`;
    } else if (isNotFound(detailReason) || (!detail && marketRows.length === 0 && marketResult.status === 'fulfilled')) {
      notFound = true;
    } else {
      coin = detail;
      marketCoin = marketRows[0] ?? null;
      chart = chartPayload;
      tickers = tickersPayload?.tickers ?? [];
      partialWarnings = [
        resultWarning('Detail payload', detailResult),
        resultWarning('Market context', marketResult),
        resultWarning('7-day chart', chartResult),
        resultWarning('Tickers', tickersResult)
      ].filter((value): value is string => Boolean(value));
    }

    loading = false;
  }
</script>

<svelte:head>
  <title>{displayName} · OpenGecko Coin Detail</title>
  <meta name="description" content={`OpenGecko frontend product view for ${displayName}, with explicit raw API access.`} />
</svelte:head>

<main class="og-shell min-h-screen text-[#f4f1e8]">
  <section class="relative border-b border-white/10 bg-[#07110f]/95">
    <div class="og-noise"></div>
    <div class="mx-auto flex max-w-[1320px] flex-wrap items-center gap-3 px-4 py-4">
      <a class="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.05] px-4 py-3 text-sm font-black text-[#cbd8d0] hover:text-white" href="/#markets">
        <ArrowLeft size={16} /> Back to dashboard
      </a>
      <span class="inline-flex items-center gap-2 rounded-full border border-[#b8ff4d]/30 bg-[#b8ff4d]/10 px-3 py-2 text-xs font-black uppercase tracking-[0.18em] text-[#b8ff4d]">
        <DatabaseZap size={14} /> Frontend coin route
      </span>
      <a class="ml-auto inline-flex items-center gap-2 rounded-2xl bg-[#b8ff4d] px-4 py-3 text-sm font-black text-[#07110f]" href={rawApiUrl(rawCoinPath)} target="_blank" rel="noreferrer">
        Open raw {rawCoinPath} <ExternalLink size={15} />
      </a>
    </div>
  </section>

  <section class="relative mx-auto max-w-[1320px] px-4 py-8">
    <div class="og-grid absolute inset-0 -z-10 opacity-60"></div>

    {#if loading}
      <div class="rounded-[2rem] border border-white/10 bg-[#0d1714]/95 p-8 shadow-2xl" aria-live="polite">
        <div class="flex items-center gap-3 text-xl font-black"><LoaderCircle class="animate-spin text-[#b8ff4d]" /> Loading coin detail route for {titleize(routeId)}...</div>
        <p class="mt-3 text-[#91a59a]">Fetching existing `/coins/{routeId}`, market context, 7-day chart, and tickers through the OpenGecko API.</p>
      </div>
    {:else if notFound}
      <div class="rounded-[2rem] border border-[#ffbf47]/30 bg-[#ffbf47]/10 p-8 shadow-2xl">
        <h1 class="text-4xl font-black tracking-[-0.06em] text-[#ffdf9b]">Coin not found</h1>
        <p class="mt-3 max-w-2xl text-[#ffe8b8]">OpenGecko did not return product data for `{routeId}` from the existing coin endpoints. Try another market row or return to the dashboard.</p>
        <div class="mt-6 flex flex-wrap gap-3">
          <button class="rounded-2xl border border-[#ffdf9b]/40 px-4 py-3 font-black text-[#ffdf9b]" type="button" on:click={() => void loadCoin()}>Retry coin route</button>
          <a class="rounded-2xl bg-[#b8ff4d] px-4 py-3 font-black text-[#07110f]" href="/#markets">Return to markets</a>
        </div>
      </div>
    {:else if error}
      <div class="rounded-[2rem] border border-[#ff5c5c]/30 bg-[#ff5c5c]/10 p-8 shadow-2xl">
        <h1 class="flex items-center gap-3 text-4xl font-black tracking-[-0.06em] text-[#ffc2c2]"><Server /> Coin route unavailable</h1>
        <p class="mt-3 max-w-2xl text-[#ffc2c2]">{error}</p>
        <div class="mt-6 flex flex-wrap gap-3">
          <button class="inline-flex items-center gap-2 rounded-2xl border border-[#ffc2c2]/40 px-4 py-3 font-black text-[#ffc2c2]" type="button" on:click={() => void loadCoin()}><RefreshCw size={16} /> Retry</button>
          <a class="rounded-2xl bg-[#b8ff4d] px-4 py-3 font-black text-[#07110f]" href="/#markets">Return to dashboard</a>
        </div>
      </div>
    {:else}
      <div class="mb-6 grid gap-5 lg:grid-cols-[1fr_360px]">
        <section class="relative overflow-hidden rounded-[2rem] border border-white/10 bg-[#0d1714]/95 p-6 shadow-2xl md:p-8">
          <div class="radar-orb"></div>
          <div class="relative z-10">
            <div class="mb-6 flex flex-wrap items-center gap-2">
              <span class="rounded-full border border-[#b8ff4d]/30 bg-[#b8ff4d]/10 px-3 py-1.5 text-xs font-black uppercase tracking-[0.18em] text-[#b8ff4d]">Product view, not raw JSON</span>
              <span class="rounded-full border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs font-black uppercase tracking-[0.18em] text-[#cbd8d0]">Coin ID {routeId}</span>
              <span class="rounded-full border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs font-black uppercase tracking-[0.18em] text-[#cbd8d0]">Rank #{rank ?? '-'}</span>
            </div>
            <div class="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
              <div class="min-w-0">
                <div class="mb-4 flex items-center gap-4">
                  {#if safeImageUrl(displayImage)}<img class="size-16 rounded-full bg-[#f4f1e8]" src={safeImageUrl(displayImage) ?? ''} alt="" />{:else}<span class="grid size-16 place-items-center rounded-full bg-[#b8ff4d] text-2xl font-black text-[#07110f]">{displaySymbol.slice(0, 2)}</span>{/if}
                  <div>
                    <p class="text-sm font-black uppercase tracking-[0.28em] text-[#ffbf47]">{displaySymbol}</p>
                    <h1 class="text-5xl font-black leading-none tracking-[-0.07em] md:text-7xl">{displayName}</h1>
                  </div>
                </div>
                <p class="max-w-3xl text-base leading-8 text-[#b7c8bf]">
                  {cleanedDescription || 'OpenGecko returned limited descriptive metadata for this asset. The route remains usable with market context, chart data, tickers, and raw API access from existing endpoints.'}
                </p>
              </div>
              <div class="rounded-[1.5rem] border border-[#b8ff4d]/20 bg-black/30 p-5 text-right">
                <div class="text-sm font-black uppercase tracking-[0.2em] text-[#91a59a]">USD Price</div>
                <div class="text-4xl font-black tracking-[-0.06em]">{money(currentPrice)}</div>
                <div class={change24h == null || change24h >= 0 ? 'mt-2 font-black text-[#b8ff4d]' : 'mt-2 font-black text-[#ff5c5c]'}>{percent(change24h)} 24h</div>
              </div>
            </div>
          </div>
        </section>

        <aside class="grid gap-3">
          <div class="terminal-card">
            <div class="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#91a59a]"><Activity size={15} /> Market cap</div>
            <div class="text-2xl font-black">{money(marketCap, true)}</div>
          </div>
          <div class="terminal-card">
            <div class="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#91a59a]"><BarChart3 size={15} /> 24h volume</div>
            <div class="text-2xl font-black">{money(volume, true)}</div>
          </div>
          <div class="terminal-card">
            <div class="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#91a59a]"><TrendingUp size={15} /> Range</div>
            <div class="text-sm font-bold text-[#cbd8d0]">High {money(high24h)} · Low {money(low24h)}</div>
          </div>
        </aside>
      </div>

      {#if partialWarnings.length > 0}
        <div class="mb-6 rounded-2xl border border-[#ffbf47]/30 bg-[#ffbf47]/10 px-4 py-3 text-sm font-bold text-[#ffe0a3]">
          Some existing endpoint data is degraded, so this page is showing the available pieces only: {partialWarnings.join('; ')}.
        </div>
      {/if}

      <div class="grid gap-5 lg:grid-cols-[1.25fr_0.75fr]">
        <section class="rounded-[2rem] border border-white/10 bg-[#0d1714]/95 p-6 shadow-xl">
          <div class="mb-5 flex items-center justify-between">
            <div>
              <h2 class="text-2xl font-black tracking-[-0.05em]">7-day chart trace</h2>
              <p class="mt-1 text-sm text-[#91a59a]">Existing `/coins/{routeId}/market_chart` prices, with market-row sparkline fallback.</p>
            </div>
            <a class="rounded-full border border-[#b8ff4d]/30 px-3 py-1 text-xs font-black text-[#b8ff4d]" href={rawApiUrl(rawChartPath)} target="_blank" rel="noreferrer">Open raw {rawChartPath}</a>
          </div>
          {#if sparkPath(chartValues)}
            <svg class="h-52 w-full" viewBox="0 0 220 72" role="img" aria-label={`${displayName} 7-day chart`}>
              <path d={sparkPath(chartValues)} fill="none" stroke={change24h == null || change24h >= 0 ? '#b8ff4d' : '#ff5c5c'} stroke-linecap="round" stroke-width="2.8" />
            </svg>
            <div class="mt-3 text-sm font-bold text-[#91a59a]">Latest chart price {money(latestChartPrice ?? currentPrice)} · {numberText(chart?.prices?.length ?? chartValues.length)} points</div>
          {:else}
            <div class="rounded-2xl border border-white/10 bg-white/[0.04] p-5 text-sm font-bold text-[#91a59a]">No chart points were available from the existing chart endpoint for this coin.</div>
          {/if}
        </section>

        <section class="rounded-[2rem] border border-white/10 bg-[#f4f1e8] p-6 text-[#07110f] shadow-xl">
          <div class="mb-5 flex items-center justify-between">
            <h2 class="text-2xl font-black tracking-[-0.05em]">Ticker venues</h2>
            <a class="rounded-full bg-[#07110f] px-3 py-1 text-xs font-black text-[#b8ff4d]" href={rawApiUrl(rawTickersPath)} target="_blank" rel="noreferrer">Open raw {rawTickersPath}</a>
          </div>
          <div class="space-y-2">
            {#each tickers.slice(0, 6) as ticker}
              <div class="flex items-center justify-between gap-3 rounded-2xl bg-white/65 p-3">
                <div class="min-w-0">
                  <div class="truncate font-black">{ticker.market?.name ?? ticker.market?.identifier ?? 'Unknown venue'}</div>
                  <div class="text-xs font-black uppercase text-[#617269]">{ticker.base ?? displaySymbol}/{ticker.target ?? 'USD'} · {ticker.trust_score ?? 'unscored'}</div>
                </div>
                <div class="text-right font-black">{money(ticker.converted_last?.usd ?? ticker.last)}</div>
              </div>
            {:else}
              <div class="rounded-2xl bg-white/65 p-4 text-sm font-bold text-[#617269]">The existing tickers endpoint returned no venues for this asset. The route stays recoverable and links the raw endpoint above.</div>
            {/each}
          </div>
        </section>
      </div>

      <section class="mt-6 rounded-[2rem] border border-[#b8ff4d]/20 bg-[#07110f] p-6 shadow-[0_0_70px_rgba(184,255,77,0.08)]">
        <div class="grid gap-5 lg:grid-cols-[1fr_1.2fr]">
          <div>
            <h2 class="flex items-center gap-2 text-2xl font-black tracking-[-0.05em]"><ShieldCheck size={22} /> Route provenance</h2>
            <p class="mt-2 text-sm leading-7 text-[#91a59a]">This frontend-owned product route composes existing OpenGecko API data only. Raw JSON remains available through explicit links.</p>
          </div>
          <div class="grid gap-3 sm:grid-cols-3">
            <a class="terminal-card block text-[#b8ff4d]" href={rawApiUrl(rawCoinPath)} target="_blank" rel="noreferrer">Open raw {rawCoinPath}</a>
            <a class="terminal-card block text-[#b8ff4d]" href={rawApiUrl(rawChartPath)} target="_blank" rel="noreferrer">Open raw chart API</a>
            <a class="terminal-card block text-[#b8ff4d]" href={rawApiUrl(rawTickersPath)} target="_blank" rel="noreferrer">Open raw tickers API</a>
          </div>
        </div>
        <div class="mt-4 flex flex-wrap gap-2 text-xs font-black uppercase tracking-[0.14em] text-[#91a59a]">
          {#if homepage}<a class="rounded-full border border-white/10 px-3 py-2 hover:text-white" href={homepage} target="_blank" rel="noreferrer">Homepage</a>{/if}
          {#if github}<a class="rounded-full border border-white/10 px-3 py-2 hover:text-white" href={github} target="_blank" rel="noreferrer">Repository</a>{/if}
          {#if explorer}<a class="rounded-full border border-white/10 px-3 py-2 hover:text-white" href={explorer} target="_blank" rel="noreferrer">Explorer</a>{/if}
          {#each coin?.categories?.slice(0, 4) ?? [] as category}
            <span class="rounded-full border border-white/10 px-3 py-2">{category}</span>
          {/each}
          {#if coin?.genesis_date}<span class="rounded-full border border-white/10 px-3 py-2">Genesis {coin.genesis_date}</span>{/if}
          {#if coin?.hashing_algorithm}<span class="rounded-full border border-white/10 px-3 py-2">{coin.hashing_algorithm}</span>{/if}
        </div>
      </section>
    {/if}
  </section>
</main>
