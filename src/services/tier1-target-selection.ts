export type Tier1TargetTier = 'top' | 'mid' | 'long_tail';

export type Tier1TargetCandidate = {
  id: string;
  rank: number | null;
};

export type Tier1SelectedTarget = Tier1TargetCandidate & {
  tier: Tier1TargetTier;
};

export type Tier1TargetSelectionPolicy = {
  topCount: number;
  midStartRank: number;
  midEndRank: number;
  midSliceSize: number;
  longTailSliceSize: number;
  longTailEveryCycles: number;
  maxTargetsPerCycle: number;
};

export type Tier1TargetSelection = {
  targets: Tier1SelectedTarget[];
  diagnostics: {
    cycle_index: number;
    top_selected: number;
    mid_selected: number;
    long_tail_selected: number;
    long_tail_deferred: number;
    max_targets_per_cycle: number;
  };
};

export const DEFAULT_TIER1_TARGET_SELECTION_POLICY: Tier1TargetSelectionPolicy = {
  topCount: 100,
  midStartRank: 101,
  midEndRank: 1000,
  midSliceSize: 100,
  longTailSliceSize: 25,
  longTailEveryCycles: 5,
  maxTargetsPerCycle: 225,
};

function sortByRankThenId(left: Tier1TargetCandidate, right: Tier1TargetCandidate) {
  const leftRank = left.rank ?? Number.MAX_SAFE_INTEGER;
  const rightRank = right.rank ?? Number.MAX_SAFE_INTEGER;
  const rankDelta = leftRank - rightRank;

  return rankDelta === 0 ? left.id.localeCompare(right.id) : rankDelta;
}

function rotatingSlice<T>(items: T[], cycleIndex: number, size: number) {
  if (items.length === 0 || size <= 0) {
    return [];
  }

  const boundedSize = Math.min(size, items.length);
  const start = (Math.max(0, cycleIndex) * boundedSize) % items.length;
  const selected: T[] = [];

  for (let offset = 0; offset < boundedSize; offset += 1) {
    selected.push(items[(start + offset) % items.length]!);
  }

  return selected;
}

export function selectTier1Targets(
  universe: Tier1TargetCandidate[],
  cycleIndex: number,
  policy: Tier1TargetSelectionPolicy = DEFAULT_TIER1_TARGET_SELECTION_POLICY,
): Tier1TargetSelection {
  const ranked = [...universe].sort(sortByRankThenId);
  const topCandidates = ranked.filter((candidate) => candidate.rank !== null && candidate.rank <= policy.topCount);
  const midCandidates = ranked.filter((candidate) =>
    candidate.rank !== null
    && candidate.rank >= policy.midStartRank
    && candidate.rank <= policy.midEndRank,
  );
  const longTailCandidates = ranked.filter((candidate) =>
    candidate.rank === null || candidate.rank > policy.midEndRank,
  );

  const selectedTop = topCandidates
    .slice(0, policy.topCount)
    .map((candidate): Tier1SelectedTarget => ({ ...candidate, tier: 'top' }));
  const remainingBudgetAfterTop = Math.max(0, policy.maxTargetsPerCycle - selectedTop.length);
  const selectedMid = rotatingSlice(midCandidates, cycleIndex, Math.min(policy.midSliceSize, remainingBudgetAfterTop))
    .map((candidate): Tier1SelectedTarget => ({ ...candidate, tier: 'mid' }));
  const remainingBudgetAfterMid = Math.max(0, policy.maxTargetsPerCycle - selectedTop.length - selectedMid.length);
  const shouldSelectLongTail = policy.longTailEveryCycles > 0 && cycleIndex > 0 && cycleIndex % policy.longTailEveryCycles === 0;
  const selectedLongTail = shouldSelectLongTail
    ? rotatingSlice(longTailCandidates, Math.floor(cycleIndex / policy.longTailEveryCycles), Math.min(policy.longTailSliceSize, remainingBudgetAfterMid))
      .map((candidate): Tier1SelectedTarget => ({ ...candidate, tier: 'long_tail' }))
    : [];

  return {
    targets: [...selectedTop, ...selectedMid, ...selectedLongTail],
    diagnostics: {
      cycle_index: cycleIndex,
      top_selected: selectedTop.length,
      mid_selected: selectedMid.length,
      long_tail_selected: selectedLongTail.length,
      long_tail_deferred: Math.max(0, longTailCandidates.length - selectedLongTail.length),
      max_targets_per_cycle: policy.maxTargetsPerCycle,
    },
  };
}
