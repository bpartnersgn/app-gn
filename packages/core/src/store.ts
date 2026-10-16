import type { CardStatus, Exchange, ExchangeQuote, VirtualCard } from './cards.ts';
import type { LinkedAccount } from './model.ts';
import type { Payment, PaymentStatus } from './payments.ts';

export interface StoredCard {
  card: VirtualCard;
  /** Le compte de la carte, pour une carte émise par App GN ; absent pour une carte venue du référentiel. */
  account?: LinkedAccount;
}

export interface IdempotencyRecord {
  fingerprint: string;
  resultId: string;
}

/**
 * Ce qu'App GN doit retrouver après un redémarrage, et que plusieurs instances partagent : paiements, clés
 * d'idempotence, devis et conversions, cartes émises et leur état. Deux implémentations : en mémoire (navigateur,
 * tests, démo) et PostgreSQL (serveur, `apps/api/src/db`).
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

  /** Garde un devis de conversion, pour qu'il soit accepté depuis n'importe quelle instance. */
  saveQuote(quote: ExchangeQuote): Promise<void>;
  quote(id: string): Promise<ExchangeQuote | undefined>;
  /** Consomme le devis : vrai pour un seul appel, même concurrent. */
  takeQuote(id: string): Promise<boolean>;

  /**
   * Enregistre une carte si son type a encore une place dans l'espace (au plus `maxPerTier`), même sous émissions
   * concurrentes depuis plusieurs instances. Vrai si la carte est enregistrée (par cet appel ou déjà avant).
   */
  insertCard(card: VirtualCard, account: LinkedAccount | undefined, maxPerTier: number): Promise<boolean>;
  /** Bloque ou débloque une carte enregistrée ; rend la carte à jour, rien si elle n'est pas enregistrée. */
  setCardStatus(accountId: string, status: CardStatus): Promise<VirtualCard | undefined>;
  cardsOfSpace(spaceId: string): Promise<StoredCard[]>;
  issuedCards(): Promise<StoredCard[]>;
}

export class MemoryAppStore implements AppStore {
  private readonly payments = new Map<string, Payment>();
  private readonly keys = new Map<string, IdempotencyRecord>();
  private readonly exchanges = new Map<string, Exchange>();
  private readonly quotes = new Map<string, ExchangeQuote>();
  private readonly cards = new Map<string, StoredCard>();

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

  async saveQuote(quote: ExchangeQuote): Promise<void> {
    this.quotes.set(quote.id, structuredClone(quote));
  }

  async quote(id: string): Promise<ExchangeQuote | undefined> {
    const quote = this.quotes.get(id);
    return quote && structuredClone(quote);
  }

  async takeQuote(id: string): Promise<boolean> {
    return this.quotes.delete(id);
  }

  async insertCard(card: VirtualCard, account: LinkedAccount | undefined, maxPerTier: number): Promise<boolean> {
    if (this.cards.has(card.accountId)) return true;
    const sameTier = [...this.cards.values()].filter((entry) => entry.card.spaceId === card.spaceId && entry.card.tier === card.tier).length;
    if (sameTier >= maxPerTier) return false;
    this.cards.set(card.accountId, structuredClone(account ? { card, account } : { card }));
    return true;
  }

  async setCardStatus(accountId: string, status: CardStatus): Promise<VirtualCard | undefined> {
    const entry = this.cards.get(accountId);
    if (!entry) return undefined;
    entry.card.status = status;
    return structuredClone(entry.card);
  }

  async cardsOfSpace(spaceId: string): Promise<StoredCard[]> {
    return [...this.cards.values()].filter((entry) => entry.card.spaceId === spaceId).map((entry) => structuredClone(entry));
  }

  async issuedCards(): Promise<StoredCard[]> {
    return [...this.cards.values()].map((entry) => structuredClone(entry));
  }
}
