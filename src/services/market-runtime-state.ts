export type MarketDataRuntimeState = {
  initialSyncCompleted: boolean;
  allowStaleLiveService: boolean;
  syncFailureReason: string | null;
  listenerBound: boolean;
  hotDataRevision: number;
  providerFailureCooldownUntil: number | null;
  forcedProviderFailure: {
    active: boolean;
    reason: string | null;
  };
  startupPrewarm: {
    enabled: boolean;
    budgetMs: number;
    readyWithinBudget: boolean;
    firstRequestWarmBenefitsObserved: boolean;
    targets: Array<{
      id: string;
      label: string;
      endpoint: string;
    }>;
    completedAt: number | null;
    totalDurationMs: number | null;
    targetResults: Array<{
      id: string;
      label: string;
      endpoint: string;
      status: 'completed' | 'timeout' | 'failed';
      durationMs: number;
      cacheSurface: 'simple_price' | 'coins_markets';
      warmCacheRevision: number | null;
      firstObservedRequest?: {
        durationMs: number;
        cacheHit: boolean;
      } | null;
    }>;
  };
};

export function createMarketDataRuntimeState(): MarketDataRuntimeState {
  return {
    initialSyncCompleted: false,
    allowStaleLiveService: false,
    syncFailureReason: null,
    listenerBound: false,
    hotDataRevision: 0,
    providerFailureCooldownUntil: null,
    forcedProviderFailure: {
      active: false,
      reason: null,
    },
    startupPrewarm: {
      enabled: false,
      budgetMs: 0,
      readyWithinBudget: true,
      firstRequestWarmBenefitsObserved: false,
      targets: [],
      completedAt: null,
      totalDurationMs: null,
      targetResults: [],
    },
  };
}
