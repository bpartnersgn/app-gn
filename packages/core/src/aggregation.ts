import type { AccountConnector } from './connectors.ts';
import type { AccountKind, LinkedAccount } from './model.ts';
import { add, money, REFERENCE_CURRENCY, toReference, type FxTable, type Money } from './money.ts';
import { providerById } from './providers.ts';

export type BalanceFreshness = 'live' | 'stale' | 'unavailable';

export interface AccountPosition {
  account: LinkedAccount;
  providerName: string;
  kind: AccountKind;
  /** Solde dans la devise du compte ; absent si le fournisseur n'a jamais répondu. */
  balance?: Money;
  /** Contre-valeur indicative en GNF ; absente si le solde ou le taux manquent. */
  referenceValue?: Money;
  freshness: BalanceFreshness;
  asOf?: string;
}

export interface ConsolidatedView {
  spaceId: string;
  generatedAt: string;
  total: Money;
  /** Vrai si au moins un compte n'est pas compté au solde du jour (indisponible ou ancien). */
  partial: boolean;
  byKind: { kind: AccountKind; total: Money; accounts: number }[];
  positions: AccountPosition[];
}

export interface AggregatorOptions {
  connectors: ReadonlyMap<string, AccountConnector>;
  fx: FxTable;
  /** Au-delà, un fournisseur est traité comme indisponible pour cette lecture. */
  timeoutMs?: number;
  now?: () => Date;
}

/**
 * Interroge tous les fournisseurs en parallèle, chacun sous un délai, et consolide.
 * Une panne d'un fournisseur ne bloque jamais la vue : on montre le dernier solde connu, marqué « ancien »,
 * ou rien si on n'en a jamais eu, et la vue est marquée partielle.
 */
export class Aggregator {
  private readonly options: Required<AggregatorOptions>;
  private readonly lastKnown = new Map<string, { balance: Money; asOf: string }>();

  constructor(options: AggregatorOptions) {
    this.options = { timeoutMs: 3000, now: () => new Date(), ...options };
  }

  async consolidate(spaceId: string, accounts: readonly LinkedAccount[]): Promise<ConsolidatedView> {
    const positions = await Promise.all(accounts.map((account) => this.position(account)));
    let total = money(0, REFERENCE_CURRENCY);
    const byKind = new Map<AccountKind, { total: Money; accounts: number }>();
    for (const position of positions) {
      const bucket = byKind.get(position.kind) ?? { total: money(0, REFERENCE_CURRENCY), accounts: 0 };
      bucket.accounts += 1;
      if (position.referenceValue) {
        total = add(total, position.referenceValue);
        bucket.total = add(bucket.total, position.referenceValue);
      }
      byKind.set(position.kind, bucket);
    }
    return {
      spaceId,
      generatedAt: this.options.now().toISOString(),
      total,
      partial: positions.some((position) => position.freshness !== 'live' || !position.referenceValue),
      byKind: [...byKind.entries()].map(([kind, bucket]) => ({ kind, ...bucket })),
      positions,
    };
  }

  private async position(account: LinkedAccount): Promise<AccountPosition> {
    const provider = providerById(account.providerId);
    const base = {
      account,
      providerName: provider?.name ?? account.providerId,
      kind: provider?.kind ?? 'bank',
    } satisfies Partial<AccountPosition>;
    const connector = this.options.connectors.get(account.providerId);
    try {
      if (!connector) throw new Error(`aucun connecteur pour ${account.providerId}`);
      const balance = await withTimeout(connector.fetchBalance(account), this.options.timeoutMs);
      const asOf = this.options.now().toISOString();
      this.lastKnown.set(account.id, { balance, asOf });
      return { ...base, balance, referenceValue: toReference(balance, this.options.fx) ?? undefined, freshness: 'live', asOf };
    } catch {
      const known = this.lastKnown.get(account.id);
      if (!known) return { ...base, freshness: 'unavailable' };
      return {
        ...base,
        balance: known.balance,
        referenceValue: toReference(known.balance, this.options.fx) ?? undefined,
        freshness: 'stale',
        asOf: known.asOf,
      };
    }
  }
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('délai dépassé')), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
