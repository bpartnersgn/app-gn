import { readdir, readFile } from 'node:fs/promises';
import { QUOTE_TTL_SECONDS } from '@app-gn/core';
import type { AppStore, CardStatus, ExchangeQuote, StoredCard, CitizenSpace, DeskCollection, Directory, DirectoryStore, Membership, Person, Role, Space, VaultDocument, DeskEntity, DeskStore, Exchange, IdempotencyRecord, LinkedAccount, Payment, PaymentStatus, Versioned, VirtualCard } from '@app-gn/core';
import type { AuthStore, Challenge, ChallengePurpose } from '../auth.ts';
import type { FeedCursors, ProcessedEvents } from '../orchea.ts';
import type { RateLimitStore } from '../security.ts';

/**
 * Ce que le magasin attend d'une connexion PostgreSQL : `pg.Pool` en service, PGlite (PostgreSQL embarqué) en test.
 * Chaque appel est une instruction autonome ; les garanties (clé déjà prise, état attendu, usage unique)
 * tiennent dans une seule instruction, sans transaction ouverte entre deux allers-retours.
 */
export interface Sql {
  query<Row = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}

/** Une migration numérotée : `migrations/NNN-nom.sql`. */
export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

export async function loadMigrations(): Promise<Migration[]> {
  const directory = new URL('./migrations/', import.meta.url);
  const files = (await readdir(directory)).filter((file) => /^\d{3}-[\w-]+\.sql$/.test(file)).sort();
  const migrations: Migration[] = [];
  for (const file of files) {
    const text = await readFile(new URL(file, directory), 'utf8');
    const statements = text
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .split(/;\s*\n/)
      .map((statement) => statement.trim().replace(/;$/, ''))
      .filter(Boolean);
    migrations.push({ version: Number(file.slice(0, 3)), name: file.slice(4, -4), statements });
  }
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) throw new Error(`migrations : ${migration.version} au lieu de ${index + 1} (numéros contigus exigés)`);
  });
  return migrations;
}

/**
 * Applique, dans l'ordre, les migrations pas encore passées, chacune dans sa transaction avec son inscription
 * dans `schema_version`. `sql` doit être une seule connexion (client dédié ou PGlite), pas un pool : c'est ce qui
 * tient la transaction. Rend les versions appliquées par cet appel.
 */
export async function migrate(sql: Sql, migrations?: readonly Migration[]): Promise<number[]> {
  const all = migrations ?? await loadMigrations();
  await sql.query('CREATE TABLE IF NOT EXISTS schema_version (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const { rows } = await sql.query<{ version: number }>('SELECT version FROM schema_version');
  const done = new Set(rows.map((row) => Number(row.version)));
  const applied: number[] = [];
  for (const migration of all) {
    if (done.has(migration.version)) continue;
    await sql.query('BEGIN');
    try {
      for (const statement of migration.statements) await sql.query(statement);
      await sql.query('INSERT INTO schema_version (version) VALUES ($1)', [migration.version]);
      await sql.query('COMMIT');
    } catch (error) {
      await sql.query('ROLLBACK');
      throw new Error(`migration ${migration.version} (${migration.name}) : ${(error as Error).message}`, { cause: error });
    }
    applied.push(migration.version);
  }
  return applied;
}

type Json<T> = { document: T };

export class PostgresStore implements AppStore, AuthStore, ProcessedEvents, DeskStore, RateLimitStore, DirectoryStore, FeedCursors {
  private readonly sql: Sql;
  constructor(sql: Sql) {
    this.sql = sql;
  }

  // ── Paiements ──

  async insertPayment(payment: Payment): Promise<void> {
    await this.sql.query(
      'INSERT INTO payments (id, space_id, status, orchestrator_reference, created_at, document) VALUES ($1, $2, $3, $4, $5, $6)',
      [payment.id, payment.spaceId, payment.status, payment.orchestratorReference ?? null, payment.createdAt, JSON.stringify(payment)],
    );
  }

  async updatePayment(payment: Payment, expected: PaymentStatus): Promise<boolean> {
    const { rows } = await this.sql.query(
      'UPDATE payments SET status = $2, orchestrator_reference = $3, document = $4 WHERE id = $1 AND status = $5 RETURNING id',
      [payment.id, payment.status, payment.orchestratorReference ?? null, JSON.stringify(payment), expected],
    );
    return rows.length === 1;
  }

  async payment(id: string): Promise<Payment | undefined> {
    const { rows } = await this.sql.query<Json<Payment>>('SELECT document FROM payments WHERE id = $1', [id]);
    return rows[0]?.document;
  }

  async paymentByReference(reference: string): Promise<Payment | undefined> {
    const { rows } = await this.sql.query<Json<Payment>>('SELECT document FROM payments WHERE orchestrator_reference = $1', [reference]);
    return rows[0]?.document;
  }

  async paymentsOfSpace(spaceId: string): Promise<Payment[]> {
    const { rows } = await this.sql.query<Json<Payment>>(
      'SELECT document FROM payments WHERE space_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200',
      [spaceId],
    );
    return rows.map((row) => row.document);
  }

  // ── Idempotence ──

  async claimIdempotency(scope: string, record: IdempotencyRecord): Promise<IdempotencyRecord | undefined> {
    const inserted = await this.sql.query(
      'INSERT INTO idempotency_keys (scope, fingerprint, result_id) VALUES ($1, $2, $3) ON CONFLICT (scope) DO NOTHING RETURNING scope',
      [scope, record.fingerprint, record.resultId],
    );
    if (inserted.rows.length === 1) return undefined;
    const { rows } = await this.sql.query<{ fingerprint: string; result_id: string }>(
      'SELECT fingerprint, result_id FROM idempotency_keys WHERE scope = $1',
      [scope],
    );
    const existing = rows[0];
    // Libérée entre-temps : on retente la réservation une fois.
    if (!existing) return this.claimIdempotency(scope, record);
    return { fingerprint: existing.fingerprint, resultId: existing.result_id };
  }

  async releaseIdempotency(scope: string): Promise<void> {
    await this.sql.query('DELETE FROM idempotency_keys WHERE scope = $1', [scope]);
  }

  // ── Conversions et cartes ──

  async saveExchange(exchange: Exchange): Promise<void> {
    await this.sql.query(
      'INSERT INTO exchanges (id, space_id, document) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET document = EXCLUDED.document',
      [exchange.id, exchange.spaceId, JSON.stringify(exchange)],
    );
  }

  async exchange(id: string): Promise<Exchange | undefined> {
    const { rows } = await this.sql.query<Json<Exchange>>('SELECT document FROM exchanges WHERE id = $1', [id]);
    return rows[0]?.document;
  }

  async saveQuote(quote: ExchangeQuote): Promise<void> {
    const expiresAt = Date.parse(quote.expiresAt);
    // Les devis expirés depuis au moins une durée de vie partent au passage.
    await this.sql.query('DELETE FROM exchange_quotes WHERE expires_at < $1', [expiresAt - 2 * QUOTE_TTL_SECONDS * 1000]);
    await this.sql.query('INSERT INTO exchange_quotes (id, expires_at, document) VALUES ($1, $2, $3)', [quote.id, expiresAt, JSON.stringify(quote)]);
  }

  async quote(id: string): Promise<ExchangeQuote | undefined> {
    const { rows } = await this.sql.query<Json<ExchangeQuote>>('SELECT document FROM exchange_quotes WHERE id = $1', [id]);
    return rows[0]?.document;
  }

  async takeQuote(id: string): Promise<boolean> {
    const { rows } = await this.sql.query('DELETE FROM exchange_quotes WHERE id = $1 RETURNING id', [id]);
    return rows.length === 1;
  }

  async insertCard(card: VirtualCard, account: LinkedAccount | undefined, maxPerTier: number): Promise<boolean> {
    // Une place par carte (index unique espace, type, place) : deux émissions simultanées ne prennent pas la même,
    // et la perdante essaie la suivante. Plus de place libre : refus.
    for (let slot = 1; slot <= maxPerTier; slot++) {
      const { rows } = await this.sql.query(
        `INSERT INTO issued_cards (account_id, space_id, tier, slot, card, account) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING RETURNING account_id`,
        [card.accountId, card.spaceId, card.tier, slot, JSON.stringify(card), account ? JSON.stringify(account) : null],
      );
      if (rows.length === 1) return true;
      const existing = await this.sql.query('SELECT 1 FROM issued_cards WHERE account_id = $1', [card.accountId]);
      if (existing.rows.length === 1) return true;
    }
    return false;
  }

  async setCardStatus(accountId: string, status: CardStatus): Promise<VirtualCard | undefined> {
    const { rows } = await this.sql.query<{ card: VirtualCard }>(
      `UPDATE issued_cards SET card = jsonb_set(card, '{status}', to_jsonb($2::text)) WHERE account_id = $1 RETURNING card`,
      [accountId, status],
    );
    return rows[0]?.card;
  }

  async cardsOfSpace(spaceId: string): Promise<StoredCard[]> {
    const { rows } = await this.sql.query<{ card: VirtualCard; account: LinkedAccount | null }>('SELECT card, account FROM issued_cards WHERE space_id = $1 ORDER BY account_id', [spaceId]);
    return rows.map((row) => (row.account ? { card: row.card, account: row.account } : { card: row.card }));
  }

  async issuedCards(): Promise<StoredCard[]> {
    const { rows } = await this.sql.query<{ card: VirtualCard; account: LinkedAccount | null }>('SELECT card, account FROM issued_cards ORDER BY account_id');
    return rows.map((row) => (row.account ? { card: row.card, account: row.account } : { card: row.card }));
  }

  // ── Événements reçus (webhooks ORCHEA) ──

  async has(eventId: string): Promise<boolean> {
    const { rows } = await this.sql.query("SELECT 1 FROM processed_events WHERE source = 'orchea' AND event_id = $1", [eventId]);
    return rows.length > 0;
  }

  async add(eventId: string): Promise<void> {
    await this.sql.query("INSERT INTO processed_events (source, event_id) VALUES ('orchea', $1) ON CONFLICT DO NOTHING", [eventId]);
  }

  // ── Connexion ──

  async saveChallenge(id: string, challenge: Challenge): Promise<void> {
    await this.sql.query(
      'INSERT INTO auth_challenges (id, person_id, code_hash, expires_at, attempts, purpose, payload) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [id, challenge.personId ?? null, challenge.codeHash ?? null, challenge.expiresAt, challenge.attempts, challenge.purpose ?? 'signin', challenge.payload === undefined ? null : JSON.stringify(challenge.payload)],
    );
  }

  async countAttempt(id: string): Promise<Challenge | undefined> {
    const { rows } = await this.sql.query<{ person_id: string | null; code_hash: string | null; expires_at: string; attempts: number; purpose: ChallengePurpose; payload: unknown }>(
      'UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = $1 RETURNING person_id, code_hash, expires_at, attempts, purpose, payload',
      [id],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      ...(row.person_id ? { personId: row.person_id } : {}),
      ...(row.code_hash ? { codeHash: row.code_hash } : {}),
      expiresAt: Number(row.expires_at),
      attempts: row.attempts,
      purpose: row.purpose,
      ...(row.payload !== null && row.payload !== undefined ? { payload: row.payload } : {}),
    };
  }

  async consumeChallenge(id: string): Promise<boolean> {
    const { rows } = await this.sql.query('DELETE FROM auth_challenges WHERE id = $1 RETURNING id', [id]);
    return rows.length === 1;
  }

  async recordCodeRequest(key: string, at: number, since: number): Promise<number> {
    const { rows } = await this.sql.query<{ count: string | number }>(
      `WITH inserted AS (INSERT INTO auth_code_requests (key, requested_at) VALUES ($1, $2) RETURNING 1)
       SELECT (SELECT count(*) FROM auth_code_requests WHERE key = $1 AND requested_at >= $3) + (SELECT count(*) FROM inserted) AS count`,
      [key, at, since],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async revoke(sessionId: string, until: number): Promise<void> {
    await this.sql.query('INSERT INTO revoked_sessions (session_id, until) VALUES ($1, $2) ON CONFLICT (session_id) DO NOTHING', [sessionId, until]);
  }

  async isRevoked(sessionId: string): Promise<boolean> {
    const { rows } = await this.sql.query('SELECT 1 FROM revoked_sessions WHERE session_id = $1', [sessionId]);
    return rows.length > 0;
  }

  async sweep(now: number, requestsBefore: number): Promise<void> {
    await this.sql.query('DELETE FROM auth_challenges WHERE expires_at <= $1', [now]);
    await this.sql.query('DELETE FROM revoked_sessions WHERE until <= $1', [now]);
    await this.sql.query('DELETE FROM auth_code_requests WHERE requested_at < $1', [requestsBefore]);
  }

  // ── Bureaux GAPP ──

  async get<T extends DeskEntity>(collection: DeskCollection, id: string): Promise<Versioned<T> | undefined> {
    const { rows } = await this.sql.query<{ version: number; document: T }>('SELECT version, document FROM desk_records WHERE collection = $1 AND id = $2', [collection, id]);
    const row = rows[0];
    return row && { version: row.version, value: row.document };
  }

  async list<T extends DeskEntity>(collection: DeskCollection, spaceId: string): Promise<Versioned<T>[]> {
    const { rows } = await this.sql.query<{ version: number; document: T }>(
      'SELECT version, document FROM desk_records WHERE collection = $1 AND space_id = $2 ORDER BY seq',
      [collection, spaceId],
    );
    return rows.map((row) => ({ version: row.version, value: row.document }));
  }

  async insert<T extends DeskEntity>(collection: DeskCollection, value: T): Promise<boolean> {
    const { rows } = await this.sql.query(
      'INSERT INTO desk_records (collection, id, space_id, version, document) VALUES ($1, $2, $3, 1, $4) ON CONFLICT (collection, id) DO NOTHING RETURNING id',
      [collection, value.id, value.spaceId, JSON.stringify(value)],
    );
    return rows.length === 1;
  }

  async update<T extends DeskEntity>(collection: DeskCollection, value: T, expectedVersion: number): Promise<boolean> {
    const { rows } = await this.sql.query(
      'UPDATE desk_records SET version = version + 1, document = $3 WHERE collection = $1 AND id = $2 AND version = $4 RETURNING id',
      [collection, value.id, JSON.stringify(value), expectedVersion],
    );
    return rows.length === 1;
  }

  // ── Limitation de débit ──

  private lastPrune = 0;

  /** Une seule instruction pour toutes les clés : chacune est créée ou incrémentée, et son total rendu. */
  async hit(keys: readonly string[], window: number): Promise<number[]> {
    if (keys.length === 0) return [];
    const values = keys.map((_, index) => `($${index + 2}, $1, 1)`).join(', ');
    const { rows } = await this.sql.query<{ key: string; count: number }>(
      `INSERT INTO rate_limits (key, window_start, count) VALUES ${values} ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1 RETURNING key, count`,
      [window, ...keys],
    );
    if (window > this.lastPrune) {
      this.lastPrune = window;
      await this.sql.query('DELETE FROM rate_limits WHERE window_start < $1', [window - 1]);
    }
    const counts = new Map(rows.map((row) => [row.key, Number(row.count)]));
    return keys.map((key) => counts.get(key) ?? 0);
  }


  // ── Référentiel ──

  async load(): Promise<Directory> {
    const [persons, spaces, memberships, accounts, documents] = await Promise.all([
      this.sql.query<Json<Person>>('SELECT document FROM persons ORDER BY id'),
      this.sql.query<Json<Space>>('SELECT document FROM spaces ORDER BY id'),
      this.sql.query<{ person_id: string; space_id: string; role: Role }>('SELECT person_id, space_id, role FROM memberships ORDER BY person_id, space_id'),
      this.sql.query<Json<LinkedAccount>>('SELECT document FROM linked_accounts ORDER BY id'),
      this.sql.query<Json<VaultDocument>>('SELECT document FROM vault_documents ORDER BY id'),
    ]);
    return {
      persons: persons.rows.map((row) => row.document),
      spaces: spaces.rows.map((row) => row.document),
      memberships: memberships.rows.map((row): Membership => ({ personId: row.person_id, spaceId: row.space_id, role: row.role })),
      accounts: accounts.rows.map((row) => row.document),
      documents: documents.rows.map((row) => row.document),
    };
  }

  /** Personne, espace personnel et rattachement en une instruction : tout ou rien, et un NIN pris une seule fois. */
  async addPerson(person: Person, space: CitizenSpace): Promise<boolean> {
    const { rows } = await this.sql.query(
      `WITH p AS (INSERT INTO persons (id, nin, document) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id),
            s AS (INSERT INTO spaces (id, kind, document) SELECT $4, 'citizen', $5 FROM p RETURNING id),
            m AS (INSERT INTO memberships (person_id, space_id, role) SELECT p.id, s.id, 'citizen' FROM p, s RETURNING person_id)
       SELECT person_id FROM m`,
      [person.id, person.nin, JSON.stringify(person), space.id, JSON.stringify(space)],
    );
    return rows.length === 1;
  }

  async addSpace(space: Space): Promise<boolean> {
    const { rows } = await this.sql.query('INSERT INTO spaces (id, kind, document) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id', [space.id, space.kind, JSON.stringify(space)]);
    return rows.length === 1;
  }

  async setMembership(membership: Membership): Promise<void> {
    await this.sql.query(
      'INSERT INTO memberships (person_id, space_id, role) VALUES ($1, $2, $3) ON CONFLICT (person_id, space_id) DO UPDATE SET role = EXCLUDED.role',
      [membership.personId, membership.spaceId, membership.role],
    );
  }

  async removeMembership(personId: string, spaceId: string): Promise<boolean> {
    const { rows } = await this.sql.query('DELETE FROM memberships WHERE person_id = $1 AND space_id = $2 RETURNING person_id', [personId, spaceId]);
    return rows.length === 1;
  }

  async addAccount(account: LinkedAccount): Promise<void> {
    await this.sql.query(
      'INSERT INTO linked_accounts (id, space_id, document) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET document = EXCLUDED.document',
      [account.id, account.spaceId, JSON.stringify(account)],
    );
  }

  async addDocument(document: VaultDocument): Promise<boolean> {
    const { rows } = await this.sql.query(
      'INSERT INTO vault_documents (id, space_id, verification_code, document) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id',
      [document.id, document.spaceId, document.verificationCode ?? null, JSON.stringify(document)],
    );
    return rows.length === 1;
  }


  // ── Flux d'événements ORCHEA ──

  async lease(source: string, holder: string, until: number, now: number): Promise<string | null | undefined> {
    const { rows } = await this.sql.query<{ cursor: string | null }>(
      `INSERT INTO feed_cursors (source, cursor, holder, leased_until) VALUES ($1, NULL, $2, $3)
       ON CONFLICT (source) DO UPDATE SET holder = EXCLUDED.holder, leased_until = EXCLUDED.leased_until
       WHERE feed_cursors.holder IS NULL OR feed_cursors.holder = EXCLUDED.holder OR feed_cursors.leased_until <= $4
       RETURNING cursor`,
      [source, holder, until, now],
    );
    return rows.length === 0 ? undefined : rows[0]!.cursor;
  }

  async advance(source: string, holder: string, cursor: string): Promise<boolean> {
    const { rows } = await this.sql.query('UPDATE feed_cursors SET cursor = $3 WHERE source = $1 AND holder = $2 RETURNING source', [source, holder, cursor]);
    return rows.length === 1;
  }

  async release(source: string, holder: string): Promise<void> {
    await this.sql.query('UPDATE feed_cursors SET holder = NULL, leased_until = 0 WHERE source = $1 AND holder = $2', [source, holder]);
  }

}
