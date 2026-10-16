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
import { DemoConfirmer, maskPhone, needsStrongConfirmation, type Confirmer } from './confirmation.ts';
import { MemoryDirectoryStore, normalizeGuineaMobile, normalizeNin, type Directory, type DirectoryStore } from './directory.ts';
import { AppError } from './errors.ts';
import type { AccountTransaction, AdministrationSpace, BusinessSpace, CitizenSpace, LinkedAccount, Membership, Person, Role, Space } from './model.ts';
import { convert, formatMoney, isCurrency, money, parseMajor, toBigInt, type Currency, type FxTable, type Money } from './money.ts';
import {
  approvalRequirement,
  BILLERS,
  SimulatedOrchestrator,
  type OrchestratorOutcome,
  type Payment,
  type PaymentDestination,
  type PaymentOrchestrator,
  type PaymentStatus,
} from './payments.ts';
import { PROVIDERS, providerById } from './providers.ts';
import { can, permissionsOf, ROLE_LABELS, ROLE_SPACE_KIND, type Permission } from './rbac.ts';
import { DEMO_FX, seedDemo } from './seed.ts';
import { MemoryAppStore, type AppStore } from './store.ts';
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
  /** Avec une session liée à un espace : celui-là seul. */
  spaces: SpaceAccess[];
  /** Les autres espaces de la personne, pour en changer : nom et nature seulement, aucun montant ni droit. */
  otherSpaces: SpaceEntry[];
}

export interface SpaceEntry {
  id: string;
  kind: Space['kind'];
  name: string;
  opensOnChannel: boolean;
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
  /** Paiements, idempotence, conversions, cartes émises. En mémoire par défaut. */
  store?: AppStore;
  /**
   * Le référentiel de référence (personnes, espaces, rattachements, comptes, documents). Les listes ci-dessus en
   * sont la copie de travail. Par défaut, un magasin en mémoire tiré de ces listes.
   */
  directory?: DirectoryStore;
  /** Envoi et vérification des codes de confirmation forte. Par défaut : code montré (démonstration). */
  confirmer?: Confirmer;
  /** Rouvre chez son fournisseur le compte d'une carte que cette instance découvre (émise ailleurs ou avant le démarrage). */
  openCardAccount?: (account: LinkedAccount) => void;
}

export interface RegistrationInput {
  nin: string;
  fullName: string;
  phone: string;
}

export interface MemberView {
  personId: string;
  fullName: string;
  role: Role;
  roleLabel: string;
}

/** Délai minimal entre deux relectures du référentiel déclenchées par une absence (NIN inconnu, espace inconnu). */
const REFRESH_ON_MISS_MS = 1000;

/**
 * Couche application d'App GN : chaque cas d'usage vérifie d'abord que la personne est membre de l'espace,
 * que l'espace s'ouvre sur son appareil, et que son rôle y porte la permission demandée. L'API HTTP et
 * l'application web (mode démo) l'appellent telle quelle ; aucune règle d'accès ne vit dans les couches au-dessus.
 */
export class AppGn {
  private readonly deps: AppGnDependencies;
  private readonly aggregator: Aggregator;
  private readonly store: AppStore;
  /** Cartes de la copie de travail déjà enregistrées dans le magasin. */
  private readonly storedCards = new Set<string>();
  private readonly now: () => Date;
  private readonly directory: DirectoryStore;
  private confirmer: Confirmer;
  private lastRefresh = 0;

  constructor(deps: AppGnDependencies) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.store = deps.store ?? new MemoryAppStore();
    this.directory = deps.directory ?? new MemoryDirectoryStore(deps);
    this.confirmer = deps.confirmer ?? new DemoConfirmer();
    this.aggregator = new Aggregator({
      connectors: deps.connectors,
      fx: deps.fx,
      timeoutMs: deps.aggregationTimeoutMs ?? 3000,
      now: this.now,
    });
  }

  /**
   * Reprend l'état gardé par le magasin (cartes émises, cartes bloquées) au démarrage. Ensuite, chaque demande qui
   * touche une carte relit celles de son espace : une autre instance a pu en émettre, en bloquer ou en débloquer.
   * Rend les comptes de carte recréés (déjà passés à `openCardAccount`).
   */
  async load(): Promise<LinkedAccount[]> {
    const restored: LinkedAccount[] = [];
    for (const { card, account } of await this.store.issuedCards()) {
      const opened = this.adoptCard(card, account);
      if (opened) restored.push(opened);
    }
    return restored;
  }

  listPersons(): Person[] {
    return this.deps.persons;
  }

  /**
   * Relit le référentiel et remplace la copie de travail (sur place : les bureaux GAPP gardent la même référence).
   * Côté serveur, appelé au démarrage, à intervalle régulier, et quand une recherche ne trouve pas (une autre
   * instance a pu inscrire la personne ou créer le rattachement).
   */
  async refresh(): Promise<void> {
    const fresh = await this.directory.load();
    this.lastRefresh = Date.now();
    const cardAccounts = this.deps.accounts.filter((account) => this.deps.cards.some((card) => card.accountId === account.id));
    replace(this.deps.persons, fresh.persons);
    replace(this.deps.spaces, fresh.spaces);
    replace(this.deps.memberships, fresh.memberships);
    // Les comptes de carte émis sont gardés par le magasin des paiements (issued_cards) : on les conserve.
    replace(this.deps.accounts, [...fresh.accounts, ...cardAccounts.filter((account) => !fresh.accounts.some((candidate) => candidate.id === account.id))]);
    replace(this.deps.documents, fresh.documents);
  }

  /** Branche l'envoi réel des codes de confirmation (le serveur le fait une fois la connexion montée). */
  useConfirmer(confirmer: Confirmer): void {
    this.confirmer = confirmer;
  }

  /** Copie du référentiel de travail (pour le verser dans un magasin vide). */
  snapshot(): Directory {
    const { persons, spaces, memberships, accounts, documents } = this.deps;
    return structuredClone({ persons, spaces, memberships, accounts: accounts.filter((account) => !this.deps.cards.some((card) => card.accountId === account.id)), documents });
  }

  /** Relit le référentiel si la dernière relecture date d'au moins une seconde. Rend vrai si elle a eu lieu. */
  private async refreshOnMiss(): Promise<boolean> {
    if (Date.now() - this.lastRefresh < REFRESH_ON_MISS_MS) return false;
    await this.refresh();
    return true;
  }

  /** Pour la connexion : la personne qui porte ce NIN (casse et espaces ignorés), ou rien. */
  personByNin(nin: string): Person | undefined {
    const wanted = normalizeNin(nin);
    return wanted ? this.deps.persons.find((person) => normalizeNin(person.nin) === wanted) : undefined;
  }

  /** Comme `personByNin`, en relisant le référentiel si la personne n'est pas dans la copie de travail. */
  async findPersonByNin(nin: string): Promise<Person | undefined> {
    return this.personByNin(nin) ?? (await this.refreshOnMiss() ? this.personByNin(nin) : undefined);
  }

  // ── Inscription et membres ─────────────────────────────────────────────────

  /** Contrôle une demande d'inscription et la rend sous sa forme gardée. Ne crée rien. */
  checkRegistration(input: Partial<RegistrationInput> | undefined): RegistrationInput {
    const nin = normalizeNin(typeof input?.nin === 'string' ? input.nin : '');
    if (!/^[A-Z0-9-]{6,30}$/.test(nin)) throw new AppError('invalid_request', 'NIN : 6 à 30 caractères, lettres, chiffres ou tirets');
    const fullName = typeof input?.fullName === 'string' ? input.fullName.trim().replace(/\s+/g, ' ') : '';
    if (fullName.length < 3 || fullName.length > 80 || !/^[\p{L}' -]+$/u.test(fullName)) throw new AppError('invalid_request', 'nom complet : 3 à 80 lettres');
    const phone = normalizeGuineaMobile(typeof input?.phone === 'string' ? input.phone : '');
    if (!phone) throw new AppError('invalid_request', 'numéro de mobile guinéen attendu (+224 6XX XX XX XX)');
    return { nin, fullName, phone };
  }

  /**
   * Inscrit une personne (numéro déjà prouvé par code SMS) avec son espace personnel. Le NIN est déclaré :
   * il sera rapproché de l'état civil quand une source le permettra. Un NIN déjà inscrit est refusé.
   */
  async register(input: RegistrationInput): Promise<{ person: Person; space: CitizenSpace }> {
    const checked = this.checkRegistration(input);
    if (await this.findPersonByNin(checked.nin)) throw new AppError('conflict', 'ce NIN a déjà un compte : connectez-vous');
    const id = randomId();
    const person: Person = { id: `per_${id}`, nin: checked.nin, fullName: checked.fullName, phone: checked.phone, identity: 'declared', registeredAt: this.now().toISOString() };
    const space: CitizenSpace = { id: `spc_cit_${id}`, kind: 'citizen', name: checked.fullName, ownerPersonId: person.id };
    if (!await this.directory.addPerson(person, space)) throw new AppError('conflict', 'ce NIN a déjà un compte : connectez-vous');
    // Une relecture concurrente a pu les ramener déjà : on n'ajoute que ce qui manque.
    if (!this.personById(person.id)) this.deps.persons.push(person);
    if (!this.deps.spaces.some((candidate) => candidate.id === space.id)) this.deps.spaces.push(space);
    if (!this.deps.memberships.some((candidate) => candidate.spaceId === space.id)) this.deps.memberships.push({ personId: person.id, spaceId: space.id, role: 'citizen' });
    return { person, space };
  }

  /**
   * Ouverture d'une organisation par l'exploitant (outil d'administration, pas l'API publique) : l'espace et son
   * premier responsable, désigné par son NIN (il doit être inscrit).
   */
  async openOrganization(space: BusinessSpace | AdministrationSpace, ownerNin: string): Promise<Space> {
    const owner = await this.findPersonByNin(ownerNin);
    if (!owner) throw new AppError('not_found', 'aucune personne inscrite avec ce NIN');
    if (!/^[a-z0-9_]{3,60}$/.test(space.id)) throw new AppError('invalid_request', 'identifiant d’espace : minuscules, chiffres, _');
    if (!await this.directory.addSpace(space)) throw new AppError('conflict', 'cet espace existe déjà');
    const membership: Membership = { personId: owner.id, spaceId: space.id, role: space.kind === 'business' ? 'business_owner' : 'admin_authorizing_officer' };
    await this.directory.setMembership(membership);
    if (!this.deps.spaces.some((candidate) => candidate.id === space.id)) this.deps.spaces.push(space);
    if (!this.deps.memberships.some((candidate) => candidate.spaceId === space.id && candidate.personId === owner.id)) this.deps.memberships.push(membership);
    return space;
  }

  /** Rattachement fait par l'exploitant (administration publique : l'ordonnateur, le comptable, le contrôle). */
  async assignMember(spaceId: string, nin: string, role: Role): Promise<Membership> {
    const space = this.deps.spaces.find((candidate) => candidate.id === spaceId) ?? (await this.refreshOnMiss() ? this.deps.spaces.find((candidate) => candidate.id === spaceId) : undefined);
    if (!space || space.kind === 'citizen') throw new AppError('not_found', 'organisation introuvable');
    const person = await this.findPersonByNin(nin);
    if (!person) throw new AppError('not_found', 'aucune personne inscrite avec ce NIN');
    return this.writeMembership(space, person, role);
  }

  members(actor: Actor, spaceId: string): MemberView[] {
    this.authorize(actor, spaceId, 'members:manage');
    return this.deps.memberships
      .filter((membership) => membership.spaceId === spaceId)
      .map((membership) => ({ personId: membership.personId, fullName: this.personById(membership.personId)?.fullName ?? '—', role: membership.role, roleLabel: ROLE_LABELS[membership.role] }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName, 'fr'));
  }

  /** Ajoute une personne inscrite à l'organisation, ou change son rôle. Le responsable ne change pas le sien. */
  async addMember(actor: Actor, spaceId: string, input: { nin?: unknown; role?: unknown } | undefined): Promise<MemberView> {
    const { space } = this.authorize(actor, spaceId, 'members:manage');
    const role = input?.role;
    if (typeof role !== 'string' || !(role in ROLE_SPACE_KIND) || ROLE_SPACE_KIND[role as Role] !== space.kind) {
      throw new AppError('invalid_request', 'rôle inconnu pour ce type d’espace');
    }
    const person = typeof input?.nin === 'string' ? await this.findPersonByNin(input.nin) : undefined;
    // La personne doit d'abord s'inscrire elle-même : son numéro est ainsi prouvé.
    if (!person) throw new AppError('not_found', 'aucune personne inscrite avec ce NIN : elle doit d’abord s’inscrire sur App GN');
    if (person.id === actor.personId) throw new AppError('invalid_request', 'vous ne pouvez pas changer votre propre rôle');
    const membership = await this.writeMembership(space, person, role as Role);
    return { personId: person.id, fullName: person.fullName, role: membership.role, roleLabel: ROLE_LABELS[membership.role] };
  }

  async removeMember(actor: Actor, spaceId: string, personId: string): Promise<void> {
    this.authorize(actor, spaceId, 'members:manage');
    if (personId === actor.personId) throw new AppError('invalid_request', 'vous ne pouvez pas vous retirer vous-même');
    const membership = this.deps.memberships.find((candidate) => candidate.spaceId === spaceId && candidate.personId === personId);
    if (!membership) throw new AppError('not_found', 'cette personne n’est pas membre');
    await this.directory.removeMembership(personId, spaceId);
    this.deps.memberships.splice(this.deps.memberships.indexOf(membership), 1);
  }

  private async writeMembership(space: Space, person: Person, role: Role): Promise<Membership> {
    if (ROLE_SPACE_KIND[role] !== space.kind || space.kind === 'citizen') throw new AppError('invalid_request', 'rôle inconnu pour ce type d’espace');
    const membership: Membership = { personId: person.id, spaceId: space.id, role };
    await this.directory.setMembership(membership);
    const index = this.deps.memberships.findIndex((candidate) => candidate.personId === person.id && candidate.spaceId === space.id);
    if (index >= 0) this.deps.memberships[index] = membership;
    else this.deps.memberships.push(membership);
    return membership;
  }

  me(actor: Actor): MeView {
    const person = this.person(actor.personId);
    const memberships = this.deps.memberships.filter((membership) => membership.personId === actor.personId);
    if (actor.spaceId && !memberships.some((membership) => membership.spaceId === actor.spaceId)) {
      throw new AppError('not_a_member', 'espace inaccessible');
    }
    const otherSpaces = this.entrances(actor.personId, actor.channel).filter((entry) => actor.spaceId && entry.id !== actor.spaceId);
    const spaces = memberships
      .filter((membership) => !actor.spaceId || membership.spaceId === actor.spaceId)
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
    return { person, spaces, otherSpaces };
  }

  /** Les espaces où la personne peut ouvrir une session : son espace personnel d'abord, puis ses organisations. */
  entrances(personId: string, channel: Actor['channel']): SpaceEntry[] {
    return this.deps.memberships
      .filter((membership) => membership.personId === personId)
      .map((membership) => this.deps.spaces.find((space) => space.id === membership.spaceId))
      .filter((space): space is Space => Boolean(space))
      .sort((a, b) => Number(a.kind !== 'citizen') - Number(b.kind !== 'citizen'))
      .map((space) => ({ id: space.id, kind: space.kind, name: space.name, opensOnChannel: spaceOpensOn(space.kind, channel) }));
  }

  async overview(actor: Actor, spaceId: string): Promise<ConsolidatedView> {
    const { space } = this.authorize(actor, spaceId, 'accounts:read');
    await this.syncCards(space);
    return this.aggregator.consolidate(spaceId, this.accountsOf(spaceId));
  }

  async transactions(actor: Actor, spaceId: string, accountId: string, limit = 20): Promise<AccountTransaction[]> {
    const { space } = this.authorize(actor, spaceId, 'accounts:read');
    await this.syncCards(space);
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

  async listPayments(actor: Actor, spaceId: string): Promise<Payment[]> {
    this.authorize(actor, spaceId, 'accounts:read');
    return this.store.paymentsOfSpace(spaceId);
  }

  /**
   * `origin: 'desk'` : appel d'un bureau GAPP. En administration, une dépense ne part que par la chaîne
   * engagement → liquidation → mandat → visa ; un paiement direct y est refusé.
   */
  async initiatePayment(actor: Actor, spaceId: string, input: PaymentInput, idempotencyKey: string, origin?: 'desk'): Promise<Payment> {
    const { space, role } = this.authorize(actor, spaceId, 'payments:initiate');
    this.assertPublicChain(space, origin);
    // Une carte bloquée sur une autre instance refuse le débit ici aussi.
    await this.syncCards(space);
    const id = this.nextId('pay');
    const claim = this.scope(actor, spaceId, 'payment', idempotencyKey);
    const replay = await this.claim(claim, [input.sourceAccountId, input.amount, input.destination, input.label ?? null], id);
    if (replay) return this.replayed(await this.store.payment(replay));

    let source: LinkedAccount;
    let amount: ReturnType<typeof parseMajor>;
    try {
      source = this.account(spaceId, input.sourceAccountId);
      const provider = providerById(source.providerId);
      if (!provider?.canDebit) throw new AppError('invalid_request', 'ce compte ne peut pas être débité depuis App GN');
      this.assertCardUsable(source);
      if (!isCurrency(source.currency)) throw new AppError('invalid_request', 'devise inconnue');
      amount = typeof input.amount === 'string' ? parseMajor(input.amount, source.currency) : null;
      if (!amount || BigInt(amount.amount) <= 0n) throw new AppError('invalid_request', `montant invalide pour ${source.currency}`);
      this.validateDestination(spaceId, source, input.destination);
      // Le dirigeant qui paie lui-même au-delà du seuil confirme par code. Un paiement né d'un lot ou d'une
      // déclaration (`desk`) a été confirmé à ce niveau-là.
      if (origin !== 'desk' && approvalRequirement(space.kind, role, amount) === 'none') {
        await this.confirmStrongly(actor, space, amount, `payment.initiate|${idempotencyKey}|${fingerprintOf(input)}`, `le paiement de ${formatMoney(amount)} (${input.label?.trim() || defaultLabel(input.destination)})`);
      }
    } catch (error) {
      // Une demande refusée ne garde pas sa clé : corrigée, elle peut repartir sous la même.
      await this.store.releaseIdempotency(claim);
      throw error;
    }

    const timestamp = this.now().toISOString();
    const payment: Payment = {
      id,
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
    await this.store.insertPayment(payment);
    if (payment.approval === 'none') return this.submit(payment);
    return payment;
  }

  async approvePayment(actor: Actor, spaceId: string, paymentId: string, origin?: 'desk'): Promise<Payment> {
    const { space } = this.authorize(actor, spaceId, 'payments:approve');
    this.assertPublicChain(space, origin);
    const payment = await this.pendingPayment(spaceId, paymentId);
    if (payment.initiatedBy === actor.personId) {
      throw new AppError('separation_of_duties', 'l’initiateur d’un paiement ne peut pas l’approuver');
    }
    if (origin !== 'desk') await this.confirmStrongly(actor, space, payment.amount, `payment.approve|${payment.id}`, `l’approbation du paiement de ${formatMoney(payment.amount)} (${payment.label})`);
    payment.decidedBy = actor.personId;
    return this.submit(payment);
  }

  async rejectPayment(actor: Actor, spaceId: string, paymentId: string, reason?: string, origin?: 'desk'): Promise<Payment> {
    const { space } = this.authorize(actor, spaceId, 'payments:approve');
    this.assertPublicChain(space, origin);
    const payment = await this.pendingPayment(spaceId, paymentId);
    payment.decidedBy = actor.personId;
    payment.status = 'rejected';
    if (reason?.trim()) payment.rejectionReason = reason.trim().slice(0, 500);
    payment.updatedAt = this.now().toISOString();
    if (!await this.store.updatePayment(payment, 'pending_approval')) throw new AppError('invalid_state', 'paiement déjà décidé');
    return payment;
  }

  /**
   * Point d'entrée de l'issue asynchrone (webhook de l'orchestrateur réel), retrouvée par la référence de
   * l'orchestrateur ou, à défaut, par l'identifiant du paiement (sa référence externe chez l'orchestrateur).
   * Seul un paiement en cours change : un événement rejoué ou tardif est sans effet.
   */
  async recordOutcome(reference: string, outcome: OrchestratorOutcome, paymentId?: string): Promise<Payment | undefined> {
    const payment = await this.store.paymentByReference(reference) ?? (paymentId ? await this.store.payment(paymentId) : undefined);
    if (!payment || payment.status !== 'processing') return payment;
    this.applyOutcome(payment, outcome);
    if (!await this.store.updatePayment(payment, 'processing')) return this.store.payment(payment.id);
    return payment;
  }

  // ── Cartes virtuelles et conversions ───────────────────────────────────────

  async cards(actor: Actor, spaceId: string): Promise<CardView[]> {
    const { space } = this.authorize(actor, spaceId, 'accounts:read');
    await this.syncCards(space);
    return this.cardViews(spaceId);
  }

  async issueCard(actor: Actor, spaceId: string, request: { network: CardNetwork; tier: CardTier; currency?: Currency }, idempotencyKey: string): Promise<CardView> {
    const { space } = this.authorize(actor, spaceId, 'cards:manage');
    const accountId = this.nextId('acc_card');
    const claim = this.scope(actor, spaceId, 'card', idempotencyKey);
    const replay = await this.claim(claim, [request.network, request.tier, request.currency ?? 'USD'], accountId);
    if (replay) return this.replayed((await this.cards(actor, spaceId)).find((card) => card.accountId === replay));
    const currency = request.currency ?? 'USD';
    let issued: { account: LinkedAccount; card: VirtualCard };
    try {
      if (!['visa', 'mastercard'].includes(request.network)) throw new AppError('invalid_request', 'réseau de carte inconnu');
      if (!['standard', 'gold'].includes(request.tier)) throw new AppError('invalid_request', 'type de carte inconnu');
      if (currency !== 'USD' && currency !== 'GNF') throw new AppError('invalid_request', 'une carte est en USD ou en GNF');
      await this.syncCards(space);
      await this.storeSeedCards(spaceId);
      const sameTier = this.deps.cards.filter((card) => card.spaceId === spaceId && card.tier === request.tier).length;
      if (sameTier >= MAX_CARDS_PER_TIER) throw new AppError('invalid_state', `au plus ${MAX_CARDS_PER_TIER} cartes de ce type`);
      issued = await this.deps.cardIssuer.issue({
        accountId,
        spaceId,
        network: request.network,
        tier: request.tier,
        holderName: this.person(actor.personId).fullName,
        currency,
      });
      // Le plafond tient dans le magasin : une émission simultanée sur une autre instance a pu prendre la dernière place.
      // La carte déjà émise chez l'émetteur est alors bloquée, et jamais montrée.
      if (!await this.store.insertCard(issued.card, issued.account, MAX_CARDS_PER_TIER)) {
        await this.deps.cardIssuer.setFrozen(issued.card, true).catch(() => undefined);
        throw new AppError('invalid_state', `au plus ${MAX_CARDS_PER_TIER} cartes de ce type`);
      }
    } catch (error) {
      await this.store.releaseIdempotency(claim);
      throw error;
    }
    const { account, card } = issued;
    // Le compte est déjà ouvert chez l'émetteur : pas besoin de le rouvrir.
    this.adoptCard(card, account, false);
    return { ...card, label: account.label, currency };
  }

  async setCardFrozen(actor: Actor, spaceId: string, accountId: string, frozen: boolean): Promise<CardView> {
    const { space } = this.authorize(actor, spaceId, 'cards:manage');
    await this.syncCards(space);
    const card = this.deps.cards.find((candidate) => candidate.accountId === accountId && candidate.spaceId === spaceId);
    if (!card) throw new AppError('not_found', 'carte introuvable');
    await this.storeSeedCards(spaceId);
    await this.deps.cardIssuer.setFrozen(card, frozen);
    const saved = await this.store.setCardStatus(accountId, frozen ? 'frozen' : 'active');
    if (!saved) throw new AppError('not_found', 'carte introuvable');
    this.adoptCard(saved);
    return this.cardViews(spaceId).find((candidate) => candidate.accountId === accountId)!;
  }

  /** Devis d'une conversion entre deux comptes de l'espace citoyen : montant, frais et cours affichés avant d'accepter. */
  async quoteExchange(actor: Actor, spaceId: string, input: ExchangeInput): Promise<ExchangeQuote> {
    const { space } = this.authorize(actor, spaceId, 'payments:initiate');
    if (space.kind !== 'citizen') throw new AppError('invalid_request', 'la conversion est réservée à l’espace citoyen pour l’instant');
    await this.syncCards(space);
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
    await this.store.saveQuote(quote);
    return quote;
  }

  async executeExchange(actor: Actor, spaceId: string, quoteId: string, idempotencyKey: string): Promise<Exchange> {
    const { space } = this.authorize(actor, spaceId, 'payments:initiate');
    const id = this.nextId('xch');
    const claim = this.scope(actor, spaceId, 'exchange', idempotencyKey);
    const replay = await this.claim(claim, [quoteId], id);
    if (replay) return this.replayed(await this.store.exchange(replay));
    let quote: ExchangeQuote | undefined;
    let source: LinkedAccount;
    let target: LinkedAccount;
    try {
      quote = await this.store.quote(quoteId);
      if (!quote || quote.spaceId !== spaceId || quote.personId !== actor.personId) throw new AppError('not_found', 'devis introuvable');
      if (Date.parse(quote.expiresAt) <= this.now().getTime()) throw new AppError('invalid_state', 'devis expiré : demandez-en un nouveau');
      await this.syncCards(space);
      source = this.account(spaceId, quote.sourceAccountId);
      target = this.account(spaceId, quote.targetAccountId);
      this.assertCardUsable(source);
      // Un devis ne sert qu'une fois, même accepté au même moment sur deux instances sous deux clés différentes.
      if (!await this.store.takeQuote(quoteId)) throw new AppError('not_found', 'devis introuvable');
    } catch (error) {
      await this.store.releaseIdempotency(claim);
      throw error;
    }
    const exchange: Exchange = {
      id,
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
    await this.store.saveExchange(exchange);
    return exchange;
  }

  catalog() {
    return { providers: PROVIDERS, billers: BILLERS, cardIssuePriceGnf: CARD_ISSUE_PRICE_GNF, fx: Object.fromEntries(Object.entries(this.deps.fx).map(([currency, rate]) => [currency, String(rate)])) };
  }

  // ── Pour les bureaux GAPP (entreprise, administration) ────────────────────
  // Ils passent par `guard` pour leur propre contrôle d'accès, puis lisent ou agissent par ce qui suit.

  /**
   * Contrôle d'accès d'un bureau GAPP : session liée à l'espace, membre, appareil admis, espace de la bonne
   * nature, et au moins une des permissions demandées.
   */
  guard(actor: Actor, spaceId: string, permissions: Permission | readonly Permission[], kind: Space['kind']): { space: Space; role: Role; person: Person } {
    const access = this.access(actor, spaceId);
    if (access.space.kind !== kind) throw new AppError('not_found', 'ce tableau de bord n’existe pas pour cet espace');
    const wanted = typeof permissions === 'string' ? [permissions] : permissions;
    if (!wanted.some((permission) => can(access.role, permission))) {
      throw new AppError('forbidden', `votre rôle ne permet pas : ${wanted.join(' ou ')}`);
    }
    return { ...access, person: this.person(actor.personId) };
  }

  /** Comptes rattachés à l'espace (sans solde). À n'appeler qu'après `guard`. */
  linkedAccounts(spaceId: string): LinkedAccount[] {
    return this.accountsOf(spaceId);
  }

  /** Un paiement de l'espace, tel qu'enregistré. À n'appeler qu'après `guard`. */
  async paymentOf(spaceId: string, paymentId: string): Promise<Payment | undefined> {
    const payment = await this.store.payment(paymentId);
    return payment?.spaceId === spaceId ? payment : undefined;
  }

  /**
   * Confirmation forte d'une opération d'entreprise au-delà du seuil : passe si la demande porte un code juste pour
   * cette opération ; sinon un code part au numéro de la personne et l'opération est refusée en `confirmation_required`
   * (428), avec de quoi renvoyer la même demande et le code. Sans effet sous le seuil et hors entreprise.
   */
  async confirmStrongly(actor: Actor, space: Space, amount: Money, operation: string, summary: string): Promise<void> {
    if (space.kind !== 'business' || !needsStrongConfirmation(amount)) return;
    const person = this.person(actor.personId);
    const wanted = { key: `${space.id}|${operation}`, summary };
    if (actor.confirmation && await this.confirmer.verify(person, wanted, actor.confirmation)) return;
    const challenge = await this.confirmer.challenge(person, wanted);
    const retry = actor.confirmation ? 'code incorrect ou expiré : un nouveau code a été envoyé' : 'confirmez avec le code envoyé par SMS';
    throw new AppError('confirmation_required', `${retry} au ${maskPhone(person.phone)}`, { confirmation: { ...challenge, summary } });
  }

  /** Les documents d'un espace, sans contrôle d'accès : pour un bureau qui en lit la validité après `guard`. */
  documentsOf(spaceId: string): DocumentView[] {
    const now = this.now();
    return this.deps.documents.filter((document) => document.spaceId === spaceId).map((document) => documentView(document, now));
  }

  /**
   * Remet un document émis par une organisation (attestation de travail…) dans le coffre personnel de la
   * personne qui porte ce NIN. Rien n'est rendu à l'émetteur : il n'apprend pas si la personne utilise App GN.
   */
  async depositIssuedDocument(nin: string, document: Omit<VaultDocument, 'spaceId'>): Promise<void> {
    const person = await this.findPersonByNin(nin);
    if (!person) return;
    const space = this.deps.spaces.find((candidate) => candidate.kind === 'citizen' && candidate.ownerPersonId === person.id);
    if (!space || this.deps.documents.some((candidate) => candidate.id === document.id)) return;
    const deposited: VaultDocument = { ...document, spaceId: space.id, holderName: person.fullName };
    if (await this.directory.addDocument(deposited)) this.deps.documents.push(deposited);
  }

  /** Vérifie qu'un document émis par une organisation est connu (pour le code de vérification public). */
  hasDocument(id: string): boolean {
    return this.deps.documents.some((document) => document.id === id);
  }

  /** Identifiants des espaces d'une nature (chargement des bureaux au démarrage). */
  spaceIdsOfKind(kind: Space['kind']): string[] {
    return this.deps.spaces.filter((space) => space.kind === kind).map((space) => space.id);
  }

  personById(personId: string): Person | undefined {
    return this.deps.persons.find((person) => person.id === personId);
  }

  clock(): Date {
    return this.now();
  }

  // ── Interne ────────────────────────────────────────────────────────────────

  private scope(actor: Actor, spaceId: string, kind: string, key: string): string {
    if (!key || key.length > 255) throw new AppError('invalid_request', 'Idempotency-Key requise (1 à 255 caractères)');
    return `${kind}:${spaceId}:${actor.personId}:${key}`;
  }

  /** Réserve la clé pour `resultId`, ou rend le résultat d'une demande identique déjà reçue. */
  private async claim(scope: string, request: unknown, resultId: string): Promise<string | undefined> {
    const fingerprint = JSON.stringify(request);
    const existing = await this.store.claimIdempotency(scope, { fingerprint, resultId });
    if (!existing) return undefined;
    if (existing.fingerprint !== fingerprint) throw new AppError('idempotency_conflict', 'cette clé d’idempotence a déjà servi pour une autre demande');
    return existing.resultId;
  }

  /** Une clé réservée dont le résultat n'est pas encore écrit : la demande identique est encore en cours. */
  private replayed<T>(result: T | undefined): T {
    if (!result) throw new AppError('idempotency_conflict', 'une demande identique est en cours : réessayez dans un instant');
    return result;
  }

  private nextId(prefix: string): string {
    // Unique d'un démarrage à l'autre : l'identifiant sert de clé d'idempotence chez l'orchestrateur réel,
    // qui rejouerait un ancien paiement si un compteur repartait de zéro.
    return `${prefix}_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
  }

  private assertPublicChain(space: Space, origin?: 'desk'): void {
    if (space.kind === 'administration' && origin !== 'desk') {
      throw new AppError('invalid_request', 'en administration, une dépense passe par l’engagement, la liquidation, le mandat et le visa du comptable');
    }
  }

  /**
   * Relit les cartes de l'espace dans le magasin : une autre instance a pu en émettre, en bloquer ou en débloquer.
   * Les cartes ne vivent que dans l'espace citoyen ; ailleurs, rien à relire.
   */
  private async syncCards(space: Space): Promise<void> {
    if (space.kind !== 'citizen') return;
    for (const { card, account } of await this.store.cardsOfSpace(space.id)) this.adoptCard(card, account);
  }

  /**
   * Remplace la carte dans la copie de travail par son état enregistré. Rend son compte s'il était inconnu ici :
   * il est alors ajouté et, sauf `open = false`, rouvert chez son fournisseur.
   */
  private adoptCard(card: VirtualCard, account?: LinkedAccount, open = true): LinkedAccount | undefined {
    this.storedCards.add(card.accountId);
    const index = this.deps.cards.findIndex((candidate) => candidate.accountId === card.accountId);
    if (index >= 0) this.deps.cards[index] = card;
    else this.deps.cards.push(card);
    if (!account || this.deps.accounts.some((candidate) => candidate.id === account.id)) return undefined;
    this.deps.accounts.push(account);
    if (open) this.deps.openCardAccount?.(account);
    return account;
  }

  /**
   * Les cartes venues du référentiel (démonstration) entrent au magasin à la première écriture dans leur espace :
   * elles comptent alors dans le plafond partagé, et leur blocage se relit d'une instance à l'autre.
   */
  private async storeSeedCards(spaceId: string): Promise<void> {
    for (const card of this.deps.cards.filter((candidate) => candidate.spaceId === spaceId && !this.storedCards.has(candidate.accountId))) {
      if (await this.store.insertCard(card, undefined, MAX_CARDS_PER_TIER)) this.storedCards.add(card.accountId);
    }
  }

  private cardViews(spaceId: string): CardView[] {
    return this.deps.cards
      .filter((card) => card.spaceId === spaceId)
      .map((card) => {
        const account = this.account(spaceId, card.accountId);
        return { ...card, label: account.label, currency: account.currency };
      });
  }

  private assertCardUsable(account: LinkedAccount): void {
    const card = this.deps.cards.find((candidate) => candidate.accountId === account.id);
    if (card?.status === 'frozen') throw new AppError('invalid_state', 'carte bloquée : débloquez-la pour l’utiliser');
  }

  /** Passe le paiement en cours (une seule fois, même sous décisions concurrentes), le remet à l'orchestrateur, garde l'issue. */
  private async submit(payment: Payment): Promise<Payment> {
    const from: PaymentStatus = payment.status;
    payment.status = 'processing';
    payment.updatedAt = this.now().toISOString();
    if (!await this.store.updatePayment(payment, from)) throw new AppError('invalid_state', 'paiement déjà décidé');
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
    // L'issue a pu arriver avant la réponse (webhook rapide) : on garde alors ce qui est enregistré.
    if (!await this.store.updatePayment(payment, 'processing')) return (await this.store.payment(payment.id))!;
    return payment;
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

  private async pendingPayment(spaceId: string, paymentId: string): Promise<Payment> {
    const payment = await this.store.payment(paymentId);
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
    // Session liée à un autre espace : même réponse qu'un espace inconnu. Les fonds personnels ne se lisent
    // pas depuis une session d'entreprise ou d'administration, ni l'inverse.
    if (actor.spaceId && actor.spaceId !== spaceId) throw new AppError('not_a_member', 'espace inaccessible');
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

/** Contenu d'une demande, sous une forme stable (clés triées) : deux demandes identiques ont la même. */
export function fingerprintOf(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    : item);
}

function replace<T>(target: T[], items: readonly T[]): void {
  target.splice(0, target.length, ...items);
}

function randomId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16);
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
  /** Remplace l'orchestrateur simulé (par ORCHEA, côté serveur), construit sur le même réseau simulé. */
  orchestrator?: (network: SimulatedNetwork, now: () => Date) => PaymentOrchestrator;
  store?: AppStore;
  /** Référentiel en base (serveur). Sans lui, le référentiel de démonstration reste en mémoire. */
  directory?: DirectoryStore;
  /** Verser le référentiel de démonstration dans un `directory` vide (oui par défaut ; jamais en production). */
  seedDirectory?: boolean;
}

/**
 * Verse un référentiel dans un magasin. Rejouable : ce qui existe déjà est laissé tel quel, ce qui peut arriver
 * quand deux instances démarrent ensemble sur une base vide.
 */
export async function seedDirectory(store: DirectoryStore, directory: Directory): Promise<void> {
  for (const person of directory.persons) {
    const space = directory.spaces.find((candidate): candidate is CitizenSpace => candidate.kind === 'citizen' && candidate.ownerPersonId === person.id);
    if (space) await store.addPerson(person, space);
  }
  for (const space of directory.spaces) if (space.kind !== 'citizen') await store.addSpace(space);
  for (const membership of directory.memberships) if (membership.role !== 'citizen') await store.setMembership(membership);
  for (const account of directory.accounts) await store.addAccount(account);
  for (const document of directory.documents) await store.addDocument(document);
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
    orchestrator: options.orchestrator?.(network, now) ?? new SimulatedOrchestrator(network, now),
    cardIssuer: new SimulatedCardIssuer(network, now),
    openCardAccount: (account) => network.open(account, []),
    fx: DEMO_FX,
    now,
    aggregationTimeoutMs: options.aggregationTimeoutMs,
    store: options.store,
    directory: options.directory,
  });
  return { app, network };
}

/** Comme `createDemoApp`, puis reprend l'état du magasin (cartes émises) et rouvre leurs comptes sur le réseau simulé. */
export async function loadDemoApp(options: DemoOptions = {}): Promise<{ app: AppGn; network: SimulatedNetwork }> {
  const demo = createDemoApp(options);
  if (options.directory) {
    const current = await options.directory.load();
    if (current.persons.length === 0 && options.seedDirectory !== false) await seedDirectory(options.directory, demo.app.snapshot());
    await demo.app.refresh();
  }
  await demo.app.load();
  return demo;
}
