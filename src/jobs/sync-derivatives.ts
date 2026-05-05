import { createDatabase, initializeDatabase } from '../db/client';
import { createLogger } from '../lib/logger';
import { closeExchangePool } from '../providers/ccxt';
import { syncDerivativeTickers } from '../services/derivatives-sync';
import { parseDerivativeVenueConfig } from '../services/derivatives-venues';

export async function runDerivativeSyncJob(env: NodeJS.ProcessEnv = process.env) {
  const logger = createLogger({ level: env.LOG_LEVEL === 'silent' ? 'silent' : 'info', pretty: false });
  const venues = parseDerivativeVenueConfig(env.DERIVATIVES_CCXT_EXCHANGES);

  if (venues.length === 0) {
    logger.info('No derivatives venues configured; set DERIVATIVES_CCXT_EXCHANGES to run the optional sync job');
    return;
  }

  const database = createDatabase(env.DATABASE_URL ?? './data/opengecko.db');

  try {
    initializeDatabase(database);
    const result = await syncDerivativeTickers(database, { venues });
    logger.info(result, 'derivatives ticker sync complete');
  } finally {
    await closeExchangePool();
    database.client.close();
  }
}

if (require.main === module) {
  void runDerivativeSyncJob();
}
