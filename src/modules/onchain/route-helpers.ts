import { eq } from 'drizzle-orm';

import type { AppDatabase } from '../../db/client';
import { onchainNetworks } from '../../db/schema';
import { HttpError } from '../../http/errors';

export function getOnchainNetwork(database: AppDatabase, networkId: string) {
  return database.db
    .select()
    .from(onchainNetworks)
    .where(eq(onchainNetworks.id, networkId))
    .limit(1)
    .get();
}

export function requireOnchainNetwork(
  database: AppDatabase,
  networkId: string,
  options: {
    statusCode?: number;
    code?: string;
    message?: string;
  } = {},
) {
  const network = getOnchainNetwork(database, networkId);

  if (!network) {
    throw new HttpError(
      options.statusCode ?? 404,
      options.code ?? 'not_found',
      options.message ?? `Onchain network not found: ${networkId}`,
    );
  }

  return network;
}
