import type { SimulatedNetwork } from './connectors.ts';
import type { LinkedAccount, Role, SpaceKind } from './model.ts';
import { money, toBigInt, type Money } from './money.ts';
import { can } from './rbac.ts';

export type MobileMoneyOperator = 'orange_money' | 'mtn_momo' | 'cellcom_money' | 'moov_money';

export type PaymentDestination =
  | { type: 'own_account'; accountId: string }
  | { type: 'mobile_money'; operator: MobileMoneyOperator; phone: string; name?: string }
  | { type: 'biller'; billerId: string; customerReference: string };

export type PaymentStatus = 'pending_approval' | 'processing' | 'completed' | 'failed' | 'rejected';

export interface Payment {
  id: string;
  spaceId: string;
  sourceAccountId: string;
  amount: Money;
  destination: PaymentDestination;
  label: string;
  status: PaymentStatus;
  approval: ApprovalRequirement;
  initiatedBy: string;
  decidedBy?: string;
  orchestratorReference?: string;
  failureReason?: string;
  /** Motif donné par qui a refusé (visa du comptable public, approbation du dirigeant). */
  rejectionReason?: string;
  createdAt: string;
  updatedAt: string;
}

export const BILLERS = [
  { id: 'edg', name: 'EDG — Électricité de Guinée' },
  { id: 'seg', name: 'SEG — Société des Eaux de Guinée' },
  { id: 'canal', name: 'Canal+ Guinée' },
  { id: 'ecole', name: 'Frais de scolarité' },
  { id: 'dgi', name: 'DGI — Direction générale des impôts' },
] as const;

/** Seuil d'approbation côté entreprise (repris des cas d'usage GAPP : MFA au-delà de 5 M GNF). */
export const BUSINESS_APPROVAL_THRESHOLD = money(5_000_000, 'GNF');

export type ApprovalRequirement = 'none' | 'second_person';

/**
 * Règle d'approbation, par espace :
 * - citoyen : aucune ;
 * - entreprise : au-delà du seuil, un membre habilité autre que l'initiateur, sauf si l'initiateur est
 *   lui-même habilité à approuver (le dirigeant) — la confirmation forte (OTP) viendra avec l'authentification réelle ;
 * - administration : toujours une seconde personne (séparation ordonnateur / comptable public).
 */
export function approvalRequirement(spaceKind: SpaceKind, initiatorRole: Role, amount: Money): ApprovalRequirement {
  if (spaceKind === 'citizen') return 'none';
  if (spaceKind === 'administration') return 'second_person';
  if (amount.currency !== BUSINESS_APPROVAL_THRESHOLD.currency) return can(initiatorRole, 'payments:approve') ? 'none' : 'second_person';
  if (toBigInt(amount) < toBigInt(BUSINESS_APPROVAL_THRESHOLD)) return 'none';
  return can(initiatorRole, 'payments:approve') ? 'none' : 'second_person';
}

export interface PaymentOrder {
  paymentId: string;
  source: LinkedAccount;
  amount: Money;
  destination: PaymentDestination;
  /** Résolu par l'application quand la destination est un compte de l'espace. */
  destinationAccount?: LinkedAccount;
  label: string;
}

export type OrchestratorOutcome =
  | { status: 'processing'; reference: string }
  | { status: 'completed'; reference: string }
  | { status: 'failed'; reference: string; reason: string };

/**
 * Port vers l'orchestrateur de paiements. La cible est ORCHEA (XeyLink Router), appelé par son API
 * (`POST /v1/payment-intents`, `POST /v1/payouts`) avec une clé d'idempotence = paymentId ; l'issue
 * arrive alors par webhook (`processing` puis `recordOutcome`). Ici, un orchestrateur simulé répond tout de suite.
 */
export interface PaymentOrchestrator {
  submit(order: PaymentOrder): Promise<OrchestratorOutcome>;
  /** Conversion entre deux comptes de la même personne (recharge de carte, crypto vers Mobile Money…). */
  convert(order: ExchangeOrder): Promise<OrchestratorOutcome>;
}

export interface ExchangeOrder {
  exchangeId: string;
  source: LinkedAccount;
  target: LinkedAccount;
  debit: Money;
  credit: Money;
  label: string;
}

export class SimulatedOrchestrator implements PaymentOrchestrator {
  private readonly network: SimulatedNetwork;
  private readonly now: () => Date;

  constructor(network: SimulatedNetwork, now: () => Date = () => new Date()) {
    this.network = network;
    this.now = now;
  }

  async submit(order: PaymentOrder): Promise<OrchestratorOutcome> {
    const reference = `sim_${order.paymentId}`;
    try {
      await this.network.reach(order.source.providerId);
    } catch {
      return { status: 'failed', reference, reason: 'rail_unavailable' };
    }
    if (toBigInt(this.network.balance(order.source)) < toBigInt(order.amount)) {
      return { status: 'failed', reference, reason: 'insufficient_funds' };
    }
    const occurredAt = this.now().toISOString();
    this.network.post(order.source, {
      occurredAt,
      direction: 'debit',
      amount: order.amount,
      label: order.label,
      counterparty: describeDestination(order.destination),
    });
    if (order.destinationAccount) {
      this.network.post(order.destinationAccount, {
        occurredAt,
        direction: 'credit',
        amount: order.amount,
        label: order.label,
        counterparty: order.source.label,
      });
    }
    return { status: 'completed', reference };
  }

  async convert(order: ExchangeOrder): Promise<OrchestratorOutcome> {
    const reference = `sim_${order.exchangeId}`;
    try {
      await this.network.reach(order.source.providerId);
      await this.network.reach(order.target.providerId);
    } catch {
      return { status: 'failed', reference, reason: 'rail_unavailable' };
    }
    if (toBigInt(this.network.balance(order.source)) < toBigInt(order.debit)) {
      return { status: 'failed', reference, reason: 'insufficient_funds' };
    }
    const occurredAt = this.now().toISOString();
    this.network.post(order.source, { occurredAt, direction: 'debit', amount: order.debit, label: order.label, counterparty: order.target.label });
    this.network.post(order.target, { occurredAt, direction: 'credit', amount: order.credit, label: order.label, counterparty: order.source.label });
    return { status: 'completed', reference };
  }
}

export function describeDestination(destination: PaymentDestination): string {
  switch (destination.type) {
    case 'own_account':
      return 'Virement interne';
    case 'mobile_money':
      return destination.name ? `${destination.name} (${destination.phone})` : destination.phone;
    case 'biller':
      return `${BILLERS.find((biller) => biller.id === destination.billerId)?.name ?? destination.billerId} · ${destination.customerReference}`;
  }
}
