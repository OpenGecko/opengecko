import { HttpError } from './errors';

const UNSIGNED_INTEGER_PATTERN = /^\d+$/;
const FINITE_NUMBER_PATTERN = /^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:e[+-]?\d+)?$/i;

function invalidParameter(parameterName: string, value: string): never {
  throw new HttpError(400, 'invalid_parameter', `Invalid ${parameterName} value: ${value}`);
}

function parseUnsignedIntegerLiteral(value: string, parameterName: string) {
  const normalizedValue = value.trim();

  if (normalizedValue.length === 0 || !UNSIGNED_INTEGER_PATTERN.test(normalizedValue)) {
    invalidParameter(parameterName, value);
  }

  const parsed = Number(normalizedValue);

  if (!Number.isFinite(parsed)) {
    invalidParameter(parameterName, value);
  }

  return parsed;
}

export function parseBooleanQuery(value: string | undefined, defaultValue = false) {
  if (value === undefined) {
    return defaultValue;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw new HttpError(400, 'invalid_parameter', `Invalid boolean query value: ${value}`);
}

export function parseCsvQuery(value: string | undefined) {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function parsePrecision(value: string | undefined): number | 'full' {
  if (value === undefined) {
    return 'full';
  }

  if (value === 'full') {
    return 'full';
  }

  const parsed = parseUnsignedIntegerLiteral(value, 'precision');

  if (parsed > 18) {
    throw new HttpError(400, 'invalid_parameter', `Invalid precision value: ${value}`);
  }

  return parsed;
}

export function parsePositiveInt(value: string | undefined, defaultValue: number, parameterName = 'integer') {
  if (value === undefined) {
    return defaultValue;
  }

  const parsed = parseUnsignedIntegerLiteral(value, parameterName);

  if (parsed <= 0) {
    invalidParameter(parameterName, value);
  }

  return parsed;
}

export function parseNonNegativeInt(value: string | undefined, defaultValue: number, parameterName = 'integer') {
  if (value === undefined) {
    return defaultValue;
  }

  return parseUnsignedIntegerLiteral(value, parameterName);
}

export function parseFiniteNumber<TDefault extends number | null>(
  value: string | undefined,
  defaultValue: TDefault,
  parameterName = 'number',
): number | TDefault {
  if (value === undefined) {
    return defaultValue;
  }

  const normalizedValue = value.trim();

  if (normalizedValue.length === 0 || !FINITE_NUMBER_PATTERN.test(normalizedValue)) {
    invalidParameter(parameterName, value);
  }

  const parsed = Number(normalizedValue);

  if (!Number.isFinite(parsed)) {
    invalidParameter(parameterName, value);
  }

  return parsed;
}

export function parseTimestampSeconds(
  value: string | undefined,
  parameterName: string,
  defaultValue?: number,
) {
  if (value === undefined) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }

    invalidParameter(parameterName, String(value));
  }

  const parsed = parseUnsignedIntegerLiteral(value, parameterName);

  if (parsed <= 0) {
    invalidParameter(parameterName, value);
  }

  return parsed;
}
