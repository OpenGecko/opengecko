<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { Tabs } from 'bits-ui';
  import {
    compareSelectionLimit,
    reconcileDashboardLocalStateWithMarkets,
    restoreDashboardLocalState,
    safePersistJson
  } from '$lib/dashboard-local-state';
  import type { DashboardControlsState, RowsPerPage, Segment } from '$lib/dashboard-local-state';
  import {
    Activity,
    ArrowDown,
    ArrowUp,
    BarChart3,
    Bell,
    BookOpen,
    BriefcaseBusiness,
    Check,
    ChevronDown,
    CircleDollarSign,
    Clock3,
    DatabaseZap,
    ExternalLink,
    Eye,
    Flame,
    Globe2,
    Layers3,
    LineChart,
    ListFilter,
    LoaderCircle,
    Menu,
    RefreshCw,
    Search,
    Server,
    ShieldCheck,
    SlidersHorizontal,
    Star,
    TrendingDown,
    TrendingUp,
    WalletCards,
    Wifi,
    X
  } from 'lucide-svelte';

  type MarketCoin = {
    id: string;
    symbol: string;
    name: string;
    image: string | null;
    current_price: number | null;
    market_cap: number | null;
    market_cap_rank: number | null;
    fully_diluted_valuation: number | null;
    total_volume: number | null;
    high_24h?: number | null;
    low_24h?: number | null;
    price_change_24h?: number | null;
    price_change_percentage_1h_in_currency?: number | null;
    price_change_percentage_24h: number | null;
    price_change_percentage_7d_in_currency?: number | null;
    price_change_percentage_30d_in_currency?: number | null;
    sparkline_in_7d?: { price?: number[] };
    last_updated?: string | null;
  };

  type TrendingCoin = {
    item?: {
      id: string;
      name: string;
      symbol: string;
      thumb?: string;
      small?: string;
      market_cap_rank?: number;
    };
  };

  type Category = {
    id: string;
    name: string;
    market_cap: number | null;
    market_cap_change_24h: number | null;
    volume_24h: number | null;
    top_3_coins?: string[];
  };

  type Exchange = {
    id: string;
    name: string;
    image: string | null;
    trust_score_rank: number | null;
    trade_volume_24h_btc: number | null;
    source?: string | null;
  };

  type GlobalPayload = {
    data?: {
      active_cryptocurrencies?: number;
      markets?: number;
      total_market_cap?: Record<string, number>;
      total_volume?: Record<string, number>;
      market_cap_percentage?: Record<string, number>;
      market_cap_change_percentage_24h_usd?: number;
    };
  };

  type RuntimePayload = {
    data?: {
      readiness?: {
        state?: string;
        canonical_phase?: string;
      };
      runtime?: {
        cache_revision?: number;
      };
      provider_health?: {
        status?: string;
      };
      freshness?: {
        status?: string;
      };
    };
  };

  type SortKey = 'rank' | 'price' | 'change24h' | 'volume' | 'marketCap' | 'fdv';
  type ResourceKey = 'markets' | 'trending' | 'global' | 'runtime' | 'categories' | 'exchanges';
  type ResourceResult = { key: ResourceKey; ok: true } | { key: ResourceKey; ok: false; error: string };

  const apiBase = import.meta.env.PUBLIC_OPENGECKO_API_BASE_URL ?? '';
  const watchlistStorageKey = 'opengecko.watchlist.v1';
  const portfolioStorageKey = 'opengecko.portfolio.v1';
  const dashboardControlsStorageKey = 'opengecko.dashboard.controls.v1';
  const resourceLabels: Record<ResourceKey, string> = {
    markets: 'Market rows',
    trending: 'Search heat',
    global: 'Market summary',
    runtime: 'Runtime health',
    categories: 'Sector radar',
    exchanges: 'Exchange quality'
  };
  const sortLabels: Record<SortKey, string> = {
    rank: 'rank',
    price: 'price',
    change24h: '24h change',
    volume: '24h volume',
    marketCap: 'market cap',
    fdv: 'FDV'
  };
  const resourceOrder: ResourceKey[] = ['markets', 'trending', 'global', 'runtime', 'categories', 'exchanges'];
  const marketRequestPath = '/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=true&price_change_percentage=1h,24h,7d,30d';

  const formatUsd = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2
  });
  const compactUsd = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 2
  });
  const compactNumber = new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1
  });
  const wholeNumber = new Intl.NumberFormat('en-US');

  let markets: MarketCoin[] = [];
  let trending: TrendingCoin[] = [];
  let categories: Category[] = [];
  let exchanges: Exchange[] = [];
  let globalData: GlobalPayload['data'] | null = null;
  let runtime: RuntimePayload['data'] | null = null;
  let selectedCoin: MarketCoin | null = null;
  let selectedCoinId: string | null = null;
  let query = '';
  let searchOpen = false;
  let mobileMenuOpen = false;
  let segment: Segment = 'all';
  let sortKey: SortKey = 'rank';
  let sortDirection: 'asc' | 'desc' = 'asc';
  let rowsPerPage: RowsPerPage = 25;
  let loading = false;
  let hasLoadedOnce = false;
  let localStateRestored = false;
  let lastUpdatedAt = '';
  let error = '';
  let resourceErrors: Partial<Record<ResourceKey, string>> = {};
  let dashboardRequestId = 0;
  let watchlist = new Set<string>();
  let compare = new Set<string>();
  let holdings: Record<string, number> = {};
  let discoveryMessage = '';
  let localStateMessage = '';
  let compareLimitMessage = '';
  let searchInput: HTMLInputElement | null = null;
  let menuButton: HTMLButtonElement | null = null;
  let selectedCoinCloseButton: HTMLButtonElement | null = null;
  let searchReturnFocus: HTMLElement | null = null;
  let selectedDrawerReturnFocus: HTMLElement | null = null;

  const apiUrl = (path: string) => `${apiBase}${path}`;

  function money(value: number | null | undefined, compact = false) {
    if (value == null || Number.isNaN(value)) return '-';
    return compact ? compactUsd.format(value) : formatUsd.format(value);
  }

  function numberText(value: number | null | undefined) {
    if (value == null || Number.isNaN(value)) return '-';
    return value > 9999 ? compactNumber.format(value) : wholeNumber.format(value);
  }

  function percent(value: number | null | undefined) {
    if (value == null || Number.isNaN(value)) return '-';
    return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
  }

  function sparkPath(values: number[] | undefined, width = 154, height = 42) {
    const points = values?.filter((value) => Number.isFinite(value)).slice(-72) ?? [];
    if (points.length < 2) return '';

    const min = Math.min(...points);
    const max = Math.max(...points);
    const range = max - min || 1;

    return points
      .map((value, index) => {
        const x = (index / (points.length - 1)) * width;
        const y = height - 4 - ((value - min) / range) * (height - 9);
        return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');
  }

  function isPositive(value: number | null | undefined) {
    return (value ?? 0) >= 0;
  }

  function safeImageUrl(value: string | null | undefined) {
    if (!value) return null;
    try {
      const url = new URL(value, 'http://opengecko.local');
      if (url.hostname.endsWith('.test')) return null;
      if (!['http:', 'https:'].includes(url.protocol)) return null;
      return value;
    } catch {
      return null;
    }
  }

  function safeNumber(value: number | null | undefined, fallback: number) {
    return value == null || Number.isNaN(value) ? fallback : value;
  }

  function capFdvRatio(coin: MarketCoin) {
    if (!coin.market_cap || !coin.fully_diluted_valuation) return null;
    return (coin.market_cap / coin.fully_diluted_valuation) * 100;
  }

  function nullableSortValue(coin: MarketCoin, key: SortKey) {
    switch (key) {
      case 'price':
        return coin.current_price;
      case 'change24h':
        return coin.price_change_percentage_24h;
      case 'volume':
        return coin.total_volume;
      case 'marketCap':
        return coin.market_cap;
      case 'fdv':
        return coin.fully_diluted_valuation;
      case 'rank':
      default:
        return coin.market_cap_rank;
    }
  }

  function compareMarkets(left: MarketCoin, right: MarketCoin) {
    const modifier = sortDirection === 'asc' ? 1 : -1;
    const leftValue = nullableSortValue(left, sortKey);
    const rightValue = nullableSortValue(right, sortKey);

    if (leftValue == null && rightValue != null) return 1;
    if (rightValue == null && leftValue != null) return -1;
    if (leftValue != null && rightValue != null && leftValue !== rightValue) {
      return (leftValue - rightValue) * modifier;
    }

    return (
      safeNumber(left.market_cap_rank, 999999) - safeNumber(right.market_cap_rank, 999999)
      || left.name.localeCompare(right.name)
      || left.id.localeCompare(right.id)
    );
  }

  function setSort(key: SortKey) {
    if (sortKey === key) {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
      return;
    }

    sortKey = key;
    sortDirection = key === 'rank' ? 'asc' : 'desc';
  }

  function sortIndicator(key: SortKey) {
    if (sortKey !== key) return '';
    return sortDirection === 'asc' ? '↑' : '↓';
  }

  function toggleWatch(id: string) {
    if (!id) return;
    const next = new Set(watchlist);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    watchlist = next;
    safePersistJson(localStorage, watchlistStorageKey, [...watchlist]);
  }

  function toggleCompare(id: string) {
    if (!id) return;
    const next = new Set(compare);
    if (next.has(id)) {
      next.delete(id);
      compareLimitMessage = '';
    } else if (next.size < compareSelectionLimit) {
      next.add(id);
      compareLimitMessage = '';
    } else {
      compareLimitMessage = `Compare Bench is full (${compareSelectionLimit}/${compareSelectionLimit}). Remove an asset before adding another.`;
    }
    compare = next;
  }

  function updateHolding(id: string, value: string) {
    if (!id) return;
    const amount = Number(value);
    const next = { ...holdings };
    if (Number.isFinite(amount) && amount > 0) {
      next[id] = amount;
    } else {
      delete next[id];
    }
    holdings = next;
    safePersistJson(localStorage, portfolioStorageKey, holdings);
  }

  function persistDashboardLocalSnapshot() {
    safePersistJson(localStorage, watchlistStorageKey, [...watchlist]);
    safePersistJson(localStorage, portfolioStorageKey, holdings);
    safePersistJson(localStorage, dashboardControlsStorageKey, {
      compareIds: [...compare],
      selectedCoinId,
      rowsPerPage,
      segment
    });
  }

  function resetLocalDashboardState() {
    watchlist = new Set();
    compare = new Set();
    holdings = {};
    selectedCoinId = null;
    compareLimitMessage = '';
    discoveryMessage = '';
    rowsPerPage = 25;
    segment = 'all';
    localStateMessage = 'Local dashboard state was reset. Watchlist, holdings, compare bench, selected drawer, row limit, and active tab are clear in this browser.';
    persistDashboardLocalSnapshot();
  }

  function reconcileLocalStateWithLoadedMarkets(marketRows: MarketCoin[]) {
    if (!localStateRestored || marketRows.length === 0) return;

    const reconciled = reconcileDashboardLocalStateWithMarkets(
      {
        watchlistIds: [...watchlist],
        holdings,
        controls: {
          compareIds: [...compare],
          selectedCoinId,
          rowsPerPage,
          segment
        }
      },
      marketRows.map((coin) => coin.id)
    );

    if (!reconciled.changed) return;

    watchlist = new Set(reconciled.state.watchlistIds);
    holdings = reconciled.state.holdings;
    compare = new Set(reconciled.state.controls.compareIds);
    selectedCoinId = reconciled.state.controls.selectedCoinId;
    rowsPerPage = reconciled.state.controls.rowsPerPage;
    segment = reconciled.state.controls.segment;
    compareLimitMessage = '';
    persistDashboardLocalSnapshot();

    const removedIds = [
      ...reconciled.removed.watchlistIds,
      ...reconciled.removed.holdingIds,
      ...reconciled.removed.compareIds,
      ...(reconciled.removed.selectedCoinId ? [reconciled.removed.selectedCoinId] : [])
    ];
    const removedCount = new Set(removedIds).size;
    localStateMessage = `Removed ${removedCount} stale local asset ${removedCount === 1 ? 'id' : 'ids'} that are not in the currently loaded market rows. Compare, watchlist, portfolio, and selected drawer now match visible rows.`;
  }

  function closeSearch(restoreFocus = true) {
    searchOpen = false;
    if (restoreFocus && searchReturnFocus?.isConnected) {
      const target = searchReturnFocus;
      void tick().then(() => target.focus({ preventScroll: true }));
    }
    searchReturnFocus = null;
  }

  function closeMobileMenu(restoreFocus = false) {
    mobileMenuOpen = false;
    if (restoreFocus) {
      void tick().then(() => menuButton?.focus({ preventScroll: true }));
    }
  }

  async function navigateToSection(sectionId: string) {
    closeMobileMenu();
    await tick();
    const target = document.getElementById(sectionId);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target?.focus({ preventScroll: true });
  }

  function selectCoin(coin: MarketCoin) {
    if (document.activeElement instanceof HTMLElement) {
      selectedDrawerReturnFocus = document.activeElement;
    }
    selectedCoinId = coin.id;
    if (searchOpen) closeSearch(false);
    closeMobileMenu();
    void tick().then(() => selectedCoinCloseButton?.focus({ preventScroll: true }));
  }

  function closeSelectedCoin() {
    selectedCoinId = null;
    const target = selectedDrawerReturnFocus;
    selectedDrawerReturnFocus = null;
    if (target?.isConnected) {
      void tick().then(() => target.focus({ preventScroll: true }));
    }
  }

  function compareButtonLabel(coin: MarketCoin, isSelected: boolean, selectedCount: number) {
    if (isSelected) return `Remove ${coin.name} from compare`;
    if (selectedCount >= compareSelectionLimit) return `Compare bench is full; remove an asset before adding ${coin.name}`;
    return `Compare ${coin.name}`;
  }

  async function openSearch(returnFocusTarget: HTMLElement | null = null) {
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    searchReturnFocus = returnFocusTarget?.isConnected
      ? returnFocusTarget
      : mobileMenuOpen && menuButton?.isConnected
        ? menuButton
        : activeElement;
    searchOpen = true;
    closeMobileMenu();
    await tick();
    searchInput?.focus();
    searchInput?.select();
  }

  function scrollToMarkets() {
    document.getElementById('markets')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function selectTrending(item: NonNullable<TrendingCoin['item']>) {
    const match = markets.find((coin) => {
      const symbol = item.symbol.toLowerCase();
      return coin.id === item.id || coin.name.toLowerCase() === item.name.toLowerCase() || coin.symbol.toLowerCase() === symbol;
    });

    segment = 'all';

    if (match) {
      query = '';
      selectCoin(match);
      discoveryMessage = `${match.name} selected from Search Heat. The drawer and market-row highlight now show that asset.`;
    } else {
      query = item.name;
      selectedCoinId = null;
      discoveryMessage = `${item.name} is trending but is not in the loaded top-100 market rows. The table is now filtered to loaded coins matching that name, ticker, or id.`;
    }

    scrollToMarkets();
  }

  $: searchedMarkets = markets.filter((coin) => {
    const needle = query.trim().toLowerCase();
    return !needle
      || coin.name.toLowerCase().includes(needle)
      || coin.symbol.toLowerCase().includes(needle)
      || coin.id.toLowerCase().includes(needle);
  });

  $: segmentedMarkets = searchedMarkets.filter((coin) => {
    if (segment === 'gainers') return (coin.price_change_percentage_24h ?? -Infinity) > 0;
    if (segment === 'losers') return (coin.price_change_percentage_24h ?? Infinity) < 0;
    if (segment === 'watchlist') return watchlist.has(coin.id);
    return true;
  });

  $: sortedMarkets = [...segmentedMarkets].sort(compareMarkets);

  $: visibleMarkets = sortedMarkets.slice(0, rowsPerPage);
  $: topCoin = markets[0] ?? null;
  $: dominance = globalData?.market_cap_percentage ?? {};
  $: topGainers = [...markets]
    .sort((left, right) => safeNumber(right.price_change_percentage_24h, -999) - safeNumber(left.price_change_percentage_24h, -999))
    .slice(0, 3);
  $: topLosers = [...markets]
    .sort((left, right) => safeNumber(left.price_change_percentage_24h, 999) - safeNumber(right.price_change_percentage_24h, 999))
    .slice(0, 3);
  $: portfolioValue = markets.reduce((sum, coin) => sum + (holdings[coin.id] ?? 0) * (coin.current_price ?? 0), 0);
  $: compareCoins = markets.filter((coin) => compare.has(coin.id));
  $: failedResourceLabels = resourceOrder.filter((key) => resourceErrors[key]).map((key) => resourceLabels[key]);
  $: hasAnyDashboardData = markets.length > 0 || trending.length > 0 || categories.length > 0 || exchanges.length > 0 || globalData != null || runtime != null;
  $: initialDashboardPending = !hasLoadedOnce && !error;
  $: loadingCopy = hasLoadedOnce ? 'Refreshing dashboard data from the OpenGecko API.' : 'Loading dashboard data from the OpenGecko API.';
  $: apiBoundaryLabel = apiBase || 'frontend proxy → OpenGecko API';
  $: marketEmptyCopy = computeMarketEmptyMessage(Boolean(resourceErrors.markets), markets.length, query, segment);
  $: sortStatus = `${sortLabels[sortKey]} ${sortDirection === 'asc' ? 'ascending' : 'descending'}`;
  $: selectedCoin = selectedCoinId ? markets.find((coin) => coin.id === selectedCoinId) ?? null : null;
  $: if (localStateRestored) {
    const controls: DashboardControlsState = {
      compareIds: [...compare],
      selectedCoinId,
      rowsPerPage,
      segment
    };
    safePersistJson(localStorage, dashboardControlsStorageKey, controls);
  }

  async function fetchJson<T>(path: string): Promise<T> {
    const response = await fetch(apiUrl(path), {
      cache: 'no-store',
      headers: {
        accept: 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`${path} returned ${response.status}`);
    }

    return response.json() as Promise<T>;
  }

  async function loadResource<T>(key: ResourceKey, path: string, apply: (payload: T) => void): Promise<ResourceResult> {
    try {
      const payload = await fetchJson<T>(path);
      apply(payload);
      return { key, ok: true };
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : 'request failed';
      return { key, ok: false, error: `${resourceLabels[key]} could not load (${detail})` };
    }
  }

  async function loadDashboard() {
    if (loading) return;
    const requestId = ++dashboardRequestId;
    loading = true;
    error = '';

    try {
      const results = await Promise.all([
        loadResource<MarketCoin[]>(
          'markets',
          marketRequestPath,
          (marketRows) => {
            markets = Array.isArray(marketRows) ? marketRows : [];
            reconcileLocalStateWithLoadedMarkets(markets);
          }
        ),
        loadResource<{ coins?: TrendingCoin[] }>('trending', '/search/trending?show_max=10', (trendingPayload) => {
          trending = trendingPayload.coins ?? [];
        }),
        loadResource<GlobalPayload>('global', '/global', (globalPayload) => {
          globalData = globalPayload.data ?? null;
        }),
        loadResource<RuntimePayload>('runtime', '/diagnostics/runtime', (runtimePayload) => {
          runtime = runtimePayload.data ?? null;
        }),
        loadResource<{ data?: Category[] } | Category[]>('categories', '/coins/categories?per_page=8&page=1', (categoriesPayload) => {
          categories = Array.isArray(categoriesPayload) ? categoriesPayload : categoriesPayload.data ?? [];
        }),
        loadResource<Exchange[]>('exchanges', '/exchanges?per_page=8&page=1', (exchangePayload) => {
          exchanges = Array.isArray(exchangePayload) ? exchangePayload : [];
        })
      ]);

      if (requestId !== dashboardRequestId) return;

      const nextErrors: Partial<Record<ResourceKey, string>> = {};
      for (const result of results) {
        if (!result.ok) nextErrors[result.key] = result.error;
      }
      resourceErrors = nextErrors;

      const failures = Object.keys(nextErrors).length;
      if (failures === 0) {
        lastUpdatedAt = new Date().toLocaleTimeString();
      } else if (failures === resourceOrder.length && !hasAnyDashboardData) {
        error = `OpenGecko API is unavailable through ${apiBoundaryLabel}. The dashboard shell is still usable; start the API and press Refresh to recover.`;
      } else {
        error = `${failures} dashboard panel${failures === 1 ? '' : 's'} could not refresh. Showing available${hasLoadedOnce ? ' or previously loaded' : ''} data with panel-specific recovery states.`;
      }
    } finally {
      if (requestId === dashboardRequestId) {
        hasLoadedOnce = true;
        loading = false;
      }
    }
  }

  function computeMarketEmptyMessage(hasMarketError: boolean, marketCount: number, searchQuery: string, activeSegment: Segment) {
    if (!hasLoadedOnce) return 'Loading market rows from /coins/markets...';
    if (hasMarketError && marketCount === 0) return 'Market rows are unavailable. Check the API service and press Refresh.';
    if (searchQuery.trim()) return `No loaded coins match "${searchQuery.trim()}". Try another name, ticker, or id.`;
    if (activeSegment === 'watchlist') return 'Your watchlist is empty. Star a market row to add it here.';
    if (activeSegment === 'gainers') return 'No loaded assets are positive over 24h right now.';
    if (activeSegment === 'losers') return 'No loaded assets are negative over 24h right now.';
    return 'The API returned no market rows for the current request.';
  }

  function restoreLocalState() {
    const restored = restoreDashboardLocalState(localStorage, {
      watchlist: watchlistStorageKey,
      holdings: portfolioStorageKey,
      controls: dashboardControlsStorageKey
    });

    watchlist = new Set(restored.watchlistIds);
    holdings = restored.holdings;
    compare = new Set(restored.controls.compareIds);
    selectedCoinId = restored.controls.selectedCoinId;
    rowsPerPage = restored.controls.rowsPerPage;
    segment = restored.controls.segment;
    localStateMessage = restored.repairedKeys.length > 0
      ? `Recovered local dashboard state by repairing ${restored.repairedKeys.join(', ')}. Valid watchlist and portfolio entries were kept when possible.`
      : 'Local watchlist, holdings, compare bench, selected drawer, row limit, and active tab are restored in this browser. Search text resets intentionally.';
    localStateRestored = true;
  }

  onMount(() => {
    restoreLocalState();
    void loadDashboard();

    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === '/' && event.target instanceof HTMLElement && !['INPUT', 'TEXTAREA'].includes(event.target.tagName)) {
        event.preventDefault();
        void openSearch();
      }

      if (event.key === 'Escape') {
        if (searchOpen) closeSearch();
        if (mobileMenuOpen) closeMobileMenu(true);
        if (selectedCoinId) closeSelectedCoin();
      }
    };

    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  });
</script>

<svelte:head>
  <title>OpenGecko Control Room</title>
  <meta
    name="description"
    content="A transparent crypto market control room powered by CoinGecko-compatible OpenGecko API routes."
  />
</svelte:head>

<main class="og-shell min-h-screen overflow-hidden pb-36 text-[#f4f1e8] md:pb-0">
  <section class="relative border-b border-white/10 bg-[#07110f]/95">
    <div class="og-noise"></div>
    <div class="mx-auto flex max-w-[1500px] flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[#91a59a]">
      <span class="inline-flex items-center gap-2"><Activity size={13} class="text-[#b8ff4d]" /> Live market room</span>
      <span>Coins <strong class="text-[#f4f1e8]">{numberText(globalData?.active_cryptocurrencies)}</strong></span>
      <span>Exchanges <strong class="text-[#f4f1e8]">{numberText(globalData?.markets)}</strong></span>
      <span>Market Cap <strong class="text-[#f4f1e8]">{money(globalData?.total_market_cap?.usd, true)}</strong></span>
      <span>24h Vol <strong class="text-[#f4f1e8]">{money(globalData?.total_volume?.usd, true)}</strong></span>
      <span class="hidden items-center gap-2 md:inline-flex">
        Dominance
        {#each Object.entries(dominance).slice(0, 2) as [symbol, value]}
          <strong class="text-[#b8ff4d]">{symbol.toUpperCase()} {value.toFixed(1)}%</strong>
        {/each}
      </span>
      <span class="ml-auto inline-flex items-center gap-2 rounded-full border border-[#b8ff4d]/30 bg-[#b8ff4d]/10 px-3 py-1 text-[#b8ff4d]">
        <span class="size-1.5 rounded-full bg-[#b8ff4d] shadow-[0_0_18px_#b8ff4d]"></span>
        {runtime?.readiness?.state ?? 'booting'} · rev {runtime?.runtime?.cache_revision ?? '-'}
      </span>
    </div>
  </section>

  <nav class="sticky top-0 z-30 border-b border-white/10 bg-[#07110f]/80 backdrop-blur-xl">
    <div class="mx-auto flex h-20 max-w-[1500px] items-center gap-4 px-4">
      <button
        class="grid size-10 place-items-center rounded-xl border border-white/10 bg-white/5 text-[#f4f1e8] lg:hidden"
        bind:this={menuButton}
        type="button"
        aria-label={mobileMenuOpen ? 'Close mobile navigation menu' : 'Open mobile navigation menu'}
        aria-expanded={mobileMenuOpen}
        aria-controls="mobile-navigation"
        on:click={() => (mobileMenuOpen = !mobileMenuOpen)}
      >
        {#if mobileMenuOpen}<X size={18} />{:else}<Menu size={18} />{/if}
      </button>

      <a class="group flex shrink-0 items-center gap-3" href="/">
        <span class="relative grid size-11 place-items-center rounded-2xl border border-[#b8ff4d]/40 bg-[#b8ff4d] text-sm font-black text-[#07110f] shadow-[0_0_30px_rgba(184,255,77,0.28)]">
          OG
          <span class="absolute -right-1 -top-1 size-3 rounded-full bg-[#ffbf47]"></span>
        </span>
        <span>
          <span class="block text-[24px] font-black leading-none tracking-[-0.04em] text-[#f4f1e8]">OpenGecko</span>
          <span class="block text-[10px] font-black uppercase tracking-[0.3em] text-[#91a59a]">open market data</span>
        </span>
      </a>

      <div class="hidden items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] p-1 text-sm font-black text-[#cbd8d0] lg:flex">
        <a class="rounded-full px-4 py-2 hover:bg-white/10 hover:text-white" href="#markets">Markets</a>
        <a class="rounded-full px-4 py-2 hover:bg-white/10 hover:text-white" href="#discover">Discover</a>
        <a class="rounded-full px-4 py-2 hover:bg-white/10 hover:text-white" href="#exchanges">Exchanges</a>
        <a class="rounded-full px-4 py-2 hover:bg-white/10 hover:text-white" href="#portfolio">Portfolio</a>
        <a class="rounded-full px-4 py-2 hover:bg-white/10 hover:text-white" href="#api">API Proof</a>
      </div>

      <button
        class="ml-auto hidden h-12 min-w-[360px] items-center justify-between rounded-2xl border border-white/10 bg-white/[0.06] px-4 text-left text-sm text-[#91a59a] transition hover:border-[#b8ff4d]/40 hover:bg-white/[0.09] md:flex"
        type="button"
        aria-label="Open search for loaded market coins"
        on:click={() => void openSearch()}
      >
        <span class="flex items-center gap-2"><Search size={17} /> Search loaded market coins</span>
        <kbd class="rounded-lg border border-white/15 bg-black/30 px-2 py-1 text-[11px] font-black text-[#f4f1e8]">/</kbd>
      </button>

      <button class="grid size-11 place-items-center rounded-2xl border border-white/10 bg-white/[0.05] text-[#cbd8d0] disabled:opacity-50" type="button" disabled aria-label="Notifications are not configured in this local dashboard">
        <Bell size={18} />
      </button>
      <a class="hidden rounded-2xl bg-[#b8ff4d] px-5 py-3 text-sm font-black text-[#07110f] shadow-[0_0_28px_rgba(184,255,77,0.25)] sm:inline-flex" href={apiUrl('/ping')} target="_blank" rel="noreferrer">
        Open raw /ping
      </a>
    </div>

    {#if mobileMenuOpen}
      <div id="mobile-navigation" class="border-t border-white/10 bg-[#07110f] px-4 py-3 lg:hidden">
        <div class="grid gap-3 text-sm font-black text-[#f4f1e8]">
          <a href="#markets" on:click={(event) => { event.preventDefault(); void navigateToSection('markets'); }}>Markets</a>
          <a href="#discover" on:click={(event) => { event.preventDefault(); void navigateToSection('discover'); }}>Discover</a>
          <a href="#exchanges" on:click={(event) => { event.preventDefault(); void navigateToSection('exchanges'); }}>Exchanges</a>
          <a href="#portfolio" on:click={(event) => { event.preventDefault(); void navigateToSection('portfolio'); }}>Portfolio</a>
          <a href="#api" on:click={(event) => { event.preventDefault(); void navigateToSection('api'); }}>API Proof</a>
          <button class="text-left" type="button" on:click={() => void openSearch(menuButton)}>Search loaded market coins</button>
        </div>
      </div>
    {/if}
  </nav>

  <section class="relative mx-auto max-w-[1500px] px-4 py-8 md:py-12">
    <div class="og-grid absolute inset-0 -z-10 opacity-60"></div>

    <div class="mb-6 rounded-[1.5rem] border border-white/10 bg-[#0d1714]/90 p-4 shadow-xl" aria-live="polite">
      <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div class="flex min-w-0 items-start gap-3">
          <span class={error ? 'mt-1 grid size-9 shrink-0 place-items-center rounded-2xl bg-[#ff5c5c]/15 text-[#ff9b9b]' : 'mt-1 grid size-9 shrink-0 place-items-center rounded-2xl bg-[#b8ff4d]/15 text-[#b8ff4d]'}>
            {#if loading || initialDashboardPending}<LoaderCircle class="animate-spin" size={18} />{:else if error}<Server size={18} />{:else}<ShieldCheck size={18} />{/if}
          </span>
          <div class="min-w-0">
            <div class="font-black text-[#f4f1e8]">
              {#if loading || initialDashboardPending}
                {loadingCopy}
              {:else if error}
                {error}
              {:else}
                Dashboard data is available from the approved API boundary.
              {/if}
            </div>
            <div class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs font-bold uppercase tracking-[0.14em] text-[#91a59a]">
              <span>Boundary: {apiBoundaryLabel}</span>
              <span>Last successful refresh: {lastUpdatedAt || 'pending'}</span>
              {#if failedResourceLabels.length > 0}
                <span class="text-[#ffbf47]">Recoverable panels: {failedResourceLabels.join(', ')}</span>
              {/if}
            </div>
          </div>
        </div>
        <button
          class="inline-flex items-center justify-center gap-2 rounded-2xl border border-[#b8ff4d]/30 bg-[#b8ff4d]/10 px-4 py-3 text-sm font-black text-[#b8ff4d] disabled:cursor-not-allowed disabled:opacity-60"
          type="button"
          aria-label={loading ? 'Dashboard data is loading' : 'Refresh dashboard data'}
          disabled={loading}
          on:click={loadDashboard}
        >
          {#if loading}<LoaderCircle class="animate-spin" size={16} />{:else}<RefreshCw size={16} />{/if}
          {loading ? 'Loading' : 'Refresh'}
        </button>
      </div>
    </div>

    <div class="mb-6 grid gap-5 xl:grid-cols-[1.25fr_0.75fr]">
      <section class="relative overflow-hidden rounded-[2rem] border border-white/10 bg-[#0d1714]/90 p-6 shadow-2xl md:p-8">
        <div class="radar-orb"></div>
        <div class="relative z-10">
          <div class="mb-6 flex flex-wrap items-center gap-2">
            <span class="inline-flex items-center gap-2 rounded-full border border-[#b8ff4d]/30 bg-[#b8ff4d]/10 px-3 py-1.5 text-xs font-black uppercase tracking-[0.18em] text-[#b8ff4d]"><DatabaseZap size={14} /> CoinGecko-compatible</span>
            <span class="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs font-black uppercase tracking-[0.18em] text-[#cbd8d0]"><Clock3 size={14} /> Cache rev {runtime?.runtime?.cache_revision ?? '-'}</span>
            <span class="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs font-black uppercase tracking-[0.18em] text-[#cbd8d0]"><Wifi size={14} /> {runtime?.readiness?.canonical_phase ?? 'syncing'}</span>
          </div>

          <div class="grid gap-8 lg:grid-cols-[1fr_290px] lg:items-end">
            <div>
              <p class="mb-3 text-sm font-black uppercase tracking-[0.32em] text-[#ffbf47]">OpenGecko Control Room</p>
              <h1 class="max-w-5xl text-[46px] font-black leading-[0.9] tracking-[-0.07em] text-[#f4f1e8] md:text-[74px]">
                Crypto markets with the receipts attached.
              </h1>
              <p class="mt-6 max-w-3xl text-base leading-8 text-[#b7c8bf] md:text-lg">
                Track prices, liquidity, categories, exchanges, portfolio exposure, runtime health, and the exact API routes powering every screen. Built to feel faster, clearer, and more trustworthy than closed market dashboards.
              </p>
            </div>

            <div class="rounded-[1.5rem] border border-[#b8ff4d]/20 bg-black/30 p-4 font-mono text-xs text-[#b7c8bf] shadow-[inset_0_0_40px_rgba(184,255,77,0.05)]">
              <div class="mb-3 flex items-center justify-between text-[#b8ff4d]"><span>{loading || initialDashboardPending ? 'LOADING REQUEST' : 'LIVE REQUEST'}</span><RefreshCw size={14} class={loading || initialDashboardPending ? 'animate-spin' : ''} /></div>
              <div class="space-y-2">
                <div><span class="text-[#ffbf47]">GET</span> /coins/markets</div>
                <div class="text-[#91a59a]">vs_currency=usd</div>
                <div class="text-[#91a59a]">sparkline=true</div>
                <div class="text-[#91a59a]">price_change=1h,24h,7d,30d</div>
              </div>
            </div>
          </div>

          <div class="mt-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div class="terminal-card">
              <div class="mb-3 flex items-center justify-between text-xs font-black uppercase tracking-[0.18em] text-[#91a59a]"><span>Market Cap</span><Globe2 size={16} /></div>
              <div class="text-3xl font-black tracking-[-0.04em]">{money(globalData?.total_market_cap?.usd, true)}</div>
              <div class={isPositive(globalData?.market_cap_change_percentage_24h_usd) ? 'mt-2 inline-flex items-center gap-1 text-sm font-black text-[#b8ff4d]' : 'mt-2 inline-flex items-center gap-1 text-sm font-black text-[#ff5c5c]'}>
                {#if isPositive(globalData?.market_cap_change_percentage_24h_usd)}<ArrowUp size={14} />{:else}<ArrowDown size={14} />{/if}
                {percent(globalData?.market_cap_change_percentage_24h_usd)} 24h
              </div>
            </div>
            <div class="terminal-card">
              <div class="mb-3 flex items-center justify-between text-xs font-black uppercase tracking-[0.18em] text-[#91a59a]"><span>Volume</span><BarChart3 size={16} /></div>
              <div class="text-3xl font-black tracking-[-0.04em]">{money(globalData?.total_volume?.usd, true)}</div>
              <div class="mt-2 text-sm font-bold text-[#91a59a]">Across tracked markets</div>
            </div>
            <div class="terminal-card">
              <div class="mb-3 flex items-center justify-between text-xs font-black uppercase tracking-[0.18em] text-[#91a59a]"><span>Portfolio</span><WalletCards size={16} /></div>
              <div class="text-3xl font-black tracking-[-0.04em]">{money(portfolioValue, true)}</div>
              <div class="mt-2 text-sm font-bold text-[#91a59a]">{watchlist.size} watched assets</div>
            </div>
            <div class="terminal-card">
              <div class="mb-3 flex items-center justify-between text-xs font-black uppercase tracking-[0.18em] text-[#91a59a]"><span>Trust Layer</span><ShieldCheck size={16} /></div>
              <div class="text-3xl font-black capitalize tracking-[-0.04em]">{runtime?.provider_health?.status ?? 'unknown'}</div>
              <div class="mt-2 text-sm font-bold text-[#91a59a]">Freshness {runtime?.freshness?.status ?? '-'}</div>
            </div>
          </div>
        </div>
      </section>

      <aside id="discover" tabindex="-1" class="grid gap-5 lg:grid-cols-2 xl:grid-cols-1">
        <section class="rounded-[2rem] border border-white/10 bg-[#f4f1e8] p-5 text-[#07110f] shadow-xl">
          <div class="mb-4 flex items-center justify-between">
            <h2 class="flex items-center gap-2 text-xl font-black tracking-[-0.04em]"><Flame class="text-[#f59e0b]" size={22} /> Search Heat</h2>
            <a class="rounded-full bg-[#07110f] px-3 py-1 text-xs font-black text-[#b8ff4d]" href={apiUrl('/search/trending')} target="_blank" rel="noreferrer">Open raw /search/trending</a>
          </div>
          <div class="space-y-2">
            {#if initialDashboardPending && trending.length === 0}
              <div class="rounded-2xl border border-black/5 bg-white/55 p-4 text-sm font-black text-[#617269]">Loading search heat from /search/trending...</div>
            {:else if resourceErrors.trending && trending.length === 0}
              <div class="rounded-2xl border border-[#b45309]/20 bg-[#ffbf47]/20 p-4 text-sm font-black text-[#6d4b12]">Trending data is temporarily unavailable. Refresh after the API returns.</div>
            {:else if trending.length === 0}
              <div class="rounded-2xl border border-black/5 bg-white/55 p-4 text-sm font-black text-[#617269]">No trending coins were returned by the API.</div>
            {:else}
              {#each trending.slice(0, 6) as trend, index}
                {@const item = trend.item}
                {#if item}
                  <button
                    class="group flex w-full items-center justify-between rounded-2xl border border-black/5 bg-white/55 p-3 text-left transition hover:-translate-y-0.5 hover:bg-white"
                    type="button"
                    aria-label={`Select or filter by trending coin ${item.name}`}
                    on:click={() => selectTrending(item)}
                  >
                    <span class="flex min-w-0 items-center gap-3">
                      <span class="grid size-7 place-items-center rounded-full bg-[#07110f] text-xs font-black text-[#b8ff4d]">{index + 1}</span>
                      {#if safeImageUrl(item.thumb)}<img class="size-8 rounded-full" src={safeImageUrl(item.thumb) ?? ''} alt="" />{/if}
                      <span class="min-w-0">
                        <span class="block truncate font-black">{item.name}</span>
                        <span class="text-xs font-black uppercase text-[#6d7d74]">{item.symbol}</span>
                      </span>
                    </span>
                    <span class="text-xs font-black text-[#6d7d74]">#{item.market_cap_rank ?? '-'}</span>
                  </button>
                {/if}
              {/each}
            {/if}
          </div>
        </section>

        <section class="rounded-[2rem] border border-white/10 bg-[#0d1714] p-5 shadow-xl">
          <div class="mb-4 flex items-center justify-between">
            <h2 class="flex items-center gap-2 text-xl font-black tracking-[-0.04em]"><TrendingUp class="text-[#b8ff4d]" size={22} /> Movers</h2>
            <span class="text-xs font-black uppercase tracking-[0.2em] text-[#91a59a]">24h signal</span>
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            {#if initialDashboardPending && markets.length === 0}
              <div class="rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-sm font-bold text-[#91a59a] sm:col-span-2">Loading 24h movers from market rows...</div>
            {:else if resourceErrors.markets && markets.length === 0}
              <div class="rounded-2xl border border-[#ff5c5c]/30 bg-[#ff5c5c]/10 p-4 text-sm font-bold text-[#ffc2c2] sm:col-span-2">Movers need /coins/markets. Restore the API and use Refresh.</div>
            {:else}
            <div class="space-y-2">
              <div class="text-xs font-black uppercase tracking-[0.18em] text-[#b8ff4d]">Gainers</div>
              {#each topGainers as coin}
                <button class="flex w-full items-center justify-between rounded-2xl border border-[#b8ff4d]/15 bg-[#b8ff4d]/10 p-3 text-left" type="button" aria-label={`Open selected coin drawer for top gainer ${coin.name}`} on:click={() => selectCoin(coin)}>
                  <span class="flex min-w-0 items-center gap-2">
                    {#if safeImageUrl(coin.image)}<img class="size-7 rounded-full" src={safeImageUrl(coin.image) ?? ''} alt="" />{/if}
                    <span class="truncate font-black">{coin.symbol.toUpperCase()}</span>
                  </span>
                  <span class="font-black text-[#b8ff4d]">{percent(coin.price_change_percentage_24h)}</span>
                </button>
              {/each}
            </div>
            <div class="space-y-2">
              <div class="text-xs font-black uppercase tracking-[0.18em] text-[#ff5c5c]">Losers</div>
              {#each topLosers as coin}
                <button class="flex w-full items-center justify-between rounded-2xl border border-[#ff5c5c]/15 bg-[#ff5c5c]/10 p-3 text-left" type="button" aria-label={`Open selected coin drawer for top loser ${coin.name}`} on:click={() => selectCoin(coin)}>
                  <span class="flex min-w-0 items-center gap-2">
                    {#if safeImageUrl(coin.image)}<img class="size-7 rounded-full" src={safeImageUrl(coin.image) ?? ''} alt="" />{/if}
                    <span class="truncate font-black">{coin.symbol.toUpperCase()}</span>
                  </span>
                  <span class="font-black text-[#ff5c5c]">{percent(coin.price_change_percentage_24h)}</span>
                </button>
              {/each}
            </div>
            {/if}
          </div>
        </section>
      </aside>
    </div>

    <div class="mb-6 grid gap-5 lg:grid-cols-2">
      <section id="categories" tabindex="-1" class="rounded-[2rem] border border-white/10 bg-[#0d1714]/90 p-5 shadow-xl">
        <div class="mb-5 flex items-center justify-between">
          <div>
            <h2 class="flex items-center gap-2 text-2xl font-black tracking-[-0.05em]"><Layers3 size={22} /> Sector Radar</h2>
            <p class="mt-1 text-sm text-[#91a59a]">Category strength, liquidity, and leaders.</p>
          </div>
          <a class="rounded-full border border-[#b8ff4d]/30 px-3 py-1 text-xs font-black text-[#b8ff4d]" href={apiUrl('/coins/categories')} target="_blank" rel="noreferrer">Open raw /coins/categories</a>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          {#if initialDashboardPending && categories.length === 0}
            <div class="rounded-3xl border border-white/10 bg-white/[0.04] p-4 text-sm font-bold text-[#91a59a] sm:col-span-2">Loading sector radar from /coins/categories...</div>
          {:else if resourceErrors.categories && categories.length === 0}
            <div class="rounded-3xl border border-[#ff5c5c]/30 bg-[#ff5c5c]/10 p-4 text-sm font-bold text-[#ffc2c2] sm:col-span-2">Sector radar is unavailable. Other dashboard panels remain usable.</div>
          {:else if categories.length === 0}
            <div class="rounded-3xl border border-white/10 bg-white/[0.04] p-4 text-sm font-bold text-[#91a59a] sm:col-span-2">The categories endpoint returned no category rows.</div>
          {:else}
            {#each categories.slice(0, 4) as category}
              <div class="rounded-3xl border border-white/10 bg-white/[0.04] p-4">
                <div class="mb-3 flex items-start justify-between gap-3">
                  <div class="font-black text-[#f4f1e8]">{category.name}</div>
                  <div class={isPositive(category.market_cap_change_24h) ? 'text-sm font-black text-[#b8ff4d]' : 'text-sm font-black text-[#ff5c5c]'}>{percent(category.market_cap_change_24h)}</div>
                </div>
                <div class="text-sm text-[#91a59a]">Market Cap <strong class="text-[#f4f1e8]">{money(category.market_cap, true)}</strong></div>
                <div class="mt-3 flex -space-x-2">
                  {#each category.top_3_coins?.slice(0, 3) ?? [] as image}
                    {#if safeImageUrl(image)}<img class="size-7 rounded-full border-2 border-[#0d1714] bg-[#f4f1e8]" src={safeImageUrl(image) ?? ''} alt="" />{/if}
                  {/each}
                </div>
              </div>
            {/each}
          {/if}
        </div>
      </section>

      <section id="exchanges" tabindex="-1" class="rounded-[2rem] border border-white/10 bg-[#f4f1e8] p-5 text-[#07110f] shadow-xl">
        <div class="mb-5 flex items-center justify-between">
          <div>
            <h2 class="flex items-center gap-2 text-2xl font-black tracking-[-0.05em]"><BriefcaseBusiness size={22} /> Exchange Quality</h2>
            <p class="mt-1 text-sm text-[#617269]">Trust-ranked venues and normalized BTC volume.</p>
          </div>
          <a class="rounded-full bg-[#07110f] px-3 py-1 text-xs font-black text-[#b8ff4d]" href={apiUrl('/exchanges')} target="_blank" rel="noreferrer">Open raw /exchanges</a>
        </div>
        <div class="grid gap-2">
          {#if initialDashboardPending && exchanges.length === 0}
            <div class="rounded-2xl border border-black/5 bg-white/60 p-4 text-sm font-black text-[#617269]">Loading exchange quality from /exchanges...</div>
          {:else if resourceErrors.exchanges && exchanges.length === 0}
            <div class="rounded-2xl border border-[#b45309]/20 bg-[#ffbf47]/20 p-4 text-sm font-black text-[#6d4b12]">Exchange data is unavailable. Refresh when the API is healthy.</div>
          {:else if exchanges.length === 0}
            <div class="rounded-2xl border border-black/5 bg-white/60 p-4 text-sm font-black text-[#617269]">The exchanges endpoint returned no venues.</div>
          {:else}
            {#each exchanges.slice(0, 5) as exchange, index}
              <div class="flex items-center justify-between gap-3 rounded-2xl border border-black/5 bg-white/60 p-3 transition hover:bg-white">
                <span class="flex min-w-0 items-center gap-3">
                  <span class="grid size-7 place-items-center rounded-full bg-[#07110f] text-xs font-black text-[#b8ff4d]">{exchange.trust_score_rank ?? index + 1}</span>
                  {#if safeImageUrl(exchange.image)}<img class="size-8 rounded-full" src={safeImageUrl(exchange.image) ?? ''} alt="" />{:else}<span class="grid size-8 place-items-center rounded-full bg-[#dfe7d8] text-xs font-black">{exchange.name.slice(0, 1)}</span>{/if}
                  <span class="truncate font-black">{exchange.name}</span>
                </span>
                <span class="flex shrink-0 items-center gap-3 text-sm font-black text-[#617269]">
                  <span>{money((exchange.trade_volume_24h_btc ?? 0) * (topCoin?.current_price ?? 0), true)}</span>
                  <a class="rounded-full bg-[#07110f] px-3 py-1 text-xs font-black text-[#b8ff4d]" href={apiUrl(`/exchanges/${exchange.id}`)} target="_blank" rel="noreferrer">Open raw exchange API</a>
                </span>
              </div>
            {/each}
          {/if}
        </div>
      </section>
    </div>

    <section id="markets" tabindex="-1" class="overflow-hidden rounded-[2rem] border border-white/10 bg-[#0d1714]/95 shadow-2xl">
      <div class="border-b border-white/10 p-5">
        <div class="mb-5 flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <p class="mb-1 text-xs font-black uppercase tracking-[0.24em] text-[#ffbf47]">Ranked market intelligence</p>
            <h2 class="text-3xl font-black tracking-[-0.06em] text-[#f4f1e8]">Top cryptocurrency prices today</h2>
            <p class="mt-2 text-sm text-[#91a59a]">Sortable market rows with watchlist, compare, holdings, sparklines, and provenance cues.</p>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <button class="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.05] px-4 py-3 text-sm font-black text-[#f4f1e8]" type="button" aria-label="Open search for loaded market coins" on:click={() => void openSearch()}>
              <Search size={16} /> Search
            </button>
            <a class="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.05] px-4 py-3 text-sm font-black text-[#b8ff4d]" href={apiUrl(marketRequestPath)} target="_blank" rel="noreferrer">
              Open raw /coins/markets
            </a>
            <button
              class="inline-flex items-center gap-2 rounded-2xl border border-[#b8ff4d]/30 bg-[#b8ff4d]/10 px-4 py-3 text-sm font-black text-[#b8ff4d] disabled:cursor-not-allowed disabled:opacity-60"
              type="button"
              aria-label={loading ? 'Market data is loading' : 'Refresh market dashboard data'}
              disabled={loading}
              on:click={loadDashboard}
            >
              {#if loading}<LoaderCircle class="animate-spin" size={16} />{:else}<RefreshCw size={16} />{/if}
              {loading ? 'Loading' : 'Refresh'}
            </button>
            <label class="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.05] px-4 py-3 text-sm font-black text-[#f4f1e8]">
              <ListFilter size={16} /> Rows
              <select class="bg-transparent font-black outline-none" bind:value={rowsPerPage} aria-label="Rows to show from loaded market rows">
                <option class="bg-[#07110f]" value={25}>25</option>
                <option class="bg-[#07110f]" value={50}>50</option>
                <option class="bg-[#07110f]" value={100}>100</option>
              </select>
            </label>
          </div>
        </div>

        {#if error}
          <div class="mb-4 rounded-2xl border border-[#ff5c5c]/30 bg-[#ff5c5c]/10 px-4 py-3 text-sm font-bold text-[#ffc2c2]">{error}</div>
        {/if}

        {#if discoveryMessage}
          <div class="mb-4 rounded-2xl border border-[#b8ff4d]/30 bg-[#b8ff4d]/10 px-4 py-3 text-sm font-bold text-[#d7ff9c]" aria-live="polite">{discoveryMessage}</div>
        {/if}

        {#if localStateMessage}
          <div class="mb-4 flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/[0.05] px-4 py-3 text-xs font-bold uppercase tracking-[0.12em] text-[#91a59a] sm:flex-row sm:items-center sm:justify-between" aria-live="polite">
            <span>{localStateMessage}</span>
            <button class="shrink-0 rounded-full border border-[#ffbf47]/40 px-3 py-2 text-[#ffdf9b] hover:bg-[#ffbf47]/10" type="button" on:click={resetLocalDashboardState}>Reset local dashboard state</button>
          </div>
        {/if}

        <Tabs.Root bind:value={segment}>
          <div class="flex flex-wrap items-center justify-between gap-3">
              <Tabs.List class="flex flex-wrap gap-2" aria-label="Market segment filters">
              <Tabs.Trigger value="all" class="rounded-full border border-white/10 px-4 py-2 text-sm font-black text-[#91a59a] data-[state=active]:border-[#b8ff4d]/40 data-[state=active]:bg-[#b8ff4d] data-[state=active]:text-[#07110f]">All Coins</Tabs.Trigger>
              <Tabs.Trigger value="gainers" class="rounded-full border border-white/10 px-4 py-2 text-sm font-black text-[#91a59a] data-[state=active]:border-[#b8ff4d]/40 data-[state=active]:bg-[#b8ff4d] data-[state=active]:text-[#07110f]">Gainers</Tabs.Trigger>
              <Tabs.Trigger value="losers" class="rounded-full border border-white/10 px-4 py-2 text-sm font-black text-[#91a59a] data-[state=active]:border-[#b8ff4d]/40 data-[state=active]:bg-[#b8ff4d] data-[state=active]:text-[#07110f]">Losers</Tabs.Trigger>
              <Tabs.Trigger value="watchlist" class="rounded-full border border-white/10 px-4 py-2 text-sm font-black text-[#91a59a] data-[state=active]:border-[#b8ff4d]/40 data-[state=active]:bg-[#b8ff4d] data-[state=active]:text-[#07110f]">Watchlist {watchlist.size}</Tabs.Trigger>
            </Tabs.List>

            <div class="flex flex-wrap items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#91a59a]">
              <span class="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.05] px-3 py-2"><SlidersHorizontal size={14} /> Sort {sortStatus}</span>
              <span class="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.05] px-3 py-2"><Eye size={14} /> Showing {visibleMarkets.length} of {sortedMarkets.length} loaded matches</span>
            </div>
          </div>
        </Tabs.Root>
        <p class="mt-4 text-xs font-bold uppercase tracking-[0.14em] text-[#91a59a]">
          Rows is a local limit over the loaded top-100 `/coins/markets` response; no fake page navigation is shown.
          Watchlist, holdings, compare bench, active tab, row limit, and an open selected drawer are browser-local state; closing the drawer clears that selected context, and search text resets on reload.
          <span class="text-[#b8ff4d] md:hidden"> On mobile, swipe the table horizontally to reach holdings, compare, trace, and raw-detail actions.</span>
        </p>
      </div>

      <div class="market-table-wrap overflow-x-auto" role="region" aria-label="Scrollable market table with sortable columns, holdings, compare, and trace controls">
        <table class="market-table w-full min-w-[1320px] border-collapse text-sm">
          <thead class="bg-white/[0.03] text-left text-[11px] font-black uppercase tracking-[0.14em] text-[#91a59a]">
            <tr>
              <th class="w-12 px-4 py-4"></th>
              <th class="w-16 px-3 py-4" aria-sort={sortKey === 'rank' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}>
                <button class="font-black text-[#f4f1e8]" type="button" aria-label={`Sort by rank; currently ${sortStatus}`} on:click={() => setSort('rank')}># {sortIndicator('rank')}</button>
              </th>
              <th class="px-3 py-4">Coin</th>
              <th class="px-3 py-4 text-right" aria-sort={sortKey === 'price' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}>
                <button class="font-black text-[#f4f1e8]" type="button" aria-label={`Sort by price; currently ${sortStatus}`} on:click={() => setSort('price')}>Price {sortIndicator('price')}</button>
              </th>
              <th class="px-3 py-4 text-right">1h</th>
              <th class="px-3 py-4 text-right" aria-sort={sortKey === 'change24h' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}>
                <button class="font-black text-[#f4f1e8]" type="button" aria-label={`Sort by 24h change; currently ${sortStatus}`} on:click={() => setSort('change24h')}>24h {sortIndicator('change24h')}</button>
              </th>
              <th class="px-3 py-4 text-right">7d</th>
              <th class="px-3 py-4 text-right">30d</th>
              <th class="px-3 py-4 text-right" aria-sort={sortKey === 'volume' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}>
                <button class="font-black text-[#f4f1e8]" type="button" aria-label={`Sort by 24h volume; currently ${sortStatus}`} on:click={() => setSort('volume')}>24h Volume {sortIndicator('volume')}</button>
              </th>
              <th class="px-3 py-4 text-right" aria-sort={sortKey === 'marketCap' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}>
                <button class="font-black text-[#f4f1e8]" type="button" aria-label={`Sort by market cap; currently ${sortStatus}`} on:click={() => setSort('marketCap')}>Market Cap {sortIndicator('marketCap')}</button>
              </th>
              <th class="px-3 py-4 text-right" aria-sort={sortKey === 'fdv' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}>
                <button class="font-black text-[#f4f1e8]" type="button" aria-label={`Sort by FDV; currently ${sortStatus}`} on:click={() => setSort('fdv')}>FDV {sortIndicator('fdv')}</button>
              </th>
              <th class="px-3 py-4 text-right">Mkt / FDV</th>
              <th class="px-3 py-4 text-right">Holdings</th>
              <th class="px-4 py-4 text-right">Compare / 7D Trace / Raw API</th>
            </tr>
          </thead>
          <tbody>
            {#if visibleMarkets.length === 0}
              <tr>
                <td class="px-4 py-12 text-center text-sm font-bold text-[#91a59a]" colspan="14">{marketEmptyCopy}</td>
              </tr>
            {/if}
            {#each visibleMarkets as coin}
              <tr class={selectedCoin?.id === coin.id ? 'selected-market-row border-t border-white/10 bg-[#b8ff4d]/10 transition hover:bg-white/[0.04]' : 'border-t border-white/10 transition hover:bg-white/[0.04]'}>
                <td class="px-4 py-4">
                  <button class={watchlist.has(coin.id) ? 'text-[#ffbf47]' : 'text-white/25 hover:text-[#ffbf47]'} type="button" aria-pressed={watchlist.has(coin.id)} aria-label={watchlist.has(coin.id) ? `Remove ${coin.name} from watchlist` : `Add ${coin.name} to watchlist`} on:click={() => toggleWatch(coin.id)}>
                    <Star size={17} fill={watchlist.has(coin.id) ? 'currentColor' : 'none'} />
                  </button>
                </td>
                <td class="px-3 py-4 font-black text-[#91a59a]">{coin.market_cap_rank ?? '-'}</td>
                <td class="px-3 py-4">
                  <button class="flex min-w-0 items-center gap-3 text-left" type="button" aria-label={`Open selected coin drawer for ${coin.name}`} on:click={() => selectCoin(coin)}>
                    {#if safeImageUrl(coin.image)}<img class="size-8 rounded-full" src={safeImageUrl(coin.image) ?? ''} alt="" loading="lazy" />{/if}
                    <span class="min-w-0">
                      <span class="block truncate font-black text-[#f4f1e8]">{coin.name}</span>
                      <span class="block text-xs font-black uppercase tracking-[0.14em] text-[#91a59a]">{coin.symbol}</span>
                    </span>
                  </button>
                </td>
                <td class="px-3 py-4 text-right font-black text-[#f4f1e8]">{money(coin.current_price)}</td>
                <td class={isPositive(coin.price_change_percentage_1h_in_currency) ? 'px-3 py-4 text-right font-black text-[#b8ff4d]' : 'px-3 py-4 text-right font-black text-[#ff5c5c]'}>{percent(coin.price_change_percentage_1h_in_currency)}</td>
                <td class={isPositive(coin.price_change_percentage_24h) ? 'px-3 py-4 text-right font-black text-[#b8ff4d]' : 'px-3 py-4 text-right font-black text-[#ff5c5c]'}>{percent(coin.price_change_percentage_24h)}</td>
                <td class={isPositive(coin.price_change_percentage_7d_in_currency) ? 'px-3 py-4 text-right font-black text-[#b8ff4d]' : 'px-3 py-4 text-right font-black text-[#ff5c5c]'}>{percent(coin.price_change_percentage_7d_in_currency)}</td>
                <td class={isPositive(coin.price_change_percentage_30d_in_currency) ? 'px-3 py-4 text-right font-black text-[#b8ff4d]' : 'px-3 py-4 text-right font-black text-[#ff5c5c]'}>{percent(coin.price_change_percentage_30d_in_currency)}</td>
                <td class="px-3 py-4 text-right text-[#d8e3dd]">{money(coin.total_volume, true)}</td>
                <td class="px-3 py-4 text-right text-[#d8e3dd]">{money(coin.market_cap, true)}</td>
                <td class="px-3 py-4 text-right text-[#d8e3dd]">{money(coin.fully_diluted_valuation, true)}</td>
                <td class="px-3 py-4 text-right">
                  {#if capFdvRatio(coin) == null}
                    <span class="text-[#91a59a]">-</span>
                  {:else}
                    <div class="ml-auto h-2 w-24 overflow-hidden rounded-full bg-white/10">
                      <div class="h-full rounded-full bg-[#b8ff4d]" style={`width: ${Math.max(4, Math.min(capFdvRatio(coin) ?? 0, 100))}%`}></div>
                    </div>
                    <div class="mt-1 text-xs font-bold text-[#91a59a]">{(capFdvRatio(coin) ?? 0).toFixed(0)}%</div>
                  {/if}
                </td>
                <td class="px-3 py-4 text-right">
                  <input class="h-9 w-24 rounded-xl border border-white/10 bg-white/[0.06] px-2 text-right text-xs font-bold text-[#f4f1e8] outline-none focus:border-[#b8ff4d]" value={holdings[coin.id] ?? ''} placeholder="0" on:input={(event) => updateHolding(coin.id, event.currentTarget.value)} aria-label={`${coin.name} holding amount`} />
                </td>
                <td class="px-4 py-4">
                  <div class="flex items-center justify-end gap-3">
                    <button
                      class={compare.has(coin.id) ? 'grid size-9 place-items-center rounded-xl bg-[#b8ff4d] text-[#07110f]' : compare.size >= compareSelectionLimit ? 'grid size-9 cursor-not-allowed place-items-center rounded-xl border border-white/10 text-[#91a59a] opacity-45' : 'grid size-9 place-items-center rounded-xl border border-white/10 text-[#91a59a]'}
                      type="button"
                      disabled={!compare.has(coin.id) && compare.size >= compareSelectionLimit}
                      aria-pressed={compare.has(coin.id)}
                      aria-label={compareButtonLabel(coin, compare.has(coin.id), compare.size)}
                      title={compareButtonLabel(coin, compare.has(coin.id), compare.size)}
                      on:click={() => toggleCompare(coin.id)}
                    >
                      {#if compare.has(coin.id)}<Check size={15} />{:else}<LineChart size={15} />{/if}
                    </button>
                    <a class="rounded-xl border border-white/10 px-3 py-2 text-xs font-black text-[#b8ff4d]" href={apiUrl(`/coins/${coin.id}`)} target="_blank" rel="noreferrer" aria-label={`Open raw coin API for ${coin.name}`}>Raw API</a>
                    {#if sparkPath(coin.sparkline_in_7d?.price)}
                      <svg class="h-10 w-[154px]" viewBox="0 0 154 42" role="img" aria-label={`${coin.name} 7-day sparkline from /coins/markets`}>
                        <path d={sparkPath(coin.sparkline_in_7d?.price)} fill="none" stroke={isPositive(coin.price_change_percentage_7d_in_currency) ? '#b8ff4d' : '#ff5c5c'} stroke-linecap="round" stroke-width="2.4" />
                      </svg>
                    {:else}
                      <span class="w-[154px] text-right text-xs font-black uppercase tracking-[0.12em] text-[#91a59a]">No sparkline</span>
                    {/if}
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <div class="mt-6 grid gap-5 lg:grid-cols-[380px_1fr]">
      <section id="portfolio" tabindex="-1" class="rounded-[2rem] border border-white/10 bg-[#f4f1e8] p-5 text-[#07110f] shadow-xl">
        <div class="mb-4 flex items-center justify-between">
          <h2 class="flex items-center gap-2 text-2xl font-black tracking-[-0.05em]"><WalletCards size={22} /> Local Portfolio</h2>
          <span class="text-2xl font-black tracking-[-0.04em]">{money(portfolioValue, true)}</span>
        </div>
        <div class="space-y-2">
          {#each markets.filter((coin) => (holdings[coin.id] ?? 0) > 0).slice(0, 6) as coin}
            <div class="flex items-center justify-between rounded-2xl bg-white/65 p-3">
              <span class="flex items-center gap-2">
                {#if safeImageUrl(coin.image)}<img class="size-7 rounded-full" src={safeImageUrl(coin.image) ?? ''} alt="" />{/if}
                <span>
                  <span class="block font-black">{coin.symbol.toUpperCase()}</span>
                  <span class="block text-xs font-bold text-[#617269]">{holdings[coin.id]} × {money(coin.current_price)}</span>
                </span>
              </span>
              <span class="font-black">{money((holdings[coin.id] ?? 0) * (coin.current_price ?? 0), true)}</span>
            </div>
          {:else}
            <div class="rounded-2xl bg-white/65 p-4 text-sm font-bold text-[#617269]">Enter holdings in the table to build a private local portfolio.</div>
          {/each}
        </div>
      </section>

      <section class="rounded-[2rem] border border-white/10 bg-[#0d1714]/95 p-5 shadow-xl">
        <div class="mb-4 flex items-center justify-between">
          <h2 class="flex items-center gap-2 text-2xl font-black tracking-[-0.05em]"><LineChart size={22} /> Compare Bench</h2>
          <span class="rounded-full border border-white/10 px-3 py-1 text-xs font-black uppercase tracking-[0.16em] text-[#91a59a]">{compare.size}/{compareSelectionLimit} selected</span>
        </div>
        {#if compareLimitMessage || compare.size >= compareSelectionLimit}
          <div class="mb-3 rounded-2xl border border-[#ffbf47]/30 bg-[#ffbf47]/10 px-4 py-3 text-sm font-bold text-[#ffe0a3]" aria-live="polite">
            {compareLimitMessage || `Compare Bench is full (${compareSelectionLimit}/${compareSelectionLimit}). Remove an asset before adding another.`}
          </div>
        {/if}
        <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {#each compareCoins as coin}
            <div class="rounded-3xl border border-white/10 bg-white/[0.04] p-4">
              <div class="mb-3 flex items-center justify-between">
                <span class="flex items-center gap-2 font-black">
                  {#if safeImageUrl(coin.image)}<img class="size-7 rounded-full" src={safeImageUrl(coin.image) ?? ''} alt="" />{/if}
                  {coin.symbol.toUpperCase()}
                </span>
                <button class="text-[#91a59a]" type="button" aria-label={`Remove ${coin.name} from compare`} on:click={() => toggleCompare(coin.id)}><X size={15} /></button>
              </div>
              <div class="text-3xl font-black tracking-[-0.04em]">{money(coin.current_price)}</div>
              <div class={isPositive(coin.price_change_percentage_24h) ? 'mt-1 text-sm font-black text-[#b8ff4d]' : 'mt-1 text-sm font-black text-[#ff5c5c]'}>{percent(coin.price_change_percentage_24h)} 24h</div>
              <div class="mt-4 grid gap-2 text-xs font-bold text-[#91a59a]">
                <div class="flex justify-between gap-3"><span>Rank</span><strong class="text-[#f4f1e8]">#{coin.market_cap_rank ?? '-'}</strong></div>
                <div class="flex justify-between gap-3"><span>Market cap</span><strong class="text-[#f4f1e8]">{money(coin.market_cap, true)}</strong></div>
                <div class="flex justify-between gap-3"><span>24h volume</span><strong class="text-[#f4f1e8]">{money(coin.total_volume, true)}</strong></div>
              </div>
            </div>
          {:else}
            <div class="rounded-3xl border border-white/10 bg-white/[0.04] p-5 text-sm font-bold text-[#91a59a] md:col-span-2 xl:col-span-4">Use chart buttons in the market table to compare up to four assets. The bench is restored locally in this browser and can be cleared with each card's remove button.</div>
          {/each}
        </div>
      </section>
    </div>

    <section id="api" tabindex="-1" class="mt-6 overflow-hidden rounded-[2rem] border border-[#b8ff4d]/20 bg-[#07110f] p-6 shadow-[0_0_70px_rgba(184,255,77,0.08)]">
      <div class="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
        <div>
          <p class="mb-2 text-xs font-black uppercase tracking-[0.28em] text-[#ffbf47]">Data transparency advantage</p>
          <h2 class="text-3xl font-black tracking-[-0.06em]">Every card should explain its source.</h2>
          <p class="mt-3 max-w-xl text-sm leading-7 text-[#91a59a]">OpenGecko can beat closed dashboards by turning runtime health, provider freshness, cache state, and CoinGecko-compatible route proof into first-class UI.</p>
        </div>
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div class="terminal-card"><div class="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#91a59a]"><Server size={15} /> Server</div><div class="text-xl font-black capitalize">{runtime?.readiness?.state ?? 'unknown'}</div></div>
          <div class="terminal-card"><div class="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#91a59a]"><ShieldCheck size={15} /> Provider</div><div class="text-xl font-black capitalize">{runtime?.provider_health?.status ?? 'unknown'}</div></div>
          <div class="terminal-card"><div class="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#91a59a]"><CircleDollarSign size={15} /> Freshness</div><div class="text-xl font-black capitalize">{runtime?.freshness?.status ?? 'unknown'}</div></div>
          <div class="terminal-card"><div class="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#91a59a]"><BookOpen size={15} /> Runtime</div><a class="inline-flex items-center gap-2 text-xl font-black text-[#b8ff4d]" href={apiUrl('/diagnostics/runtime')} target="_blank" rel="noreferrer">Open raw /diagnostics/runtime <ExternalLink size={15} /></a></div>
        </div>
      </div>
    </section>
  </section>

  {#if selectedCoin}
    <div class="fixed bottom-4 left-4 right-4 z-20 rounded-[1.75rem] border border-white/10 bg-[#07110f]/95 p-4 text-[#f4f1e8] shadow-2xl backdrop-blur-xl md:left-auto md:w-[440px]" role="dialog" aria-modal="false" aria-labelledby="selected-coin-title">
      <div class="mb-3 flex items-center justify-between">
        <div class="flex items-center gap-3">
          {#if safeImageUrl(selectedCoin.image)}<img class="size-10 rounded-full" src={safeImageUrl(selectedCoin.image) ?? ''} alt="" />{/if}
          <div>
            <div id="selected-coin-title" class="font-black">{selectedCoin.name}</div>
            <div class="text-xs font-black uppercase tracking-[0.14em] text-[#91a59a]">{selectedCoin.symbol} · Rank #{selectedCoin.market_cap_rank ?? '-'}</div>
          </div>
        </div>
        <button class="text-[#91a59a]" bind:this={selectedCoinCloseButton} type="button" aria-label={`Close selected coin drawer for ${selectedCoin.name}`} on:click={closeSelectedCoin}><X size={18} /></button>
      </div>
      <div class="grid grid-cols-3 gap-2 text-sm">
        <div class="rounded-2xl border border-white/10 bg-white/[0.05] p-3"><div class="text-xs font-bold text-[#91a59a]">Price</div><div class="font-black">{money(selectedCoin.current_price)}</div></div>
        <div class="rounded-2xl border border-white/10 bg-white/[0.05] p-3"><div class="text-xs font-bold text-[#91a59a]">High</div><div class="font-black">{money(selectedCoin.high_24h)}</div></div>
        <div class="rounded-2xl border border-white/10 bg-white/[0.05] p-3"><div class="text-xs font-bold text-[#91a59a]">Low</div><div class="font-black">{money(selectedCoin.low_24h)}</div></div>
      </div>
      <div class="mt-3 flex gap-2">
        <button class="flex-1 rounded-2xl border border-white/10 px-3 py-2 text-sm font-black" type="button" aria-label={watchlist.has(selectedCoin.id) ? `Remove ${selectedCoin.name} from watchlist` : `Add ${selectedCoin.name} to watchlist`} on:click={() => toggleWatch(selectedCoin.id)}>{watchlist.has(selectedCoin.id) ? 'Remove Watchlist' : 'Add Watchlist'}</button>
        <a class="flex-1 rounded-2xl bg-[#b8ff4d] px-3 py-2 text-center text-sm font-black text-[#07110f]" href={apiUrl(`/coins/${selectedCoin.id}`)} target="_blank" rel="noreferrer">Open raw coin API</a>
      </div>
    </div>
  {/if}

  {#if searchOpen}
    <div class="fixed inset-0 z-50 p-4">
      <button class="absolute inset-0 bg-[#020504]/70 backdrop-blur-sm" type="button" aria-label="Close search dialog" on:click={() => closeSearch()}></button>
      <div class="relative mx-auto mt-16 max-w-2xl overflow-hidden rounded-[1.75rem] border border-white/10 bg-[#0d1714] text-[#f4f1e8] shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="search-dialog-title">
        <div class="flex items-center gap-3 border-b border-white/10 px-4 py-3">
          <Search size={18} class="text-[#91a59a]" />
          <label id="search-dialog-title" class="sr-only" for="dashboard-search-input">Search loaded market coins</label>
          <input id="dashboard-search-input" class="h-12 flex-1 bg-transparent outline-none placeholder:text-[#66766d]" bind:this={searchInput} bind:value={query} aria-describedby="search-dialog-help" placeholder="Search loaded market coins by name, ticker, or id" />
          <button class="grid size-9 place-items-center rounded-xl text-[#91a59a] hover:bg-white/10" type="button" aria-label="Close search dialog" on:click={() => closeSearch()}><X size={18} /></button>
        </div>
        <p id="search-dialog-help" class="border-b border-white/10 px-4 py-2 text-xs font-bold uppercase tracking-[0.12em] text-[#91a59a]">Results are filtered from the loaded top-100 market rows. Use Enter to select a result or Escape to close.</p>
        <div class="max-h-[520px] overflow-y-auto p-3">
          {#if initialDashboardPending && markets.length === 0}
            <div class="rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-sm font-bold text-[#91a59a]">Loading searchable market coins...</div>
          {:else if searchedMarkets.length === 0}
            <div class="rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-sm font-bold text-[#91a59a]">{marketEmptyCopy}</div>
          {:else}
            {#each searchedMarkets.slice(0, 10) as coin}
              <button class="flex w-full items-center justify-between rounded-2xl p-3 text-left hover:bg-white/[0.06]" type="button" aria-label={`Select ${coin.name} from search results`} on:click={() => selectCoin(coin)}>
                <span class="flex items-center gap-3">
                  {#if safeImageUrl(coin.image)}<img class="size-9 rounded-full" src={safeImageUrl(coin.image) ?? ''} alt="" />{/if}
                  <span>
                    <span class="block font-black">{coin.name}</span>
                    <span class="text-xs font-black uppercase tracking-[0.14em] text-[#91a59a]">{coin.symbol} · #{coin.market_cap_rank ?? '-'}</span>
                  </span>
                </span>
                <span class="font-black">{money(coin.current_price)}</span>
              </button>
            {/each}
          {/if}
        </div>
      </div>
    </div>
  {/if}
</main>
