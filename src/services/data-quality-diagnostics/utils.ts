
export function isFinitePositive(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function isFiniteNonNegative(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function latestIsoFromDates(values: Array<Date | null | undefined>) {
  const latest = values.reduce<Date | null>((current, value) => {
    if (!value) {
      return current;
    }

    return current === null || value.getTime() > current.getTime() ? value : current;
  }, null);

  return latest?.toISOString() ?? null;
}

export function safePercentage(numerator: number, denominator: number) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return 0;
  }

  return (numerator / denominator) * 100;
}

export function deltaRatio(left: number, right: number) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return 1;
  }

  if (left === 0) {
    return right === 0 ? 0 : 1;
  }

  return Math.abs(left - right) / Math.abs(left);
}
