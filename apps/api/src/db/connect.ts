import { mkdir } from 'node:fs/promises';
import { migrate, PostgresStore, type Sql } from './postgres-store.ts';

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
