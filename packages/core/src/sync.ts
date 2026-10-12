/**
 * Hors ligne d'abord : l'application lit d'abord ce qu'elle a gardé sur l'appareil, et met en file
 * ce qu'on lui demande d'envoyer quand le réseau manque. À la reconnexion, la file est rejouée dans l'ordre.
 *
 * Trois règles tiennent la sécurité de l'argent :
 * 1. Chaque opération en file porte sa clé d'idempotence dès sa création ; un rejeu après une coupure
 *    au mauvais moment (envoyée, réponse perdue) ne débite jamais deux fois.
 * 2. Une opération qui attend trop longtemps expire au lieu de partir des jours plus tard sur un solde changé.
 * 3. Seuls les paiements initiés par la personne se mettent en file. Ce qui dépend d'un état frais
 *    (approuver, convertir sur un cours, bloquer une carte) exige le réseau.
 *
 * Le stockage est abstrait : localStorage pour la démo web, IndexedDB ou SQLite chiffré sur l'appareil ensuite.
 */

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemoryStore implements KeyValueStore {
  private readonly values = new Map<string, string>();
  async get(key: string) { return this.values.get(key) ?? null; }
  async set(key: string, value: string) { this.values.set(key, value); }
  async delete(key: string) { this.values.delete(key); }
}

export interface Snapshot<T> {
  data: T;
  savedAt: string;
}

/** Dernière réponse connue de chaque lecture, datée. */
export class SnapshotCache {
  private readonly store: KeyValueStore;
  private readonly prefix: string;

  constructor(store: KeyValueStore, prefix = 'appgn:cache:') {
    this.store = store;
    this.prefix = prefix;
  }

  async save<T>(key: string, data: T, at: Date): Promise<void> {
    await this.store.set(this.prefix + key, JSON.stringify({ data, savedAt: at.toISOString() }));
  }

  async load<T>(key: string): Promise<Snapshot<T> | null> {
    const raw = await this.store.get(this.prefix + key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Snapshot<T>;
    } catch {
      return null;
    }
  }
}

export type PendingStatus = 'pending' | 'sent' | 'rejected' | 'expired';

export interface PendingOperation<Payload = unknown> {
  /** Sert aussi de clé d'idempotence côté serveur. */
  id: string;
  kind: string;
  personId: string;
  spaceId: string;
  payload: Payload;
  createdAt: string;
  expiresAt: string;
  status: PendingStatus;
  attempts: number;
  /** Raison d'un rejet, ou identifiant de ce que le serveur a créé. */
  detail?: string;
}

/** Délai maximal d'attente d'un paiement hors ligne avant expiration. */
export const OUTBOX_TTL_HOURS = 24;

export type ReplayResult =
  | { outcome: 'sent'; detail?: string }
  | { outcome: 'rejected'; detail: string }
  | { outcome: 'offline' };

export class Outbox {
  private readonly store: KeyValueStore;
  private readonly key: string;

  constructor(store: KeyValueStore, key = 'appgn:outbox') {
    this.store = store;
    this.key = key;
  }

  async list(): Promise<PendingOperation[]> {
    const raw = await this.store.get(this.key);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as PendingOperation[];
    } catch {
      return [];
    }
  }

  async enqueue<Payload>(operation: Omit<PendingOperation<Payload>, 'status' | 'attempts' | 'expiresAt'>, ttlHours = OUTBOX_TTL_HOURS): Promise<PendingOperation<Payload>> {
    const pending: PendingOperation<Payload> = {
      ...operation,
      status: 'pending',
      attempts: 0,
      expiresAt: new Date(Date.parse(operation.createdAt) + ttlHours * 3600_000).toISOString(),
    };
    const all = await this.list();
    all.push(pending);
    await this.write(all);
    return pending;
  }

  /**
   * Rejoue les opérations en attente, dans l'ordre de création. S'arrête à la première coupure :
   * l'ordre des débits voulu par la personne est respecté.
   */
  async flush(replay: (operation: PendingOperation) => Promise<ReplayResult>, now: Date): Promise<PendingOperation[]> {
    const all = await this.list();
    const changed: PendingOperation[] = [];
    for (const operation of all) {
      if (operation.status !== 'pending') continue;
      if (Date.parse(operation.expiresAt) <= now.getTime()) {
        operation.status = 'expired';
        changed.push(operation);
        continue;
      }
      operation.attempts += 1;
      const result = await replay(operation);
      if (result.outcome === 'offline') break;
      operation.status = result.outcome;
      operation.detail = result.detail;
      changed.push(operation);
    }
    await this.write(all);
    return changed;
  }

  /** Retire ce qui est terminé (envoyé, rejeté, expiré) une fois que la personne l'a vu. */
  async prune(): Promise<void> {
    await this.write((await this.list()).filter((operation) => operation.status === 'pending'));
  }

  private async write(all: PendingOperation[]): Promise<void> {
    await this.store.set(this.key, JSON.stringify(all));
  }
}
