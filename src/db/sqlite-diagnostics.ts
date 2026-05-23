import type { SqliteClient, SqliteStatement } from './runtime';
import { sanitizeDiagnosticText } from '../services/diagnostic-sanitizer';

export const MAX_SQLITE_RECENT_FAILURES = 10;

export type SqliteDiagnosticFailureClassification = 'contention' | 'fatal_persistence' | 'untracked';

export type SqliteDiagnosticFailureSample = {
  occurred_at: string;
  classification: Exclude<SqliteDiagnosticFailureClassification, 'untracked'>;
  reason_code:
    | 'sqlite_busy'
    | 'sqlite_locked'
    | 'sqlite_cantopen'
    | 'sqlite_corrupt'
    | 'sqlite_ioerr'
    | 'sqlite_readonly'
    | 'sqlite_full'
    | 'sqlite_notadb'
    | 'sqlite_fatal_persistence';
  operation: string;
  sql_kind: string | null;
  error_code: string | null;
  message: string;
};

export type SqliteDiagnosticState = {
  totalContentionCount: number;
  busyCount: number;
  lockedCount: number;
  totalFatalPersistenceCount: number;
  lastContentionAt: Date | null;
  lastFatalPersistenceAt: Date | null;
  recentFailures: SqliteDiagnosticFailureSample[];
};

type SqliteDiagnosticFailureContext = {
  operation: string;
  sql?: string | null;
  now?: Date;
};

class InstrumentedSqliteClient implements SqliteClient {
  constructor(
    private readonly delegate: SqliteClient,
    private readonly diagnostics: SqliteDiagnosticState,
  ) {}

  prepare<Row = unknown>(sql: string): SqliteStatement<Row> {
    try {
      const statement = this.delegate.prepare<Row>(sql);

      return {
        get: (...params) => this.executeStatementMethod(
          () => statement.get(...params),
          { operation: 'statement.get', sql },
        ),
        all: (...params) => this.executeStatementMethod(
          () => statement.all(...params),
          { operation: 'statement.all', sql },
        ),
        run: (...params) => this.executeStatementMethod(
          () => statement.run(...params),
          { operation: 'statement.run', sql },
        ),
      };
    } catch (error) {
      recordSqliteDiagnosticFailure(this.diagnostics, error, { operation: 'prepare', sql });
      throw error;
    }
  }

  exec(sql: string) {
    try {
      this.delegate.exec(sql);
    } catch (error) {
      recordSqliteDiagnosticFailure(this.diagnostics, error, { operation: 'exec', sql });
      throw error;
    }
  }

  pragma(sql: string) {
    try {
      return this.delegate.pragma(sql);
    } catch (error) {
      recordSqliteDiagnosticFailure(this.diagnostics, error, { operation: 'pragma', sql: `PRAGMA ${sql}` });
      throw error;
    }
  }

  close() {
    this.delegate.close();
  }

  private executeStatementMethod<T>(operation: () => T, context: SqliteDiagnosticFailureContext): T {
    try {
      return operation();
    } catch (error) {
      recordSqliteDiagnosticFailure(this.diagnostics, error, context);
      throw error;
    }
  }
}

export function createSqliteDiagnosticState(): SqliteDiagnosticState {
  return {
    totalContentionCount: 0,
    busyCount: 0,
    lockedCount: 0,
    totalFatalPersistenceCount: 0,
    lastContentionAt: null,
    lastFatalPersistenceAt: null,
    recentFailures: [],
  };
}

function extractSqliteErrorCode(error: unknown): string | null {
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    for (const key of ['code', 'errno', 'name']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim().toUpperCase();
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
      }
    }
  }

  return null;
}

function classifySqliteDiagnosticFailure(error: unknown): {
  classification: SqliteDiagnosticFailureClassification;
  reasonCode: SqliteDiagnosticFailureSample['reason_code'] | null;
} {
  const code = extractSqliteErrorCode(error);
  const message = sanitizeDiagnosticText(error).toLowerCase();
  const normalizedCode = code?.toUpperCase() ?? '';

  if (normalizedCode.includes('SQLITE_BUSY') || /\bdatabase (?:is )?busy\b/.test(message)) {
    return { classification: 'contention', reasonCode: 'sqlite_busy' };
  }

  if (normalizedCode.includes('SQLITE_LOCKED') || /\bdatabase (?:table )?(?:is )?locked\b/.test(message)) {
    return { classification: 'contention', reasonCode: 'sqlite_locked' };
  }

  if (normalizedCode.includes('SQLITE_CORRUPT') || message.includes('database disk image is malformed')) {
    return { classification: 'fatal_persistence', reasonCode: 'sqlite_corrupt' };
  }

  if (normalizedCode.includes('SQLITE_IOERR') || message.includes('disk i/o error')) {
    return { classification: 'fatal_persistence', reasonCode: 'sqlite_ioerr' };
  }

  if (normalizedCode.includes('SQLITE_CANTOPEN') || message.includes('unable to open database file')) {
    return { classification: 'fatal_persistence', reasonCode: 'sqlite_cantopen' };
  }

  if (normalizedCode.includes('SQLITE_READONLY') || message.includes('readonly database')) {
    return { classification: 'fatal_persistence', reasonCode: 'sqlite_readonly' };
  }

  if (normalizedCode.includes('SQLITE_FULL') || message.includes('database or disk is full')) {
    return { classification: 'fatal_persistence', reasonCode: 'sqlite_full' };
  }

  if (normalizedCode.includes('SQLITE_NOTADB') || message.includes('file is not a database')) {
    return { classification: 'fatal_persistence', reasonCode: 'sqlite_notadb' };
  }

  return { classification: 'untracked', reasonCode: null };
}

function sanitizeSqliteOperation(value: string) {
  return sanitizeDiagnosticText(value).slice(0, 160);
}

function extractSqlKind(sql: string | null | undefined) {
  if (!sql) {
    return null;
  }

  const normalized = sql.trim().replace(/^PRAGMA\s+/i, 'pragma ');
  const [kind] = normalized.split(/\s+/, 1);
  return kind ? sanitizeDiagnosticText(kind.toLowerCase()).slice(0, 32) : null;
}

export function recordSqliteDiagnosticFailure(
  state: SqliteDiagnosticState,
  error: unknown,
  context: SqliteDiagnosticFailureContext,
): SqliteDiagnosticFailureClassification {
  const { classification, reasonCode } = classifySqliteDiagnosticFailure(error);
  if (classification === 'untracked' || reasonCode === null) {
    return 'untracked';
  }

  const occurredAt = context.now ?? new Date();
  const errorCode = extractSqliteErrorCode(error);
  const sample: SqliteDiagnosticFailureSample = {
    occurred_at: occurredAt.toISOString(),
    classification,
    reason_code: reasonCode,
    operation: sanitizeSqliteOperation(context.operation),
    sql_kind: extractSqlKind(context.sql),
    error_code: errorCode === null ? null : sanitizeDiagnosticText(errorCode).slice(0, 80),
    message: sanitizeDiagnosticText(error),
  };

  if (classification === 'contention') {
    state.totalContentionCount += 1;
    if (reasonCode === 'sqlite_busy') {
      state.busyCount += 1;
    } else if (reasonCode === 'sqlite_locked') {
      state.lockedCount += 1;
    }
    state.lastContentionAt = occurredAt;
  } else {
    state.totalFatalPersistenceCount += 1;
    state.lastFatalPersistenceAt = occurredAt;
  }

  state.recentFailures.push(sample);
  if (state.recentFailures.length > MAX_SQLITE_RECENT_FAILURES) {
    state.recentFailures.splice(0, state.recentFailures.length - MAX_SQLITE_RECENT_FAILURES);
  }

  return classification;
}

export function instrumentSqliteClient(client: SqliteClient, diagnostics: SqliteDiagnosticState): SqliteClient {
  return new InstrumentedSqliteClient(client, diagnostics);
}
