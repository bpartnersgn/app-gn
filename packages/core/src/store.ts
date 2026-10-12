import type { Exchange, VirtualCard } from './cards.ts';
import type { LinkedAccount } from './model.ts';
import type { Payment, PaymentStatus } from './payments.ts';

export interface IdempotencyRecord {
  fingerprint: string;
  resultId: string;
}

/**
 * Ce qu'App GN doit retrouver après un redémarrage : paiements, clés d'idempotence, conversions, cartes émises.
 * Deux implémentations : en mémoire (navigateur, tests, démo) et PostgreSQL (serveur, `apps/api/src/db`).
 *
 * Le référentiel (personnes, espaces, rattachements, comptes liés, documents) vient encore des données de
 * démonstration ; les devis de conversion (60 s) restent en mémoire.
 */
export interface AppStore {
  insertPayment(payment: Payment): Promise<void>;
  /** Écrit le paiement seulement s'il est encore dans l'état attendu : deux décisions concurrentes ne passent pas toutes les deux. */
  updatePayment(payment: Payment, expected: PaymentStatus): Promise<boolean>;
  payment(id: string): Promise<Payment | undefined>;
  paymentByReference(reference: string): Promise<Payment | undefined>;
  paymentsOfSpace(spaceId: string): Promise<Payment[]>;

  /**
   * Réserve une clé d'idempotence pour un résultat à venir. Rend l'enregistrement existant si la clé a déjà
   * servi (y compris par une requête concurrente), rien si la réservation est prise.
   */
  claimIdempotency(scope: string, record: IdempotencyRecord): Promise<IdempotencyRecord | undefined>;
  /** Libère une réservation dont la demande a échoué avant d'avoir produit quoi que ce soit. */
  releaseIdempotency(scope: string): Promise<void>;

  saveExchange(exchange: Exchange): Promise<void>;
  exchange(id: string): Promise<Exchange | undefined>;

  saveCard(card: VirtualCard, account?: LinkedAccount): Promise<void>;
  issuedCards(): Promise<{ card: VirtualCard; account?: LinkedAccount }[]>;
}

export class MemoryAppStore implements AppStore {
  private readonly payments = new Map<string, Payment>();
  private readonly keys = new Map<string, IdempotencyRecord>();
  private readonly exchanges = new Map<string, Exchange>();
  private readonly cards = new Map<string, { card: VirtualCard; account?: LinkedAccount }>();

  async insertPayment(payment: Payment): Promise<void> {
    if (this.payments.has(payment.id)) throw new Error(`paiement ${payment.id} déjà enregistré`);
    this.payments.set(payment.id, structuredClone(payment));
  }

  async updatePayment(payment: Payment, expected: PaymentStatus): Promise<boolean> {
    const current = this.payments.get(payment.id);
    if (!current || current.status !== expected) return false;
    this.payments.set(payment.id, structuredClone(payment));
    return true;
  }

  async payment(id: string): Promise<Payment | undefined> {
    const payment = this.payments.get(id);
    return payment && structuredClone(payment);
  }

  async paymentByReference(reference: string): Promise<Payment | undefined> {
    const payment = [...this.payments.values()].find((candidate) => candidate.orchestratorReference === reference);
    return payment && structuredClone(payment);
  }

  async paymentsOfSpace(spaceId: string): Promise<Payment[]> {
    return [...this.payments.values()]
      .filter((payment) => payment.spaceId === spaceId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .map((payment) => structuredClone(payment));
  }

  async claimIdempotency(scope: string, record: IdempotencyRecord): Promise<IdempotencyRecord | undefined> {
    const existing = this.keys.get(scope);
    if (existing) return existing;
    this.keys.set(scope, record);
    return undefined;
  }

  async releaseIdempotency(scope: string): Promise<void> {
    this.keys.delete(scope);
  }

  async saveExchange(exchange: Exchange): Promise<void> {
    this.exchanges.set(exchange.id, structuredClone(exchange));
  }

  async exchange(id: string): Promise<Exchange | undefined> {
    const exchange = this.exchanges.get(id);
    return exchange && structuredClone(exchange);
  }

  async saveCard(card: VirtualCard, account?: LinkedAccount): Promise<void> {
    const previous = this.cards.get(card.accountId);
    this.cards.set(card.accountId, structuredClone({ card, account: account ?? previous?.account }));
  }

  async issuedCards(): Promise<{ card: VirtualCard; account?: LinkedAccount }[]> {
    return [...this.cards.values()].map((entry) => structuredClone(entry));
  }
}
