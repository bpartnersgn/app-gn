/**
 * Socle commun des tableaux de bord GAPP (entreprise et administration) : un magasin d'enregistrements
 * versionnés, une piste d'audit chaînée, des compteurs sans trou et l'idempotence des actions.
 *
 * Chaque enregistrement appartient à un seul espace : un bureau ne lit que les enregistrements de l'espace
 * de la session, et rien de l'espace personnel des membres n'y entre jamais.
 */

export interface DeskEntity {
  id: string;
  spaceId: string;
}

export interface Versioned<T> {
  version: number;
  value: T;
}

/** Collections connues ; le nom sert aussi de préfixe en base. */
export type DeskCollection =
  | 'counters'
  | 'audit'
  | 'idempotency'
  | 'invoices'
  | 'bills'
  | 'batches'
  | 'vat_returns'
  | 'employees'
  | 'certificates'
  | 'budget_lines'
  | 'engagements'
  | 'agents';

/**
 * Port de stockage des bureaux. Deux implémentations : en mémoire (navigateur, tests, démo) et PostgreSQL
 * (`apps/api/src/db`). Les garanties tiennent en une instruction : insertion refusée si l'identifiant existe,
 * mise à jour refusée si la version a changé entre la lecture et l'écriture.
 */
export interface DeskStore {
  get<T extends DeskEntity>(collection: DeskCollection, id: string): Promise<Versioned<T> | undefined>;
  list<T extends DeskEntity>(collection: DeskCollection, spaceId: string): Promise<Versioned<T>[]>;
  /** Faux si l'identifiant existe déjà. */
  insert<T extends DeskEntity>(collection: DeskCollection, value: T): Promise<boolean>;
  /** Faux si l'enregistrement n'est plus à la version lue. */
  update<T extends DeskEntity>(collection: DeskCollection, value: T, expectedVersion: number): Promise<boolean>;
}

export class MemoryDeskStore implements DeskStore {
  private readonly records = new Map<string, Versioned<DeskEntity> & { collection: DeskCollection; order: number }>();
  private order = 0;

  async get<T extends DeskEntity>(collection: DeskCollection, id: string): Promise<Versioned<T> | undefined> {
    const record = this.records.get(`${collection}/${id}`);
    return record && { version: record.version, value: structuredClone(record.value) as T };
  }

  async list<T extends DeskEntity>(collection: DeskCollection, spaceId: string): Promise<Versioned<T>[]> {
    return [...this.records.values()]
      .filter((record) => record.collection === collection && record.value.spaceId === spaceId)
      .sort((a, b) => a.order - b.order)
      .map((record) => ({ version: record.version, value: structuredClone(record.value) as T }));
  }

  async insert<T extends DeskEntity>(collection: DeskCollection, value: T): Promise<boolean> {
    const key = `${collection}/${value.id}`;
    if (this.records.has(key)) return false;
    this.order += 1;
    this.records.set(key, { collection, version: 1, value: structuredClone(value), order: this.order });
    return true;
  }

  async update<T extends DeskEntity>(collection: DeskCollection, value: T, expectedVersion: number): Promise<boolean> {
    const key = `${collection}/${value.id}`;
    const current = this.records.get(key);
    if (!current || current.version !== expectedVersion) return false;
    this.records.set(key, { ...current, version: expectedVersion + 1, value: structuredClone(value) });
    return true;
  }
}

/** Lit, transforme, écrit ; recommence si un autre a écrit entre-temps. */
export async function mutate<T extends DeskEntity>(
  store: DeskStore,
  collection: DeskCollection,
  id: string,
  change: (current: T | undefined) => T | Promise<T>,
  attempts = 8,
): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = await store.get<T>(collection, id);
    const next = await change(current ? current.value : undefined);
    const written = current ? await store.update(collection, next, current.version) : await store.insert(collection, next);
    if (written) return next;
  }
  throw new Error(`écriture concurrente répétée sur ${collection}/${id}`);
}

// ── Empreintes ────────────────────────────────────────────────────────────────

/** SHA-256 en hexadécimal, par WebCrypto (Node 22 et navigateur). */
export async function sha256(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** JSON à clés triées : la même donnée donne toujours la même empreinte. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const GENESIS = '0'.repeat(64);

// ── Compteurs sans trou ─────────────────────────────────────────────────────

interface Counter extends DeskEntity {
  value: number;
  /** Dernière empreinte de la chaîne portée par ce compteur (factures, piste d'audit). */
  head: string;
}

/**
 * Réserve le numéro suivant d'une séquence et chaîne l'empreinte de ce qu'il numérote à la précédente.
 * Le compteur et l'empreinte avancent ensemble, sous la même version : deux factures simultanées ne
 * prennent ni le même numéro ni la même empreinte précédente.
 */
export async function nextInChain(
  store: DeskStore,
  spaceId: string,
  sequence: string,
  seal: (number: number, previous: string) => Promise<string>,
): Promise<{ number: number; previous: string; hash: string }> {
  let result: { number: number; previous: string; hash: string } | undefined;
  await mutate<Counter>(store, 'counters', `${spaceId}:${sequence}`, async (current) => {
    const number = (current?.value ?? 0) + 1;
    const previous = current?.head ?? GENESIS;
    const hash = await seal(number, previous);
    result = { number, previous, hash };
    return { id: `${spaceId}:${sequence}`, spaceId, value: number, head: hash };
  });
  return result!;
}

// ── Piste d'audit ─────────────────────────────────────────────────────────

export interface AuditEntry extends DeskEntity {
  sequence: number;
  at: string;
  personId: string;
  personName: string;
  /** Verbe court : `invoice.issued`, `batch.approved`, `engagement.created`… */
  action: string;
  /** Identifiant de l'objet concerné. */
  target: string;
  summary: string;
  previousHash: string;
  hash: string;
}

export interface ChainCheck {
  intact: boolean;
  checked: number;
  /** Premier maillon dont l'empreinte ne correspond plus. */
  brokenAt?: number;
}

function auditPayload(entry: Omit<AuditEntry, 'hash'>): string {
  const { id: _id, hash: _hash, ...rest } = entry as AuditEntry;
  return canonical(rest);
}

/**
 * Journal en ajout seul : chaque entrée porte l'empreinte de la précédente. Une entrée modifiée ou retirée
 * en base casse la chaîne à cet endroit, ce que `verify` signale. C'est la piste que lisent l'expert-comptable,
 * l'auditeur et la Cour des Comptes.
 */
export class AuditTrail {
  private readonly store: DeskStore;
  constructor(store: DeskStore) {
    this.store = store;
  }

  async append(spaceId: string, entry: Pick<AuditEntry, 'at' | 'personId' | 'personName' | 'action' | 'target' | 'summary'>): Promise<AuditEntry> {
    let written: AuditEntry | undefined;
    await nextInChain(this.store, spaceId, 'audit', async (sequence, previousHash) => {
      const draft = { ...entry, id: `${spaceId}:${String(sequence).padStart(8, '0')}`, spaceId, sequence, previousHash };
      written = { ...draft, hash: await sha256(previousHash + auditPayload(draft)) };
      return written.hash;
    });
    await this.store.insert('audit', written!);
    return written!;
  }

  async entries(spaceId: string): Promise<AuditEntry[]> {
    return (await this.store.list<AuditEntry>('audit', spaceId)).map((record) => record.value).sort((a, b) => a.sequence - b.sequence);
  }

  async verify(spaceId: string): Promise<ChainCheck> {
    const entries = await this.entries(spaceId);
    let previous = GENESIS;
    for (const [index, entry] of entries.entries()) {
      const expected = await sha256(previous + auditPayload(entry));
      if (entry.sequence !== index + 1 || entry.previousHash !== previous || entry.hash !== expected) {
        return { intact: false, checked: entries.length, brokenAt: index + 1 };
      }
      previous = entry.hash;
    }
    return { intact: true, checked: entries.length };
  }
}

// ── Idempotence des actions de bureau ────────────────────────────────────────

interface IdempotencyEntry extends DeskEntity {
  fingerprint: string;
  resultId: string;
}

/**
 * Réserve `key` pour une action ; rend l'identifiant déjà produit si la même demande a déjà été reçue.
 * Une autre demande sous la même clé est refusée par l'appelant (`conflict`).
 */
export async function claimKey(
  store: DeskStore,
  spaceId: string,
  personId: string,
  action: string,
  key: string,
  request: unknown,
  resultId: string,
): Promise<{ replay?: string; conflict?: boolean }> {
  const id = `${spaceId}:${personId}:${action}:${key}`;
  const fingerprint = canonical(request);
  if (await store.insert<IdempotencyEntry>('idempotency', { id, spaceId, fingerprint, resultId })) return {};
  const existing = (await store.get<IdempotencyEntry>('idempotency', id))?.value;
  if (!existing || existing.fingerprint !== fingerprint) return { conflict: true };
  return { replay: existing.resultId };
}

export function randomId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
}
