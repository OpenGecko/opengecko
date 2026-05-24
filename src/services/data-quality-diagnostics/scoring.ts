
import type { QualityDimensionId, QualityStatus, SourceState } from '../data-quality-contract';
import { TARGET_THRESHOLD } from './constants';
import type { CoverageEntry, QualityDimension } from './types';

export function roundScore(score: number) {
  if (!Number.isFinite(score)) {
    return 0;
  }

  return Math.max(0, Math.min(10, Math.round(score * 10) / 10));
}

export function statusForScore(score: number, required: boolean): QualityStatus {
  if (!required) {
    return 'out_of_scope';
  }

  if (score >= TARGET_THRESHOLD) {
    return 'pass';
  }

  return score >= 6 ? 'degraded' : 'fail';
}

export function sourceStateForOwnership(ownershipClass: CoverageEntry['ownership_class'] | undefined): SourceState {
  switch (ownershipClass) {
    case 'live':
      return 'live';
    case 'hybrid':
      return 'hybrid';
    case 'seeded':
      return 'seeded';
    case 'fixture':
      return 'fixture';
    case 'synthetic':
      return 'synthetic';
    case 'unavailable':
    default:
      return 'unavailable';
  }
}

export function sourceScore(sourceState: SourceState) {
  switch (sourceState) {
    case 'live':
      return 9.5;
    case 'hybrid':
      return 7;
    case 'seeded':
      return 5.5;
    case 'replay':
      return 5;
    case 'fixture':
      return 4;
    case 'synthetic':
      return 4;
    case 'fallback':
      return 5;
    case 'degraded':
      return 5;
    case 'stale':
      return 5;
    case 'out_of_scope':
      return 0;
    case 'unavailable':
    default:
      return 0;
  }
}

export function freshnessScore(entry: CoverageEntry | undefined, sourceState: SourceState) {
  if (!entry) {
    return { score: 4, reason: 'missing_coverage_entry' };
  }

  switch (entry.freshness.state) {
    case 'degraded':
      return { score: 7, reason: 'stale_source' };
    case 'stale':
      return { score: 5, reason: 'stale_source' };
    case 'unknown':
      return { score: 4, reason: 'unknown_freshness' };
    default:
      break;
  }

  if (sourceState === 'fixture' || sourceState === 'seeded' || sourceState === 'synthetic') {
    return { score: 6, reason: `${sourceState}_source` };
  }

  switch (entry.freshness.state) {
    case 'fresh':
      return { score: 9.5, reason: 'fresh_source' };
    case 'unbudgeted':
      return { score: entry.last_successful_refresh_at ? 9 : 7, reason: entry.last_successful_refresh_at ? 'unbudgeted_source' : 'missing_freshness_budget' };
    default:
      return { score: 4, reason: 'unknown_freshness' };
  }
}

export function buildDimension(
  id: QualityDimensionId,
  score: number,
  required: boolean,
  reasonCodes: string[],
  message: string,
): QualityDimension {
  const normalizedScore = roundScore(score);
  return {
    id,
    score: normalizedScore,
    status: statusForScore(normalizedScore, required),
    weight: 1,
    reason_codes: reasonCodes,
    message,
  };
}
