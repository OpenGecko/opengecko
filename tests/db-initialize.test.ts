import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createDatabase } from '../src/db/runtime';
import { migrateDatabase } from '../src/db/migrations';
import { initializeDatabase, seedStaticReferenceData } from '../src/db/seeds';
import { assetPlatforms, coins } from '../src/db/schema';

describe('db initialization seams', () => {
  it('initializeDatabase composes migrations, deterministic seed data, and search rebuild through stable modules', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'opengecko-db-init-'));
    const database = createDatabase(join(tempDir, 'test.db'));

    try {
      initializeDatabase(database);
      expect(database.db.select().from(coins).all().length).toBe(8);
      expect(database.db.select().from(assetPlatforms).all().length).toBe(3);
    } finally {
      database.client.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('migration bootstrap preserves targeted journal recording when runtime indexes already exist', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'opengecko-db-journal-'));
    const database = createDatabase(join(tempDir, 'journal.db'));

    try {
      migrateDatabase(database);
      database.client.prepare('DELETE FROM __drizzle_migrations WHERE hash = ?').run(
        '8301ee03effe7ffc4e7723bb625c4a009dfa80811cdd268979f756b9a4cab40e',
      );

      migrateDatabase(database);

      const journalRow = database.client.prepare<{ count: number }>(
        'SELECT COUNT(*) AS count FROM __drizzle_migrations WHERE hash = ?',
      ).get('8301ee03effe7ffc4e7723bb625c4a009dfa80811cdd268979f756b9a4cab40e');

      expect(journalRow?.count).toBe(1);
    } finally {
      database.client.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('seedStaticReferenceData remains idempotent through the dedicated seed module', () => {
    const database = createDatabase(':memory:');

    try {
      migrateDatabase(database);
      seedStaticReferenceData(database);
      seedStaticReferenceData(database);

      expect(database.db.select().from(coins).all().length).toBe(8);
      expect(database.db.select().from(assetPlatforms).all().length).toBe(3);
    } finally {
      database.client.close();
    }
  });
});
