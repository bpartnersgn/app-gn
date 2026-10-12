import { Aggregator, type ConsolidatedView } from './aggregation.ts';
import { SimulatedConnector, SimulatedNetwork, type AccountConnector } from './connectors.ts';
import { AppError } from './errors.ts';
import type { AccountTransaction, LinkedAccount, Membership, Person, Role, Space } from './model.ts';
import { isCurrency, parseMajor, type FxTable } from './money.ts';
import {
  approvalRequirement,
  BILLERS,
  SimulatedOrchestrator,
  type OrchestratorOutcome,
  type Payment,
  type PaymentDestination,
  type PaymentOrchestrator,
} from './payments.ts';
import { PROVIDERS, providerById } from './providers.ts';
import { can, permissionsOf, ROLE_LABELS, type Permission } from './rbac.ts';
import { DEMO_FX, seedDemo } from './seed.ts';
import { servicesFor, type ServiceDefinition } from './services.ts';

export interface SpaceAccess {
  space: Space;
  role: Role;
  roleLabel: string;
  permissions: readonly Permission[];
}

export interface MeView {
  person: Person;
  spaces: SpaceAccess[];
}

export interface PaymentInput {
  sourceAccountId: string;
  /** Montant en unités majeures, saisi par l'utilisateur (« 150000 », « 12.50 »). */
  amount: string;
  destination: PaymentDestination;
  label?: string;
}

interface IdempotencyRecord {
  fingerprint: string;
  paymentId: string;
}

export interface AppGnDependencies {
  persons: Person[];
  spaces: Space[];
  memberships: Membership[];
  accounts: LinkedAccount[];
  connectors: ReadonlyMap<string, AccountConnector>;
  orchestrator: PaymentOrchestrator;
  fx: FxTable;
  now?: () => Date;
  aggregationTimeoutMs?: number;
}

/**
 * Couche application d'App GN : chaque cas d'usage vérifie d'abord que la personne est membre de l'espace
 * et que son rôle y porte la permission demandée. L'API HTTP et l'application web (mode démo) l'appellent
 * telle quelle ; aucune règle d'accès ne vit dans les couches au-dessus.
 */
export class AppGn {
  private readonly deps: AppGnDependencies;
  private readonly aggregator: Aggregator;
  private readonly payments = new Map<string, Payment>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly now: () => Date;
  private sequence = 0;

  constructor(deps: AppGnDependencies) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.aggregator = new Aggregator({
      connectors: deps.connectors,
      fx: deps.fx,
      timeoutMs: deps.aggregationTimeoutMs ?? 3000,
      now: this.now,
    });
  }

  listPersons(): Person[] {
    return this.deps.persons;
  }

  me(personId: string): MeView {
    const person = this.person(personId);
    const spaces = this.deps.memberships
      .filter((membership) => membership.personId === personId)
      .map((membership) => {
        const space = this.deps.spaces.find((candidate) => candidate.id === membership.spaceId);
        if (!space) throw new Error(`espace ${membership.spaceId} introuvable`);
        return { space, role: membership.role, roleLabel: ROLE_LABELS[membership.role], permissions: permissionsOf(membership.role) };
      });
    return { person, spaces };
  }

  async overview(personId: string, spaceId: string): Promise<ConsolidatedView> {
    this.authorize(personId, spaceId, 'accounts:read');
    return this.aggregator.consolidate(spaceId, this.accountsOf(spaceId));
  }

  async transactions(personId: string, spaceId: string, accountId: string, limit = 20): Promise<AccountTransaction[]> {
    this.authorize(personId, spaceId, 'accounts:read');
    const account = this.account(spaceId, accountId);
    const connector = this.deps.connectors.get(account.providerId);
    if (!connector) throw new AppError('not_found', 'aucun connecteur pour ce compte');
    try {
      return await connector.fetchTransactions(account, Math.min(Math.max(limit, 1), 100));
    } catch {
      return [];
    }
  }

  services(personId: string, spaceId: string): ServiceDefinition[] {
    const { space, role } = this.access(personId, spaceId);
    return servicesFor(space.kind, role);
  }

  listPayments(personId: string, spaceId: string): Payment[] {
    this.authorize(personId, spaceId, 'accounts:read');
    return [...this.payments.values()]
      .filter((payment) => payment.spaceId === spaceId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async initiatePayment(personId: string, spaceId: string, input: PaymentInput, idempotencyKey: string): Promise<Payment> {
    const { space, role } = this.authorize(personId, spaceId, 'payments:initiate');
    if (!idempotencyKey || idempotencyKey.length > 255) throw new AppError('invalid_request', 'Idempotency-Key requise (1 à 255 caractères)');

    const fingerprint = JSON.stringify([input.sourceAccountId, input.amount, input.destination, input.label ?? null]);
    const scopedKey = `${spaceId}:${personId}:${idempotencyKey}`;
    const replay = this.idempotency.get(scopedKey);
    if (replay) {
      if (replay.fingerprint !== fingerprint) throw new AppError('idempotency_conflict', 'cette clé d’idempotence a déjà servi pour une autre demande');
      return this.payments.get(replay.paymentId)!;
    }

    const source = this.account(spaceId, input.sourceAccountId);
    const provider = providerById(source.providerId);
    if (!provider?.canDebit) throw new AppError('invalid_request', 'ce compte ne peut pas être débité depuis App GN');
    if (!isCurrency(source.currency)) throw new AppError('invalid_request', 'devise inconnue');
    const amount = typeof input.amount === 'string' ? parseMajor(input.amount, source.currency) : null;
    if (!amount || BigInt(amount.amount) <= 0n) throw new AppError('invalid_request', `montant invalide pour ${source.currency}`);
    this.validateDestination(spaceId, source, input.destination);

    const timestamp = this.now().toISOString();
    this.sequence += 1;
    const payment: Payment = {
      id: `pay_${this.sequence.toString().padStart(6, '0')}`,
      spaceId,
      sourceAccountId: source.id,
      amount,
      destination: input.destination,
      label: input.label?.trim() || defaultLabel(input.destination),
      status: 'pending_approval',
      approval: approvalRequirement(space.kind, role, amount),
      initiatedBy: personId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.payments.set(payment.id, payment);
    this.idempotency.set(scopedKey, { fingerprint, paymentId: payment.id });

    if (payment.approval === 'none') await this.submit(payment);
    return payment;
  }

  async approvePayment(personId: string, spaceId: string, paymentId: string): Promise<Payment> {
    this.authorize(personId, spaceId, 'payments:approve');
    const payment = this.pendingPayment(spaceId, paymentId);
    if (payment.initiatedBy === personId) {
      throw new AppError('separation_of_duties', 'l’initiateur d’un paiement ne peut pas l’approuver');
    }
    payment.decidedBy = personId;
    await this.submit(payment);
    return payment;
  }

  rejectPayment(personId: string, spaceId: string, paymentId: string): Payment {
    this.authorize(personId, spaceId, 'payments:approve');
    const payment = this.pendingPayment(spaceId, paymentId);
    payment.decidedBy = personId;
    payment.status = 'rejected';
    payment.updatedAt = this.now().toISOString();
    return payment;
  }

  /** Point d'entrée de l'issue asynchrone (webhook de l'orchestrateur réel). */
  recordOutcome(reference: string, outcome: OrchestratorOutcome): Payment | undefined {
    const payment = [...this.payments.values()].find((candidate) => candidate.orchestratorReference === reference);
    if (!payment || payment.status !== 'processing') return payment;
    this.applyOutcome(payment, outcome);
    return payment;
  }

  catalog() {
    return { providers: PROVIDERS, billers: BILLERS };
  }

  private async submit(payment: Payment): Promise<void> {
    payment.status = 'processing';
    payment.updatedAt = this.now().toISOString();
    const source = this.account(payment.spaceId, payment.sourceAccountId);
    const destinationAccount = payment.destination.type === 'own_account'
      ? this.account(payment.spaceId, payment.destination.accountId)
      : undefined;
    const outcome = await this.deps.orchestrator.submit({
      paymentId: payment.id,
      source,
      amount: payment.amount,
      destination: payment.destination,
      destinationAccount,
      label: payment.label,
    });
    this.applyOutcome(payment, outcome);
  }

  private applyOutcome(payment: Payment, outcome: OrchestratorOutcome): void {
    payment.orchestratorReference = outcome.reference;
    payment.status = outcome.status;
    if (outcome.status === 'failed') payment.failureReason = outcome.reason;
    payment.updatedAt = this.now().toISOString();
  }

  private validateDestination(spaceId: string, source: LinkedAccount, destination: PaymentDestination): void {
    if (!destination || typeof destination !== 'object') throw new AppError('invalid_request', 'destination requise');
    switch (destination.type) {
      case 'own_account': {
        const target = this.account(spaceId, destination.accountId);
        if (target.id === source.id) throw new AppError('invalid_request', 'le compte source et le compte destinataire sont identiques');
        if (target.currency !== source.currency) throw new AppError('invalid_request', 'virement interne entre devises différentes non pris en charge');
        return;
      }
      case 'mobile_money':
        if (!['orange_money', 'mtn_momo', 'cellcom_money', 'moov_money'].includes(destination.operator)) {
          throw new AppError('invalid_request', 'opérateur Mobile Money inconnu');
        }
        if (!/^\+?224\s?\d[\d\s]{7,11}$/.test(destination.phone ?? '')) throw new AppError('invalid_request', 'numéro guinéen attendu (+224…)');
        if (source.currency !== 'GNF') throw new AppError('invalid_request', 'un envoi Mobile Money part d’un compte en GNF');
        return;
      case 'biller':
        if (!BILLERS.some((biller) => biller.id === destination.billerId)) throw new AppError('invalid_request', 'facturier inconnu');
        if (!destination.customerReference?.trim()) throw new AppError('invalid_request', 'référence client requise');
        if (source.currency !== 'GNF') throw new AppError('invalid_request', 'une facture se paie depuis un compte en GNF');
        return;
      default:
        throw new AppError('invalid_request', 'type de destination inconnu');
    }
  }

  private pendingPayment(spaceId: string, paymentId: string): Payment {
    const payment = this.payments.get(paymentId);
    if (!payment || payment.spaceId !== spaceId) throw new AppError('not_found', 'paiement introuvable');
    if (payment.status !== 'pending_approval') throw new AppError('invalid_state', `paiement déjà ${payment.status}`);
    return payment;
  }

  private person(personId: string): Person {
    const person = this.deps.persons.find((candidate) => candidate.id === personId);
    if (!person) throw new AppError('unauthenticated', 'personne inconnue');
    return person;
  }

  private access(personId: string, spaceId: string): { space: Space; role: Role } {
    this.person(personId);
    const membership = this.deps.memberships.find((candidate) => candidate.personId === personId && candidate.spaceId === spaceId);
    const space = this.deps.spaces.find((candidate) => candidate.id === spaceId);
    // Même réponse qu'il n'existe pas ou qu'on n'en soit pas membre : on ne révèle pas l'existence d'un espace.
    if (!membership || !space) throw new AppError('not_a_member', 'espace inaccessible');
    return { space, role: membership.role };
  }

  private authorize(personId: string, spaceId: string, permission: Permission): { space: Space; role: Role } {
    const access = this.access(personId, spaceId);
    if (!can(access.role, permission)) throw new AppError('forbidden', `votre rôle ne permet pas : ${permission}`);
    return access;
  }

  private accountsOf(spaceId: string): LinkedAccount[] {
    return this.deps.accounts.filter((account) => account.spaceId === spaceId);
  }

  private account(spaceId: string, accountId: string): LinkedAccount {
    const account = this.deps.accounts.find((candidate) => candidate.id === accountId && candidate.spaceId === spaceId);
    if (!account) throw new AppError('not_found', 'compte introuvable dans cet espace');
    return account;
  }
}

function defaultLabel(destination: PaymentDestination): string {
  switch (destination.type) {
    case 'own_account': return 'Virement entre mes comptes';
    case 'mobile_money': return 'Envoi Mobile Money';
    case 'biller': return `Facture ${BILLERS.find((biller) => biller.id === destination.billerId)?.name ?? ''}`.trim();
  }
}

export interface DemoOptions {
  now?: () => Date;
  aggregationTimeoutMs?: number;
}

/** Monte une instance complète sur données fictives : réseau simulé, un connecteur simulé par fournisseur. */
export function createDemoApp(options: DemoOptions = {}): { app: AppGn; network: SimulatedNetwork } {
  const now = options.now ?? (() => new Date());
  const network = new SimulatedNetwork();
  const data = seedDemo(network, now());
  const connectors = new Map<string, AccountConnector>(
    PROVIDERS.map((provider) => [provider.id, new SimulatedConnector(provider.id, network)]),
  );
  const app = new AppGn({
    ...data,
    connectors,
    orchestrator: new SimulatedOrchestrator(network, now),
    fx: DEMO_FX,
    now,
    aggregationTimeoutMs: options.aggregationTimeoutMs,
  });
  return { app, network };
}
