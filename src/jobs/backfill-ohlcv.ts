import { loadConfig } from '../config/env';
import { createDatabase, initializeDatabase } from '../db/client';
import { runOhlcvBackfillOnce } from '../services/ohlcv-backfill';

async function backfillOhlcvJob() {
  const config = loadConfig();
  const database = createDatabase(config.databaseUrl);

  try {
    initializeDatabase(database);
    await runOhlcvBackfillOnce(database, config);
  } finally {
    database.client.close();
  }
}

void backfillOhlcvJob();
