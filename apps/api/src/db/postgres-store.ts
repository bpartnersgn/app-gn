import { readFile } from 'node:fs/promises';
import type { AppStore, Exchange, IdempotencyRecord, LinkedAccount, Payment, PaymentStatus, VirtualCard } from '@app-gn/core';
import type { AuthStore, Challenge } from '../auth.ts';
import type { ProcessedEvents } from '../orchea.ts';

/**
 * Ce que le magasin attend d'une connexion PostgreSQL : `pg.Pool` en service, PGlite (PostgreSQL embarqué) en test.
 * Chaque appel est une instruction autonome ; les garanties (clé déjà prise, état attendu, usage unique)
 * tiennent dans une seule instruction, sans transaction ouverte entre deux allers-retours.
 */
export interface Sql {
  query<Row = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}

/** Applique le schéma (rejouable). */
export async function migrate(sql: Sql): Promise<void> {
  const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  const statements = schema
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(/;\s*\n/)
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) await sql.query(statement);
}

type Json<T> = { document: T };

export class PostgresStore implements AppStore, AuthStore, ProcessedEvents {
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

  async saveCard(card: VirtualCard, account?: LinkedAccount): Promise<void> {
    await this.sql.query(
      `INSERT INTO issued_cards (account_id, space_id, card, account) VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_id) DO UPDATE SET card = EXCLUDED.card, account = COALESCE(EXCLUDED.account, issued_cards.account)`,
      [card.accountId, card.spaceId, JSON.stringify(card), account ? JSON.stringify(account) : null],
    );
  }

  async issuedCards(): Promise<{ card: VirtualCard; account?: LinkedAccount }[]> {
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
      'INSERT INTO auth_challenges (id, person_id, code_hash, expires_at, attempts) VALUES ($1, $2, $3, $4, $5)',
      [id, challenge.personId ?? null, challenge.codeHash ?? null, challenge.expiresAt, challenge.attempts],
    );
  }

  async countAttempt(id: string): Promise<Challenge | undefined> {
    const { rows } = await this.sql.query<{ person_id: string | null; code_hash: string | null; expires_at: string; attempts: number }>(
      'UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = $1 RETURNING person_id, code_hash, expires_at, attempts',
      [id],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      ...(row.person_id ? { personId: row.person_id } : {}),
      ...(row.code_hash ? { codeHash: row.code_hash } : {}),
      expiresAt: Number(row.expires_at),
      attempts: row.attempts,
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
}
