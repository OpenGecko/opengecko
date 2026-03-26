export type MarketDataRuntimeState = {
  initialSyncCompleted: boolean;
  allowStaleLiveService: boolean;
  syncFailureReason: string | null;
  listenerBound: boolean;
  hotDataRevision: number;
};

export function createMarketDataRuntimeState(): MarketDataRuntimeState {
  return {
    initialSyncCompleted: false,
    allowStaleLiveService: false,
    syncFailureReason: null,
    listenerBound: false,
    hotDataRevision: 0,
  };
}
