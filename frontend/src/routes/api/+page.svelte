<script lang="ts">
  import { browser } from '$app/environment';
  import { onDestroy } from 'svelte';
  import { ArrowLeft, BookOpen, Check, DatabaseZap, ExternalLink, LoaderCircle, RefreshCw, Server, ShieldCheck } from 'lucide-svelte';
  import { apiBase, apiUrl, rawApiUrl } from '$lib/api';

  type ApiRoute = {
    path: string;
    purpose: string;
    usedBy: string;
    productPath: string;
  };
  type ApiRouteStatus = ApiRoute & {
    ok: boolean;
    status: number | null;
    snippet: string;
  };

  const routes: ApiRoute[] = [
    {
      path: '/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=5&page=1&sparkline=true&price_change_percentage=1h,24h,7d,30d',
      purpose: 'Market table, dashboard search pool, compare bench, portfolio pricing, and coin detail market context.',
      usedBy: 'Dashboard · coin detail',
      productPath: '/#markets'
    },
    {
      path: '/search/trending?show_max=5',
      purpose: 'Search Heat and discovery context for dashboard users.',
      usedBy: 'Dashboard discovery',
      productPath: '/#discover'
    },
    {
      path: '/global',
      purpose: 'Global market cap, volume, active coin count, and dominance summary.',
      usedBy: 'Dashboard header',
      productPath: '/'
    },
    {
      path: '/coins/categories?per_page=8&page=1',
      purpose: 'Category overview cards with market cap, 24h change, liquidity, and leaders.',
      usedBy: 'Dashboard category cards · categories route',
      productPath: '/categories'
    },
    {
      path: '/exchanges?per_page=8&page=1',
      purpose: 'Exchange quality list and exchange-detail list context.',
      usedBy: 'Dashboard exchange cards · exchange detail',
      productPath: '/#exchanges'
    },
    {
      path: '/diagnostics/runtime',
      purpose: 'Readiness, provider status, freshness, cache revision, and runtime operator context.',
      usedBy: 'Dashboard status card · status route',
      productPath: '/status'
    },
    {
      path: '/ping',
      purpose: 'Minimal liveness proof used by status and raw API affordances.',
      usedBy: 'Header · status route',
      productPath: '/status'
    }
  ];

  let statuses: ApiRouteStatus[] = [];
  let loading = true;
  let error = '';
  let checkedAt = '';
  let requestToken = 0;

  $: okCount = statuses.filter((status) => status.ok).length;
  $: effectiveBase = apiBase === '/__opengecko_api' ? 'frontend relative proxy /__opengecko_api → configured OpenGecko API' : apiBase;

  if (browser) {
    void checkRoutes();
  }

  onDestroy(() => {
    requestToken += 1;
  });

  function summarizePayload(payload: unknown) {
    if (Array.isArray(payload)) return `${payload.length} array item${payload.length === 1 ? '' : 's'}`;
    if (!payload || typeof payload !== 'object') return String(payload ?? 'empty response');

    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.data)) return `data array with ${record.data.length} item${record.data.length === 1 ? '' : 's'}`;
    if (record.data && typeof record.data === 'object') {
      return `data fields: ${Object.keys(record.data as Record<string, unknown>).slice(0, 6).join(', ') || 'none'}`;
    }
    if (Array.isArray(record.coins)) return `coins: ${record.coins.length}, categories: ${Array.isArray(record.categories) ? record.categories.length : 0}`;
    if (typeof record.gecko_says === 'string') return record.gecko_says;
    return `fields: ${Object.keys(record).slice(0, 6).join(', ') || 'none'}`;
  }

  async function checkRoute(route: ApiRoute): Promise<ApiRouteStatus> {
    try {
      const response = await fetch(apiUrl(route.path), {
        cache: 'no-store',
        headers: {
          accept: 'application/json'
        }
      });

      let snippet = response.ok ? 'JSON response available' : `Request returned ${response.status}`;
      try {
        snippet = summarizePayload(await response.json());
      } catch {
        if (response.ok) snippet = 'Response was not JSON-decodable in the browser.';
      }

      return {
        ...route,
        ok: response.ok,
        status: response.status,
        snippet
      };
    } catch (caught) {
      return {
        ...route,
        ok: false,
        status: null,
        snippet: caught instanceof Error ? caught.message : 'request failed'
      };
    }
  }

  async function checkRoutes() {
    const token = ++requestToken;
    loading = true;
    error = '';

    try {
      statuses = await Promise.all(routes.map(checkRoute));
      checkedAt = new Date().toLocaleTimeString();
      if (statuses.every((status) => !status.ok)) {
        error = `No UI-used API routes responded through ${effectiveBase}. Start the API and retry this frontend-owned explorer.`;
      }
    } catch (caught) {
      if (token !== requestToken) return;
      error = caught instanceof Error ? caught.message : 'route checks failed';
    } finally {
      if (token === requestToken) loading = false;
    }
  }
</script>

<svelte:head>
  <title>API Explorer · OpenGecko</title>
  <meta name="description" content="Frontend-owned OpenGecko API proof and explorer for UI-used existing endpoints." />
</svelte:head>

<main class="og-shell min-h-screen text-[#f4f1e8]">
  <section class="relative border-b border-white/10 bg-[#07110f]/95">
    <div class="og-noise"></div>
    <div class="mx-auto flex max-w-[1320px] flex-wrap items-center gap-3 px-4 py-4">
      <a class="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.05] px-4 py-3 text-sm font-black text-[#cbd8d0] hover:text-white" href="/#api">
        <ArrowLeft size={16} /> Back to dashboard
      </a>
      <span class="inline-flex items-center gap-2 rounded-full border border-[#b8ff4d]/30 bg-[#b8ff4d]/10 px-3 py-2 text-xs font-black uppercase tracking-[0.18em] text-[#b8ff4d]">
        <DatabaseZap size={14} /> Frontend API proof
      </span>
      <button class="ml-auto inline-flex items-center gap-2 rounded-2xl bg-[#b8ff4d] px-4 py-3 text-sm font-black text-[#07110f] disabled:opacity-60" type="button" disabled={loading} on:click={() => void checkRoutes()}>
        {#if loading}<LoaderCircle class="animate-spin" size={15} />{:else}<RefreshCw size={15} />{/if}
        {loading ? 'Checking routes' : 'Recheck routes'}
      </button>
    </div>
  </section>

  <section class="relative mx-auto max-w-[1320px] px-4 py-8">
    <div class="og-grid absolute inset-0 -z-10 opacity-60"></div>

    <section class="relative mb-6 overflow-hidden rounded-[2rem] border border-white/10 bg-[#0d1714]/95 p-6 shadow-2xl md:p-8">
      <div class="radar-orb"></div>
      <div class="relative z-10 grid gap-8 lg:grid-cols-[1fr_380px] lg:items-end">
        <div>
          <p class="mb-3 text-sm font-black uppercase tracking-[0.32em] text-[#ffbf47]">Route proof</p>
          <h1 class="max-w-4xl text-5xl font-black leading-[0.9] tracking-[-0.07em] md:text-7xl">The UI route map with raw endpoints separated.</h1>
          <p class="mt-6 max-w-3xl text-base leading-8 text-[#b7c8bf]">
            This explorer checks existing endpoints already used by the dashboard and route polish surfaces. Product links stay in frontend-owned views; raw JSON links are explicit and labeled with concrete paths.
          </p>
        </div>
        <div class="rounded-[1.5rem] border border-[#b8ff4d]/20 bg-black/30 p-5">
          <div class="text-xs font-black uppercase tracking-[0.18em] text-[#91a59a]">Approved base/proxy behavior</div>
          <div class="mt-3 break-words font-mono text-sm font-bold text-[#b8ff4d]">{effectiveBase}</div>
          <div class="mt-3 text-xs font-bold uppercase tracking-[0.12em] text-[#91a59a]">Checked {okCount}/{statuses.length || routes.length} routes · {checkedAt || 'pending'}</div>
        </div>
      </div>
    </section>

    {#if loading && statuses.length === 0}
      <div class="rounded-[2rem] border border-white/10 bg-[#0d1714]/95 p-8 shadow-2xl" aria-live="polite">
        <div class="flex items-center gap-3 text-xl font-black"><LoaderCircle class="animate-spin text-[#b8ff4d]" /> Checking UI-used API routes...</div>
        <p class="mt-3 text-[#91a59a]">Fetching existing OpenGecko endpoints through the same browser API base that frontend route code uses.</p>
      </div>
    {:else}
      {#if error}
        <div class="mb-6 rounded-[2rem] border border-[#ff5c5c]/30 bg-[#ff5c5c]/10 p-6">
          <h2 class="flex items-center gap-3 text-3xl font-black tracking-[-0.06em] text-[#ffc2c2]"><Server /> API proof degraded</h2>
          <p class="mt-2 text-[#ffc2c2]">{error}</p>
        </div>
      {/if}

      <div class="mb-6 grid gap-3 sm:grid-cols-3">
        <div class="terminal-card"><div class="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#91a59a]"><Check size={15} /> Responding</div><div class="text-3xl font-black">{okCount}</div></div>
        <div class="terminal-card"><div class="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#91a59a]"><BookOpen size={15} /> Catalogued</div><div class="text-3xl font-black">{routes.length}</div></div>
        <div class="terminal-card"><div class="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#91a59a]"><ShieldCheck size={15} /> Backend changes</div><div class="text-3xl font-black">0</div></div>
      </div>

      <section class="grid gap-4">
        {#each (statuses.length ? statuses : routes.map((route) => ({ ...route, ok: false, status: null, snippet: 'Not checked yet.' }))) as route}
          <article class="rounded-[1.75rem] border border-white/10 bg-[#0d1714]/95 p-5 shadow-xl">
            <div class="grid gap-4 lg:grid-cols-[1fr_220px] lg:items-start">
              <div>
                <div class="mb-2 flex flex-wrap items-center gap-2">
                  <span class={route.ok ? 'rounded-full border border-[#b8ff4d]/30 bg-[#b8ff4d]/10 px-3 py-1 text-xs font-black uppercase tracking-[0.14em] text-[#b8ff4d]' : 'rounded-full border border-[#ffbf47]/30 bg-[#ffbf47]/10 px-3 py-1 text-xs font-black uppercase tracking-[0.14em] text-[#ffdf9b]'}>
                    {route.status == null ? 'not connected' : `HTTP ${route.status}`}
                  </span>
                  <span class="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-black uppercase tracking-[0.14em] text-[#91a59a]">{route.usedBy}</span>
                </div>
                <h2 class="break-words font-mono text-xl font-black text-[#f4f1e8]">{route.path}</h2>
                <p class="mt-3 max-w-3xl text-sm leading-7 text-[#91a59a]">{route.purpose}</p>
                <div class="mt-3 rounded-2xl border border-white/10 bg-white/[0.04] p-3 text-sm font-bold text-[#cbd8d0]">Result snippet: {route.snippet}</div>
              </div>
              <div class="grid gap-2">
                <a class="rounded-2xl bg-[#b8ff4d] px-4 py-3 text-center text-sm font-black text-[#07110f]" href={route.productPath}>Open product view</a>
                <a class="rounded-2xl border border-[#b8ff4d]/30 px-4 py-3 text-center text-sm font-black text-[#b8ff4d]" href={rawApiUrl(route.path)} target="_blank" rel="noreferrer">Open raw API {route.path.split('?')[0]} <ExternalLink class="inline" size={14} /></a>
              </div>
            </div>
          </article>
        {/each}
      </section>

      <section class="mt-6 rounded-[2rem] border border-[#b8ff4d]/20 bg-[#07110f] p-6 shadow-[0_0_70px_rgba(184,255,77,0.08)]">
        <div class="grid gap-5 lg:grid-cols-[1fr_1.2fr]">
          <div>
            <h2 class="text-2xl font-black tracking-[-0.05em]">Explorer assumptions</h2>
            <p class="mt-2 text-sm leading-7 text-[#91a59a]">
              The default browser API base is the frontend-relative proxy `/__opengecko_api`; raw API links use the configured raw base when present, otherwise the same approved proxy/base. No route listed here requires a new backend endpoint.
            </p>
          </div>
          <div class="grid gap-3 sm:grid-cols-3">
            <a class="terminal-card block text-[#b8ff4d]" href="/categories">Frontend categories</a>
            <a class="terminal-card block text-[#b8ff4d]" href="/status">Frontend status</a>
            <a class="terminal-card block text-[#b8ff4d]" href={rawApiUrl('/ping')} target="_blank" rel="noreferrer">Open raw /ping</a>
          </div>
        </div>
      </section>
    {/if}
  </section>
</main>
