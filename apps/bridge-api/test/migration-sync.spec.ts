import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CORE_SCHEMA_SQL, HARDEN_LEGACY_SCHEMA_SQL } from '../src/storage/postgres-store.js';

describe('database migration source of truth', () => {
  it('keeps every committed SQL migration in sync with the runtime migration', async () => {
    const coreMigration = await readFile(
      new URL('../migrations/001_bridge_core.sql', import.meta.url),
      'utf8',
    );
    const hardenLegacyMigration = await readFile(
      new URL('../migrations/002_harden_legacy_upgrade.sql', import.meta.url),
      'utf8',
    );

    expect(coreMigration.trim()).toBe(CORE_SCHEMA_SQL.trim());
    expect(hardenLegacyMigration.trim()).toBe(HARDEN_LEGACY_SCHEMA_SQL.trim());
  });
});
