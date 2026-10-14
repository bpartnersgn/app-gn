import {
  Outbox,
  SnapshotCache,
  type Actor,
  type KeyValueStore,
  type PaymentInput,
  type PendingOperation,
  type Payment,
} from '@app-gn/core';
import { ClientError, NETWORK_ERROR, type AppGnClient } from './client.ts';

/** localStorage quand il est disponible, sinon la mémoire (navigation privée, aperçu). IndexedDB ensuite. */
class BrowserStore implements KeyValueStore {
  private readonly memory = new Map<string, string>();
  async get(key: string) {
    try { return window.localStorage.getItem(key) ?? this.memory.get(key) ?? null; } catch { return this.memory.get(key) ?? null; }
  }
  async set(key: string, value: string) {
    this.memory.set(key, value);
    try { window.localStorage.setItem(key, value); } catch { /* mémoire seule */ }
  }
  async delete(key: string) {
    this.memory.delete(key);
    try { window.localStorage.removeItem(key); } catch { /* mémoire seule */ }
  }
}

export interface OfflineStatus {
  online: boolean;
  /** Vrai quand l'utilisateur a coupé le réseau depuis l'interface (démo). */
  simulatedOffline: boolean;
  /** Date de la plus ancienne donnée affichée depuis l'appareil, quand on est hors ligne. */
  servedFromCacheAt?: string;
  pending: PendingOperation<PaymentInput>[];
  /** Résultat de la dernière synchronisation, à montrer une fois. */
  lastSync?: { sent: number; rejected: number; expired: number; at: string };
  syncing: boolean;
}

/** Ce que la boîte de dialogue montre pour une confirmation forte. */
export interface CodeRequest {
  message: string;
  challenge: { challengeId: string; expiresAt: string; sentTo: string; summary: string; demoCode?: string };
}

export type PayResult = { kind: 'sent'; payment: Payment } | { kind: 'queued'; operation: PendingOperation<PaymentInput> };

/**
 * Enveloppe hors ligne d'abord autour du client : lectures servies par le réseau puis gardées sur l'appareil,
 * relues depuis l'appareil quand le réseau manque ; paiements mis en file hors ligne et rejoués au retour du réseau
 * avec leur clé d'idempotence. Toute autre écriture exige le réseau.
 */
export class OfflineClient {
  readonly base: AppGnClient;
  private readonly cache: SnapshotCache;
  private readonly outbox: Outbox;
  private status: OfflineStatus;
  private readonly listeners = new Set<() => void>();
  /** La session ouverte : seules ses opérations en file partent à la synchronisation. */
  private session: Actor | null = null;

  constructor(base: AppGnClient, store: KeyValueStore = new BrowserStore()) {
    this.base = base;
    this.cache = new SnapshotCache(store);
    this.outbox = new Outbox(store);
    this.status = { online: typeof navigator === 'undefined' ? true : navigator.onLine, simulatedOffline: false, pending: [], syncing: false };
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.setNetwork(true));
      window.addEventListener('offline', () => this.setNetwork(false));
    }
    void this.refreshPending();
  }

  get mode() { return this.base.mode; }

  /** Ouvre ou ferme la session de l'appareil. Rejoue alors ce qui attendait pour cet espace. */
  setSession(actor: Actor | null) {
    this.session = actor;
    void this.refreshPending();
    if (actor) void this.sync();
  }

  /**
   * Quitter un espace efface ce qui en était gardé sur l'appareil : sur une tablette de bureau partagée,
   * les soldes personnels ne restent pas après une session d'entreprise, ni l'inverse.
   * Les paiements en file restent : ce sont des ordres de la personne, rejoués à son retour dans cet espace.
   */
  async forget(actor: Actor) {
    await this.cache.forget(groupOf(actor));
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = () => this.status;

  get isOnline() {
    return this.status.online && !this.status.simulatedOffline;
  }

  /** On tente le réseau dès que rien ne dit qu'il manque : un serveur revenu se voit à la requête suivante. */
  private get mayTry() {
    return !this.status.simulatedOffline && (typeof navigator === 'undefined' || navigator.onLine);
  }

  private reachable() {
    if (!this.status.online) {
      this.update({ online: true });
      void this.sync();
    }
  }

  setSimulatedOffline(offline: boolean) {
    this.update({ simulatedOffline: offline });
    if (!offline) void this.sync();
  }

  /** Lecture : réseau d'abord, appareil ensuite. */
  async read<T>(actor: Actor, key: string, fetcher: () => Promise<T>): Promise<T> {
    const cacheKey = `${groupOf(actor)}:${key}`;
    if (this.mayTry) {
      try {
        const data = await fetcher();
        this.reachable();
        await this.cache.saveIn(groupOf(actor), cacheKey, data, new Date());
        if (this.status.servedFromCacheAt) this.update({ servedFromCacheAt: undefined });
        return data;
      } catch (error) {
        if (!(error instanceof ClientError) || error.code !== NETWORK_ERROR) throw error;
        this.update({ online: false });
      }
    }
    const snapshot = await this.cache.load<T>(cacheKey);
    if (!snapshot) throw new ClientError('offline', 'Hors ligne, et rien n’a encore été gardé sur cet appareil pour cet écran.');
    const oldest = this.status.servedFromCacheAt;
    if (!oldest || snapshot.savedAt < oldest) this.update({ servedFromCacheAt: snapshot.savedAt });
    return snapshot.data;
  }

  /**
   * Qui demande le code de confirmation forte à la personne (la boîte de dialogue de l'application). Rend le code
   * saisi, ou `null` si elle renonce.
   */
  askCode: ((request: CodeRequest) => Promise<string | null>) | null = null;

  /** Écriture qui exige le réseau. */
  async write<T>(work: () => Promise<T>): Promise<T> {
    if (!this.mayTry) throw new ClientError('offline', 'Cette action demande une connexion. Réessayez au retour du réseau.');
    try {
      const result = await this.confirming(work);
      this.reachable();
      return result;
    } catch (error) {
      if (error instanceof ClientError && error.code === NETWORK_ERROR) this.update({ online: false });
      throw error;
    }
  }

  /**
   * Au-delà du seuil d'entreprise, le serveur demande un code reçu par SMS (428) : on le demande à la personne et on
   * renvoie la même demande avec le code. Un code faux en fait partir un autre ; la personne peut renoncer.
   */
  private async confirming<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        const challenge = error instanceof ClientError && error.code === 'confirmation_required' ? error.details?.confirmation as CodeRequest['challenge'] | undefined : undefined;
        if (!challenge || !this.askCode || attempt >= 3) throw error;
        const code = await this.askCode({ message: (error as ClientError).message, challenge });
        if (!code) throw new ClientError('cancelled', 'Opération non confirmée : rien n’est parti.');
        this.base.confirmNext({ challengeId: challenge.challengeId, code });
      }
    }
  }

  async pay(actor: Actor, spaceId: string, input: PaymentInput): Promise<PayResult> {
    const key = crypto.randomUUID();
    if (this.mayTry) {
      try {
        const payment = await this.confirming(() => this.base.pay(actor, spaceId, input, key));
        this.reachable();
        return { kind: 'sent', payment };
      } catch (error) {
        if (!(error instanceof ClientError) || error.code !== NETWORK_ERROR) throw error;
        this.update({ online: false });
        // Coupure pendant l'envoi : on garde la même clé, le rejeu ne débitera pas deux fois.
      }
    }
    const operation = await this.outbox.enqueue<PaymentInput>({
      id: key,
      kind: 'payment',
      personId: actor.personId,
      spaceId,
      payload: { ...input, label: input.label },
      createdAt: new Date().toISOString(),
    });
    await this.refreshPending();
    return { kind: 'queued', operation };
  }

  async sync(): Promise<void> {
    const session = this.session;
    if (!this.mayTry || this.status.syncing || !session?.spaceId) return;
    this.update({ syncing: true });
    try {
      const changed = await this.outbox.flush(async (operation) => {
        try {
          // Le citoyen est le seul à payer hors ligne : son espace s'ouvre sur tout appareil.
          const payment = await this.base.pay({ personId: operation.personId, channel: 'phone', spaceId: operation.spaceId }, operation.spaceId, operation.payload as PaymentInput, operation.id);
          return { outcome: 'sent', detail: payment.status };
        } catch (error) {
          if (error instanceof ClientError && error.code === NETWORK_ERROR) return { outcome: 'offline' };
          return { outcome: 'rejected', detail: (error as Error).message };
        }
      }, new Date(), (operation) => operation.personId === session.personId && operation.spaceId === session.spaceId);
      if (changed.length > 0) {
        this.update({
          lastSync: {
            sent: changed.filter((operation) => operation.status === 'sent').length,
            rejected: changed.filter((operation) => operation.status === 'rejected').length,
            expired: changed.filter((operation) => operation.status === 'expired').length,
            at: new Date().toISOString(),
          },
        });
      }
      await this.outbox.prune();
    } finally {
      await this.refreshPending();
      this.update({ syncing: false });
    }
  }

  dismissSync() {
    this.update({ lastSync: undefined });
  }

  private setNetwork(online: boolean) {
    this.update({ online });
    if (online) void this.sync();
  }

  private async refreshPending() {
    const session = this.session;
    this.update({
      pending: (await this.outbox.list()).filter((operation) => operation.status === 'pending'
        && operation.personId === session?.personId && operation.spaceId === session?.spaceId) as PendingOperation<PaymentInput>[],
    });
  }

  private update(patch: Partial<OfflineStatus>) {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener();
  }
}

function groupOf(actor: Actor): string {
  return `${actor.personId}@${actor.spaceId ?? '*'}`;
}
