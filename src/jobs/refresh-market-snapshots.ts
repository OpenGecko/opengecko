import { loadConfig } from '../config/env';
import { createDatabase, initializeDatabase, seedStaticReferenceData } from '../db/client';
import {
  registerSqliteProcessHeartbeat,
  type SqliteProcessHeartbeatRegistration,
} from '../db/sqlite-coordination';
import { runMarketRefreshOnce } from '../services/market-refresh';

function readValidationWorkerHoldMs(env: NodeJS.ProcessEnv) {
  const value = Number(env.OPENGECKO_VALIDATION_WORKER_HOLD_MS ?? 0);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 30_000) : 0;
}

async function refreshMarketSnapshots() {
  const config = loadConfig();
  const database = createDatabase(config.databaseUrl);
  let sqliteProcessHeartbeat: SqliteProcessHeartbeatRegistration | null = null;

  try {
    initializeDatabase(database);
    sqliteProcessHeartbeat = registerSqliteProcessHeartbeat(database, 'worker');
    const validationHoldMs = readValidationWorkerHoldMs(process.env);
    if (validationHoldMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, validationHoldMs));
    }
    seedStaticReferenceData(database, { includeSeededExchanges: true });
    await runMarketRefreshOnce(database, config);
  } finally {
    sqliteProcessHeartbeat?.stop();
    sqliteProcessHeartbeat?.markInactive();
    database.client.close();
  }
}

void refreshMarketSnapshots();
