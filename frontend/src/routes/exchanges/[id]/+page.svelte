<script lang="ts">
  import { browser } from '$app/environment';
  import { page } from '$app/stores';
  import { onDestroy } from 'svelte';
  import { ArrowLeft, BarChart3, BriefcaseBusiness, DatabaseZap, ExternalLink, Globe2, LoaderCircle, RefreshCw, Server, ShieldCheck, Star } from 'lucide-svelte';
  import { fetchJson, OpenGeckoApiError, rawApiUrl } from '$lib/api';
  import { money, numberText, safeImageUrl } from '$lib/format';

  type ExchangeTicker = {
    base?: string | null;
    target?: string | null;
    coin_id?: string | null;
    trust_score?: string | null;
    last?: number | null;
    volume?: number | null;
    converted_last?: Record<string, number | null> | null;
    converted_volume?: Record<string, number | null> | null;
  };
  type ExchangeDetail = {
    id?: string;
    name?: string | null;
    image?: string | null;
    year_established?: number | null;
    country?: string | null;
    description?: string | null;
    url?: string | null;
    trust_score?: number | null;
    trust_score_rank?: number | null;
    trade_volume_24h_btc?: number | null;
    tickers?: ExchangeTicker[] | null;
  };
  type ExchangeListRow = {
    id: string;
    name?: string | null;
    image?: string | null;
    trust_score?: number | null;
    trust_score_rank?: number | null;
    trade_volume_24h_btc?: number | null;
  };

  let exchange: ExchangeDetail | null = null;
  let listRow: ExchangeListRow | null = null;
  let loading = true;
  let notFound = false;
  let error = '';
  let partialWarnings: string[] = [];
  let loadedId = '';
  let requestToken = 0;

  $: routeId = $page.params.id ?? '';
  $: rawExchangePath = routeId ? `/exchanges/${routeId}` : '/exchanges/{id}';
  $: displayName = exchange?.name ?? listRow?.name ?? titleize(routeId);
  $: displayImage = exchange?.image ?? listRow?.image ?? null;
  $: trustScore = exchange?.trust_score ?? listRow?.trust_score ?? null;
  $: trustRank = exchange?.trust_score_rank ?? listRow?.trust_score_rank ?? null;
  $: volumeBtc = exchange?.trade_volume_24h_btc ?? listRow?.trade_volume_24h_btc ?? null;
  $: tickers = exchange?.tickers ?? [];
  $: cleanedDescription = cleanText(exchange?.description);

  $: if (browser && routeId && routeId !== loadedId) {
    void loadExchange(routeId);
  }

  onDestroy(() => {
    requestToken += 1;
  });

  function titleize(value: string) {
    return value
      .split('-')
      .filter(Boolean)
      .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
      .join(' ') || 'Unknown exchange';
  }

  function cleanText(value: string | null | undefined) {
    return value?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() ?? '';
  }

  function isNotFound(value: unknown) {
    return value instanceof OpenGeckoApiError && value.status === 404;
  }

  function errorText(value: unknown) {
    return value instanceof Error ? value.message : 'request failed';
  }

  function resultValue<T>(result: PromiseSettledResult<T>) {
    return result.status === 'fulfilled' ? result.value : null;
  }

  function resultWarning<T>(label: string, result: PromiseSettledResult<T>) {
    return result.status === 'rejected' ? `${label}: ${errorText(result.reason)}` : null;
  }

  async function loadExchange(id = routeId) {
    const token = ++requestToken;
    loadedId = id;
    loading = true;
    notFound = false;
    error = '';
    partialWarnings = [];
    exchange = null;
    listRow = null;

    const [detailResult, listResult] = await Promise.allSettled([
      fetchJson<ExchangeDetail>(`/exchanges/${id}`),
      fetchJson<ExchangeListRow[]>('/exchanges?per_page=100&page=1')
    ]);

    if (token !== requestToken) return;

    const detail = resultValue(detailResult);
    const rows = resultValue(listResult) ?? [];
    const matchedRow = rows.find((row) => row.id === id) ?? null;

    const detailReason = detailResult.status === 'rejected' ? detailResult.reason : null;

    if (detailResult.status === 'rejected' && listResult.status === 'rejected' && !isNotFound(detailReason)) {
      error = `Exchange detail could not load from the OpenGecko API. ${errorText(detailResult.status === 'rejected' ? detailResult.reason : undefined)}`;
    } else if (isNotFound(detailReason) || (!detail && !matchedRow && listResult.status === 'fulfilled')) {
      notFound = true;
    } else {
      exchange = detail;
      listRow = matchedRow;
      partialWarnings = [
        resultWarning('Detail payload', detailResult),
        resultWarning('Exchange list context', listResult)
      ].filter((value): value is string => Boolean(value));
    }

    loading = false;
  }
</script>

<svelte:head>
  <title>{displayName} · OpenGecko Exchange Detail</title>
  <meta name="description" content={`OpenGecko frontend product view for ${displayName}, with explicit raw API access.`} />
</svelte:head>

<main class="og-shell min-h-screen text-[#f4f1e8]">
  <section class="relative border-b border-white/10 bg-[#07110f]/95">
    <div class="og-noise"></div>
    <div class="mx-auto flex max-w-[1320px] flex-wrap items-center gap-3 px-4 py-4">
      <a class="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.05] px-4 py-3 text-sm font-black text-[#cbd8d0] hover:text-white" href="/#exchanges">
        <ArrowLeft size={16} /> Back to exchanges
      </a>
      <span class="inline-flex items-center gap-2 rounded-full border border-[#b8ff4d]/30 bg-[#b8ff4d]/10 px-3 py-2 text-xs font-black uppercase tracking-[0.18em] text-[#b8ff4d]">
        <DatabaseZap size={14} /> Frontend exchange route
      </span>
      <a class="ml-auto inline-flex items-center gap-2 rounded-2xl bg-[#b8ff4d] px-4 py-3 text-sm font-black text-[#07110f]" href={rawApiUrl(rawExchangePath)} target="_blank" rel="noreferrer">
        Open raw {rawExchangePath} <ExternalLink size={15} />
      </a>
    </div>
  </section>

  <section class="relative mx-auto max-w-[1320px] px-4 py-8">
    <div class="og-grid absolute inset-0 -z-10 opacity-60"></div>

    {#if loading}
      <div class="rounded-[2rem] border border-white/10 bg-[#0d1714]/95 p-8 shadow-2xl" aria-live="polite">
        <div class="flex items-center gap-3 text-xl font-black"><LoaderCircle class="animate-spin text-[#b8ff4d]" /> Loading exchange detail route for {titleize(routeId)}...</div>
        <p class="mt-3 text-[#91a59a]">Fetching existing `/exchanges/{routeId}` data and exchange-list context through the OpenGecko API.</p>
      </div>
    {:else if notFound}
      <div class="rounded-[2rem] border border-[#ffbf47]/30 bg-[#ffbf47]/10 p-8 shadow-2xl">
        <h1 class="text-4xl font-black tracking-[-0.06em] text-[#ffdf9b]">Exchange not found</h1>
        <p class="mt-3 max-w-2xl text-[#ffe8b8]">OpenGecko did not return product data for `{routeId}` from the existing exchange endpoints. Try a listed exchange or return to the dashboard.</p>
        <div class="mt-6 flex flex-wrap gap-3">
          <button class="rounded-2xl border border-[#ffdf9b]/40 px-4 py-3 font-black text-[#ffdf9b]" type="button" on:click={() => void loadExchange()}>Retry exchange route</button>
          <a class="rounded-2xl bg-[#b8ff4d] px-4 py-3 font-black text-[#07110f]" href="/#exchanges">Return to exchanges</a>
        </div>
      </div>
    {:else if error}
      <div class="rounded-[2rem] border border-[#ff5c5c]/30 bg-[#ff5c5c]/10 p-8 shadow-2xl">
        <h1 class="flex items-center gap-3 text-4xl font-black tracking-[-0.06em] text-[#ffc2c2]"><Server /> Exchange route unavailable</h1>
        <p class="mt-3 max-w-2xl text-[#ffc2c2]">{error}</p>
        <div class="mt-6 flex flex-wrap gap-3">
          <button class="inline-flex items-center gap-2 rounded-2xl border border-[#ffc2c2]/40 px-4 py-3 font-black text-[#ffc2c2]" type="button" on:click={() => void loadExchange()}><RefreshCw size={16} /> Retry</button>
          <a class="rounded-2xl bg-[#b8ff4d] px-4 py-3 font-black text-[#07110f]" href="/#exchanges">Return to dashboard</a>
        </div>
      </div>
    {:else}
      <div class="mb-6 grid gap-5 lg:grid-cols-[1fr_360px]">
        <section class="relative overflow-hidden rounded-[2rem] border border-white/10 bg-[#0d1714]/95 p-6 shadow-2xl md:p-8">
          <div class="radar-orb"></div>
          <div class="relative z-10">
            <div class="mb-6 flex flex-wrap items-center gap-2">
              <span class="rounded-full border border-[#b8ff4d]/30 bg-[#b8ff4d]/10 px-3 py-1.5 text-xs font-black uppercase tracking-[0.18em] text-[#b8ff4d]">Product view, not raw JSON</span>
              <span class="rounded-full border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs font-black uppercase tracking-[0.18em] text-[#cbd8d0]">Exchange ID {routeId}</span>
              <span class="rounded-full border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs font-black uppercase tracking-[0.18em] text-[#cbd8d0]">Trust rank #{trustRank ?? '-'}</span>
            </div>
            <div class="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
              <div class="min-w-0">
                <div class="mb-4 flex items-center gap-4">
                  {#if safeImageUrl(displayImage)}<img class="size-16 rounded-full bg-[#f4f1e8]" src={safeImageUrl(displayImage) ?? ''} alt="" />{:else}<span class="grid size-16 place-items-center rounded-full bg-[#b8ff4d] text-2xl font-black text-[#07110f]">{displayName.slice(0, 2).toUpperCase()}</span>{/if}
                  <div>
                    <p class="text-sm font-black uppercase tracking-[0.28em] text-[#ffbf47]">Exchange venue</p>
                    <h1 class="text-5xl font-black leading-none tracking-[-0.07em] md:text-7xl">{displayName}</h1>
                  </div>
                </div>
                <p class="max-w-3xl text-base leading-8 text-[#b7c8bf]">
                  {cleanedDescription || 'OpenGecko returned limited descriptive metadata for this venue. The route remains usable with exchange identity, trust context, normalized volume, ticker previews, and explicit raw API access.'}
                </p>
              </div>
              <div class="rounded-[1.5rem] border border-[#b8ff4d]/20 bg-black/30 p-5 text-right">
                <div class="text-sm font-black uppercase tracking-[0.2em] text-[#91a59a]">Trust score</div>
                <div class="text-4xl font-black tracking-[-0.06em]">{trustScore ?? '-'}</div>
                <div class="mt-2 font-black text-[#b8ff4d]">Rank #{trustRank ?? '-'}</div>
              </div>
            </div>
          </div>
        </section>

        <aside class="grid gap-3">
          <div class="terminal-card">
            <div class="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#91a59a]"><BarChart3 size={15} /> Normalized volume</div>
            <div class="text-2xl font-black">{numberText(volumeBtc)} BTC</div>
          </div>
          <div class="terminal-card">
            <div class="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#91a59a]"><Globe2 size={15} /> Country</div>
            <div class="text-2xl font-black">{exchange?.country ?? '-'}</div>
          </div>
          <div class="terminal-card">
            <div class="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#91a59a]"><Star size={15} /> Established</div>
            <div class="text-2xl font-black">{exchange?.year_established ?? '-'}</div>
          </div>
        </aside>
      </div>

      {#if partialWarnings.length > 0}
        <div class="mb-6 rounded-2xl border border-[#ffbf47]/30 bg-[#ffbf47]/10 px-4 py-3 text-sm font-bold text-[#ffe0a3]">
          Some existing exchange data is degraded, so this page is showing available pieces only: {partialWarnings.join('; ')}.
        </div>
      {/if}

      <div class="grid gap-5 lg:grid-cols-[0.85fr_1.15fr]">
        <section class="rounded-[2rem] border border-white/10 bg-[#f4f1e8] p-6 text-[#07110f] shadow-xl">
          <h2 class="flex items-center gap-2 text-2xl font-black tracking-[-0.05em]"><BriefcaseBusiness size={22} /> Exchange context</h2>
          <div class="mt-5 grid gap-3">
            <div class="rounded-2xl bg-white/70 p-4">
              <div class="text-xs font-black uppercase tracking-[0.16em] text-[#617269]">Endpoint</div>
              <div class="mt-1 font-black">{rawExchangePath}</div>
            </div>
            <div class="rounded-2xl bg-white/70 p-4">
              <div class="text-xs font-black uppercase tracking-[0.16em] text-[#617269]">Website</div>
              {#if exchange?.url}
                <a class="mt-1 inline-flex items-center gap-2 font-black text-[#244d16]" href={exchange.url} target="_blank" rel="noreferrer">Open exchange website <ExternalLink size={14} /></a>
              {:else}
                <div class="mt-1 font-bold text-[#617269]">No website URL in the current payload.</div>
              {/if}
            </div>
            <a class="rounded-2xl bg-[#07110f] p-4 font-black text-[#b8ff4d]" href={rawApiUrl(rawExchangePath)} target="_blank" rel="noreferrer">Open raw {rawExchangePath}</a>
          </div>
        </section>

        <section class="rounded-[2rem] border border-white/10 bg-[#0d1714]/95 p-6 shadow-xl">
          <div class="mb-5 flex items-center justify-between">
            <div>
              <h2 class="text-2xl font-black tracking-[-0.05em]">Top ticker preview</h2>
              <p class="mt-1 text-sm text-[#91a59a]">Ticker rows included in the existing exchange detail payload when available.</p>
            </div>
            <a class="rounded-full border border-[#b8ff4d]/30 px-3 py-1 text-xs font-black text-[#b8ff4d]" href={rawApiUrl(rawExchangePath)} target="_blank" rel="noreferrer">Open raw exchange API</a>
          </div>
          <div class="grid gap-2">
            {#each tickers.slice(0, 8) as ticker}
              <div class="grid gap-2 rounded-2xl border border-white/10 bg-white/[0.04] p-3 sm:grid-cols-[1fr_1fr_1fr] sm:items-center">
                <div class="font-black">{ticker.base ?? ticker.coin_id ?? 'Asset'}/{ticker.target ?? 'Quote'}</div>
                <div class="text-sm font-bold text-[#91a59a]">Last {money(ticker.converted_last?.usd ?? ticker.last)}</div>
                <div class="text-right text-sm font-bold text-[#91a59a]">Vol {money(ticker.converted_volume?.usd ?? ticker.volume, true)} · {ticker.trust_score ?? 'unscored'}</div>
              </div>
            {:else}
              <div class="rounded-2xl border border-white/10 bg-white/[0.04] p-5 text-sm font-bold text-[#91a59a]">The current `/exchanges/{routeId}` payload did not include ticker rows. Rank, trust, and normalized volume context remain visible when available.</div>
            {/each}
          </div>
        </section>
      </div>

      <section class="mt-6 rounded-[2rem] border border-[#b8ff4d]/20 bg-[#07110f] p-6 shadow-[0_0_70px_rgba(184,255,77,0.08)]">
        <div class="grid gap-5 lg:grid-cols-[1fr_1.2fr]">
          <div>
            <h2 class="flex items-center gap-2 text-2xl font-black tracking-[-0.05em]"><ShieldCheck size={22} /> Route provenance</h2>
            <p class="mt-2 text-sm leading-7 text-[#91a59a]">This frontend-owned exchange route composes existing `/exchanges/{routeId}` data and the dashboard exchange list only. Raw JSON is intentionally separate.</p>
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <a class="terminal-card block text-[#b8ff4d]" href={rawApiUrl(rawExchangePath)} target="_blank" rel="noreferrer">Open raw {rawExchangePath}</a>
            <a class="terminal-card block text-[#b8ff4d]" href={rawApiUrl('/exchanges?per_page=100&page=1')} target="_blank" rel="noreferrer">Open raw /exchanges list context</a>
          </div>
        </div>
      </section>
    {/if}
  </section>
</main>
