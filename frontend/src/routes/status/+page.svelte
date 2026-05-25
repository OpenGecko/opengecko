<script lang="ts">
  import { browser } from '$app/environment';
  import { onDestroy } from 'svelte';
  import { Activity, ArrowLeft, CircleDollarSign, DatabaseZap, ExternalLink, LoaderCircle, RefreshCw, Server, ShieldCheck, Wifi } from 'lucide-svelte';
  import { apiBase, fetchJson, rawApiUrl } from '$lib/api';
  import { numberText } from '$lib/format';

  type RuntimePayload = {
    data?: {
      readiness?: {
        state?: string;
        canonical_phase?: string;
        details?: Record<string, unknown>;
      };
      degraded?: boolean;
      runtime?: {
        cache_revision?: number;
      };
      provider_health?: {
        status?: string;
      };
      freshness?: {
        status?: string;
      };
      providers?: ProviderEntry[] | Record<string, ProviderEntry>;
      provider_attempts?: Record<string, unknown>;
      hot_paths?: {
        cache_revision?: number;
        shared_market_snapshot?: {
          freshness?: string | { threshold_seconds?: number; age_seconds?: number; is_stale?: boolean };
          age_ms?: number | null;
          rows?: number | null;
        };
      };
      transport?: Record<string, unknown>;
      database?: Record<string, unknown>;
      sqlite_coordination?: Record<string, unknown>;
      startup_prewarm?: Record<string, unknown>;
      validation_profile?: Record<string, unknown>;
    };
  };
  type PingPayload = {
    gecko_says?: string;
  };
  type ProviderEntry = {
    id?: string;
    status?: string;
    state?: string;
    alert_status?: string;
    last_success_at?: string | null;
    last_error_at?: string | null;
    last_failure_at?: string | null;
    error?: string | null;
    last_failure_reason?: string | null;
  };
  type RuntimeData = NonNullable<RuntimePayload['data']>;

  let runtime: RuntimeData | null = null;
  let ping: PingPayload | null = null;
  let loading = true;
  let error = '';
  let partialWarnings: string[] = [];
  let checkedAt = '';
  let requestToken = 0;

  const runtimePath = '/diagnostics/runtime';
  const pingPath = '/ping';

  $: readiness = runtime?.readiness?.state ?? (ping?.gecko_says ? 'reachable' : 'unknown');
  $: phase = runtime?.readiness?.canonical_phase ?? 'unreported';
  $: providerStatus = runtime?.provider_health?.status ?? providerSummary(runtime?.providers) ?? (runtime?.degraded ? 'degraded' : 'unknown');
  $: freshnessStatus = freshnessSummary(runtime?.freshness?.status ?? runtime?.hot_paths?.shared_market_snapshot?.freshness);
  $: cacheRevision = runtime?.runtime?.cache_revision ?? runtime?.hot_paths?.cache_revision ?? null;
  $: snapshotRows = runtime?.hot_paths?.shared_market_snapshot?.rows ?? null;
  $: snapshotAge = runtime?.hot_paths?.shared_market_snapshot?.age_ms ?? freshnessAgeMs(runtime?.hot_paths?.shared_market_snapshot?.freshness);
  $: effectiveBase = apiBase === '/__opengecko_api' ? 'frontend relative proxy /__opengecko_api → configured OpenGecko API' : apiBase;
  $: providerEntries = normalizeProviders(runtime?.providers);

  if (browser) {
    void loadStatus();
  }

  onDestroy(() => {
    requestToken += 1;
  });

  function normalizeProviders(providers: RuntimeData['providers'] | undefined): Array<[string, ProviderEntry]> {
    if (Array.isArray(providers)) {
      return providers.map((provider, index) => [provider.id ?? `provider-${index + 1}`, provider]);
    }

    return Object.entries(providers ?? {});
  }

  function providerSummary(providers: RuntimeData['providers'] | undefined) {
    const statuses = normalizeProviders(providers)
      .map(([, provider]) => provider.status ?? provider.alert_status ?? provider.state)
      .filter(Boolean);
    if (statuses.length === 0) return null;
    if (statuses.every((status) => status === 'ok' || status === 'healthy')) return 'healthy';
    if (statuses.some((status) => status === 'error' || status === 'failing' || status === 'degraded' || status === 'half_open')) return 'degraded';
    return statuses[0] ?? null;
  }

  function freshnessSummary(value: unknown) {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      const freshness = value as { is_stale?: boolean; age_seconds?: number };
      return freshness.is_stale ? 'stale' : 'fresh';
    }
    return 'unknown';
  }

  function freshnessAgeMs(value: unknown) {
    if (value && typeof value === 'object') {
      const freshness = value as { age_seconds?: number };
      return typeof freshness.age_seconds === 'number' ? freshness.age_seconds * 1000 : null;
    }
    return null;
  }

  function objectPreview(value: Record<string, unknown> | undefined) {
    if (!value) return 'No details reported by this runtime payload.';
    return Object.entries(value)
      .slice(0, 5)
      .map(([key, entry]) => `${key}: ${typeof entry === 'object' && entry !== null ? JSON.stringify(entry).slice(0, 80) : String(entry)}`)
      .join(' · ');
  }

  function resultValue<T>(result: PromiseSettledResult<T>) {
    return result.status === 'fulfilled' ? result.value : null;
  }

  function resultWarning<T>(label: string, result: PromiseSettledResult<T>) {
    if (result.status === 'fulfilled') return null;
    return `${label}: ${result.reason instanceof Error ? result.reason.message : 'request failed'}`;
  }

  async function loadStatus() {
    const token = ++requestToken;
    loading = true;
    error = '';
    partialWarnings = [];

    const [runtimeResult, pingResult] = await Promise.allSettled([
      fetchJson<RuntimePayload>(runtimePath),
      fetchJson<PingPayload>(pingPath)
    ]);

    if (token !== requestToken) return;

    runtime = resultValue(runtimeResult)?.data ?? null;
    ping = resultValue(pingResult);
    partialWarnings = [
      resultWarning('Runtime diagnostics', runtimeResult),
      resultWarning('Ping', pingResult)
    ].filter((value): value is string => Boolean(value));

    if (!runtime && !ping) {
      error = `Status data could not load from ${effectiveBase}. Start the API and retry this frontend-owned status route.`;
    } else {
      checkedAt = new Date().toLocaleTimeString();
    }

    loading = false;
  }
</script>

<svelte:head>
  <title>Status · OpenGecko Runtime</title>
  <meta name="description" content="Frontend-owned OpenGecko status and runtime view using /diagnostics/runtime and /ping." />
</svelte:head>

<main class="og-shell min-h-screen text-[#f4f1e8]">
  <section class="relative border-b border-white/10 bg-[#07110f]/95">
    <div class="og-noise"></div>
    <div class="mx-auto flex max-w-[1320px] flex-wrap items-center gap-3 px-4 py-4">
      <a class="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.05] px-4 py-3 text-sm font-black text-[#cbd8d0] hover:text-white" href="/#api">
        <ArrowLeft size={16} /> Back to dashboard
      </a>
      <span class="inline-flex items-center gap-2 rounded-full border border-[#b8ff4d]/30 bg-[#b8ff4d]/10 px-3 py-2 text-xs font-black uppercase tracking-[0.18em] text-[#b8ff4d]">
        <DatabaseZap size={14} /> Frontend status route
      </span>
      <a class="ml-auto inline-flex items-center gap-2 rounded-2xl bg-[#b8ff4d] px-4 py-3 text-sm font-black text-[#07110f]" href={rawApiUrl(runtimePath)} target="_blank" rel="noreferrer">
        Open raw {runtimePath} <ExternalLink size={15} />
      </a>
    </div>
  </section>

  <section class="relative mx-auto max-w-[1320px] px-4 py-8">
    <div class="og-grid absolute inset-0 -z-10 opacity-60"></div>

    <section class="relative mb-6 overflow-hidden rounded-[2rem] border border-white/10 bg-[#0d1714]/95 p-6 shadow-2xl md:p-8">
      <div class="radar-orb"></div>
      <div class="relative z-10 grid gap-8 lg:grid-cols-[1fr_360px] lg:items-end">
        <div>
          <p class="mb-3 text-sm font-black uppercase tracking-[0.32em] text-[#ffbf47]">Runtime telemetry</p>
          <h1 class="max-w-4xl text-5xl font-black leading-[0.9] tracking-[-0.07em] md:text-7xl">Status, freshness, cache, and provider context.</h1>
          <p class="mt-6 max-w-3xl text-base leading-8 text-[#b7c8bf]">
            This frontend-owned status view composes existing `/diagnostics/runtime` and `/ping` data. Raw diagnostics links are explicit, and the effective API base is shown so proxy assumptions stay understandable.
          </p>
        </div>
        <div class="rounded-[1.5rem] border border-[#b8ff4d]/20 bg-black/30 p-5">
          <div class="text-xs font-black uppercase tracking-[0.18em] text-[#91a59a]">Effective API base</div>
          <div class="mt-3 break-words font-mono text-sm font-bold text-[#b8ff4d]">{effectiveBase}</div>
          <div class="mt-3 text-xs font-bold uppercase tracking-[0.12em] text-[#91a59a]">Last check: {checkedAt || 'pending'}</div>
        </div>
      </div>
    </section>

    {#if loading}
      <div class="rounded-[2rem] border border-white/10 bg-[#0d1714]/95 p-8 shadow-2xl" aria-live="polite">
        <div class="flex items-center gap-3 text-xl font-black"><LoaderCircle class="animate-spin text-[#b8ff4d]" /> Loading runtime status from diagnostics...</div>
        <p class="mt-3 text-[#91a59a]">Fetching existing `/diagnostics/runtime` and `/ping` endpoints.</p>
      </div>
    {:else if error}
      <div class="rounded-[2rem] border border-[#ff5c5c]/30 bg-[#ff5c5c]/10 p-8 shadow-2xl">
        <h2 class="flex items-center gap-3 text-4xl font-black tracking-[-0.06em] text-[#ffc2c2]"><Server /> Status route unavailable</h2>
        <p class="mt-3 max-w-2xl text-[#ffc2c2]">{error}</p>
        <div class="mt-6 flex flex-wrap gap-3">
          <button class="inline-flex items-center gap-2 rounded-2xl border border-[#ffc2c2]/40 px-4 py-3 font-black text-[#ffc2c2]" type="button" on:click={() => void loadStatus()}><RefreshCw size={16} /> Retry status</button>
          <a class="rounded-2xl bg-[#b8ff4d] px-4 py-3 font-black text-[#07110f]" href="/">Return to dashboard</a>
        </div>
      </div>
    {:else}
      {#if partialWarnings.length > 0}
        <div class="mb-6 rounded-2xl border border-[#ffbf47]/30 bg-[#ffbf47]/10 px-4 py-3 text-sm font-bold text-[#ffe0a3]">
          Showing partial runtime status from available endpoints: {partialWarnings.join('; ')}.
        </div>
      {/if}

      <div class="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div class="terminal-card"><div class="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#91a59a]"><Activity size={15} /> Readiness</div><div class="text-3xl font-black capitalize">{readiness}</div><div class="mt-1 text-sm font-bold text-[#91a59a]">{phase}</div></div>
        <div class="terminal-card"><div class="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#91a59a]"><ShieldCheck size={15} /> Provider</div><div class="text-3xl font-black capitalize">{providerStatus}</div><div class="mt-1 text-sm font-bold text-[#91a59a]">{providerEntries.length || 'No'} providers listed</div></div>
        <div class="terminal-card"><div class="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#91a59a]"><CircleDollarSign size={15} /> Freshness</div><div class="text-3xl font-black capitalize">{freshnessStatus}</div><div class="mt-1 text-sm font-bold text-[#91a59a]">{snapshotAge == null ? 'Age unknown' : `${numberText(Math.round(snapshotAge / 1000))}s age`}</div></div>
        <div class="terminal-card"><div class="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#91a59a]"><Wifi size={15} /> Cache</div><div class="text-3xl font-black">rev {cacheRevision ?? '-'}</div><div class="mt-1 text-sm font-bold text-[#91a59a]">{snapshotRows == null ? 'Rows unknown' : `${numberText(snapshotRows)} rows`}</div></div>
      </div>

      <div class="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
        <section class="rounded-[2rem] border border-white/10 bg-[#f4f1e8] p-6 text-[#07110f] shadow-xl">
          <h2 class="text-2xl font-black tracking-[-0.05em]">Endpoint health proof</h2>
          <div class="mt-5 grid gap-3">
            <div class="rounded-2xl bg-white/70 p-4">
              <div class="text-xs font-black uppercase tracking-[0.16em] text-[#617269]">Ping says</div>
              <div class="mt-1 text-xl font-black">{ping?.gecko_says ?? 'No ping payload available'}</div>
            </div>
            <div class="rounded-2xl bg-white/70 p-4">
              <div class="text-xs font-black uppercase tracking-[0.16em] text-[#617269]">Readiness details</div>
              <div class="mt-1 text-sm font-bold text-[#617269]">{objectPreview(runtime?.readiness?.details)}</div>
            </div>
            <div class="grid gap-3 sm:grid-cols-2">
              <a class="rounded-2xl bg-[#07110f] p-4 font-black text-[#b8ff4d]" href={rawApiUrl(runtimePath)} target="_blank" rel="noreferrer">Open raw {runtimePath}</a>
              <a class="rounded-2xl bg-[#07110f] p-4 font-black text-[#b8ff4d]" href={rawApiUrl(pingPath)} target="_blank" rel="noreferrer">Open raw {pingPath}</a>
            </div>
          </div>
        </section>

        <section class="rounded-[2rem] border border-white/10 bg-[#0d1714]/95 p-6 shadow-xl">
          <h2 class="text-2xl font-black tracking-[-0.05em]">Provider and cache context</h2>
          <p class="mt-2 text-sm leading-7 text-[#91a59a]">Fields vary by runtime state, so this route names missing details instead of hiding them or requiring backend changes.</p>
          <div class="mt-5 grid gap-3">
            {#each providerEntries as [name, provider]}
              <div class="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                <div class="flex items-start justify-between gap-3">
                  <div class="font-black">{name}</div>
                  <span class="rounded-full border border-[#b8ff4d]/30 px-3 py-1 text-xs font-black uppercase text-[#b8ff4d]">{provider.status ?? provider.alert_status ?? provider.state ?? 'unknown'}</span>
                </div>
                <div class="mt-2 text-xs font-bold uppercase tracking-[0.12em] text-[#91a59a]">Last success {provider.last_success_at ?? '-'} · Last error {provider.last_error_at ?? provider.last_failure_at ?? '-'}</div>
                {#if provider.error || provider.last_failure_reason}<div class="mt-2 text-sm font-bold text-[#ff9b9b]">{provider.error ?? provider.last_failure_reason}</div>{/if}
              </div>
            {:else}
              <div class="rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-sm font-bold text-[#91a59a]">The current runtime payload did not include a provider map. Readiness, freshness, cache, and ping context remain visible above.</div>
            {/each}
            <div class="rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-sm font-bold text-[#91a59a]">Transport: {objectPreview(runtime?.transport)}</div>
            <div class="rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-sm font-bold text-[#91a59a]">Database: {objectPreview(runtime?.database)}</div>
          </div>
        </section>
      </div>

      <section class="mt-6 rounded-[2rem] border border-[#b8ff4d]/20 bg-[#07110f] p-6 shadow-[0_0_70px_rgba(184,255,77,0.08)]">
        <div class="grid gap-5 lg:grid-cols-[1fr_1.2fr]">
          <div>
            <h2 class="text-2xl font-black tracking-[-0.05em]">Status route assumptions</h2>
            <p class="mt-2 text-sm leading-7 text-[#91a59a]">Product path `/status` is frontend-owned. Runtime data comes from `/diagnostics/runtime`; liveness comes from `/ping`. Raw API links are explicit and opened intentionally.</p>
          </div>
          <div class="grid gap-3 sm:grid-cols-3">
            <a class="terminal-card block text-[#b8ff4d]" href={rawApiUrl(runtimePath)} target="_blank" rel="noreferrer">Open raw /diagnostics/runtime</a>
            <a class="terminal-card block text-[#b8ff4d]" href={rawApiUrl(pingPath)} target="_blank" rel="noreferrer">Open raw /ping</a>
            <a class="terminal-card block text-[#b8ff4d]" href="/api">Open frontend API explorer</a>
          </div>
        </div>
      </section>
    {/if}
  </section>
</main>
