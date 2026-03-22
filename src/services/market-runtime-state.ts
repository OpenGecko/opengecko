export type MarketDataRuntimeState = {
  initialSyncCompleted: boolean;
  allowStaleLiveService: boolean;
  syncFailureReason: string | null;
};

export function createMarketDataRuntimeState(): MarketDataRuntimeState {
  return {
    initialSyncCompleted: false,
    allowStaleLiveService: false,
    syncFailureReason: null,
  };
}
