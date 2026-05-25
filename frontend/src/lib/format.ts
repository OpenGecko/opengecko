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

export function money(value: number | null | undefined, compact = false) {
  if (value == null || Number.isNaN(value)) return '-';
  return compact ? compactUsd.format(value) : formatUsd.format(value);
}

export function numberText(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return '-';
  return value > 9999 ? compactNumber.format(value) : wholeNumber.format(value);
}

export function percent(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return '-';
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

export function safeImageUrl(value: string | null | undefined) {
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

export function sparkPath(values: number[] | undefined, width = 220, height = 72) {
  const points = values?.filter((value) => Number.isFinite(value)).slice(-80) ?? [];
  if (points.length < 2) return '';

  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;

  return points
    .map((value, index) => {
      const x = (index / (points.length - 1)) * width;
      const y = height - 6 - ((value - min) / range) * (height - 12);
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
}
