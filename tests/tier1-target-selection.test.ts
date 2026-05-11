import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TIER1_TARGET_SELECTION_POLICY,
  selectTier1Targets,
} from '../src/services/tier1-target-selection';

function rankedUniverse(size: number) {
  return Array.from({ length: size }, (_, index) => ({
    id: `coin-${String(index + 1).padStart(4, '0')}`,
    rank: index + 1,
  }));
}

describe('Tier 1 target selection', () => {
  it('selects top 100 every cycle and rotates mid-tier targets without starvation', () => {
    const universe = rankedUniverse(1_050);
    const observedMidTargets = new Set<string>();

    for (let cycle = 0; cycle < 5; cycle += 1) {
      const selection = selectTier1Targets(universe, cycle, {
        ...DEFAULT_TIER1_TARGET_SELECTION_POLICY,
        midSliceSize: 180,
        longTailSliceSize: 0,
        maxTargetsPerCycle: 280,
      });

      expect(selection.targets.slice(0, 100).map((target) => target.id)).toEqual(
        universe.slice(0, 100).map((target) => target.id),
      );
      for (const target of selection.targets.filter((candidate) => candidate.tier === 'mid')) {
        observedMidTargets.add(target.id);
      }
    }

    expect(observedMidTargets.size).toBe(900);
    expect(observedMidTargets.has('coin-0101')).toBe(true);
    expect(observedMidTargets.has('coin-1000')).toBe(true);
  });

  it('keeps long-tail opportunistic and rate-limit bounded for oversized catalogs', () => {
    const universe = rankedUniverse(5_000);
    const policy = {
      ...DEFAULT_TIER1_TARGET_SELECTION_POLICY,
      topCount: 100,
      midSliceSize: 50,
      longTailSliceSize: 25,
      longTailEveryCycles: 3,
      maxTargetsPerCycle: 175,
    };

    const longTailCycle = selectTier1Targets(universe, 3, policy);
    expect(longTailCycle.targets.length).toBeLessThanOrEqual(policy.maxTargetsPerCycle);
    expect(longTailCycle.diagnostics.top_selected).toBe(100);
    expect(longTailCycle.diagnostics.mid_selected).toBe(50);
    expect(longTailCycle.diagnostics.long_tail_selected).toBe(25);
    expect(longTailCycle.diagnostics.long_tail_deferred).toBeGreaterThan(0);

    const ordinaryCycle = selectTier1Targets(universe, 4, policy);
    expect(ordinaryCycle.targets.length).toBe(150);
    expect(ordinaryCycle.diagnostics.long_tail_selected).toBe(0);
    expect(ordinaryCycle.targets.some((target) => target.tier === 'long_tail')).toBe(false);
  });
});
