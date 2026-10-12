import type { SimulatedNetwork } from './connectors.ts';
import type { AccountKind, LinkedAccount } from './model.ts';
import { toBigInt, type Currency, type Money } from './money.ts';

/**
 * Cartes virtuelles et conversions, sur le modèle des néo-portefeuilles africains (type Keecash) :
 * plusieurs cartes par personne, rechargées depuis le Mobile Money ou la crypto, blocage instantané,
 * frais affichés avant de confirmer. L'émission réelle passera par un émetteur de cartes partenaire (port CardIssuer).
 */

export type CardNetwork = 'visa' | 'mastercard';
export type CardTier = 'standard' | 'gold';
export type CardStatus = 'active' | 'frozen';

export interface VirtualCard {
  accountId: string;
  spaceId: string;
  network: CardNetwork;
  tier: CardTier;
  status: CardStatus;
  last4: string;
  /** MM/AA */
  expiry: string;
  holderName: string;
}

export const CARD_TIER_LABELS: Record<CardTier, string> = { standard: 'Standard', gold: 'Gold' };

/** Plafond par personne et par type de carte. */
export const MAX_CARDS_PER_TIER = 3;

/** Prix d'émission (fictifs, en GNF) : à fixer avec l'émetteur partenaire. */
export const CARD_ISSUE_PRICE_GNF: Record<CardTier, number> = { standard: 25_000, gold: 120_000 };

export interface CardIssuer {
  issue(request: { accountId: string; spaceId: string; network: CardNetwork; tier: CardTier; holderName: string; currency: Currency }): Promise<{ account: LinkedAccount; card: VirtualCard }>;
  setFrozen(card: VirtualCard, frozen: boolean): Promise<void>;
}

export class SimulatedCardIssuer implements CardIssuer {
  private readonly network: SimulatedNetwork;
  private readonly now: () => Date;

  constructor(network: SimulatedNetwork, now: () => Date = () => new Date()) {
    this.network = network;
    this.now = now;
  }

  async issue(request: { accountId: string; spaceId: string; network: CardNetwork; tier: CardTier; holderName: string; currency: Currency }) {
    await this.network.reach('appgn_card');
    const digits = [...request.accountId].reduce((sum, char, index) => (sum + char.charCodeAt(0) * (index + 7919)) % 6000, 0);
    const last4 = String(4000 + digits).slice(-4);
    const now = this.now();
    const expiry = `${String(now.getUTCMonth() + 1).padStart(2, '0')}/${String((now.getUTCFullYear() + 3) % 100).padStart(2, '0')}`;
    const account: LinkedAccount = {
      id: request.accountId,
      spaceId: request.spaceId,
      providerId: 'appgn_card',
      label: `Carte ${request.network === 'visa' ? 'Visa' : 'Mastercard'} ${CARD_TIER_LABELS[request.tier]}`,
      currency: request.currency,
      maskedIdentifier: `•••• ${last4}`,
      linkedAt: now.toISOString(),
    };
    this.network.open(account, []);
    const card: VirtualCard = { accountId: account.id, spaceId: request.spaceId, network: request.network, tier: request.tier, status: 'active', last4, expiry, holderName: request.holderName };
    return { account, card };
  }

  async setFrozen(): Promise<void> {
    await this.network.reach('appgn_card');
  }
}

/**
 * Frais d'une conversion, en points de base du montant débité (fictifs, à fixer par la grille tarifaire) :
 * recharge d'une carte Gold gratuite ; depuis la crypto 1 % ; recharge d'une carte Standard 2 % ; sinon 1,5 %.
 */
export function exchangeFeeBps(sourceKind: AccountKind, targetKind: AccountKind, targetTier?: CardTier): number {
  if (targetKind === 'virtual_card' && targetTier === 'gold') return 0;
  if (sourceKind === 'crypto') return 100;
  if (targetKind === 'virtual_card') return 200;
  return 150;
}

export function feeFor(amount: Money, bps: number): bigint {
  // Arrondi au supérieur : le frais affiché est celui prélevé, jamais moins.
  return (toBigInt(amount) * BigInt(bps) + 9999n) / 10000n;
}

export interface ExchangeQuote {
  id: string;
  spaceId: string;
  personId: string;
  sourceAccountId: string;
  targetAccountId: string;
  /** Débité du compte source, frais compris. */
  debit: Money;
  fee: Money;
  feeBps: number;
  /** Crédité au compte cible. */
  credit: Money;
  /** Pour l'affichage : combien de GNF vaut une unité de chaque devise. */
  rates: { currency: Currency; gnfPerUnit: string }[];
  expiresAt: string;
}

export const QUOTE_TTL_SECONDS = 60;

export type ExchangeStatus = 'completed' | 'failed';

export interface Exchange {
  id: string;
  quoteId: string;
  spaceId: string;
  sourceAccountId: string;
  targetAccountId: string;
  debit: Money;
  fee: Money;
  credit: Money;
  status: ExchangeStatus;
  failureReason?: string;
  createdAt: string;
}
