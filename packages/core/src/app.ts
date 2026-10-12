import { Aggregator, type ConsolidatedView } from './aggregation.ts';
import {
  CARD_ISSUE_PRICE_GNF,
  exchangeFeeBps,
  feeFor,
  MAX_CARDS_PER_TIER,
  QUOTE_TTL_SECONDS,
  SimulatedCardIssuer,
  type CardIssuer,
  type CardNetwork,
  type CardTier,
  type Exchange,
  type ExchangeQuote,
  type VirtualCard,
} from './cards.ts';
import { spaceOpensOn, type Actor } from './channels.ts';
import { SimulatedConnector, SimulatedNetwork, type AccountConnector } from './connectors.ts';
import { documentView, seedDocuments, type DocumentVerification, type DocumentView, type VaultDocument } from './documents.ts';
import { AppError } from './errors.ts';
import type { AccountTransaction, LinkedAccount, Membership, Person, Role, Space } from './model.ts';
import { convert, isCurrency, money, parseMajor, toBigInt, type Currency, type FxTable } from './money.ts';
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
  /** L'espace s'ouvre-t-il sur l'appareil utilisé ? (entreprise et administration : tablette ou ordinateur) */
  opensOnChannel: boolean;
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

export interface ExchangeInput {
  sourceAccountId: string;
  targetAccountId: string;
  /** Montant débité, frais compris, en unités majeures de la devise source. */
  amount: string;
}

export interface CardView extends VirtualCard {
  label: string;
  balance?: string;
  currency: Currency;
}

interface IdempotencyRecord {
  fingerprint: string;
  resultId: string;
}

export interface AppGnDependencies {
  persons: Person[];
  spaces: Space[];
  memberships: Membership[];
  accounts: LinkedAccount[];
  documents: VaultDocument[];
  cards: VirtualCard[];
  connectors: ReadonlyMap<string, AccountConnector>;
  orchestrator: PaymentOrchestrator;
  cardIssuer: CardIssuer;
  fx: FxTable;
  now?: () => Date;
  aggregationTimeoutMs?: number;
}

/**
 * Couche application d'App GN : chaque cas d'usage vérifie d'abord que la personne est membre de l'espace,
 * que l'espace s'ouvre sur son appareil, et que son rôle y porte la permission demandée. L'API HTTP et
 * l'application web (mode démo) l'appellent telle quelle ; aucune règle d'accès ne vit dans les couches au-dessus.
 */
export class AppGn {
  private readonly deps: AppGnDependencies;
  private readonly aggregator: Aggregator;
  private readonly payments = new Map<string, Payment>();
  private readonly quotes = new Map<string, ExchangeQuote>();
  private readonly exchanges = new Map<string, Exchange>();
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

  me(actor: Actor): MeView {
    const person = this.person(actor.personId);
    const spaces = this.deps.memberships
      .filter((membership) => membership.personId === actor.personId)
      .map((membership) => {
        const space = this.deps.spaces.find((candidate) => candidate.id === membership.spaceId);
        if (!space) throw new Error(`espace ${membership.spaceId} introuvable`);
        return {
          space,
          role: membership.role,
          roleLabel: ROLE_LABELS[membership.role],
          permissions: permissionsOf(membership.role),
          opensOnChannel: spaceOpensOn(space.kind, actor.channel),
        };
      });
    return { person, spaces };
  }

  async overview(actor: Actor, spaceId: string): Promise<ConsolidatedView> {
    this.authorize(actor, spaceId, 'accounts:read');
    return this.aggregator.consolidate(spaceId, this.accountsOf(spaceId));
  }

  async transactions(actor: Actor, spaceId: string, accountId: string, limit = 20): Promise<AccountTransaction[]> {
    this.authorize(actor, spaceId, 'accounts:read');
    const account = this.account(spaceId, accountId);
    const connector = this.deps.connectors.get(account.providerId);
    if (!connector) throw new AppError('not_found', 'aucun connecteur pour ce compte');
    try {
      return await connector.fetchTransactions(account, Math.min(Math.max(limit, 1), 100));
    } catch {
      return [];
    }
  }

  services(actor: Actor, spaceId: string): ServiceDefinition[] {
    const { space, role } = this.access(actor, spaceId);
    return servicesFor(space.kind, role);
  }

  // ── Documents ──────────────────────────────────────────────────────────────

  documents(actor: Actor, spaceId: string): DocumentView[] {
    this.authorize(actor, spaceId, 'documents:read');
    const now = this.now();
    return this.deps.documents
      .filter((document) => document.spaceId === spaceId)
      .map((document) => documentView(document, now))
      .sort((a, b) => rankValidity(a) - rankValidity(b) || a.title.localeCompare(b.title, 'fr'));
  }

  /**
   * Vérification publique d'un document par son code (contrôle routier, guichet) : ne rend que le titre,
   * l'émetteur, le porteur et la validité. Un document déclaratif n'a pas de code et ne se vérifie pas.
   */
  verifyDocument(code: string): DocumentVerification {
    const normalized = code.trim().toUpperCase();
    const document = this.deps.documents.find((candidate) => candidate.verificationCode === normalized);
    if (!document) throw new AppError('not_found', 'code inconnu');
    const view = documentView(document, this.now());
    return { title: view.title, issuer: view.issuer, holderName: view.holderName, validity: view.validity, expiresAt: view.expiresAt };
  }

  // ── Paiements ──────────────────────────────────────────────────────────────

  listPayments(actor: Actor, spaceId: string): Payment[] {
    this.authorize(actor, spaceId, 'accounts:read');
    return [...this.payments.values()]
      .filter((payment) => payment.spaceId === spaceId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  async initiatePayment(actor: Actor, spaceId: string, input: PaymentInput, idempotencyKey: string): Promise<Payment> {
    const { space, role } = this.authorize(actor, spaceId, 'payments:initiate');
    const replay = this.replay(actor, spaceId, 'payment', idempotencyKey, [input.sourceAccountId, input.amount, input.destination, input.label ?? null]);
    if (replay) return this.payments.get(replay)!;

    const source = this.account(spaceId, input.sourceAccountId);
    const provider = providerById(source.providerId);
    if (!provider?.canDebit) throw new AppError('invalid_request', 'ce compte ne peut pas être débité depuis App GN');
    this.assertCardUsable(source);
    if (!isCurrency(source.currency)) throw new AppError('invalid_request', 'devise inconnue');
    const amount = typeof input.amount === 'string' ? parseMajor(input.amount, source.currency) : null;
    if (!amount || BigInt(amount.amount) <= 0n) throw new AppError('invalid_request', `montant invalide pour ${source.currency}`);
    this.validateDestination(spaceId, source, input.destination);

    const timestamp = this.now().toISOString();
    const payment: Payment = {
      id: this.nextId('pay'),
      spaceId,
      sourceAccountId: source.id,
      amount,
      destination: input.destination,
      label: input.label?.trim() || defaultLabel(input.destination),
      status: 'pending_approval',
      approval: approvalRequirement(space.kind, role, amount),
      initiatedBy: actor.personId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.payments.set(payment.id, payment);
    this.remember(actor, spaceId, 'payment', idempotencyKey, [input.sourceAccountId, input.amount, input.destination, input.label ?? null], payment.id);

    if (payment.approval === 'none') await this.submit(payment);
    return payment;
  }

  async approvePayment(actor: Actor, spaceId: string, paymentId: string): Promise<Payment> {
    this.authorize(actor, spaceId, 'payments:approve');
    const payment = this.pendingPayment(spaceId, paymentId);
    if (payment.initiatedBy === actor.personId) {
      throw new AppError('separation_of_duties', 'l’initiateur d’un paiement ne peut pas l’approuver');
    }
    payment.decidedBy = actor.personId;
    await this.submit(payment);
    return payment;
  }

  rejectPayment(actor: Actor, spaceId: string, paymentId: string): Payment {
    this.authorize(actor, spaceId, 'payments:approve');
    const payment = this.pendingPayment(spaceId, paymentId);
    payment.decidedBy = actor.personId;
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

  // ── Cartes virtuelles et conversions ───────────────────────────────────────

  cards(actor: Actor, spaceId: string): CardView[] {
    this.authorize(actor, spaceId, 'accounts:read');
    return this.deps.cards
      .filter((card) => card.spaceId === spaceId)
      .map((card) => {
        const account = this.account(spaceId, card.accountId);
        return { ...card, label: account.label, currency: account.currency };
      });
  }

  async issueCard(actor: Actor, spaceId: string, request: { network: CardNetwork; tier: CardTier; currency?: Currency }, idempotencyKey: string): Promise<CardView> {
    this.authorize(actor, spaceId, 'cards:manage');
    const replay = this.replay(actor, spaceId, 'card', idempotencyKey, [request.network, request.tier, request.currency ?? 'USD']);
    if (replay) return this.cards(actor, spaceId).find((card) => card.accountId === replay)!;
    if (!['visa', 'mastercard'].includes(request.network)) throw new AppError('invalid_request', 'réseau de carte inconnu');
    if (!['standard', 'gold'].includes(request.tier)) throw new AppError('invalid_request', 'type de carte inconnu');
    const currency = request.currency ?? 'USD';
    if (currency !== 'USD' && currency !== 'GNF') throw new AppError('invalid_request', 'une carte est en USD ou en GNF');
    const sameTier = this.deps.cards.filter((card) => card.spaceId === spaceId && card.tier === request.tier).length;
    if (sameTier >= MAX_CARDS_PER_TIER) throw new AppError('invalid_state', `au plus ${MAX_CARDS_PER_TIER} cartes de ce type`);
    this.sequence += 1;
    const { account, card } = await this.deps.cardIssuer.issue({
      spaceId,
      network: request.network,
      tier: request.tier,
      holderName: this.person(actor.personId).fullName,
      currency,
      sequence: this.sequence,
    });
    this.deps.accounts.push(account);
    this.deps.cards.push(card);
    this.remember(actor, spaceId, 'card', idempotencyKey, [request.network, request.tier, request.currency ?? 'USD'], account.id);
    return { ...card, label: account.label, currency };
  }

  async setCardFrozen(actor: Actor, spaceId: string, accountId: string, frozen: boolean): Promise<CardView> {
    this.authorize(actor, spaceId, 'cards:manage');
    const card = this.deps.cards.find((candidate) => candidate.accountId === accountId && candidate.spaceId === spaceId);
    if (!card) throw new AppError('not_found', 'carte introuvable');
    await this.deps.cardIssuer.setFrozen(card, frozen);
    card.status = frozen ? 'frozen' : 'active';
    return this.cards(actor, spaceId).find((candidate) => candidate.accountId === accountId)!;
  }

  /** Devis d'une conversion entre deux comptes de l'espace citoyen : montant, frais et cours affichés avant d'accepter. */
  quoteExchange(actor: Actor, spaceId: string, input: ExchangeInput): ExchangeQuote {
    const { space } = this.authorize(actor, spaceId, 'payments:initiate');
    if (space.kind !== 'citizen') throw new AppError('invalid_request', 'la conversion est réservée à l’espace citoyen pour l’instant');
    const source = this.account(spaceId, input.sourceAccountId);
    const target = this.account(spaceId, input.targetAccountId);
    if (source.id === target.id) throw new AppError('invalid_request', 'choisissez deux comptes différents');
    this.assertCardUsable(source);
    const sourceKind = providerById(source.providerId)?.kind ?? 'bank';
    const targetKind = providerById(target.providerId)?.kind ?? 'bank';
    if (targetKind === 'crypto') throw new AppError('invalid_request', 'l’achat de crypto n’est pas ouvert');
    const debit = typeof input.amount === 'string' ? parseMajor(input.amount, source.currency) : null;
    if (!debit || toBigInt(debit) <= 0n) throw new AppError('invalid_request', `montant invalide pour ${source.currency}`);
    const card = this.deps.cards.find((candidate) => candidate.accountId === target.id);
    const feeBps = exchangeFeeBps(sourceKind, targetKind, card?.tier);
    const fee = money(feeFor(debit, feeBps), source.currency);
    const credit = convert(money(toBigInt(debit) - toBigInt(fee), source.currency), target.currency, this.deps.fx);
    if (!credit || toBigInt(credit) <= 0n) throw new AppError('invalid_request', 'montant trop faible après frais et conversion');
    const rates = [...new Set([source.currency, target.currency])]
      .filter((currency) => currency !== 'GNF')
      .map((currency) => ({ currency, gnfPerUnit: String(this.deps.fx[currency] ?? '') }));
    const quote: ExchangeQuote = {
      id: this.nextId('qte'),
      spaceId,
      personId: actor.personId,
      sourceAccountId: source.id,
      targetAccountId: target.id,
      debit,
      fee,
      feeBps,
      credit,
      rates,
      expiresAt: new Date(this.now().getTime() + QUOTE_TTL_SECONDS * 1000).toISOString(),
    };
    this.quotes.set(quote.id, quote);
    return quote;
  }

  async executeExchange(actor: Actor, spaceId: string, quoteId: string, idempotencyKey: string): Promise<Exchange> {
    this.authorize(actor, spaceId, 'payments:initiate');
    const replay = this.replay(actor, spaceId, 'exchange', idempotencyKey, [quoteId]);
    if (replay) return this.exchanges.get(replay)!;
    const quote = this.quotes.get(quoteId);
    if (!quote || quote.spaceId !== spaceId || quote.personId !== actor.personId) throw new AppError('not_found', 'devis introuvable');
    if (Date.parse(quote.expiresAt) <= this.now().getTime()) throw new AppError('invalid_state', 'devis expiré : demandez-en un nouveau');
    const source = this.account(spaceId, quote.sourceAccountId);
    const target = this.account(spaceId, quote.targetAccountId);
    this.assertCardUsable(source);
    this.quotes.delete(quoteId);
    const exchange: Exchange = {
      id: this.nextId('xch'),
      quoteId,
      spaceId,
      sourceAccountId: source.id,
      targetAccountId: target.id,
      debit: quote.debit,
      fee: quote.fee,
      credit: quote.credit,
      status: 'failed',
      createdAt: this.now().toISOString(),
    };
    const outcome = await this.deps.orchestrator.convert({
      exchangeId: exchange.id,
      source,
      target,
      debit: quote.debit,
      credit: quote.credit,
      label: `Conversion ${source.currency} → ${target.currency}`,
    });
    exchange.status = outcome.status === 'failed' ? 'failed' : 'completed';
    if (outcome.status === 'failed') exchange.failureReason = outcome.reason;
    this.exchanges.set(exchange.id, exchange);
    this.remember(actor, spaceId, 'exchange', idempotencyKey, [quoteId], exchange.id);
    return exchange;
  }

  catalog() {
    return { providers: PROVIDERS, billers: BILLERS, cardIssuePriceGnf: CARD_ISSUE_PRICE_GNF, fx: Object.fromEntries(Object.entries(this.deps.fx).map(([currency, rate]) => [currency, String(rate)])) };
  }

  // ── Interne ────────────────────────────────────────────────────────────────

  private replay(actor: Actor, spaceId: string, kind: string, key: string, request: unknown): string | undefined {
    if (!key || key.length > 255) throw new AppError('invalid_request', 'Idempotency-Key requise (1 à 255 caractères)');
    const record = this.idempotency.get(`${kind}:${spaceId}:${actor.personId}:${key}`);
    if (!record) return undefined;
    if (record.fingerprint !== JSON.stringify(request)) throw new AppError('idempotency_conflict', 'cette clé d’idempotence a déjà servi pour une autre demande');
    return record.resultId;
  }

  private remember(actor: Actor, spaceId: string, kind: string, key: string, request: unknown, resultId: string): void {
    this.idempotency.set(`${kind}:${spaceId}:${actor.personId}:${key}`, { fingerprint: JSON.stringify(request), resultId });
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_${this.sequence.toString().padStart(6, '0')}`;
  }

  private assertCardUsable(account: LinkedAccount): void {
    const card = this.deps.cards.find((candidate) => candidate.accountId === account.id);
    if (card?.status === 'frozen') throw new AppError('invalid_state', 'carte bloquée : débloquez-la pour l’utiliser');
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
        if (target.currency !== source.currency) throw new AppError('invalid_request', 'entre deux devises, utilisez « Convertir »');
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

  private access(actor: Actor, spaceId: string): { space: Space; role: Role } {
    this.person(actor.personId);
    const membership = this.deps.memberships.find((candidate) => candidate.personId === actor.personId && candidate.spaceId === spaceId);
    const space = this.deps.spaces.find((candidate) => candidate.id === spaceId);
    // Même réponse qu'il n'existe pas ou qu'on n'en soit pas membre : on ne révèle pas l'existence d'un espace.
    if (!membership || !space) throw new AppError('not_a_member', 'espace inaccessible');
    if (!spaceOpensOn(space.kind, actor.channel)) {
      throw new AppError('channel_not_allowed', 'cet espace s’ouvre sur tablette ou ordinateur');
    }
    return { space, role: membership.role };
  }

  private authorize(actor: Actor, spaceId: string, permission: Permission): { space: Space; role: Role } {
    const access = this.access(actor, spaceId);
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

function rankValidity(document: DocumentView): number {
  return { expired: 0, expiring: 1, valid: 2, no_expiry: 3 }[document.validity];
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
    documents: seedDocuments(now()),
    connectors,
    orchestrator: new SimulatedOrchestrator(network, now),
    cardIssuer: new SimulatedCardIssuer(network, now),
    fx: DEMO_FX,
    now,
    aggregationTimeoutMs: options.aggregationTimeoutMs,
  });
  return { app, network };
}
