const MAX_DIAGNOSTIC_ERROR_LENGTH = 500;
const SENSITIVE_QUERY_KEYS = [
  'access_token',
  'api_key',
  'apikey',
  'auth',
  'client_secret',
  'database_url',
  'db_url',
  'key',
  'password',
  'pass',
  'secret',
  'signature',
  'token',
];
const SENSITIVE_QUERY_KEY_PATTERN = SENSITIVE_QUERY_KEYS.join('|');
const SENSITIVE_QUERY_ASSIGNMENT = new RegExp(
  `(?:${SENSITIVE_QUERY_KEY_PATTERN})(?:\\[[^\\]]+\\])?\\s*[=:]\\s*[^&\\s,;'")]+`,
  'gi',
);
const SENSITIVE_LABEL_ASSIGNMENT = new RegExp(
  `(?:${SENSITIVE_QUERY_KEY_PATTERN})(?:\\[[^\\]]+\\])?\\s*[:=]\\s*[^\\s,;'")]+`,
  'gi',
);
const AUTHORIZATION_HEADER_PATTERN = /\bauthorization\s*[:=]\s*(?:bearer|basic|token)?\s*[^\s,;'")]+/gi;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g;
const UNIX_SENSITIVE_PATH_PATTERN = /(?:\b[A-Z_]*DATABASE_URL=)?(?:file:)?\/(?:home|Users|root|var|tmp|private|data)\/[^\s,;'")]+/g;
const DATABASE_FILE_PATH_PATTERN = /(?:\b[A-Z_]*DATABASE_URL=)?(?:file:)?(?:\.{0,2}\/)?[A-Za-z0-9._/-]*[A-Za-z0-9_-]+\.(?:sqlite|sqlite3|db)(?:\?[^&\s,;'")]+)?/gi;

export function sanitizeDiagnosticText(value: unknown) {
  const raw = value instanceof Error ? value.message : String(value);
  const withoutStack = raw.split(/\r?\n\s*at\s+/)[0] ?? raw;
  const withoutUrls = withoutStack.replace(/https?:\/\/[^\s]+/gi, (rawUrl) => {
    try {
      const parsed = new URL(rawUrl);
      parsed.username = parsed.username ? 'redacted' : '';
      parsed.password = parsed.password ? 'redacted' : '';
      parsed.search = parsed.search ? '?redacted' : '';
      parsed.hash = '';
      return parsed.toString();
    } catch {
      return '[url redacted]';
    }
  });
  const redacted = withoutUrls
    .replace(AUTHORIZATION_HEADER_PATTERN, 'authorization=[redacted]')
    .replace(BEARER_TOKEN_PATTERN, 'authorization=[redacted]')
    .replace(SENSITIVE_QUERY_ASSIGNMENT, 'credential=[redacted]')
    .replace(SENSITIVE_LABEL_ASSIGNMENT, 'credential=[redacted]')
    .replace(UNIX_SENSITIVE_PATH_PATTERN, '[path redacted]')
    .replace(DATABASE_FILE_PATH_PATTERN, '[database path redacted]');

  return redacted.length > MAX_DIAGNOSTIC_ERROR_LENGTH
    ? `${redacted.slice(0, MAX_DIAGNOSTIC_ERROR_LENGTH - 3)}...`
    : redacted;
}

export function sanitizeNullableDiagnosticText(value: string | null) {
  return value === null ? null : sanitizeDiagnosticText(value);
}
