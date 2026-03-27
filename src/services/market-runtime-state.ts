export type MarketDataRuntimeState = {
  initialSyncCompleted: boolean;
  allowStaleLiveService: boolean;
  syncFailureReason: string | null;
  listenerBound: boolean;
  hotDataRevision: number;
  validationOverride: {
    mode: 'off' | 'stale_disallowed' | 'stale_allowed' | 'degraded_seeded_bootstrap';
    reason: string | null;
    snapshotTimestampOverride: string | null;
    snapshotSourceCountOverride: number | null;
  };
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
    firstRequestWarmBenefitPending: boolean;
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
      status: 'completed' | 'timeout' | 'failed' | 'skipped_budget';
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
    validationOverride: {
      mode: 'off',
      reason: null,
      snapshotTimestampOverride: null,
      snapshotSourceCountOverride: null,
    },
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
      firstRequestWarmBenefitPending: false,
      targets: [],
      completedAt: null,
      totalDurationMs: null,
      targetResults: [],
    },
  };
}
