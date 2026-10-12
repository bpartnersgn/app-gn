import type { AccountTransaction, LinkedAccount } from './model.ts';
import { money, toBigInt, type Money } from './money.ts';

/**
 * Port d'agrégation : ce qu'App GN demande à un fournisseur pour un compte rattaché.
 * Un connecteur réel (API bancaire, API Mobile Money, dépositaire crypto) implémentera ce contrat ;
 * les paiements, eux, ne passent pas par ici mais par l'orchestrateur (payments.ts).
 */
export interface AccountConnector {
  readonly providerId: string;
  fetchBalance(account: LinkedAccount): Promise<Money>;
  fetchTransactions(account: LinkedAccount, limit: number): Promise<AccountTransaction[]>;
}

export class ConnectorUnavailableError extends Error {
  readonly providerId: string;
  constructor(providerId: string) {
    super(`fournisseur ${providerId} indisponible`);
    this.providerId = providerId;
  }
}

/**
 * Réseau simulé : tient le solde et l'historique de chaque compte en mémoire.
 * Il sert à la fois les connecteurs simulés (lecture) et l'orchestrateur simulé (écriture).
 */
export class SimulatedNetwork {
  private readonly ledgers = new Map<string, AccountTransaction[]>();
  private readonly down = new Set<string>();
  private readonly slow = new Map<string, number>();
  private sequence = 0;

  open(account: LinkedAccount, history: Omit<AccountTransaction, 'id' | 'accountId'>[]): void {
    const entries = history.map((entry) => ({ ...entry, id: this.nextId(), accountId: account.id }));
    this.ledgers.set(account.id, entries);
  }

  /** Simule une panne du fournisseur (tous ses comptes). */
  setUnavailable(providerId: string, unavailable: boolean): void {
    if (unavailable) this.down.add(providerId);
    else this.down.delete(providerId);
  }

  /** Simule un fournisseur lent, pour exercer le délai de l'agrégation. */
  setLatency(providerId: string, milliseconds: number): void {
    this.slow.set(providerId, milliseconds);
  }

  async reach(providerId: string): Promise<void> {
    const latency = this.slow.get(providerId) ?? 0;
    if (latency > 0) await new Promise((resolve) => setTimeout(resolve, latency));
    if (this.down.has(providerId)) throw new ConnectorUnavailableError(providerId);
  }

  balance(account: LinkedAccount): Money {
    let total = 0n;
    for (const entry of this.entries(account)) {
      total += entry.direction === 'credit' ? toBigInt(entry.amount) : -toBigInt(entry.amount);
    }
    return money(total, account.currency);
  }

  entries(account: LinkedAccount): AccountTransaction[] {
    return this.ledgers.get(account.id) ?? [];
  }

  post(account: LinkedAccount, entry: Omit<AccountTransaction, 'id' | 'accountId'>): AccountTransaction {
    const ledger = this.ledgers.get(account.id);
    if (!ledger) throw new Error(`compte ${account.id} inconnu du réseau simulé`);
    const created = { ...entry, id: this.nextId(), accountId: account.id };
    ledger.push(created);
    return created;
  }

  private nextId(): string {
    this.sequence += 1;
    return `txn_${this.sequence.toString().padStart(6, '0')}`;
  }
}

export class SimulatedConnector implements AccountConnector {
  readonly providerId: string;
  private readonly network: SimulatedNetwork;

  constructor(providerId: string, network: SimulatedNetwork) {
    this.providerId = providerId;
    this.network = network;
  }

  async fetchBalance(account: LinkedAccount): Promise<Money> {
    await this.network.reach(this.providerId);
    return this.network.balance(account);
  }

  async fetchTransactions(account: LinkedAccount, limit: number): Promise<AccountTransaction[]> {
    await this.network.reach(this.providerId);
    return [...this.network.entries(account)]
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, limit);
  }
}
