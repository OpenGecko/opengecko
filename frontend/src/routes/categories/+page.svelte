<script lang="ts">
  import { browser } from '$app/environment';
  import { onDestroy } from 'svelte';
  import { ArrowLeft, BarChart3, DatabaseZap, ExternalLink, Layers3, LoaderCircle, RefreshCw, Server, ShieldCheck, TrendingUp } from 'lucide-svelte';
  import { fetchJson, rawApiUrl } from '$lib/api';
  import { money, numberText, percent, safeImageUrl } from '$lib/format';

  type Category = {
    id: string;
    name: string;
    market_cap?: number | null;
    market_cap_change_24h?: number | null;
    volume_24h?: number | null;
    content?: string | null;
    top_3_coins?: string[] | null;
    top_3_coins_id?: string[] | null;
    updated_at?: string | null;
  };
  type CategoriesPayload = { data?: Category[]; meta?: { count?: number; source?: string; updated_at?: string } } | Category[];

  let categories: Category[] = [];
  let meta: { count?: number; source?: string; updated_at?: string } | null = null;
  let loading = true;
  let error = '';
  let loaded = false;
  let requestToken = 0;

  const rawCategoriesPath = '/coins/categories?per_page=50&page=1';

  $: totalMarketCap = categories.reduce((sum, category) => sum + (category.market_cap ?? 0), 0);
  $: totalVolume = categories.reduce((sum, category) => sum + (category.volume_24h ?? 0), 0);
  $: positiveCategories = categories.filter((category) => (category.market_cap_change_24h ?? 0) >= 0).length;
  $: strongestCategories = [...categories]
    .sort((left, right) => (right.market_cap_change_24h ?? -Infinity) - (left.market_cap_change_24h ?? -Infinity))
    .slice(0, 6);

  if (browser) {
    void loadCategories();
  }

  onDestroy(() => {
    requestToken += 1;
  });

  function normalizePayload(payload: CategoriesPayload) {
    if (Array.isArray(payload)) {
      categories = payload;
      meta = null;
      return;
    }

    categories = payload.data ?? [];
    meta = payload.meta ?? null;
  }

  function cleanText(value: string | null | undefined) {
    return value?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() ?? '';
  }

  function categorySlugLabel(category: Category) {
    return category.id || category.name.toLowerCase().replace(/\s+/g, '-');
  }

  async function loadCategories() {
    const token = ++requestToken;
    loading = true;
    error = '';

    try {
      normalizePayload(await fetchJson<CategoriesPayload>(rawCategoriesPath));
      loaded = true;
    } catch (caught) {
      if (token !== requestToken) return;
      error = caught instanceof Error ? caught.message : 'request failed';
    } finally {
      if (token === requestToken) loading = false;
    }
  }
</script>

<svelte:head>
  <title>Categories · OpenGecko</title>
  <meta name="description" content="Frontend-owned OpenGecko categories overview using the existing /coins/categories endpoint." />
</svelte:head>

<main class="og-shell min-h-screen text-[#f4f1e8]">
  <section class="relative border-b border-white/10 bg-[#07110f]/95">
    <div class="og-noise"></div>
    <div class="mx-auto flex max-w-[1320px] flex-wrap items-center gap-3 px-4 py-4">
      <a class="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.05] px-4 py-3 text-sm font-black text-[#cbd8d0] hover:text-white" href="/#categories">
        <ArrowLeft size={16} /> Back to dashboard
      </a>
      <span class="inline-flex items-center gap-2 rounded-full border border-[#b8ff4d]/30 bg-[#b8ff4d]/10 px-3 py-2 text-xs font-black uppercase tracking-[0.18em] text-[#b8ff4d]">
        <DatabaseZap size={14} /> Frontend category overview
      </span>
      <a class="ml-auto inline-flex items-center gap-2 rounded-2xl bg-[#b8ff4d] px-4 py-3 text-sm font-black text-[#07110f]" href={rawApiUrl(rawCategoriesPath)} target="_blank" rel="noreferrer">
        Open raw {rawCategoriesPath} <ExternalLink size={15} />
      </a>
    </div>
  </section>

  <section class="relative mx-auto max-w-[1320px] px-4 py-8">
    <div class="og-grid absolute inset-0 -z-10 opacity-60"></div>

    <section class="relative mb-6 overflow-hidden rounded-[2rem] border border-white/10 bg-[#0d1714]/95 p-6 shadow-2xl md:p-8">
      <div class="radar-orb"></div>
      <div class="relative z-10 grid gap-8 lg:grid-cols-[1fr_360px] lg:items-end">
        <div>
          <p class="mb-3 text-sm font-black uppercase tracking-[0.32em] text-[#ffbf47]">Sector Radar</p>
          <h1 class="max-w-4xl text-5xl font-black leading-[0.9] tracking-[-0.07em] md:text-7xl">Categories overview, without fake detail promises.</h1>
          <p class="mt-6 max-w-3xl text-base leading-8 text-[#b7c8bf]">
            This frontend route renders existing `/coins/categories` data only. The current API exposes category list metrics and leaders, but no supported category-by-id detail/asset route is required here, so category cards stay overview-only.
          </p>
        </div>
        <div class="rounded-[1.5rem] border border-[#b8ff4d]/20 bg-black/30 p-5">
          <div class="text-xs font-black uppercase tracking-[0.18em] text-[#91a59a]">Route contract</div>
          <div class="mt-3 space-y-2 text-sm font-bold text-[#cbd8d0]">
            <div><span class="text-[#ffbf47]">GET</span> {rawCategoriesPath}</div>
            <div>Product route: <strong class="text-[#b8ff4d]">/categories</strong></div>
            <div>Detail affordance: <strong class="text-[#ffdf9b]">disabled unless API data supports it</strong></div>
          </div>
        </div>
      </div>
    </section>

    {#if loading}
      <div class="rounded-[2rem] border border-white/10 bg-[#0d1714]/95 p-8 shadow-2xl" aria-live="polite">
        <div class="flex items-center gap-3 text-xl font-black"><LoaderCircle class="animate-spin text-[#b8ff4d]" /> Loading categories overview from /coins/categories...</div>
        <p class="mt-3 text-[#91a59a]">The route shell stays visible while category metrics load through the approved API proxy/base configuration.</p>
      </div>
    {:else if error}
      <div class="rounded-[2rem] border border-[#ff5c5c]/30 bg-[#ff5c5c]/10 p-8 shadow-2xl">
        <h2 class="flex items-center gap-3 text-4xl font-black tracking-[-0.06em] text-[#ffc2c2]"><Server /> Categories unavailable</h2>
        <p class="mt-3 max-w-2xl text-[#ffc2c2]">The existing categories endpoint could not load: {error}. No backend endpoint changes are required; restore the API and retry.</p>
        <div class="mt-6 flex flex-wrap gap-3">
          <button class="inline-flex items-center gap-2 rounded-2xl border border-[#ffc2c2]/40 px-4 py-3 font-black text-[#ffc2c2]" type="button" on:click={() => void loadCategories()}><RefreshCw size={16} /> Retry categories</button>
          <a class="rounded-2xl bg-[#b8ff4d] px-4 py-3 font-black text-[#07110f]" href="/">Return to dashboard</a>
        </div>
      </div>
    {:else}
      <div class="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div class="terminal-card"><div class="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#91a59a]"><Layers3 size={15} /> Categories</div><div class="text-3xl font-black">{numberText(meta?.count ?? categories.length)}</div></div>
        <div class="terminal-card"><div class="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#91a59a]"><BarChart3 size={15} /> Market cap</div><div class="text-3xl font-black">{money(totalMarketCap, true)}</div></div>
        <div class="terminal-card"><div class="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#91a59a]"><TrendingUp size={15} /> Positive 24h</div><div class="text-3xl font-black">{positiveCategories}/{categories.length}</div></div>
        <div class="terminal-card"><div class="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#91a59a]"><ShieldCheck size={15} /> Liquidity</div><div class="text-3xl font-black">{money(totalVolume, true)}</div></div>
      </div>

      {#if categories.length === 0}
        <div class="rounded-[2rem] border border-white/10 bg-[#0d1714]/95 p-8 text-[#91a59a] shadow-2xl">The current `/coins/categories` response is empty. The route does not invent unsupported category detail pages.</div>
      {:else}
        <div class="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
          <section class="rounded-[2rem] border border-white/10 bg-[#f4f1e8] p-6 text-[#07110f] shadow-xl">
            <h2 class="text-2xl font-black tracking-[-0.05em]">Strongest category signals</h2>
            <p class="mt-2 text-sm font-bold text-[#617269]">Sorted locally from loaded category rows. Selecting a category is intentionally not offered as a detail route because the current supported endpoint is overview data.</p>
            <div class="mt-5 space-y-2">
              {#each strongestCategories as category, index}
                <div class="rounded-2xl bg-white/70 p-4">
                  <div class="flex items-start justify-between gap-3">
                    <div>
                      <div class="text-xs font-black uppercase tracking-[0.16em] text-[#617269]">#{index + 1} · {categorySlugLabel(category)}</div>
                      <div class="text-xl font-black">{category.name}</div>
                    </div>
                    <div class={(category.market_cap_change_24h ?? 0) >= 0 ? 'font-black text-[#244d16]' : 'font-black text-[#9f1239]'}>{percent(category.market_cap_change_24h)}</div>
                  </div>
                  <div class="mt-3 grid gap-2 text-sm font-bold text-[#617269] sm:grid-cols-2">
                    <div>Market cap <strong class="text-[#07110f]">{money(category.market_cap, true)}</strong></div>
                    <div>24h volume <strong class="text-[#07110f]">{money(category.volume_24h, true)}</strong></div>
                  </div>
                </div>
              {/each}
            </div>
          </section>

          <section class="grid gap-3 sm:grid-cols-2">
            {#each categories as category}
              <article class="rounded-[1.75rem] border border-white/10 bg-[#0d1714]/95 p-5 shadow-xl">
                <div class="mb-3 flex items-start justify-between gap-3">
                  <div>
                    <div class="text-xs font-black uppercase tracking-[0.16em] text-[#91a59a]">{categorySlugLabel(category)}</div>
                    <h3 class="text-2xl font-black tracking-[-0.05em]">{category.name}</h3>
                  </div>
                  <span class={(category.market_cap_change_24h ?? 0) >= 0 ? 'rounded-full bg-[#b8ff4d]/10 px-3 py-1 text-sm font-black text-[#b8ff4d]' : 'rounded-full bg-[#ff5c5c]/10 px-3 py-1 text-sm font-black text-[#ff9b9b]'}>{percent(category.market_cap_change_24h)}</span>
                </div>
                <p class="min-h-12 text-sm leading-6 text-[#91a59a]">{cleanText(category.content) || 'No description is present in the current category row; metrics remain available from the overview endpoint.'}</p>
                <div class="mt-4 grid gap-2 text-sm font-bold text-[#cbd8d0]">
                  <div class="flex justify-between gap-3"><span>Market cap</span><strong>{money(category.market_cap, true)}</strong></div>
                  <div class="flex justify-between gap-3"><span>Volume</span><strong>{money(category.volume_24h, true)}</strong></div>
                </div>
                <div class="mt-4 flex items-center justify-between gap-3">
                  <div class="flex -space-x-2">
                    {#each category.top_3_coins?.slice(0, 3) ?? [] as image}
                      {#if safeImageUrl(image)}<img class="size-8 rounded-full border-2 border-[#0d1714] bg-[#f4f1e8]" src={safeImageUrl(image) ?? ''} alt="" />{/if}
                    {/each}
                  </div>
                  <span class="rounded-full border border-[#ffbf47]/30 bg-[#ffbf47]/10 px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-[#ffdf9b]">Overview only</span>
                </div>
                {#if category.top_3_coins_id?.length}
                  <div class="mt-3 text-xs font-bold uppercase tracking-[0.12em] text-[#91a59a]">Leaders: {category.top_3_coins_id.slice(0, 3).join(', ')}</div>
                {/if}
              </article>
            {/each}
          </section>
        </div>
      {/if}

      <section class="mt-6 rounded-[2rem] border border-[#b8ff4d]/20 bg-[#07110f] p-6 shadow-[0_0_70px_rgba(184,255,77,0.08)]">
        <div class="grid gap-5 lg:grid-cols-[1fr_1.2fr]">
          <div>
            <h2 class="text-2xl font-black tracking-[-0.05em]">Category route assumptions</h2>
            <p class="mt-2 text-sm leading-7 text-[#91a59a]">
              Product path `/categories` is frontend-owned. Raw JSON access is intentionally separate. Category detail links are not rendered because this mission only uses the existing category overview endpoint.
            </p>
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <a class="terminal-card block text-[#b8ff4d]" href={rawApiUrl(rawCategoriesPath)} target="_blank" rel="noreferrer">Open raw {rawCategoriesPath}</a>
            <a class="terminal-card block text-[#b8ff4d]" href="/api">Open frontend API explorer</a>
          </div>
        </div>
      </section>
    {/if}
  </section>
</main>
