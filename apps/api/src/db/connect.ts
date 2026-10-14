import { mkdir } from 'node:fs/promises';
import { migrate, PostgresStore, type Sql } from './postgres-store.ts';

/** Clé du verrou consultatif qui sérialise les migrations (arbitraire, propre à App GN). */
const MIGRATION_LOCK = 4_242_001;

/**
 * Choisit la base d'après l'environnement :
 * - `DATABASE_URL` (postgres://…) : un serveur PostgreSQL, la cible en service ;
 * - `APPGN_PGLITE_DIR` : PostgreSQL embarqué (PGlite) dans ce dossier, pour travailler sur un poste sans serveur ;
 * - rien : pas de base, tout reste en mémoire (perdu à l'arrêt).
 */
export async function databaseFromEnvironment(environment: Readonly<Record<string, string | undefined>>):
  Promise<{ store: PostgresStore; kind: 'postgres' | 'pglite'; close: () => Promise<void> } | undefined> {
  const url = environment.DATABASE_URL?.trim();
  const directory = environment.APPGN_PGLITE_DIR?.trim();
  let sql: Sql;
  let close: () => Promise<void>;
  let kind: 'postgres' | 'pglite';
  if (url) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: url, max: Number(environment.DATABASE_POOL_SIZE ?? 10) });
    sql = pool as unknown as Sql;
    close = () => pool.end();
    kind = 'postgres';
    // Plusieurs instances peuvent démarrer ensemble : une seule migre, les autres attendent le verrou.
    const client = await pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
      try {
        await migrate(client as unknown as Sql);
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]);
      }
    } finally {
      client.release();
    }
    return { store: new PostgresStore(sql), kind, close };
  } else if (directory) {
    const { PGlite } = await import('@electric-sql/pglite');
    await mkdir(directory, { recursive: true });
    const database = new PGlite(directory);
    sql = database as unknown as Sql;
    close = () => database.close();
    kind = 'pglite';
  } else {
    return undefined;
  }
  await migrate(sql);
  return { store: new PostgresStore(sql), kind, close };
}
