import { loadConfig } from '../config/env';
import { createDatabase, initializeDatabase, seedStaticReferenceData } from '../db/client';
import { runMarketRefreshOnce } from '../services/market-refresh';

async function refreshMarketSnapshots() {
  const config = loadConfig();
  const database = createDatabase(config.databaseUrl);

  try {
    initializeDatabase(database);
    seedStaticReferenceData(database, { includeSeededExchanges: true });
    await runMarketRefreshOnce(database, config);
  } finally {
    database.client.close();
  }
}

void refreshMarketSnapshots();
