import { HttpError } from '../http/errors';

export function sortNumber(value: number | null | undefined, fallback: number) {
  return value ?? fallback;
}

export function parseJsonArray<T>(value: string): T[] {
  return JSON.parse(value) as T[];
}

export function parseJsonObject<T extends Record<string, unknown>>(value: string): T {
  return JSON.parse(value) as T;
}

export function normalizeCategoryId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function parseDexPairFormat(value: string | undefined) {
  if (!value) {
    return 'symbol';
  }

  const normalized = value.toLowerCase();

  if (normalized === 'symbol' || normalized === 'contract_address') {
    return normalized;
  }

  throw new HttpError(400, 'invalid_parameter', `Unsupported dex_pair_format value: ${value}`);
}
