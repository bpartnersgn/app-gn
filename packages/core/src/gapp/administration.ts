import type { AppGn } from '../app.ts';
import type { Actor } from '../channels.ts';
import { AppError } from '../errors.ts';
import type { AdministrationSpace, LinkedAccount, Role } from '../model.ts';
import { toBigInt, toMajor, type Money } from '../money.ts';
import type { Payment } from '../payments.ts';
import { providerById } from '../providers.ts';
import { can, type Permission } from '../rbac.ts';
import { addDays, csv, dayOf, gnf, isPeriod, normalizedNin, optionalText, parseGnf, payee, periodOf, sum, text, type MobilePayee } from './common.ts';
import { AuditTrail, claimKey, mutate, nextInChain, randomId, type AuditEntry, type ChainCheck, type DeskEntity, type DeskStore } from './desk.ts';

/**
 * GAPP Institutionnel : le tableau de bord d'une collectivité ou d'un établissement public. La logique est
 * celle de la dépense publique, avec la séparation des fonctions :
 *
 * - l'ordonnateur engage la dépense sur une ligne de crédit (refusé au-delà du disponible), certifie le service
 *   fait et liquide, puis émet le mandat de paiement ;
 * - le comptable public contrôle le mandat (crédit, service fait, montant, bénéficiaire) et le vise, ce qui
 *   le paie, ou le rejette avec un motif ;
 * - la paie des agents est contrôlée ligne à ligne (NIN, identité, doublons, wallet partagé) avant d'être
 *   mandatée et imputée sur sa ligne ;
 * - le contrôle (lecture seule) suit l'exécution, les recettes et la piste d'audit, et produit l'état
 *   transmis à la Cour des Comptes.
 */

const ADMINISTRATION = 'administration' as const;

export interface BudgetLine extends DeskEntity {
  code: string;
  label: string;
  section: 'fonctionnement' | 'investissement';
  year: number;
  allocated: Money;
  /** Total engagé, tenu sous la même version que la ligne : deux engagements simultanés ne dépassent pas le crédit. */
  engaged: Money;
  /** Ligne sur laquelle la paie des agents est imputée. */
  payroll?: boolean;
}

export interface Liquidation {
  id: string;
  amount: Money;
  invoiceReference: string;
  serviceDoneOn: string;
  certifiedBy: string;
  on: string;
  mandate?: { number: string; paymentId: string; issuedBy: string; on: string };
  /** Mandats rejetés par le comptable, gardés pour la piste. */
  rejected?: { number: string; paymentId: string; reason: string }[];
}

export interface Engagement extends DeskEntity {
  number: string;
  lineId: string;
  supplier: { name: string; nif?: string };
  payee: MobilePayee;
  object: string;
  amount: Money;
  status: 'engaged' | 'closed';
  createdBy: string;
  createdOn: string;
  liquidations: Liquidation[];
}

export type MandateState = 'to_mandate' | 'awaiting_visa' | 'paying' | 'paid' | 'rejected' | 'failed';

export interface LiquidationView extends Liquidation {
  state: MandateState;
  rejectionReason?: string;
}

export interface EngagementView extends Omit<Engagement, 'liquidations'> {
  lineCode: string;
  lineLabel: string;
  liquidated: Money;
  remaining: Money;
  liquidations: LiquidationView[];
}

export interface BudgetLineView extends BudgetLine {
  liquidated: Money;
  mandated: Money;
  paid: Money;
  available: Money;
  /** Taux d'exécution : payé sur alloué, en pour cent (une décimale). */
  executionRate: number;
}

export interface BudgetView {
  year: number;
  lines: BudgetLineView[];
  totals: Record<'fonctionnement' | 'investissement' | 'total', { allocated: Money; engaged: Money; paid: Money; available: Money }>;
}

export interface Agent extends DeskEntity {
  matricule: string;
  fullName: string;
  nin: string;
  grade: string;
  monthlyNet: Money;
  payout: MobilePayee;
  status: 'active' | 'suspended';
}

export type PayrollIssue = 'nin_invalid' | 'nin_unknown' | 'identity_mismatch' | 'duplicate_nin' | 'shared_wallet' | 'suspended';

export const PAYROLL_ISSUE_LABELS: Record<PayrollIssue, string> = {
  nin_invalid: 'NIN mal formé',
  nin_unknown: 'NIN absent du registre national',
  identity_mismatch: 'le nom ne correspond pas au NIN',
  duplicate_nin: 'NIN présent deux fois',
  shared_wallet: 'wallet partagé avec un autre agent',
  suspended: 'agent suspendu',
};

export interface PayrollCheckLine {
  agentId: string;
  matricule: string;
  fullName: string;
  amount: Money;
  issues: PayrollIssue[];
}

export interface PayrollCheck {
  period: string;
  eligible: PayrollCheckLine[];
  excluded: PayrollCheckLine[];
  total: Money;
  lineId?: string;
  available?: Money;
}

export interface AdminPayroll extends DeskEntity {
  period: string;
  number: string;
  lineId: string;
  sourceAccountId: string;
  lines: { agentId: string; matricule: string; fullName: string; amount: Money; paymentId?: string; error?: string }[];
  excluded: PayrollCheckLine[];
  total: Money;
  preparedBy: string;
  preparedOn: string;
  /** Crédit rendu à la ligne pour les lignes rejetées ou échouées. */
  released?: Money;
}

export interface AdminPayrollView extends AdminPayroll {
  state: 'awaiting_visa' | 'partly_paid' | 'paid' | 'closed';
  lineStates: Payment['status'][];
}

/** Ce que le registre national (simulé) sait d'un NIN : le nom de la personne. */
export type CivilRegistry = (nin: string) => string | undefined;

export interface EngagementInput {
  lineId: string;
  supplier: { name: string; nif?: string };
  payee: MobilePayee;
  object: string;
  amount: string | number;
}

function nameKey(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
}

interface Context {
  space: AdministrationSpace;
  role: Role;
  personName: string;
  today: string;
  at: string;
}

export class AdministrationDesk {
  private readonly app: AppGn;
  private readonly store: DeskStore;
  private readonly audit: AuditTrail;
  private readonly registry: CivilRegistry;

  constructor(app: AppGn, store: DeskStore, registry: CivilRegistry) {
    this.app = app;
    this.store = store;
    this.audit = new AuditTrail(store);
    this.registry = registry;
  }

  // ── Budget ─────────────────────────────────────────────────────────────────

  /** Crédits ouverts au budget de l'année, une seule fois par ligne (reprise du budget voté). */
  async openBudgetLine(actor: Actor, spaceId: string, input: { code: string; label: string; section: BudgetLine['section']; allocated: string | number; payroll?: boolean }): Promise<BudgetLine> {
    const context = this.context(actor, spaceId, 'budget:engage');
    const year = Number(context.today.slice(0, 4));
    const code = text(input?.code, 'code de la ligne', 20);
    if (!['fonctionnement', 'investissement'].includes(input.section)) throw new AppError('invalid_request', 'section : fonctionnement ou investissement');
    const line: BudgetLine = {
      id: `${spaceId}:${year}:${code}`, spaceId, code, label: text(input.label, 'intitulé', 160), section: input.section, year,
      allocated: parseGnf(input.allocated, 'crédit voté'), engaged: gnf(0), ...(input.payroll ? { payroll: true } : {}),
    };
    if (line.payroll && (await this.lines(spaceId, year)).some((candidate) => candidate.payroll)) throw new AppError('invalid_state', 'une ligne porte déjà la paie');
    if (!await this.store.insert('budget_lines', line)) throw new AppError('invalid_state', `ligne ${code} déjà ouverte pour ${year}`);
    await this.record(context, actor, 'budget.opened', line.id, `Ligne ${code} · ${line.label} · ${toMajor(line.allocated)} GNF`);
    return line;
  }

  async budget(actor: Actor, spaceId: string): Promise<BudgetView> {
    const context = this.context(actor, spaceId, 'budget:read');
    const year = Number(context.today.slice(0, 4));
    const payments = await this.paymentMap(actor, spaceId);
    const engagements = await this.engagementRecords(spaceId);
    const payrolls = await this.payrollRecords(spaceId);
    const lines = (await this.lines(spaceId, year)).map((line): BudgetLineView => {
      let liquidated = 0n;
      let mandated = 0n;
      let paid = 0n;
      for (const engagement of engagements.filter((candidate) => candidate.lineId === line.id)) {
        for (const liquidation of engagement.liquidations) {
          liquidated += toBigInt(liquidation.amount);
          const payment = liquidation.mandate ? payments.get(liquidation.mandate.paymentId) : undefined;
          if (payment && ['pending_approval', 'processing', 'completed'].includes(payment.status)) mandated += toBigInt(liquidation.amount);
          if (payment?.status === 'completed') paid += toBigInt(liquidation.amount);
        }
      }
      for (const payroll of payrolls.filter((candidate) => candidate.lineId === line.id)) {
        for (const entry of payroll.lines) {
          const payment = entry.paymentId ? payments.get(entry.paymentId) : undefined;
          if (!payment || payment.status === 'failed' || payment.status === 'rejected') continue;
          liquidated += toBigInt(entry.amount);
          mandated += toBigInt(entry.amount);
          if (payment.status === 'completed') paid += toBigInt(entry.amount);
        }
      }
      const available = toBigInt(line.allocated) - toBigInt(line.engaged);
      const rate = toBigInt(line.allocated) > 0n ? Number((paid * 1000n) / toBigInt(line.allocated)) / 10 : 0;
      return { ...line, liquidated: gnf(liquidated), mandated: gnf(mandated), paid: gnf(paid), available: gnf(available), executionRate: rate };
    });
    const total = (filter: (line: BudgetLineView) => boolean) => {
      const selected = lines.filter(filter);
      return {
        allocated: sum(selected.map((line) => line.allocated)),
        engaged: sum(selected.map((line) => line.engaged)),
        paid: sum(selected.map((line) => line.paid)),
        available: sum(selected.map((line) => line.available)),
      };
    };
    return {
      year,
      lines,
      totals: {
        fonctionnement: total((line) => line.section === 'fonctionnement'),
        investissement: total((line) => line.section === 'investissement'),
        total: total(() => true),
      },
    };
  }

  // ── Chaîne de la dépense ───────────────────────────────────────────────────

  async engagements(actor: Actor, spaceId: string): Promise<EngagementView[]> {
    this.context(actor, spaceId, ['budget:read', 'payments:approve']);
    const payments = await this.paymentMap(actor, spaceId);
    const lines = new Map((await this.store.list<BudgetLine>('budget_lines', spaceId)).map(({ value }) => [value.id, value]));
    return (await this.engagementRecords(spaceId)).reverse().map((engagement) => this.engagementView(engagement, lines, payments));
  }

  /** Engage une dépense : refusé si le montant dépasse le crédit encore disponible sur la ligne. */
  async engage(actor: Actor, spaceId: string, input: EngagementInput, idempotencyKey: string): Promise<EngagementView> {
    const context = this.context(actor, spaceId, 'budget:engage');
    const amount = parseGnf(input?.amount, 'montant engagé');
    const supplier = { name: text(input?.supplier?.name, 'fournisseur', 120), ...(optionalText(input?.supplier?.nif, 30) ? { nif: optionalText(input.supplier.nif, 30)! } : {}) };
    const target = payee(input?.payee, 'bénéficiaire');
    const object = text(input?.object, 'objet de la dépense', 200);
    const line = (await this.store.get<BudgetLine>('budget_lines', input?.lineId ?? ''))?.value;
    if (!line || line.spaceId !== spaceId) throw new AppError('not_found', 'ligne budgétaire introuvable');
    if (line.payroll) throw new AppError('invalid_request', 'la ligne de la paie s’engage par la paie des agents');
    const id = randomId('eng');
    const claim = await claimKey(this.store, spaceId, actor.personId, 'engage', idempotencyKey, input, id);
    if (claim.conflict) throw new AppError('idempotency_conflict', 'cette clé a déjà servi pour une autre demande');
    if (claim.replay) return this.viewOf(actor, spaceId, claim.replay);

    await this.consumeCredit(line.id, amount);
    try {
      const year = line.year;
      const { number } = await nextInChain(this.store, spaceId, `ENG-${year}`, async () => id);
      const engagement: Engagement = {
        id, spaceId, number: `ENG-${year}-${String(number).padStart(4, '0')}`, lineId: line.id, supplier, payee: target, object, amount,
        status: 'engaged', createdBy: actor.personId, createdOn: context.today, liquidations: [],
      };
      await this.store.insert('engagements', engagement);
      await this.record(context, actor, 'engagement.created', id, `${engagement.number} · ligne ${line.code} · ${supplier.name} · ${toMajor(amount)} GNF`);
    } catch (error) {
      await this.releaseCredit(line.id, amount);
      throw error;
    }
    return this.viewOf(actor, spaceId, id);
  }

  /** Clôture un engagement : la part non liquidée revient au disponible de la ligne. */
  async closeEngagement(actor: Actor, spaceId: string, engagementId: string): Promise<EngagementView> {
    const context = this.context(actor, spaceId, 'budget:engage');
    let released = gnf(0);
    const engagement = await mutate<Engagement>(this.store, 'engagements', engagementId, (current) => {
      if (!current || current.spaceId !== spaceId) throw new AppError('not_found', 'engagement introuvable');
      if (current.status !== 'engaged') throw new AppError('invalid_state', 'engagement déjà clôturé');
      released = gnf(toBigInt(current.amount) - toBigInt(sum(current.liquidations.map((liquidation) => liquidation.amount))));
      return { ...current, status: 'closed' };
    });
    if (toBigInt(released) > 0n) await this.releaseCredit(engagement.lineId, released);
    await this.record(context, actor, 'engagement.closed', engagement.id, `${engagement.number} clôturé · ${toMajor(released)} GNF rendus à la ligne`);
    return this.viewOf(actor, spaceId, engagementId);
  }

  /** Service fait : l'ordonnateur certifie et liquide tout ou partie de l'engagement. */
  async liquidate(actor: Actor, spaceId: string, engagementId: string, input: { amount: string | number; invoiceReference: string; serviceDoneOn: string }): Promise<EngagementView> {
    const context = this.context(actor, spaceId, 'budget:engage');
    const amount = parseGnf(input?.amount, 'montant liquidé');
    const invoiceReference = text(input?.invoiceReference, 'référence de la facture', 60);
    if (typeof input.serviceDoneOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.serviceDoneOn) || input.serviceDoneOn > context.today) {
      throw new AppError('invalid_request', 'date du service fait : aujourd’hui ou avant');
    }
    const id = randomId('liq');
    const engagement = await mutate<Engagement>(this.store, 'engagements', engagementId, (current) => {
      if (!current || current.spaceId !== spaceId) throw new AppError('not_found', 'engagement introuvable');
      if (current.status !== 'engaged') throw new AppError('invalid_state', 'engagement clôturé');
      if (input.serviceDoneOn < current.createdOn) throw new AppError('invalid_request', 'service fait avant l’engagement');
      const already = toBigInt(sum(current.liquidations.map((liquidation) => liquidation.amount)));
      if (already + toBigInt(amount) > toBigInt(current.amount)) throw new AppError('invalid_state', `dépasse le reste à liquider (${toMajor(gnf(toBigInt(current.amount) - already))} GNF)`);
      return { ...current, liquidations: [...current.liquidations, { id, amount, invoiceReference, serviceDoneOn: input.serviceDoneOn, certifiedBy: actor.personId, on: context.today }] };
    });
    await this.record(context, actor, 'engagement.liquidated', id, `${engagement.number} · service fait le ${input.serviceDoneOn} · ${toMajor(amount)} GNF`);
    return this.viewOf(actor, spaceId, engagementId);
  }

  /**
   * L'ordonnateur émet le mandat d'une liquidation : un paiement qui attend le visa du comptable public.
   * Un mandat rejeté peut être réémis, une fois corrigé.
   */
  async mandate(actor: Actor, spaceId: string, engagementId: string, liquidationId: string, input: { sourceAccountId: string }): Promise<EngagementView> {
    const context = this.context(actor, spaceId, 'payments:initiate');
    const record = await this.store.get<Engagement>('engagements', engagementId);
    const engagement = record?.value;
    if (!engagement || engagement.spaceId !== spaceId) throw new AppError('not_found', 'engagement introuvable');
    const liquidation = engagement.liquidations.find((candidate) => candidate.id === liquidationId);
    if (!liquidation) throw new AppError('not_found', 'liquidation introuvable');
    if (liquidation.mandate) {
      const payment = await this.app.paymentOf(spaceId, liquidation.mandate.paymentId);
      if (payment?.status !== 'rejected' && payment?.status !== 'failed') throw new AppError('invalid_state', `mandat ${liquidation.mandate.number} déjà émis`);
    }
    const source = this.debitAccount(spaceId, input?.sourceAccountId);
    const attempt = (liquidation.rejected?.length ?? 0) + (liquidation.mandate ? 1 : 0);
    const { number } = await nextInChain(this.store, spaceId, `MDT-${context.today.slice(0, 4)}`, async () => liquidationId);
    const mandateNumber = `MDT-${context.today.slice(0, 4)}-${String(number).padStart(4, '0')}`;
    const payment = await this.app.initiatePayment(actor, spaceId, {
      sourceAccountId: source.id,
      amount: toMajor(liquidation.amount),
      destination: { type: 'mobile_money', operator: engagement.payee.operator, phone: engagement.payee.phone, name: engagement.supplier.name },
      label: `${mandateNumber} · ${engagement.object}`,
    }, `${liquidationId}:${attempt}`);
    const updated = await mutate<Engagement>(this.store, 'engagements', engagementId, async (current) => {
      const liquidations = await Promise.all(current!.liquidations.map(async (candidate) => {
        if (candidate.id !== liquidationId) return candidate;
        const rejected = [...(candidate.rejected ?? [])];
        if (candidate.mandate) {
          const previous = await this.app.paymentOf(spaceId, candidate.mandate.paymentId);
          rejected.push({ number: candidate.mandate.number, paymentId: candidate.mandate.paymentId, reason: previous?.rejectionReason ?? previous?.failureReason ?? 'rejeté' });
        }
        return { ...candidate, mandate: { number: mandateNumber, paymentId: payment.id, issuedBy: actor.personId, on: context.today }, ...(rejected.length ? { rejected } : {}) };
      }));
      return { ...current!, liquidations };
    });
    await this.record(context, actor, 'mandate.issued', payment.id, `${mandateNumber} · ${updated.number} · ${engagement.supplier.name} · ${toMajor(liquidation.amount)} GNF`);
    return this.viewOf(actor, spaceId, engagementId);
  }

  /**
   * Visa du comptable public : il contrôle que le mandat correspond à une liquidation certifiée, sur un
   * engagement ouvert, au même montant et au même bénéficiaire, puis le paie. Il ne vise pas ce qu'il a émis.
   */
  async visa(actor: Actor, spaceId: string, engagementId: string, liquidationId: string): Promise<EngagementView> {
    const context = this.context(actor, spaceId, 'payments:approve');
    const { engagement, liquidation, payment } = await this.mandated(spaceId, engagementId, liquidationId);
    const destination = payment.destination;
    if (destination.type !== 'mobile_money' || destination.phone !== engagement.payee.phone || destination.operator !== engagement.payee.operator) {
      throw new AppError('invalid_state', 'le bénéficiaire du mandat ne correspond pas à l’engagement : rejetez-le');
    }
    if (payment.amount.amount !== liquidation.amount.amount) throw new AppError('invalid_state', 'le montant du mandat ne correspond pas à la liquidation : rejetez-le');
    const paid = await this.app.approvePayment(actor, spaceId, payment.id);
    await this.record(context, actor, 'mandate.approved', payment.id, `${liquidation.mandate!.number} visé et payé · ${paid.status}`);
    return this.viewOf(actor, spaceId, engagementId);
  }

  async rejectMandate(actor: Actor, spaceId: string, engagementId: string, liquidationId: string, reason: string): Promise<EngagementView> {
    const context = this.context(actor, spaceId, 'payments:approve');
    const motive = text(reason, 'motif du rejet', 300);
    const { liquidation, payment } = await this.mandated(spaceId, engagementId, liquidationId);
    await this.app.rejectPayment(actor, spaceId, payment.id, motive);
    await this.record(context, actor, 'mandate.rejected', payment.id, `${liquidation.mandate!.number} rejeté : ${motive}`);
    return this.viewOf(actor, spaceId, engagementId);
  }

  // ── Paie des agents ────────────────────────────────────────────────────────

  async agents(actor: Actor, spaceId: string): Promise<Agent[]> {
    this.context(actor, spaceId, ['payroll:submit', 'payments:approve']);
    return this.agentRecords(spaceId);
  }

  async enrolAgent(actor: Actor, spaceId: string, input: { matricule: string; fullName: string; nin: string; grade: string; monthlyNet: string | number; payout: MobilePayee }): Promise<Agent> {
    const context = this.context(actor, spaceId, 'payroll:submit');
    const matricule = text(input?.matricule, 'matricule', 20);
    const agent: Agent = {
      id: `${spaceId}:${matricule}`, spaceId, matricule, fullName: text(input.fullName, 'nom', 120),
      // Le NIN est gardé tel que saisi : le contrôle de la paie dira s'il est valide.
      nin: typeof input.nin === 'string' ? input.nin.trim().toUpperCase() : '',
      grade: text(input.grade, 'grade', 80), monthlyNet: parseGnf(input.monthlyNet, 'traitement net'), payout: payee(input.payout, 'wallet de paie'), status: 'active',
    };
    if (!await this.store.insert('agents', agent)) throw new AppError('invalid_state', `matricule ${matricule} déjà inscrit`);
    await this.record(context, actor, 'agent.enrolled', agent.id, `${matricule} · ${agent.fullName} · ${agent.grade}`);
    return agent;
  }

  async setAgentSuspended(actor: Actor, spaceId: string, agentId: string, suspended: boolean): Promise<Agent> {
    const context = this.context(actor, spaceId, 'payroll:submit');
    const agent = await mutate<Agent>(this.store, 'agents', agentId, (current) => {
      if (!current || current.spaceId !== spaceId) throw new AppError('not_found', 'agent introuvable');
      return { ...current, status: suspended ? 'suspended' : 'active' };
    });
    await this.record(context, actor, suspended ? 'agent.suspended' : 'agent.reinstated', agent.id, `${agent.matricule} · ${agent.fullName}`);
    return agent;
  }

  /**
   * Contrôle de la paie d'un mois, avant tout mandat : chaque NIN est vérifié au registre national (forme,
   * existence, concordance du nom), puis les doublons de NIN et les wallets partagés entre agents sont écartés.
   */
  async payrollCheck(actor: Actor, spaceId: string, period: string): Promise<PayrollCheck> {
    const context = this.context(actor, spaceId, ['payroll:submit', 'payments:approve', 'reports:read']);
    if (!isPeriod(period)) throw new AppError('invalid_request', 'mois attendu (AAAA-MM)');
    const agents = await this.agentRecords(spaceId);
    const ninCount = new Map<string, number>();
    const walletCount = new Map<string, number>();
    for (const agent of agents.filter((candidate) => candidate.status === 'active')) {
      const nin = normalizedNin(agent.nin);
      if (nin) ninCount.set(nin, (ninCount.get(nin) ?? 0) + 1);
      const wallet = agent.payout.phone.replace(/\D/g, '');
      walletCount.set(wallet, (walletCount.get(wallet) ?? 0) + 1);
    }
    const eligible: PayrollCheckLine[] = [];
    const excluded: PayrollCheckLine[] = [];
    for (const agent of agents) {
      const issues: PayrollIssue[] = [];
      const nin = normalizedNin(agent.nin);
      if (agent.status === 'suspended') issues.push('suspended');
      else {
        if (!nin) issues.push('nin_invalid');
        else {
          const name = this.registry(nin);
          if (!name) issues.push('nin_unknown');
          else if (nameKey(name) !== nameKey(agent.fullName)) issues.push('identity_mismatch');
          if ((ninCount.get(nin) ?? 0) > 1) issues.push('duplicate_nin');
        }
        if ((walletCount.get(agent.payout.phone.replace(/\D/g, '')) ?? 0) > 1) issues.push('shared_wallet');
      }
      const line = { agentId: agent.id, matricule: agent.matricule, fullName: agent.fullName, amount: agent.monthlyNet, issues };
      (issues.length ? excluded : eligible).push(line);
    }
    const payrollLine = (await this.lines(spaceId, Number(context.today.slice(0, 4)))).find((line) => line.payroll);
    return {
      period, eligible, excluded, total: sum(eligible.map((line) => line.amount)),
      ...(payrollLine ? { lineId: payrollLine.id, available: gnf(toBigInt(payrollLine.allocated) - toBigInt(payrollLine.engaged)) } : {}),
    };
  }

  /**
   * L'ordonnateur mandate la paie contrôlée : la masse est imputée sur la ligne de la paie (refusé au-delà
   * du disponible) et chaque agent éligible reçoit un mandat, que le comptable public vise ensuite.
   */
  async preparePayroll(actor: Actor, spaceId: string, input: { period: string; sourceAccountId: string }, idempotencyKey: string): Promise<AdminPayrollView> {
    const context = this.context(actor, spaceId, 'payroll:submit');
    if (!can(context.role, 'payments:initiate')) throw new AppError('forbidden', 'votre rôle ne permet pas : payments:initiate');
    const period = input?.period;
    if (!isPeriod(period) || period > periodOf(context.today) || period < periodOf(addDays(context.today, -62))) throw new AppError('invalid_request', 'mois de paie : le mois en cours ou l’un des deux précédents');
    const id = `${spaceId}:${period}`;
    const claim = await claimKey(this.store, spaceId, actor.personId, 'payroll', idempotencyKey, input, id);
    if (claim.conflict) throw new AppError('idempotency_conflict', 'cette clé a déjà servi pour une autre demande');
    const payments = await this.paymentMap(actor, spaceId);
    const existing = await this.store.get<AdminPayroll>('batches', id);
    if (existing) {
      if (claim.replay) return this.payrollView(existing.value, payments);
      throw new AppError('invalid_state', `paie ${period} déjà mandatée`);
    }
    const source = this.debitAccount(spaceId, input.sourceAccountId);
    const check = await this.payrollCheck(actor, spaceId, period);
    if (!check.lineId) throw new AppError('invalid_state', 'aucune ligne budgétaire ne porte la paie');
    if (check.eligible.length === 0) throw new AppError('invalid_state', 'aucun agent éligible');
    await this.consumeCredit(check.lineId, check.total);
    const payroll: AdminPayroll = {
      id, spaceId, period, number: `PAIE-${period}`, lineId: check.lineId, sourceAccountId: source.id,
      lines: check.eligible.map((line) => ({ agentId: line.agentId, matricule: line.matricule, fullName: line.fullName, amount: line.amount })),
      excluded: check.excluded, total: check.total, preparedBy: actor.personId, preparedOn: context.today,
    };
    if (!await this.store.insert('batches', payroll)) {
      await this.releaseCredit(check.lineId, check.total);
      throw new AppError('invalid_state', `paie ${period} déjà mandatée`);
    }
    const agents = new Map((await this.agentRecords(spaceId)).map((agent) => [agent.id, agent]));
    for (const line of payroll.lines) {
      const agent = agents.get(line.agentId)!;
      try {
        const payment = await this.app.initiatePayment(actor, spaceId, {
          sourceAccountId: source.id,
          amount: toMajor(line.amount),
          destination: { type: 'mobile_money', operator: agent.payout.operator, phone: agent.payout.phone, name: agent.fullName },
          label: `Traitement ${period} · ${line.matricule}`,
        }, `${id}:${line.agentId}`);
        line.paymentId = payment.id;
        payments.set(payment.id, payment);
      } catch (error) {
        line.error = error instanceof AppError ? error.message : 'échec du mandat';
      }
    }
    const saved = await mutate<AdminPayroll>(this.store, 'batches', id, (current) => ({ ...current!, lines: payroll.lines }));
    await this.record(context, actor, 'payroll.mandated', id, `${payroll.number} · ${payroll.lines.length} agent(s) · ${toMajor(payroll.total)} GNF · ${payroll.excluded.length} écarté(s)`);
    return this.payrollView(saved, payments);
  }

  async payrolls(actor: Actor, spaceId: string): Promise<AdminPayrollView[]> {
    this.context(actor, spaceId, ['payroll:submit', 'payments:approve', 'reports:read']);
    const payments = await this.paymentMap(actor, spaceId);
    return (await this.payrollRecords(spaceId)).reverse().map((payroll) => this.payrollView(payroll, payments));
  }

  /** Le comptable public vise la paie : chaque mandat encore en attente est payé ; les lignes refusées rendent leur crédit. */
  async payPayroll(actor: Actor, spaceId: string, payrollId: string): Promise<AdminPayrollView> {
    const context = this.context(actor, spaceId, 'payments:approve');
    const payroll = (await this.store.get<AdminPayroll>('batches', payrollId))?.value;
    if (!payroll || payroll.spaceId !== spaceId || !payroll.number.startsWith('PAIE-')) throw new AppError('not_found', 'paie introuvable');
    if (payroll.preparedBy === actor.personId) throw new AppError('separation_of_duties', 'qui mandate la paie ne la vise pas');
    let paid = 0;
    for (const line of payroll.lines) {
      if (!line.paymentId) continue;
      const payment = await this.app.paymentOf(spaceId, line.paymentId);
      if (payment?.status !== 'pending_approval') continue;
      await this.app.approvePayment(actor, spaceId, line.paymentId);
      paid += 1;
    }
    if (paid === 0) throw new AppError('invalid_state', 'aucun mandat de cette paie n’attend de visa');
    await this.settlePayrollCredit(actor, spaceId, payrollId);
    await this.record(context, actor, 'payroll.approved', payrollId, `${payroll.number} visée · ${paid} mandat(s) payé(s)`);
    return this.payrollView((await this.store.get<AdminPayroll>('batches', payrollId))!.value, await this.paymentMap(actor, spaceId));
  }

  // ── Recettes, état de la Cour des Comptes, audit ─────────────────────────────

  /** Recettes des 30 derniers jours, par compte et par nature (taxes de marché, état civil…). */
  async revenue(actor: Actor, spaceId: string): Promise<{ since: string; total: Money; byNature: { nature: string; total: Money; count: number }[]; byAccount: { accountId: string; label: string; total: Money }[] }> {
    const { today } = this.context(actor, spaceId, ['budget:read', 'reports:read']);
    const since = addDays(today, -30);
    const byNature = new Map<string, { total: bigint; count: number }>();
    const byAccount: { accountId: string; label: string; total: Money }[] = [];
    let total = 0n;
    for (const account of this.app.linkedAccounts(spaceId).filter((candidate) => candidate.currency === 'GNF')) {
      let accountTotal = 0n;
      for (const transaction of await this.app.transactions(actor, spaceId, account.id, 100)) {
        if (transaction.direction !== 'credit' || transaction.occurredAt.slice(0, 10) < since || transaction.label === 'Solde reporté') continue;
        const nature = transaction.counterparty ?? 'Divers';
        const bucket = byNature.get(nature) ?? { total: 0n, count: 0 };
        bucket.total += toBigInt(transaction.amount);
        bucket.count += 1;
        byNature.set(nature, bucket);
        accountTotal += toBigInt(transaction.amount);
      }
      total += accountTotal;
      byAccount.push({ accountId: account.id, label: account.label, total: gnf(accountTotal) });
    }
    return {
      since,
      total: gnf(total),
      byNature: [...byNature.entries()].map(([nature, bucket]) => ({ nature, total: gnf(bucket.total), count: bucket.count })).sort((a, b) => Number(toBigInt(b.total) - toBigInt(a.total))),
      byAccount,
    };
  }

  /**
   * État d'exécution transmis à la Cour des Comptes : ligne par ligne (voté, engagé, liquidé, mandaté, payé),
   * puis chaque mandat payé, et l'état de la piste d'audit. CSV séparé par des points-virgules.
   */
  async courtReport(actor: Actor, spaceId: string): Promise<string> {
    const context = this.context(actor, spaceId, 'reports:read');
    const budget = await this.budget(actor, spaceId);
    const rows: (string | number)[][] = [
      [`Compte d'exécution ${budget.year}`, context.space.name],
      ['Ligne', 'Intitulé', 'Section', 'Voté', 'Engagé', 'Liquidé', 'Mandaté', 'Payé', 'Disponible', 'Taux d’exécution (%)'],
      ...budget.lines.map((line) => [line.code, line.label, line.section, toMajor(line.allocated), toMajor(line.engaged), toMajor(line.liquidated), toMajor(line.mandated), toMajor(line.paid), toMajor(line.available), line.executionRate]),
      ['Total', '', '', toMajor(budget.totals.total.allocated), toMajor(budget.totals.total.engaged), '', '', toMajor(budget.totals.total.paid), toMajor(budget.totals.total.available), ''],
      [],
      ['Mandat', 'Engagement', 'Bénéficiaire', 'Objet', 'Montant', 'Payé le', 'Référence de paiement'],
    ];
    const payments = await this.paymentMap(actor, spaceId);
    for (const engagement of await this.engagementRecords(spaceId)) {
      for (const liquidation of engagement.liquidations) {
        const payment = liquidation.mandate ? payments.get(liquidation.mandate.paymentId) : undefined;
        if (payment?.status !== 'completed') continue;
        rows.push([liquidation.mandate!.number, engagement.number, engagement.supplier.name, engagement.object, toMajor(liquidation.amount), payment.updatedAt.slice(0, 10), payment.orchestratorReference ?? '']);
      }
    }
    for (const payroll of await this.payrollRecords(spaceId)) {
      const paid = payroll.lines.filter((line) => line.paymentId && payments.get(line.paymentId)?.status === 'completed');
      if (paid.length) rows.push([payroll.number, '', `${paid.length} agent(s)`, `Traitements ${payroll.period}`, toMajor(sum(paid.map((line) => line.amount))), '', '']);
    }
    const check = await this.audit.verify(spaceId);
    rows.push([], ['Piste d’audit', check.intact ? 'intègre' : `rompue à l’entrée ${check.brokenAt}`, `${check.checked} entrée(s) vérifiée(s)`, `édité le ${context.today}`]);
    return csv(rows);
  }

  async auditTrail(actor: Actor, spaceId: string): Promise<{ entries: AuditEntry[]; check: ChainCheck }> {
    this.context(actor, spaceId, 'reports:read');
    return { entries: (await this.audit.entries(spaceId)).reverse(), check: await this.audit.verify(spaceId) };
  }

  // ── Interne ────────────────────────────────────────────────────────────────

  private context(actor: Actor, spaceId: string, permissions: Permission | readonly Permission[]): Context {
    const { space, role, person } = this.app.guard(actor, spaceId, permissions, ADMINISTRATION);
    const now = this.app.clock();
    return { space: space as AdministrationSpace, role, personName: person.fullName, today: dayOf(now), at: now.toISOString() };
  }

  private async record(context: Context, actor: Actor, action: string, target: string, summary: string): Promise<void> {
    await this.audit.append(context.space.id, { at: context.at, personId: actor.personId, personName: context.personName, action, target, summary });
  }

  private async lines(spaceId: string, year: number): Promise<BudgetLine[]> {
    return (await this.store.list<BudgetLine>('budget_lines', spaceId)).map(({ value }) => value).filter((line) => line.year === year).sort((a, b) => a.code.localeCompare(b.code, 'fr', { numeric: true }));
  }

  private async consumeCredit(lineId: string, amount: Money): Promise<void> {
    await mutate<BudgetLine>(this.store, 'budget_lines', lineId, (current) => {
      const available = toBigInt(current!.allocated) - toBigInt(current!.engaged);
      if (toBigInt(amount) > available) throw new AppError('invalid_state', `crédit insuffisant sur la ligne ${current!.code} : ${toMajor(gnf(available))} GNF disponibles`);
      return { ...current!, engaged: gnf(toBigInt(current!.engaged) + toBigInt(amount)) };
    });
  }

  private async releaseCredit(lineId: string, amount: Money): Promise<void> {
    await mutate<BudgetLine>(this.store, 'budget_lines', lineId, (current) => ({ ...current!, engaged: gnf(toBigInt(current!.engaged) - toBigInt(amount)) }));
  }

  /** Rend à la ligne de la paie le crédit des lignes rejetées ou échouées, une seule fois. */
  private async settlePayrollCredit(actor: Actor, spaceId: string, payrollId: string): Promise<void> {
    const payments = await this.paymentMap(actor, spaceId);
    let delta = 0n;
    const payroll = await mutate<AdminPayroll>(this.store, 'batches', payrollId, (current) => {
      const lost = current!.lines
        .filter((line) => !line.paymentId || ['failed', 'rejected'].includes(payments.get(line.paymentId)?.status ?? ''))
        .reduce((total, line) => total + toBigInt(line.amount), 0n);
      delta = lost - toBigInt(current!.released ?? gnf(0));
      return { ...current!, released: gnf(lost) };
    });
    if (delta > 0n) await this.releaseCredit(payroll.lineId, gnf(delta));
  }

  private async mandated(spaceId: string, engagementId: string, liquidationId: string): Promise<{ engagement: Engagement; liquidation: Liquidation; payment: Payment }> {
    const engagement = (await this.store.get<Engagement>('engagements', engagementId))?.value;
    if (!engagement || engagement.spaceId !== spaceId) throw new AppError('not_found', 'engagement introuvable');
    const liquidation = engagement.liquidations.find((candidate) => candidate.id === liquidationId);
    if (!liquidation?.mandate) throw new AppError('not_found', 'aucun mandat pour cette liquidation');
    const payment = await this.app.paymentOf(spaceId, liquidation.mandate.paymentId);
    if (!payment || payment.status !== 'pending_approval') throw new AppError('invalid_state', 'ce mandat n’attend pas de visa');
    return { engagement, liquidation, payment };
  }

  private debitAccount(spaceId: string, accountId: unknown): LinkedAccount {
    const account = this.app.linkedAccounts(spaceId).find((candidate) => candidate.id === accountId);
    if (!account) throw new AppError('not_found', 'compte introuvable dans cet espace');
    if (account.currency !== 'GNF' || !providerById(account.providerId)?.canDebit) throw new AppError('invalid_request', 'choisissez un compte en GNF qui peut être débité');
    return account;
  }

  private async engagementRecords(spaceId: string): Promise<Engagement[]> {
    return (await this.store.list<Engagement>('engagements', spaceId)).map(({ value }) => value);
  }

  private async payrollRecords(spaceId: string): Promise<AdminPayroll[]> {
    return (await this.store.list<AdminPayroll>('batches', spaceId)).map(({ value }) => value).filter((value) => value.number?.startsWith('PAIE-'));
  }

  private async agentRecords(spaceId: string): Promise<Agent[]> {
    return (await this.store.list<Agent>('agents', spaceId)).map(({ value }) => value).sort((a, b) => a.matricule.localeCompare(b.matricule));
  }

  private async paymentMap(actor: Actor, spaceId: string): Promise<Map<string, Payment>> {
    return new Map((await this.app.listPayments(actor, spaceId)).map((payment) => [payment.id, payment]));
  }

  private async viewOf(actor: Actor, spaceId: string, engagementId: string): Promise<EngagementView> {
    const engagement = (await this.store.get<Engagement>('engagements', engagementId))?.value;
    if (!engagement) throw new AppError('not_found', 'engagement introuvable');
    const lines = new Map((await this.store.list<BudgetLine>('budget_lines', spaceId)).map(({ value }) => [value.id, value]));
    return this.engagementView(engagement, lines, await this.paymentMap(actor, spaceId));
  }

  private engagementView(engagement: Engagement, lines: ReadonlyMap<string, BudgetLine>, payments: ReadonlyMap<string, Payment>): EngagementView {
    const line = lines.get(engagement.lineId);
    const liquidated = sum(engagement.liquidations.map((liquidation) => liquidation.amount));
    return {
      ...engagement,
      lineCode: line?.code ?? '',
      lineLabel: line?.label ?? '',
      liquidated,
      remaining: gnf(engagement.status === 'closed' ? 0n : toBigInt(engagement.amount) - toBigInt(liquidated)),
      liquidations: engagement.liquidations.map((liquidation): LiquidationView => {
        const payment = liquidation.mandate ? payments.get(liquidation.mandate.paymentId) : undefined;
        if (!payment) return { ...liquidation, state: 'to_mandate' };
        switch (payment.status) {
          case 'pending_approval': return { ...liquidation, state: 'awaiting_visa' };
          case 'processing': return { ...liquidation, state: 'paying' };
          case 'completed': return { ...liquidation, state: 'paid' };
          case 'rejected': return { ...liquidation, state: 'rejected', ...(payment.rejectionReason ? { rejectionReason: payment.rejectionReason } : {}) };
          default: return { ...liquidation, state: 'failed', ...(payment.failureReason ? { rejectionReason: payment.failureReason } : {}) };
        }
      }),
    };
  }

  private payrollView(payroll: AdminPayroll, payments: ReadonlyMap<string, Payment>): AdminPayrollView {
    const lineStates = payroll.lines.map((line) => (line.paymentId ? payments.get(line.paymentId)?.status ?? 'failed' : 'failed'));
    const waiting = lineStates.filter((status) => status === 'pending_approval').length;
    const completed = lineStates.filter((status) => status === 'completed').length;
    const state = waiting === lineStates.length ? 'awaiting_visa' : waiting > 0 ? 'partly_paid' : completed === lineStates.length ? 'paid' : 'closed';
    return { ...payroll, state, lineStates };
  }
}
