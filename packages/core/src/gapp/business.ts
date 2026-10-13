import type { AccountPosition } from '../aggregation.ts';
import type { AppGn } from '../app.ts';
import type { Actor } from '../channels.ts';
import { AppError } from '../errors.ts';
import type { AccountKind, BusinessSpace, LinkedAccount, Role } from '../model.ts';
import { toBigInt, toMajor, type Money } from '../money.ts';
import { BUSINESS_APPROVAL_THRESHOLD, type Payment, type PaymentDestination } from '../payments.ts';
import { providerById } from '../providers.ts';
import { can, type Permission } from '../rbac.ts';
import {
  addDays,
  csv,
  dayOf,
  daysBetween,
  gnf,
  isDay,
  isPeriod,
  normalizedNin,
  optionalText,
  parseGnf,
  payee,
  periodOf,
  share,
  sum,
  text,
  verificationCode,
  type MobilePayee,
} from './common.ts';
import {
  AuditTrail,
  canonical,
  claimKey,
  GENESIS,
  mutate,
  nextInChain,
  randomId,
  sha256,
  type AuditEntry,
  type ChainCheck,
  type DeskEntity,
  type DeskStore,
} from './desk.ts';

/**
 * GAPP Entreprise : le tableau de bord d'une PME ou d'une ETI. Chaque fonction suit la logique métier
 * de l'entreprise et le rôle de qui la demande :
 *
 * - trésorerie du jour et projection à 7 jours (encaissements attendus, fournisseurs, paie, TVA) ;
 * - factures de vente numérotées sans trou et scellées en chaîne, rapprochées des encaissements ;
 * - factures fournisseurs payées par lots (50 au plus), routés vers le compte le moins coûteux, approuvés
 *   par le dirigeant au-delà du seuil ;
 * - TVA du mois : déclaration et paiement à la DGI ensemble, crédit reporté ;
 * - équipe : registre, attestations de travail déposées dans le coffre personnel du salarié, paie ;
 * - score B2B indicatif, journal comptable exportable, piste d'audit chaînée.
 *
 * Le bureau ne lit que l'espace de l'entreprise : aucune donnée de l'espace personnel d'un membre n'y entre,
 * et ce qu'il dépose chez un salarié (attestation) ne lui révèle rien en retour.
 */

export const DEFAULT_VAT_RATE_BPS = 1800;
export const MAX_BATCH_LINES = 50;
export const PROJECTION_DAYS = 7;
/** La TVA d'un mois se déclare et se paie au plus tard le 15 du mois suivant. */
export const VAT_DEADLINE_DAY = 15;

const BUSINESS = 'business' as const;

// ── Modèle ──────────────────────────────────────────────────────────────────

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitPrice: Money;
  total: Money;
}

export interface Customer {
  name: string;
  phone?: string;
  nif?: string;
}

export interface SalesInvoice extends DeskEntity {
  number: string;
  customer: Customer;
  lines: InvoiceLine[];
  vatRateBps: number;
  subtotal: Money;
  vat: Money;
  total: Money;
  issueDate: string;
  dueDate: string;
  status: 'issued' | 'paid' | 'cancelled';
  settlement?: { accountId: string; transactionId?: string; on: string; by: string };
  cancellation?: { on: string; by: string; reason: string };
  issuedBy: string;
  seal: { previous: string; hash: string };
}

export type InvoiceState = 'issued' | 'overdue' | 'paid' | 'cancelled';

export interface InvoiceView extends SalesInvoice {
  state: InvoiceState;
  daysOverdue?: number;
}

export interface SupplierBill extends DeskEntity {
  supplier: { name: string; nif?: string };
  payee: MobilePayee;
  reference: string;
  issueDate: string;
  dueDate: string;
  amount: Money;
  vat: Money;
  recordedBy: string;
  /** Lot qui le paie (ou l'a tenté en dernier). */
  batchId?: string;
}

export type BillState = 'to_pay' | 'overdue' | 'awaiting_approval' | 'processing' | 'paid';

export interface BillView extends SupplierBill {
  state: BillState;
  lastFailure?: string;
  paidOn?: string;
}

export interface BatchLine {
  /** Facture fournisseur ou salarié payé. */
  ref: string;
  beneficiary: string;
  destination: PaymentDestination;
  amount: Money;
  label: string;
  paymentId?: string;
  error?: string;
}

export interface PaymentBatch extends DeskEntity {
  kind: 'suppliers' | 'payroll';
  reference: string;
  period?: string;
  sourceAccountId: string;
  lines: BatchLine[];
  total: Money;
  estimatedFees: Money;
  status: 'pending_approval' | 'executing' | 'executed' | 'rejected';
  initiatedBy: string;
  initiatedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  rejectionReason?: string;
}

export interface BatchLineView extends Omit<BatchLine, 'destination' | 'amount'> {
  destination?: PaymentDestination;
  amount?: Money;
  status: 'pending' | Payment['status'] | 'error';
}

export interface BatchView extends Omit<PaymentBatch, 'lines'> {
  lines: BatchLineView[];
  /** Les lignes d'une paie (salaires nominatifs) ne sont montrées qu'à la RH et à qui l'approuve. */
  linesHidden: boolean;
  counts: { completed: number; processing: number; failed: number; pending: number };
  sourceLabel: string;
}

export interface VatComputation {
  period: string;
  collected: Money;
  deductible: Money;
  creditBrought: Money;
  /** Positif : à payer ; zéro : rien à payer (crédit éventuel reporté). */
  due: Money;
  creditCarried: Money;
  invoices: number;
  bills: number;
  deadline: string;
}

export interface VatReturn extends DeskEntity, VatComputation {
  sourceAccountId?: string;
  paymentId?: string;
  attempts: number;
  preparedBy: string;
  preparedAt: string;
}

export type VatState = 'filed' | 'awaiting_approval' | 'paying' | 'payment_failed';

export interface VatReturnView extends VatReturn {
  state: VatState;
  acknowledgement?: string;
}

export interface Employee extends DeskEntity {
  fullName: string;
  nin: string;
  position: string;
  hiredOn: string;
  monthlyNet: Money;
  payout: MobilePayee;
  status: 'active' | 'left';
  leftOn?: string;
}

export interface Certificate extends DeskEntity {
  employeeId: string;
  documentId: string;
  verificationCode: string;
  holderName: string;
  holderNin: string;
  issuedOn: string;
  issuedBy: string;
  fields: { label: string; value: string }[];
  employerName: string;
}

export interface ForecastItem {
  kind: 'receivable' | 'payable' | 'payroll' | 'vat';
  label: string;
  amount: Money;
}

export interface ForecastDay {
  date: string;
  inflows: Money;
  outflows: Money;
  balance: Money;
  items: ForecastItem[];
  tension: boolean;
}

export interface TreasuryView {
  asOf: string;
  /** Disponible en GNF, celui qui paie les échéances. */
  cash: Money;
  /** Avoirs en devises, à part : ils ne paient pas une échéance en GNF sans conversion. */
  foreign: { accountId: string; label: string; balance: Money; referenceValue?: Money }[];
  partial: boolean;
  byRail: { kind: AccountKind; total: Money; accounts: number }[];
  accounts: { id: string; label: string; kind: AccountKind; balance?: Money; freshness: AccountPosition['freshness'] }[];
  projection: ForecastDay[];
  overdueReceivables: Money;
  overduePayables: Money;
  lowest: { date: string; balance: Money };
  tension: boolean;
}

export interface RailOption {
  accountId: string;
  label: string;
  kind: AccountKind;
  balance?: Money;
  fees: Money;
  sufficient: boolean;
  recommended: boolean;
}

export interface ScoreCriterion {
  key: 'collections' | 'supplier_punctuality' | 'tax_compliance' | 'cash_cushion' | 'legal_file';
  label: string;
  weight: number;
  score: number;
  detail: string;
}

export interface BusinessScore {
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'E';
  criteria: ScoreCriterion[];
  computedAt: string;
  notice: string;
}

export interface InvoiceInput {
  customer: Customer;
  lines: { description: string; quantity: number | string; unitPrice: string | number }[];
  vatRateBps?: number;
  issueDate?: string;
  dueInDays?: number;
}

export interface BillInput {
  supplier: { name: string; nif?: string };
  payee: MobilePayee;
  reference: string;
  amount: string | number;
  vat?: string | number;
  issueDate?: string;
  dueDate: string;
}

export interface EmployeeInput {
  fullName: string;
  nin: string;
  position: string;
  hiredOn: string;
  monthlyNet: string | number;
  payout: MobilePayee;
}

// ── Frais des rails (barème simulé) ──────────────────────────────────────────

/**
 * Coût d'un versement vers un wallet Mobile Money selon le compte débité. Barème de démonstration, à
 * remplacer par la grille négociée avec chaque rail (ORCHEA la tient) : même opérateur 0,5 %, autre
 * opérateur 1,5 %, banque 1 %, wallet App GN 1,2 %.
 */
export function railFeeBps(source: LinkedAccount, operator: string): number {
  const kind = providerById(source.providerId)?.kind;
  if (kind === 'mobile_money') return source.providerId === operator ? 50 : 150;
  if (kind === 'bank') return 100;
  return 120;
}

function batchNeedsApproval(kind: PaymentBatch['kind'], total: Money, role: Role): boolean {
  if (can(role, 'payments:approve')) return false;
  if (kind === 'payroll') return true;
  return toBigInt(total) >= toBigInt(BUSINESS_APPROVAL_THRESHOLD);
}

function invoiceSealPayload(invoice: Omit<SalesInvoice, 'seal' | 'status' | 'settlement' | 'cancellation'>): string {
  return canonical({
    number: invoice.number,
    spaceId: invoice.spaceId,
    customer: invoice.customer,
    lines: invoice.lines,
    vatRateBps: invoice.vatRateBps,
    subtotal: invoice.subtotal,
    vat: invoice.vat,
    total: invoice.total,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    issuedBy: invoice.issuedBy,
  });
}

interface Context {
  space: BusinessSpace;
  role: Role;
  personName: string;
  today: string;
  at: string;
}

export class BusinessDesk {
  private readonly app: AppGn;
  private readonly store: DeskStore;
  private readonly audit: AuditTrail;

  constructor(app: AppGn, store: DeskStore) {
    this.app = app;
    this.store = store;
    this.audit = new AuditTrail(store);
  }

  /** Redépose dans les coffres personnels les attestations émises avant un redémarrage. */
  async load(spaceIds: readonly string[]): Promise<void> {
    for (const spaceId of spaceIds) {
      for (const { value } of await this.store.list<Certificate>('certificates', spaceId)) this.deposit(value);
    }
  }

  // ── Trésorerie ────────────────────────────────────────────────────────────

  async treasury(actor: Actor, spaceId: string): Promise<TreasuryView> {
    const context = this.context(actor, spaceId, ['payments:initiate', 'reports:read']);
    const overview = await this.app.overview(actor, spaceId);
    let cash = 0n;
    const foreign: TreasuryView['foreign'] = [];
    for (const position of overview.positions) {
      if (!position.balance) continue;
      if (position.balance.currency === 'GNF') cash += toBigInt(position.balance);
      else foreign.push({ accountId: position.account.id, label: position.account.label, balance: position.balance, ...(position.referenceValue ? { referenceValue: position.referenceValue } : {}) });
    }

    const { today } = context;
    const horizon = addDays(today, PROJECTION_DAYS);
    const schedule = new Map<string, ForecastItem[]>();
    const plan = (date: string, item: ForecastItem) => {
      const day = date < today ? today : date;
      if (day > horizon) return;
      schedule.set(day, [...(schedule.get(day) ?? []), item]);
    };

    let overdueReceivables = 0n;
    for (const invoice of await this.invoiceViews(spaceId, today)) {
      if (invoice.state === 'overdue') overdueReceivables += toBigInt(invoice.total);
      // Une créance en retard n'est pas comptée comme encaissement attendu : prudence.
      if (invoice.state === 'issued') plan(invoice.dueDate, { kind: 'receivable', label: `${invoice.number} · ${invoice.customer.name}`, amount: invoice.total });
    }
    let overduePayables = 0n;
    for (const bill of await this.billViews(actor, spaceId, today)) {
      if (bill.state === 'overdue') overduePayables += toBigInt(bill.amount);
      if (['to_pay', 'overdue', 'awaiting_approval'].includes(bill.state)) {
        plan(bill.dueDate, { kind: 'payable', label: `${bill.supplier.name} · ${bill.reference}`, amount: bill.amount });
      }
    }
    const batches = await this.batchRecords(spaceId);
    for (const batch of batches) {
      if (batch.kind === 'payroll' && batch.status === 'pending_approval') plan(today, { kind: 'payroll', label: `Paie ${batch.period} (à approuver)`, amount: batch.total });
    }
    // Paie du mois en cours, versée le dernier jour du mois si elle n'est pas encore préparée.
    const endOfMonth = addDays(`${addDays(`${periodOf(today)}-01`, 32).slice(0, 7)}-01`, -1);
    if (!batches.some((batch) => batch.kind === 'payroll' && batch.period === periodOf(today) && batch.status !== 'rejected')) {
      const payroll = sum((await this.employeeRecords(spaceId)).filter((employee) => employee.status === 'active').map((employee) => employee.monthlyNet));
      if (toBigInt(payroll) > 0n) plan(endOfMonth, { kind: 'payroll', label: `Paie ${periodOf(today)} (prévue)`, amount: payroll });
    }
    // TVA du mois écoulé, à verser avant le 15.
    const previous = periodOf(addDays(`${periodOf(today)}-01`, -1));
    const filed = await this.store.get<VatReturn>('vat_returns', `${spaceId}:${previous}`);
    if (!filed) {
      const vat = await this.computeVat(spaceId, previous);
      if (toBigInt(vat.due) > 0n) plan(vat.deadline, { kind: 'vat', label: `TVA ${previous}`, amount: vat.due });
    }

    const projection: ForecastDay[] = [];
    let balance = cash;
    let lowest = { date: today, balance: gnf(cash) };
    for (let offset = 0; offset <= PROJECTION_DAYS; offset += 1) {
      const date = addDays(today, offset);
      const items = schedule.get(date) ?? [];
      const inflows = items.filter((item) => item.kind === 'receivable').reduce((total, item) => total + toBigInt(item.amount), 0n);
      const outflows = items.filter((item) => item.kind !== 'receivable').reduce((total, item) => total + toBigInt(item.amount), 0n);
      balance += inflows - outflows;
      projection.push({ date, inflows: gnf(inflows), outflows: gnf(outflows), balance: gnf(balance), items, tension: balance < 0n });
      if (balance < toBigInt(lowest.balance)) lowest = { date, balance: gnf(balance) };
    }

    return {
      asOf: overview.generatedAt,
      cash: gnf(cash),
      foreign,
      partial: overview.partial,
      byRail: overview.byKind,
      accounts: overview.positions.map((position) => ({
        id: position.account.id,
        label: position.account.label,
        kind: position.kind,
        ...(position.balance ? { balance: position.balance } : {}),
        freshness: position.freshness,
      })),
      projection,
      overdueReceivables: gnf(overdueReceivables),
      overduePayables: gnf(overduePayables),
      lowest,
      tension: projection.some((day) => day.tension),
    };
  }

  // ── Factures de vente ─────────────────────────────────────────────────────

  async invoices(actor: Actor, spaceId: string): Promise<{ invoices: InvoiceView[]; chain: ChainCheck; outstanding: Money; overdue: Money }> {
    const { today } = this.context(actor, spaceId, ['invoices:write', 'reports:read']);
    const invoices = await this.invoiceViews(spaceId, today);
    return {
      invoices: [...invoices].reverse(),
      chain: await this.verifyInvoiceChain(spaceId, invoices),
      outstanding: sum(invoices.filter((invoice) => invoice.state === 'issued' || invoice.state === 'overdue').map((invoice) => invoice.total)),
      overdue: sum(invoices.filter((invoice) => invoice.state === 'overdue').map((invoice) => invoice.total)),
    };
  }

  /**
   * Émet une facture : numéro suivant de l'année (FAC-AAAA-NNNN, sans trou), TVA calculée ligne à ligne,
   * scellée par une empreinte qui inclut celle de la facture précédente. Une facture émise ne se modifie pas.
   */
  async issueInvoice(actor: Actor, spaceId: string, input: InvoiceInput, idempotencyKey: string): Promise<InvoiceView> {
    const context = this.context(actor, spaceId, 'invoices:write');
    const customer = {
      name: text(input?.customer?.name, 'nom du client', 120),
      ...(optionalText(input?.customer?.phone, 30) ? { phone: optionalText(input.customer.phone, 30)! } : {}),
      ...(optionalText(input?.customer?.nif, 30) ? { nif: optionalText(input.customer.nif, 30)! } : {}),
    };
    if (!Array.isArray(input?.lines) || input.lines.length === 0 || input.lines.length > 100) throw new AppError('invalid_request', 'de 1 à 100 lignes');
    const lines = input.lines.map((line, index) => {
      const quantity = Number(line?.quantity);
      if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 1_000_000) throw new AppError('invalid_request', `ligne ${index + 1} : quantité entière positive attendue`);
      const unitPrice = parseGnf(line?.unitPrice, `ligne ${index + 1}`);
      return { description: text(line?.description, `ligne ${index + 1} : désignation`, 200), quantity, unitPrice, total: gnf(toBigInt(unitPrice) * BigInt(quantity)) };
    });
    const vatRateBps = input.vatRateBps ?? DEFAULT_VAT_RATE_BPS;
    if (![0, DEFAULT_VAT_RATE_BPS].includes(vatRateBps)) throw new AppError('invalid_request', 'TVA : 18 % ou exonéré (0)');
    const issueDate = input.issueDate ?? context.today;
    if (!isDay(issueDate) || issueDate > context.today || daysBetween(issueDate, context.today) > 90) throw new AppError('invalid_request', 'date de facture : aujourd’hui ou dans les 90 derniers jours');
    const dueInDays = input.dueInDays ?? 30;
    if (!Number.isInteger(dueInDays) || dueInDays < 0 || dueInDays > 120) throw new AppError('invalid_request', 'échéance : de 0 à 120 jours');
    if (await this.periodLocked(spaceId, periodOf(issueDate))) throw new AppError('invalid_state', `la TVA de ${periodOf(issueDate)} est déjà déclarée : datez la facture d’aujourd’hui`);

    const id = randomId('inv');
    const claim = await claimKey(this.store, spaceId, actor.personId, 'invoice', idempotencyKey, input, id);
    if (claim.conflict) throw new AppError('idempotency_conflict', 'cette clé a déjà servi pour une autre demande');
    if (claim.replay) return this.invoiceView((await this.store.get<SalesInvoice>('invoices', claim.replay))!.value, context.today);

    const subtotal = sum(lines.map((line) => line.total));
    const vat = share(subtotal, vatRateBps);
    const year = issueDate.slice(0, 4);
    let invoice: SalesInvoice | undefined;
    await nextInChain(this.store, spaceId, `FAC-${year}`, async (sequence, previous) => {
      const latest = await this.latestInvoice(spaceId, year);
      // Les numéros suivent l'ordre des dates : une facture ne peut pas être antidatée avant la précédente.
      if (latest && latest.issueDate > issueDate) throw new AppError('invalid_state', `date antérieure à la facture ${latest.number}`);
      const draft = {
        id, spaceId, number: `FAC-${year}-${String(sequence).padStart(4, '0')}`, customer, lines, vatRateBps, subtotal, vat,
        total: gnf(toBigInt(subtotal) + toBigInt(vat)), issueDate, dueDate: addDays(issueDate, dueInDays), issuedBy: actor.personId,
      };
      const hash = await sha256(previous + invoiceSealPayload(draft));
      invoice = { ...draft, status: 'issued', seal: { previous, hash } };
      return hash;
    });
    await this.store.insert('invoices', invoice!);
    await this.record(context, actor, 'invoice.issued', invoice!.id, `Facture ${invoice!.number} · ${customer.name} · ${toMajor(invoice!.total)} GNF`);
    return this.invoiceView(invoice!, context.today);
  }

  /** Marque une facture comme encaissée, avec le compte (et le mouvement) qui l'a reçue. */
  async settleInvoice(actor: Actor, spaceId: string, invoiceId: string, input: { accountId: string; transactionId?: string; receivedOn?: string }): Promise<InvoiceView> {
    const context = this.context(actor, spaceId, 'invoices:write');
    if (!this.app.linkedAccounts(spaceId).some((account) => account.id === input?.accountId)) throw new AppError('not_found', 'compte introuvable dans cet espace');
    const receivedOn = input.receivedOn ?? context.today;
    if (!isDay(receivedOn) || receivedOn > context.today) throw new AppError('invalid_request', 'date d’encaissement : aujourd’hui ou avant');
    const invoice = await mutate<SalesInvoice>(this.store, 'invoices', invoiceId, (current) => {
      if (!current || current.spaceId !== spaceId) throw new AppError('not_found', 'facture introuvable');
      if (current.status !== 'issued') throw new AppError('invalid_state', `facture déjà ${current.status === 'paid' ? 'encaissée' : 'annulée'}`);
      if (receivedOn < current.issueDate) throw new AppError('invalid_request', 'encaissement antérieur à la facture');
      return { ...current, status: 'paid', settlement: { accountId: input.accountId, ...(input.transactionId ? { transactionId: String(input.transactionId) } : {}), on: receivedOn, by: actor.personId } };
    });
    await this.record(context, actor, 'invoice.settled', invoice.id, `Facture ${invoice.number} encaissée`);
    return this.invoiceView(invoice, context.today);
  }

  /**
   * Annule une facture émise. Elle garde son numéro (pas de trou), sort du chiffre d'affaires et de la TVA,
   * et le journal comptable la contre-passe. Refusé si la TVA de son mois est déjà déclarée.
   */
  async cancelInvoice(actor: Actor, spaceId: string, invoiceId: string, reason: string): Promise<InvoiceView> {
    const context = this.context(actor, spaceId, 'invoices:write');
    const motive = text(reason, 'motif d’annulation', 300);
    const existing = (await this.store.get<SalesInvoice>('invoices', invoiceId))?.value;
    if (!existing || existing.spaceId !== spaceId) throw new AppError('not_found', 'facture introuvable');
    if (await this.periodLocked(spaceId, periodOf(existing.issueDate))) throw new AppError('invalid_state', 'TVA de ce mois déjà déclarée : émettez un avoir le mois en cours');
    const invoice = await mutate<SalesInvoice>(this.store, 'invoices', invoiceId, (current) => {
      if (!current || current.status !== 'issued') throw new AppError('invalid_state', 'seule une facture émise et non encaissée s’annule');
      return { ...current, status: 'cancelled', cancellation: { on: context.today, by: actor.personId, reason: motive } };
    });
    await this.record(context, actor, 'invoice.cancelled', invoice.id, `Facture ${invoice.number} annulée : ${motive}`);
    return this.invoiceView(invoice, context.today);
  }

  /** Encaissements reçus qui correspondent au montant exact d'une facture ouverte, depuis sa date d'émission. */
  async reconciliation(actor: Actor, spaceId: string): Promise<{ invoiceId: string; number: string; accountId: string; accountLabel: string; transactionId: string; occurredAt: string; amount: Money; counterparty?: string }[]> {
    const { today } = this.context(actor, spaceId, 'invoices:write');
    const open = (await this.invoiceViews(spaceId, today)).filter((invoice) => invoice.state === 'issued' || invoice.state === 'overdue');
    if (open.length === 0) return [];
    const used = new Set((await this.invoiceRecords(spaceId)).map((invoice) => invoice.settlement?.transactionId).filter(Boolean));
    const suggestions = [];
    for (const account of this.app.linkedAccounts(spaceId).filter((candidate) => candidate.currency === 'GNF')) {
      for (const transaction of await this.app.transactions(actor, spaceId, account.id, 100)) {
        if (transaction.direction !== 'credit' || used.has(transaction.id)) continue;
        const match = open.find((invoice) => invoice.total.amount === transaction.amount.amount && transaction.occurredAt.slice(0, 10) >= invoice.issueDate);
        if (!match) continue;
        used.add(transaction.id);
        suggestions.push({
          invoiceId: match.id, number: match.number, accountId: account.id, accountLabel: account.label, transactionId: transaction.id,
          occurredAt: transaction.occurredAt, amount: transaction.amount, ...(transaction.counterparty ? { counterparty: transaction.counterparty } : {}),
        });
      }
    }
    return suggestions;
  }

  // ── Fournisseurs ───────────────────────────────────────────────────────────

  async bills(actor: Actor, spaceId: string): Promise<BillView[]> {
    const { today } = this.context(actor, spaceId, ['invoices:write', 'payments:initiate', 'reports:read']);
    return (await this.billViews(actor, spaceId, today)).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  }

  async recordBill(actor: Actor, spaceId: string, input: BillInput, idempotencyKey: string): Promise<BillView> {
    const context = this.context(actor, spaceId, 'invoices:write');
    const amount = parseGnf(input?.amount, 'montant TTC');
    const vat = input?.vat === undefined || input.vat === '' || Number(input.vat) === 0 ? gnf(0) : parseGnf(input.vat, 'TVA déductible');
    if (toBigInt(vat) >= toBigInt(amount)) throw new AppError('invalid_request', 'la TVA dépasse le montant TTC');
    const issueDate = input.issueDate ?? context.today;
    if (!isDay(issueDate) || issueDate > context.today) throw new AppError('invalid_request', 'date de facture invalide');
    if (!isDay(input.dueDate) || input.dueDate < issueDate) throw new AppError('invalid_request', 'échéance invalide');
    const bill: SupplierBill = {
      id: randomId('bil'),
      spaceId,
      supplier: { name: text(input.supplier?.name, 'fournisseur', 120), ...(optionalText(input.supplier?.nif, 30) ? { nif: optionalText(input.supplier.nif, 30)! } : {}) },
      payee: payee(input.payee, 'fournisseur'),
      reference: text(input.reference, 'numéro de facture fournisseur', 60),
      issueDate,
      dueDate: input.dueDate,
      amount,
      vat,
      recordedBy: actor.personId,
    };
    const duplicate = (await this.billRecords(spaceId)).find((candidate) => candidate.supplier.name.toLowerCase() === bill.supplier.name.toLowerCase() && candidate.reference === bill.reference);
    if (duplicate) throw new AppError('invalid_state', `facture ${bill.reference} de ${bill.supplier.name} déjà enregistrée`);
    const claim = await claimKey(this.store, spaceId, actor.personId, 'bill', idempotencyKey, input, bill.id);
    if (claim.conflict) throw new AppError('idempotency_conflict', 'cette clé a déjà servi pour une autre demande');
    if (!claim.replay) {
      await this.store.insert('bills', bill);
      await this.record(context, actor, 'bill.recorded', bill.id, `Facture fournisseur ${bill.reference} · ${bill.supplier.name} · ${toMajor(amount)} GNF`);
    }
    return (await this.billViews(actor, spaceId, context.today)).find((candidate) => candidate.id === (claim.replay ?? bill.id))!;
  }

  /** Coût du lot depuis chaque compte en GNF de l'entreprise ; le moins cher qui couvre le lot est recommandé. */
  async previewSupplierBatch(actor: Actor, spaceId: string, billIds: readonly string[]): Promise<{ total: Money; lines: number; options: RailOption[] }> {
    const { today } = this.context(actor, spaceId, 'payments:initiate');
    const bills = await this.payableBills(actor, spaceId, billIds, today);
    return { total: sum(bills.map((bill) => bill.amount)), lines: bills.length, options: await this.railOptions(actor, spaceId, bills.map((bill) => ({ operator: bill.payee.operator, amount: bill.amount }))) };
  }

  /**
   * Paie des factures fournisseurs en un lot. Au-delà de 5 M GNF, un lot préparé par qui ne peut pas
   * approuver attend le dirigeant ; sinon il part tout de suite. Chaque ligne devient un paiement distinct,
   * sous une clé dérivée du lot : rejouer l'exécution ne paie jamais deux fois.
   */
  async createSupplierBatch(actor: Actor, spaceId: string, input: { billIds: string[]; sourceAccountId: string }, idempotencyKey: string): Promise<BatchView> {
    const context = this.context(actor, spaceId, 'payments:initiate');
    const bills = await this.payableBills(actor, spaceId, input?.billIds ?? [], context.today);
    const source = this.debitAccount(spaceId, input?.sourceAccountId);
    const lines: BatchLine[] = bills.map((bill) => ({
      ref: bill.id,
      beneficiary: bill.supplier.name,
      destination: { type: 'mobile_money', operator: bill.payee.operator, phone: bill.payee.phone, name: bill.supplier.name },
      amount: bill.amount,
      label: `${bill.supplier.name} · ${bill.reference}`,
    }));
    return this.createBatch(actor, context, { kind: 'suppliers', source, lines, reference: `LOT-${context.today}` }, idempotencyKey, [...(input?.billIds ?? [])].sort());
  }

  async batches(actor: Actor, spaceId: string): Promise<BatchView[]> {
    const { role } = this.context(actor, spaceId, ['payments:initiate', 'payments:approve', 'payroll:submit', 'reports:read']);
    const seesSuppliers = ['payments:initiate', 'payments:approve', 'reports:read'].some((permission) => can(role, permission as Permission));
    const payments = await this.paymentMap(actor, spaceId);
    return (await this.batchRecords(spaceId))
      .filter((batch) => batch.kind === 'payroll' || seesSuppliers)
      .reverse()
      .map((batch) => this.batchView(batch, role, payments));
  }

  async approveBatch(actor: Actor, spaceId: string, batchId: string): Promise<BatchView> {
    const context = this.context(actor, spaceId, 'payments:approve');
    const record = await this.store.get<PaymentBatch>('batches', batchId);
    if (!record || record.value.spaceId !== spaceId) throw new AppError('not_found', 'lot introuvable');
    const batch = record.value;
    if (batch.status !== 'pending_approval') throw new AppError('invalid_state', 'lot déjà décidé');
    if (batch.initiatedBy === actor.personId) throw new AppError('separation_of_duties', 'qui prépare un lot ne l’approuve pas');
    const claimed: PaymentBatch = { ...batch, status: 'executing', decidedBy: actor.personId, decidedAt: context.at };
    if (!await this.store.update('batches', claimed, record.version)) throw new AppError('invalid_state', 'lot déjà décidé');
    await this.record(context, actor, 'batch.approved', batch.id, `${batch.reference} approuvé · ${batch.lines.length} lignes · ${toMajor(batch.total)} GNF`);
    const executed = await this.execute(actor, claimed);
    return this.batchView(executed, context.role, await this.paymentMap(actor, spaceId));
  }

  async rejectBatch(actor: Actor, spaceId: string, batchId: string, reason: string): Promise<BatchView> {
    const context = this.context(actor, spaceId, 'payments:approve');
    const motive = text(reason, 'motif du refus', 300);
    const batch = await mutate<PaymentBatch>(this.store, 'batches', batchId, (current) => {
      if (!current || current.spaceId !== spaceId) throw new AppError('not_found', 'lot introuvable');
      if (current.status !== 'pending_approval') throw new AppError('invalid_state', 'lot déjà décidé');
      return { ...current, status: 'rejected', decidedBy: actor.personId, decidedAt: context.at, rejectionReason: motive };
    });
    await this.record(context, actor, 'batch.rejected', batch.id, `${batch.reference} refusé : ${motive}`);
    return this.batchView(batch, context.role, await this.paymentMap(actor, spaceId));
  }

  // ── TVA ───────────────────────────────────────────────────────────────────

  /** Déclarations passées et mois clos encore à déclarer (les trois derniers). */
  async vat(actor: Actor, spaceId: string): Promise<{ returns: VatReturnView[]; open: VatComputation[]; rateBps: number }> {
    const { today } = this.context(actor, spaceId, ['tax:declare', 'reports:read']);
    const payments = await this.paymentMap(actor, spaceId);
    const returns = (await this.store.list<VatReturn>('vat_returns', spaceId)).map(({ value }) => this.vatView(value, payments));
    const open: VatComputation[] = [];
    let month = `${periodOf(today)}-01`;
    for (let index = 0; index < 3; index += 1) {
      month = `${periodOf(addDays(month, -1))}-01`;
      const period = periodOf(month);
      const existing = returns.find((candidate) => candidate.period === period);
      if (!existing || existing.state === 'payment_failed') open.push(await this.computeVat(spaceId, period));
    }
    return { returns: returns.sort((a, b) => b.period.localeCompare(a.period)), open, rateBps: DEFAULT_VAT_RATE_BPS };
  }

  async vatPreview(actor: Actor, spaceId: string, period: string): Promise<VatComputation> {
    const { today } = this.context(actor, spaceId, ['tax:declare', 'reports:read']);
    this.closedPeriod(period, today);
    return this.computeVat(spaceId, period);
  }

  /**
   * Déclare la TVA d'un mois clos et la paie à la DGI dans le même geste : la déclaration n'est acquise
   * que si le paiement l'est. Sans montant dû, elle est déposée tout de suite et le crédit est reporté.
   * Un mois ne se déclare qu'une fois ; après un paiement échoué, on peut recommencer.
   */
  async fileVat(actor: Actor, spaceId: string, input: { period: string; sourceAccountId?: string }, idempotencyKey: string): Promise<VatReturnView> {
    const context = this.context(actor, spaceId, 'tax:declare');
    const period = input?.period;
    this.closedPeriod(period, context.today);
    const id = `${spaceId}:${period}`;
    const claim = await claimKey(this.store, spaceId, actor.personId, 'vat', idempotencyKey, input, id);
    if (claim.conflict) throw new AppError('idempotency_conflict', 'cette clé a déjà servi pour une autre demande');
    const payments = await this.paymentMap(actor, spaceId);
    if (claim.replay) {
      const existing = await this.store.get<VatReturn>('vat_returns', id);
      if (existing) return this.vatView(existing.value, payments);
    }

    const computation = await this.computeVat(spaceId, period);
    const record = await this.store.get<VatReturn>('vat_returns', id);
    if (record && this.vatView(record.value, payments).state !== 'payment_failed') throw new AppError('invalid_state', `TVA ${period} déjà déclarée`);
    const due = toBigInt(computation.due) > 0n;
    const source = due ? this.debitAccount(spaceId, input.sourceAccountId) : undefined;
    const attempts = (record?.value.attempts ?? 0) + 1;
    const draft: VatReturn = {
      ...computation, id, spaceId, attempts, preparedBy: actor.personId, preparedAt: context.at,
      ...(source ? { sourceAccountId: source.id } : {}),
    };
    const written = record ? await this.store.update('vat_returns', draft, record.version) : await this.store.insert('vat_returns', draft);
    if (!written) throw new AppError('invalid_state', `TVA ${period} : une déclaration est déjà en cours`);
    if (due) {
      const payment = await this.app.initiatePayment(actor, spaceId, {
        sourceAccountId: source!.id,
        amount: toMajor(computation.due),
        destination: { type: 'biller', billerId: 'dgi', customerReference: `NIF ${context.space.nif} · TVA ${period}` },
        label: `TVA ${period}`,
      }, `${id}:${attempts}`);
      await mutate<VatReturn>(this.store, 'vat_returns', id, (current) => ({ ...current!, paymentId: payment.id }));
      draft.paymentId = payment.id;
      payments.set(payment.id, payment);
    }
    await this.record(context, actor, 'vat.filed', id, `TVA ${period} · collectée ${toMajor(computation.collected)} · déductible ${toMajor(computation.deductible)} · due ${toMajor(computation.due)} GNF`);
    return this.vatView(draft, payments);
  }

  // ── Équipe ──────────────────────────────────────────────────────────────

  async employees(actor: Actor, spaceId: string): Promise<{ employees: Employee[]; certificates: Certificate[]; monthlyPayroll: Money }> {
    this.context(actor, spaceId, 'payroll:submit');
    const employees = await this.employeeRecords(spaceId);
    return {
      employees,
      certificates: (await this.store.list<Certificate>('certificates', spaceId)).map((record) => record.value).reverse(),
      monthlyPayroll: sum(employees.filter((employee) => employee.status === 'active').map((employee) => employee.monthlyNet)),
    };
  }

  async hire(actor: Actor, spaceId: string, input: EmployeeInput, idempotencyKey: string): Promise<Employee> {
    const context = this.context(actor, spaceId, 'payroll:submit');
    const nin = normalizedNin(input?.nin);
    if (!nin) throw new AppError('invalid_request', 'NIN invalide (GN-NIN- et 10 chiffres)');
    if (!isDay(input.hiredOn) || input.hiredOn > addDays(context.today, 60)) throw new AppError('invalid_request', 'date d’embauche invalide');
    const employee: Employee = {
      id: randomId('emp'),
      spaceId,
      fullName: text(input.fullName, 'nom', 120),
      nin,
      position: text(input.position, 'poste', 120),
      hiredOn: input.hiredOn,
      monthlyNet: parseGnf(input.monthlyNet, 'salaire net mensuel'),
      payout: payee(input.payout, 'versement du salaire'),
      status: 'active',
    };
    if ((await this.employeeRecords(spaceId)).some((candidate) => candidate.status === 'active' && candidate.nin === nin)) throw new AppError('invalid_state', 'ce NIN figure déjà au registre');
    const claim = await claimKey(this.store, spaceId, actor.personId, 'hire', idempotencyKey, input, employee.id);
    if (claim.conflict) throw new AppError('idempotency_conflict', 'cette clé a déjà servi pour une autre demande');
    if (claim.replay) return (await this.store.get<Employee>('employees', claim.replay))!.value;
    await this.store.insert('employees', employee);
    await this.record(context, actor, 'employee.hired', employee.id, `${employee.fullName} · ${employee.position}`);
    return employee;
  }

  async endContract(actor: Actor, spaceId: string, employeeId: string, leftOn: string): Promise<Employee> {
    const context = this.context(actor, spaceId, 'payroll:submit');
    if (!isDay(leftOn)) throw new AppError('invalid_request', 'date de sortie invalide');
    const employee = await mutate<Employee>(this.store, 'employees', employeeId, (current) => {
      if (!current || current.spaceId !== spaceId) throw new AppError('not_found', 'salarié introuvable');
      if (current.status === 'left') throw new AppError('invalid_state', 'contrat déjà terminé');
      if (leftOn < current.hiredOn) throw new AppError('invalid_request', 'sortie antérieure à l’embauche');
      return { ...current, status: 'left', leftOn };
    });
    await this.record(context, actor, 'employee.left', employee.id, `${employee.fullName} · sortie le ${leftOn}`);
    return employee;
  }

  /**
   * Attestation de travail : émise au nom de l'entreprise, vérifiable par son code, et déposée dans le
   * coffre personnel du salarié s'il utilise App GN. La réponse est la même dans les deux cas.
   */
  async issueCertificate(actor: Actor, spaceId: string, employeeId: string): Promise<Certificate> {
    const context = this.context(actor, spaceId, 'payroll:submit');
    if (!can(context.role, 'documents:write')) throw new AppError('forbidden', 'votre rôle ne permet pas : documents:write');
    const employee = (await this.store.get<Employee>('employees', employeeId))?.value;
    if (!employee || employee.spaceId !== spaceId) throw new AppError('not_found', 'salarié introuvable');
    const certificate: Certificate = {
      id: randomId('crt'),
      spaceId,
      employeeId,
      documentId: randomId('doc_att'),
      verificationCode: verificationCode('AT'),
      holderName: employee.fullName,
      holderNin: employee.nin,
      issuedOn: context.today,
      issuedBy: actor.personId,
      employerName: `${context.space.name} ${context.space.legalForm}`,
      fields: [
        { label: 'Employeur', value: `${context.space.name} ${context.space.legalForm} · RCCM ${context.space.rccm}` },
        { label: 'Poste', value: employee.position },
        { label: 'Depuis le', value: employee.hiredOn.split('-').reverse().join('/') },
        { label: 'Situation', value: employee.status === 'active' ? 'En poste' : `Sorti le ${employee.leftOn!.split('-').reverse().join('/')}` },
        { label: 'Signataire', value: context.personName },
      ],
    };
    await this.store.insert('certificates', certificate);
    this.deposit(certificate);
    await this.record(context, actor, 'certificate.issued', certificate.id, `Attestation de travail · ${employee.fullName}`);
    return certificate;
  }

  /**
   * Prépare la paie d'un mois : une ligne par salarié actif, versée sur son wallet. Préparée par la RH,
   * elle attend toujours l'approbation du dirigeant (qui n'est pas celui qui l'a préparée).
   */
  async preparePayroll(actor: Actor, spaceId: string, input: { period: string; sourceAccountId: string }, idempotencyKey: string): Promise<BatchView> {
    const context = this.context(actor, spaceId, 'payroll:submit');
    const period = input?.period;
    if (!isPeriod(period) || period > periodOf(context.today) || period < periodOf(addDays(context.today, -62))) throw new AppError('invalid_request', 'mois de paie : le mois en cours ou l’un des deux précédents');
    const existing = (await this.batchRecords(spaceId)).find((batch) => batch.kind === 'payroll' && batch.period === period && batch.status !== 'rejected');
    const source = this.debitAccount(spaceId, input.sourceAccountId);
    const employees = (await this.employeeRecords(spaceId)).filter((employee) => employee.status === 'active' && employee.hiredOn <= `${period}-31`);
    if (employees.length === 0) throw new AppError('invalid_state', 'aucun salarié actif ce mois');
    const lines: BatchLine[] = employees.map((employee) => ({
      ref: employee.id,
      beneficiary: employee.fullName,
      destination: { type: 'mobile_money', operator: employee.payout.operator, phone: employee.payout.phone, name: employee.fullName },
      amount: employee.monthlyNet,
      label: `Salaire ${period} · ${employee.fullName}`,
    }));
    return this.createBatch(actor, context, { kind: 'payroll', source, lines, reference: `PAIE-${period}`, period }, idempotencyKey, [period, source.id], existing);
  }

  // ── Score, journal, audit ───────────────────────────────────────────────

  async score(actor: Actor, spaceId: string): Promise<BusinessScore> {
    const context = this.context(actor, spaceId, 'reports:read');
    const { today } = context;
    const since = addDays(today, -90);
    const invoices = (await this.invoiceRecords(spaceId)).filter((invoice) => invoice.status !== 'cancelled' && invoice.dueDate >= since && invoice.dueDate <= today);
    const onTime = invoices.filter((invoice) => invoice.status === 'paid' && invoice.settlement!.on <= invoice.dueDate).length;
    const collections = invoices.length ? Math.round((onTime / invoices.length) * 100) : 50;

    const payments = await this.paymentMap(actor, spaceId);
    const bills = (await this.billViews(actor, spaceId, today)).filter((bill) => bill.dueDate >= since && bill.dueDate <= today);
    const paidOnTime = bills.filter((bill) => bill.state === 'paid' && (bill.paidOn ?? today) <= bill.dueDate).length;
    const punctuality = bills.length ? Math.round((paidOnTime / bills.length) * 100) : 50;

    const returns = new Map((await this.store.list<VatReturn>('vat_returns', spaceId)).map(({ value }) => [value.period, this.vatView(value, payments)]));
    let month = `${periodOf(today)}-01`;
    let filedCount = 0;
    for (let index = 0; index < 3; index += 1) {
      month = `${periodOf(addDays(month, -1))}-01`;
      if (returns.get(periodOf(month))?.state === 'filed') filedCount += 1;
    }
    const tax = Math.round((filedCount / 3) * 100);

    const treasury = await this.treasury(actor, spaceId);
    const obligations = treasury.projection.reduce((total, day) => total + toBigInt(day.outflows), 0n);
    const cushion = treasury.tension ? 20 : obligations === 0n ? 100 : Math.min(100, Number((toBigInt(treasury.cash) * 50n) / obligations));

    const company = this.app.documentsOf(spaceId).filter((document) => document.category === 'company');
    const legalPoints = company.reduce((total, document) => total + (document.validity === 'expired' ? 0 : document.validity === 'expiring' ? 0.5 : 1), 0);
    const legal = company.length ? Math.round((legalPoints / company.length) * 100) : 0;

    const criteria: ScoreCriterion[] = [
      { key: 'collections', label: 'Encaissement des clients', weight: 25, score: collections, detail: invoices.length ? `${onTime} facture(s) sur ${invoices.length} payée(s) à l’échéance (90 jours)` : 'pas encore assez de factures échues' },
      { key: 'supplier_punctuality', label: 'Paiement des fournisseurs', weight: 25, score: punctuality, detail: bills.length ? `${paidOnTime} facture(s) sur ${bills.length} réglée(s) à temps (90 jours)` : 'pas encore assez de factures échues' },
      { key: 'tax_compliance', label: 'TVA déclarée et payée', weight: 20, score: tax, detail: `${filedCount} mois sur les 3 derniers` },
      { key: 'cash_cushion', label: 'Coussin de trésorerie', weight: 15, score: cushion, detail: treasury.tension ? 'tension prévue dans les 7 jours' : 'aucune tension prévue dans les 7 jours' },
      { key: 'legal_file', label: 'Dossier légal à jour', weight: 15, score: legal, detail: company.length ? legalDetail(company.map((document) => document.validity)) : 'aucune pièce au coffre' },
    ];
    const score = Math.round(criteria.reduce((total, criterion) => total + criterion.score * criterion.weight, 0) / 100);
    const grade = score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : score >= 35 ? 'D' : 'E';
    return { score, grade, criteria, computedAt: context.at, notice: 'Score indicatif calculé par App GN sur les données de l’espace ; ce n’est pas une notation de crédit.' };
  }

  async auditTrail(actor: Actor, spaceId: string): Promise<{ entries: AuditEntry[]; check: ChainCheck }> {
    this.context(actor, spaceId, 'reports:read');
    return { entries: (await this.audit.entries(spaceId)).reverse(), check: await this.audit.verify(spaceId) };
  }

  /**
   * Écritures du mois au plan SYSCOHADA (ventes, achats, banque), en CSV séparé par des points-virgules,
   * pour l'expert-comptable ou l'ERP. Les comptes sont indicatifs, à valider par l'expert-comptable.
   */
  async ledger(actor: Actor, spaceId: string, period: string): Promise<string> {
    const { today } = this.context(actor, spaceId, 'reports:read');
    if (!isPeriod(period) || period > periodOf(today)) throw new AppError('invalid_request', 'mois attendu (AAAA-MM)');
    const rows: (string | number)[][] = [['Date', 'Journal', 'Pièce', 'Compte', 'Libellé', 'Débit', 'Crédit']];
    const entry = (date: string, journal: string, piece: string, account: string, label: string, debit: Money | null, credit: Money | null) =>
      rows.push([date, journal, piece, account, label, debit ? toMajor(debit) : '', credit ? toMajor(credit) : '']);
    const inPeriod = (date: string) => periodOf(date) === period;

    for (const invoice of await this.invoiceRecords(spaceId)) {
      if (inPeriod(invoice.issueDate)) {
        entry(invoice.issueDate, 'VT', invoice.number, '411', invoice.customer.name, invoice.total, null);
        entry(invoice.issueDate, 'VT', invoice.number, '701', invoice.customer.name, null, invoice.subtotal);
        if (toBigInt(invoice.vat) > 0n) entry(invoice.issueDate, 'VT', invoice.number, '4431', `TVA ${invoice.number}`, null, invoice.vat);
      }
      if (invoice.cancellation && inPeriod(invoice.cancellation.on)) {
        entry(invoice.cancellation.on, 'VT', invoice.number, '411', `Annulation ${invoice.number}`, null, invoice.total);
        entry(invoice.cancellation.on, 'VT', invoice.number, '701', `Annulation ${invoice.number}`, invoice.subtotal, null);
        if (toBigInt(invoice.vat) > 0n) entry(invoice.cancellation.on, 'VT', invoice.number, '4431', `Annulation TVA ${invoice.number}`, invoice.vat, null);
      }
      if (invoice.settlement && inPeriod(invoice.settlement.on)) {
        entry(invoice.settlement.on, 'BQ', invoice.number, '521', `Encaissement ${invoice.customer.name}`, invoice.total, null);
        entry(invoice.settlement.on, 'BQ', invoice.number, '411', `Encaissement ${invoice.customer.name}`, null, invoice.total);
      }
    }
    for (const bill of await this.billRecords(spaceId)) {
      if (!inPeriod(bill.issueDate)) continue;
      entry(bill.issueDate, 'AC', bill.reference, '605', bill.supplier.name, gnf(toBigInt(bill.amount) - toBigInt(bill.vat)), null);
      if (toBigInt(bill.vat) > 0n) entry(bill.issueDate, 'AC', bill.reference, '4452', `TVA ${bill.reference}`, bill.vat, null);
      entry(bill.issueDate, 'AC', bill.reference, '401', bill.supplier.name, null, bill.amount);
    }
    const payments = await this.paymentMap(actor, spaceId);
    for (const batch of await this.batchRecords(spaceId)) {
      for (const line of batch.lines) {
        const payment = line.paymentId ? payments.get(line.paymentId) : undefined;
        if (payment?.status !== 'completed' || !inPeriod(payment.updatedAt.slice(0, 10))) continue;
        const on = payment.updatedAt.slice(0, 10);
        if (batch.kind === 'payroll') {
          entry(on, 'OD', batch.reference, '661', line.label, line.amount, null);
          entry(on, 'OD', batch.reference, '422', line.label, null, line.amount);
          entry(on, 'BQ', batch.reference, '422', line.label, line.amount, null);
        } else {
          entry(on, 'BQ', batch.reference, '401', line.label, line.amount, null);
        }
        entry(on, 'BQ', batch.reference, '521', line.label, null, line.amount);
      }
    }
    for (const { value } of await this.store.list<VatReturn>('vat_returns', spaceId)) {
      const payment = value.paymentId ? payments.get(value.paymentId) : undefined;
      if (payment?.status !== 'completed' || !inPeriod(payment.updatedAt.slice(0, 10))) continue;
      const on = payment.updatedAt.slice(0, 10);
      entry(on, 'BQ', `TVA ${value.period}`, '4441', `TVA due ${value.period}`, payment.amount, null);
      entry(on, 'BQ', `TVA ${value.period}`, '521', `TVA due ${value.period}`, null, payment.amount);
    }
    const [header, ...body] = rows;
    return csv([header!, ...body.sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])) || String(a[2]).localeCompare(String(b[2])))]);
  }

  // ── Interne ────────────────────────────────────────────────────────────

  private context(actor: Actor, spaceId: string, permissions: Permission | readonly Permission[]): Context {
    const { space, role, person } = this.app.guard(actor, spaceId, permissions, BUSINESS);
    const now = this.app.clock();
    return { space: space as BusinessSpace, role, personName: person.fullName, today: dayOf(now), at: now.toISOString() };
  }

  private async record(context: Context, actor: Actor, action: string, target: string, summary: string): Promise<void> {
    await this.audit.append(context.space.id, { at: context.at, personId: actor.personId, personName: context.personName, action, target, summary });
  }

  private deposit(certificate: Certificate): void {
    this.app.depositIssuedDocument(certificate.holderNin, {
      id: certificate.documentId,
      category: 'employment',
      title: 'Attestation de travail',
      issuer: certificate.employerName,
      holderName: certificate.holderName,
      reference: `AT •••• ${certificate.verificationCode.slice(-4)}`,
      issuedAt: certificate.issuedOn,
      source: 'issuer',
      verificationCode: certificate.verificationCode,
      fields: certificate.fields,
    });
  }

  private async invoiceRecords(spaceId: string): Promise<SalesInvoice[]> {
    return (await this.store.list<SalesInvoice>('invoices', spaceId)).map((record) => record.value).sort((a, b) => a.number.localeCompare(b.number));
  }

  private async invoiceViews(spaceId: string, today: string): Promise<InvoiceView[]> {
    return (await this.invoiceRecords(spaceId)).map((invoice) => this.invoiceView(invoice, today));
  }

  private invoiceView(invoice: SalesInvoice, today: string): InvoiceView {
    if (invoice.status !== 'issued') return { ...invoice, state: invoice.status };
    if (invoice.dueDate < today) return { ...invoice, state: 'overdue', daysOverdue: daysBetween(invoice.dueDate, today) };
    return { ...invoice, state: 'issued' };
  }

  private async latestInvoice(spaceId: string, year: string): Promise<SalesInvoice | undefined> {
    return (await this.invoiceRecords(spaceId)).filter((invoice) => invoice.number.startsWith(`FAC-${year}-`)).at(-1);
  }

  /** Recalcule chaque sceau, année par année : une facture modifiée en base, ou retirée, casse la chaîne. */
  private async verifyInvoiceChain(spaceId: string, invoices: readonly SalesInvoice[]): Promise<ChainCheck> {
    const byYear = new Map<string, SalesInvoice[]>();
    for (const invoice of invoices) byYear.set(invoice.number.slice(4, 8), [...(byYear.get(invoice.number.slice(4, 8)) ?? []), invoice]);
    let checked = 0;
    for (const [year, chain] of byYear) {
      let previous = GENESIS;
      for (const [index, invoice] of chain.entries()) {
        checked += 1;
        const expected = await sha256(previous + invoiceSealPayload(invoice));
        if (invoice.number !== `FAC-${year}-${String(index + 1).padStart(4, '0')}` || invoice.seal.previous !== previous || invoice.seal.hash !== expected) {
          return { intact: false, checked, brokenAt: checked };
        }
        previous = invoice.seal.hash;
      }
      const counter = await this.store.get<DeskEntity & { value: number }>('counters', `${spaceId}:FAC-${year}`);
      if (counter && counter.value.value !== chain.length) return { intact: false, checked, brokenAt: chain.length + 1 };
    }
    return { intact: true, checked };
  }

  private async billRecords(spaceId: string): Promise<SupplierBill[]> {
    return (await this.store.list<SupplierBill>('bills', spaceId)).map((record) => record.value);
  }

  private async billViews(actor: Actor, spaceId: string, today: string): Promise<BillView[]> {
    const batches = new Map((await this.batchRecords(spaceId)).map((batch) => [batch.id, batch]));
    const payments = await this.paymentMap(actor, spaceId);
    return (await this.billRecords(spaceId)).map((bill) => this.billView(bill, today, batches, payments));
  }

  private billView(bill: SupplierBill, today: string, batches: ReadonlyMap<string, PaymentBatch>, payments: ReadonlyMap<string, Payment>): BillView {
    const unpaid = (lastFailure?: string): BillView => ({ ...bill, state: bill.dueDate < today ? 'overdue' : 'to_pay', ...(lastFailure ? { lastFailure } : {}) });
    const batch = bill.batchId ? batches.get(bill.batchId) : undefined;
    if (!batch) return unpaid();
    if (batch.status === 'rejected') return unpaid(`lot refusé : ${batch.rejectionReason ?? ''}`.trim());
    if (batch.status === 'pending_approval') return { ...bill, state: 'awaiting_approval' };
    const line = batch.lines.find((candidate) => candidate.ref === bill.id);
    if (line?.error) return unpaid(line.error);
    const payment = line?.paymentId ? payments.get(line.paymentId) : undefined;
    if (!payment) return { ...bill, state: 'processing' };
    switch (payment.status) {
      case 'completed': return { ...bill, state: 'paid', paidOn: payment.updatedAt.slice(0, 10) };
      case 'processing': return { ...bill, state: 'processing' };
      case 'pending_approval': return { ...bill, state: 'awaiting_approval' };
      default: return unpaid(payment.failureReason ?? payment.rejectionReason ?? 'paiement refusé');
    }
  }

  private async payableBills(actor: Actor, spaceId: string, billIds: readonly string[], today: string): Promise<BillView[]> {
    if (!Array.isArray(billIds) || billIds.length === 0) throw new AppError('invalid_request', 'choisissez au moins une facture');
    if (billIds.length > MAX_BATCH_LINES) throw new AppError('invalid_request', `au plus ${MAX_BATCH_LINES} factures par lot`);
    if (new Set(billIds).size !== billIds.length) throw new AppError('invalid_request', 'une facture figure deux fois');
    const views = new Map((await this.billViews(actor, spaceId, today)).map((bill) => [bill.id, bill]));
    return billIds.map((id) => {
      const bill = views.get(id);
      if (!bill) throw new AppError('not_found', 'facture fournisseur introuvable');
      if (bill.state !== 'to_pay' && bill.state !== 'overdue') throw new AppError('invalid_state', `${bill.supplier.name} · ${bill.reference} : déjà payée ou en cours`);
      return bill;
    });
  }

  private debitAccount(spaceId: string, accountId: unknown): LinkedAccount {
    const account = this.app.linkedAccounts(spaceId).find((candidate) => candidate.id === accountId);
    if (!account) throw new AppError('not_found', 'compte introuvable dans cet espace');
    if (account.currency !== 'GNF' || !providerById(account.providerId)?.canDebit) throw new AppError('invalid_request', 'choisissez un compte en GNF qui peut être débité');
    return account;
  }

  private async railOptions(actor: Actor, spaceId: string, payouts: readonly { operator: string; amount: Money }[]): Promise<RailOption[]> {
    const total = payouts.reduce((value, payout) => value + toBigInt(payout.amount), 0n);
    const overview = await this.app.overview(actor, spaceId);
    const options = this.app.linkedAccounts(spaceId)
      .filter((account) => account.currency === 'GNF' && providerById(account.providerId)?.canDebit)
      .map((account) => {
        const position = overview.positions.find((candidate) => candidate.account.id === account.id);
        const fees = payouts.reduce((value, payout) => value + toBigInt(share(payout.amount, railFeeBps(account, payout.operator))), 0n);
        const balance = position?.freshness === 'live' ? position.balance : undefined;
        return {
          accountId: account.id, label: account.label, kind: providerById(account.providerId)!.kind,
          ...(balance ? { balance } : {}), fees: gnf(fees), sufficient: balance ? toBigInt(balance) >= total + fees : false, recommended: false,
        };
      })
      .sort((a, b) => Number(b.sufficient) - Number(a.sufficient) || Number(toBigInt(a.fees) - toBigInt(b.fees)));
    if (options[0]?.sufficient) options[0].recommended = true;
    return options;
  }

  private async createBatch(
    actor: Actor,
    context: Context,
    draft: { kind: PaymentBatch['kind']; source: LinkedAccount; lines: BatchLine[]; reference: string; period?: string },
    idempotencyKey: string,
    fingerprint: unknown,
    existing?: PaymentBatch,
  ): Promise<BatchView> {
    const spaceId = context.space.id;
    const id = randomId('bat');
    const claim = await claimKey(this.store, spaceId, actor.personId, `batch.${draft.kind}`, idempotencyKey, [fingerprint, draft.source.id], id);
    if (claim.conflict) throw new AppError('idempotency_conflict', 'cette clé a déjà servi pour une autre demande');
    if (claim.replay) {
      const replayed = await this.store.get<PaymentBatch>('batches', claim.replay);
      if (replayed) return this.batchView(replayed.value, context.role, await this.paymentMap(actor, spaceId));
    }
    if (existing) throw new AppError('invalid_state', `${existing.reference} existe déjà`);

    const total = sum(draft.lines.map((line) => line.amount));
    const options = await this.railOptions(actor, spaceId, draft.lines.map((line) => ({ operator: (line.destination as { operator: string }).operator, amount: line.amount })));
    const option = options.find((candidate) => candidate.accountId === draft.source.id)!;
    if (!option.balance) throw new AppError('invalid_state', 'solde du compte indisponible : réessayez ou choisissez un autre compte');
    if (toBigInt(option.balance) < toBigInt(total)) throw new AppError('insufficient_funds', `solde insuffisant sur ${draft.source.label}`);

    const needsApproval = batchNeedsApproval(draft.kind, total, context.role);
    const batch: PaymentBatch = {
      id, spaceId, kind: draft.kind, reference: draft.reference, ...(draft.period ? { period: draft.period } : {}),
      sourceAccountId: draft.source.id, lines: draft.lines, total, estimatedFees: option.fees,
      status: needsApproval ? 'pending_approval' : 'executing', initiatedBy: actor.personId, initiatedAt: context.at,
    };
    if (draft.kind === 'suppliers') await this.lockBills(spaceId, batch);
    await this.store.insert('batches', batch);
    await this.record(context, actor, `batch.${needsApproval ? 'submitted' : 'executed'}`, batch.id,
      `${batch.reference} · ${batch.lines.length} ligne(s) · ${toMajor(total)} GNF${needsApproval ? ' · en attente d’approbation' : ''}`);
    const result = needsApproval ? batch : await this.execute(actor, batch);
    return this.batchView(result, context.role, await this.paymentMap(actor, spaceId));
  }

  /** Rattache chaque facture au lot ; si l'une a été prise entre-temps par un autre lot, rien n'est rattaché. */
  private async lockBills(spaceId: string, batch: PaymentBatch): Promise<void> {
    const locked: { id: string; previous?: string }[] = [];
    try {
      for (const line of batch.lines) {
        const record = await this.store.get<SupplierBill>('bills', line.ref);
        if (!record || record.value.spaceId !== spaceId) throw new AppError('not_found', 'facture fournisseur introuvable');
        if (!await this.store.update('bills', { ...record.value, batchId: batch.id }, record.version)) throw new AppError('invalid_state', 'une facture vient d’être prise dans un autre lot');
        locked.push({ id: line.ref, ...(record.value.batchId ? { previous: record.value.batchId } : {}) });
      }
    } catch (error) {
      for (const { id, previous } of locked) {
        await mutate<SupplierBill>(this.store, 'bills', id, (current) => {
          const { batchId: _batchId, ...rest } = current!;
          return previous ? { ...rest, batchId: previous } : rest;
        });
      }
      throw error;
    }
  }

  /** Exécute un lot passé à `executing` : une ligne = un paiement, sous une clé dérivée du lot. */
  private async execute(actor: Actor, batch: PaymentBatch): Promise<PaymentBatch> {
    const lines: BatchLine[] = [];
    for (const line of batch.lines) {
      if (line.paymentId) {
        lines.push(line);
        continue;
      }
      try {
        const payment = await this.app.initiatePayment(actor, batch.spaceId, {
          sourceAccountId: batch.sourceAccountId,
          amount: toMajor(line.amount),
          destination: line.destination,
          label: line.label,
        }, `${batch.id}:${line.ref}`);
        lines.push({ ...line, paymentId: payment.id });
      } catch (error) {
        lines.push({ ...line, error: error instanceof AppError ? error.message : 'échec du paiement' });
      }
    }
    return mutate<PaymentBatch>(this.store, 'batches', batch.id, (current) => ({ ...current!, lines, status: 'executed' }));
  }

  private async batchRecords(spaceId: string): Promise<PaymentBatch[]> {
    return (await this.store.list<PaymentBatch>('batches', spaceId)).map((record) => record.value);
  }

  private batchView(batch: PaymentBatch, role: Role, payments: ReadonlyMap<string, Payment>): BatchView {
    const linesHidden = batch.kind === 'payroll' && !can(role, 'payroll:submit') && !can(role, 'payments:approve');
    const counts = { completed: 0, processing: 0, failed: 0, pending: 0 };
    const lines = batch.lines.map((line): BatchLineView => {
      const payment = line.paymentId ? payments.get(line.paymentId) : undefined;
      const status: BatchLineView['status'] = line.error ? 'error' : payment ? payment.status : 'pending';
      if (status === 'completed') counts.completed += 1;
      else if (status === 'processing') counts.processing += 1;
      else if (status === 'pending' || status === 'pending_approval') counts.pending += 1;
      else counts.failed += 1;
      if (linesHidden) return { ref: '', beneficiary: '', label: '', status };
      return { ...line, status, ...(payment?.failureReason ? { error: payment.failureReason } : {}) };
    });
    const source = this.app.linkedAccounts(batch.spaceId).find((account) => account.id === batch.sourceAccountId);
    return { ...batch, lines, linesHidden, counts, sourceLabel: source?.label ?? batch.sourceAccountId };
  }

  private async paymentMap(actor: Actor, spaceId: string): Promise<Map<string, Payment>> {
    return new Map((await this.app.listPayments(actor, spaceId)).map((payment) => [payment.id, payment]));
  }

  private async employeeRecords(spaceId: string): Promise<Employee[]> {
    return (await this.store.list<Employee>('employees', spaceId)).map((record) => record.value);
  }

  private closedPeriod(period: unknown, today: string): asserts period is string {
    if (!isPeriod(period) || period >= periodOf(today)) throw new AppError('invalid_request', 'un mois clos (AAAA-MM) est attendu');
  }

  /** Un mois dont la TVA est déposée ou en cours de paiement ne reçoit plus de facture ni d'annulation. */
  private async periodLocked(spaceId: string, period: string): Promise<boolean> {
    const record = await this.store.get<VatReturn>('vat_returns', `${spaceId}:${period}`);
    if (!record) return false;
    if (!record.value.paymentId) return toBigInt(record.value.due) === 0n;
    const payment = await this.app.paymentOf(spaceId, record.value.paymentId);
    return payment?.status !== 'failed' && payment?.status !== 'rejected';
  }

  private async computeVat(spaceId: string, period: string): Promise<VatComputation> {
    const invoices = (await this.invoiceRecords(spaceId)).filter((invoice) => invoice.status !== 'cancelled' && periodOf(invoice.issueDate) === period);
    const bills = (await this.billRecords(spaceId)).filter((bill) => periodOf(bill.issueDate) === period);
    const collected = sum(invoices.map((invoice) => invoice.vat));
    const deductible = sum(bills.map((bill) => bill.vat));
    const earlier = (await this.store.list<VatReturn>('vat_returns', spaceId))
      .map((record) => record.value)
      .filter((value) => value.period < period)
      .sort((a, b) => b.period.localeCompare(a.period));
    let creditBrought = gnf(0);
    for (const candidate of earlier) {
      const payment = candidate.paymentId ? await this.app.paymentOf(spaceId, candidate.paymentId) : undefined;
      if (!candidate.paymentId || payment?.status === 'completed') {
        creditBrought = candidate.creditCarried;
        break;
      }
    }
    const balance = toBigInt(collected) - toBigInt(deductible) - toBigInt(creditBrought);
    const next = addDays(`${period}-01`, 32).slice(0, 7);
    return {
      period, collected, deductible, creditBrought,
      due: gnf(balance > 0n ? balance : 0n),
      creditCarried: gnf(balance < 0n ? -balance : 0n),
      invoices: invoices.length, bills: bills.length,
      deadline: `${next}-${String(VAT_DEADLINE_DAY).padStart(2, '0')}`,
    };
  }

  private vatView(value: VatReturn, payments: ReadonlyMap<string, Payment>): VatReturnView {
    if (!value.paymentId) {
      if (toBigInt(value.due) > 0n) return { ...value, state: 'payment_failed' };
      return { ...value, state: 'filed', acknowledgement: acknowledgement(value) };
    }
    const payment = payments.get(value.paymentId);
    switch (payment?.status) {
      case 'completed': return { ...value, state: 'filed', acknowledgement: acknowledgement(value) };
      case 'pending_approval': return { ...value, state: 'awaiting_approval' };
      case 'processing': return { ...value, state: 'paying' };
      default: return { ...value, state: 'payment_failed' };
    }
  }
}

function legalDetail(validities: readonly string[]): string {
  const count = (validity: string) => validities.filter((candidate) => candidate === validity).length;
  const parts = [`${count('valid') + count('no_expiry')} valide(s)`];
  if (count('expiring')) parts.push(`${count('expiring')} à renouveler sous 30 jours`);
  if (count('expired')) parts.push(`${count('expired')} expirée(s)`);
  return `${parts.join(', ')} sur ${validities.length}`;
}

/** Accusé de dépôt (simulé) : la cible est le numéro rendu par le téléservice de la DGI. */
function acknowledgement(value: VatReturn): string {
  const digits = [...`${value.spaceId}${value.period}${value.attempts}`].reduce((hash, char) => (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0, 7);
  return `DGI-TVA-${value.period.replace('-', '')}-${String(digits % 1_000_000).padStart(6, '0')}`;
}
