import type { Actor } from '../channels.ts';
import type { MobilePayee } from './common.ts';
import type { BillInput, EmployeeInput, InvoiceInput } from './business.ts';
import type { BudgetLine, EngagementInput } from './administration.ts';
import type { Gapp } from './demo.ts';

export interface GappCall {
  actor: Actor;
  spaceId: string;
  params: Record<string, string>;
  body: Record<string, unknown>;
  /** Clé d'idempotence (en-tête `Idempotency-Key`). */
  key: string;
}

export interface GappRoute {
  method: 'GET' | 'POST';
  /** Chemin à la manière de Fastify (`/v1/spaces/:spaceId/business/invoices/:id/settle`). */
  path: string;
  /** Statut HTTP d'une réponse réussie. */
  status: 200 | 201;
  handle(gapp: Gapp, call: GappCall): Promise<unknown>;
}

const B = '/v1/spaces/:spaceId/business';
const A = '/v1/spaces/:spaceId/administration';
const get = (path: string, handle: GappRoute['handle']): GappRoute => ({ method: 'GET', path, status: 200, handle });
const post = (path: string, handle: GappRoute['handle'], status: 200 | 201 = 200): GappRoute => ({ method: 'POST', path, status, handle });
const str = (value: unknown) => (typeof value === 'string' ? value : '');

/**
 * Table des routes des tableaux de bord GAPP, une seule pour les deux transports : l'API (Fastify) l'enregistre,
 * l'application web en mode démo la sert directement. L'accès et les règles restent dans les bureaux.
 */
export const GAPP_ROUTES: readonly GappRoute[] = [
  get(`${B}/treasury`, (g, c) => g.business.treasury(c.actor, c.spaceId)),
  get(`${B}/invoices`, (g, c) => g.business.invoices(c.actor, c.spaceId)),
  post(`${B}/invoices`, (g, c) => g.business.issueInvoice(c.actor, c.spaceId, c.body as unknown as InvoiceInput, c.key), 201),
  post(`${B}/invoices/:id/settle`, (g, c) => g.business.settleInvoice(c.actor, c.spaceId, c.params.id!, c.body as { accountId: string; transactionId?: string; receivedOn?: string })),
  post(`${B}/invoices/:id/cancel`, (g, c) => g.business.cancelInvoice(c.actor, c.spaceId, c.params.id!, str(c.body.reason))),
  get(`${B}/reconciliation`, (g, c) => g.business.reconciliation(c.actor, c.spaceId)),
  get(`${B}/bills`, (g, c) => g.business.bills(c.actor, c.spaceId)),
  post(`${B}/bills`, (g, c) => g.business.recordBill(c.actor, c.spaceId, c.body as unknown as BillInput, c.key), 201),
  post(`${B}/batches/preview`, (g, c) => g.business.previewSupplierBatch(c.actor, c.spaceId, (c.body.billIds ?? []) as string[])),
  get(`${B}/batches`, (g, c) => g.business.batches(c.actor, c.spaceId)),
  post(`${B}/batches`, (g, c) => g.business.createSupplierBatch(c.actor, c.spaceId, c.body as { billIds: string[]; sourceAccountId: string }, c.key), 201),
  post(`${B}/batches/:id/approve`, (g, c) => g.business.approveBatch(c.actor, c.spaceId, c.params.id!)),
  post(`${B}/batches/:id/reject`, (g, c) => g.business.rejectBatch(c.actor, c.spaceId, c.params.id!, str(c.body.reason))),
  get(`${B}/vat`, (g, c) => g.business.vat(c.actor, c.spaceId)),
  get(`${B}/vat/:period`, (g, c) => g.business.vatPreview(c.actor, c.spaceId, c.params.period!)),
  post(`${B}/vat`, (g, c) => g.business.fileVat(c.actor, c.spaceId, c.body as { period: string; sourceAccountId?: string }, c.key), 201),
  get(`${B}/team`, (g, c) => g.business.employees(c.actor, c.spaceId)),
  post(`${B}/team`, (g, c) => g.business.hire(c.actor, c.spaceId, c.body as unknown as EmployeeInput, c.key), 201),
  post(`${B}/team/:id/leave`, (g, c) => g.business.endContract(c.actor, c.spaceId, c.params.id!, str(c.body.leftOn))),
  post(`${B}/team/:id/certificates`, (g, c) => g.business.issueCertificate(c.actor, c.spaceId, c.params.id!), 201),
  post(`${B}/payroll`, (g, c) => g.business.preparePayroll(c.actor, c.spaceId, c.body as { period: string; sourceAccountId: string }, c.key), 201),
  get(`${B}/score`, (g, c) => g.business.score(c.actor, c.spaceId)),
  get(`${B}/audit`, (g, c) => g.business.auditTrail(c.actor, c.spaceId)),
  get(`${B}/ledger/:period`, async (g, c) => ({ name: `journal-${c.params.period}.csv`, content: await g.business.ledger(c.actor, c.spaceId, c.params.period!) })),

  get(`${A}/budget`, (g, c) => g.administration.budget(c.actor, c.spaceId)),
  post(`${A}/budget-lines`, (g, c) => g.administration.openBudgetLine(c.actor, c.spaceId, c.body as { code: string; label: string; section: BudgetLine['section']; allocated: string; payroll?: boolean }), 201),
  get(`${A}/engagements`, (g, c) => g.administration.engagements(c.actor, c.spaceId)),
  post(`${A}/engagements`, (g, c) => g.administration.engage(c.actor, c.spaceId, c.body as unknown as EngagementInput, c.key), 201),
  post(`${A}/engagements/:id/close`, (g, c) => g.administration.closeEngagement(c.actor, c.spaceId, c.params.id!)),
  post(`${A}/engagements/:id/liquidations`, (g, c) => g.administration.liquidate(c.actor, c.spaceId, c.params.id!, c.body as { amount: string; invoiceReference: string; serviceDoneOn: string }), 201),
  post(`${A}/engagements/:id/liquidations/:liquidationId/mandate`, (g, c) => g.administration.mandate(c.actor, c.spaceId, c.params.id!, c.params.liquidationId!, c.body as { sourceAccountId: string })),
  post(`${A}/engagements/:id/liquidations/:liquidationId/visa`, (g, c) => g.administration.visa(c.actor, c.spaceId, c.params.id!, c.params.liquidationId!)),
  post(`${A}/engagements/:id/liquidations/:liquidationId/reject`, (g, c) => g.administration.rejectMandate(c.actor, c.spaceId, c.params.id!, c.params.liquidationId!, str(c.body.reason))),
  get(`${A}/agents`, (g, c) => g.administration.agents(c.actor, c.spaceId)),
  post(`${A}/agents`, (g, c) => g.administration.enrolAgent(c.actor, c.spaceId, c.body as { matricule: string; fullName: string; nin: string; grade: string; monthlyNet: string; payout: MobilePayee }), 201),
  post(`${A}/agents/:id/suspend`, (g, c) => g.administration.setAgentSuspended(c.actor, c.spaceId, c.params.id!, true)),
  post(`${A}/agents/:id/reinstate`, (g, c) => g.administration.setAgentSuspended(c.actor, c.spaceId, c.params.id!, false)),
  get(`${A}/payroll-check/:period`, (g, c) => g.administration.payrollCheck(c.actor, c.spaceId, c.params.period!)),
  get(`${A}/payrolls`, (g, c) => g.administration.payrolls(c.actor, c.spaceId)),
  post(`${A}/payrolls`, (g, c) => g.administration.preparePayroll(c.actor, c.spaceId, c.body as { period: string; sourceAccountId: string }, c.key), 201),
  post(`${A}/payrolls/:id/pay`, (g, c) => g.administration.payPayroll(c.actor, c.spaceId, c.params.id!)),
  get(`${A}/revenue`, (g, c) => g.administration.revenue(c.actor, c.spaceId)),
  get(`${A}/court-report`, async (g, c) => ({ name: 'compte-execution.csv', content: await g.administration.courtReport(c.actor, c.spaceId) })),
  get(`${A}/audit`, (g, c) => g.administration.auditTrail(c.actor, c.spaceId)),
];

/** Trouve la route d'une requête et en extrait les paramètres (décodés). */
export function matchGappRoute(method: string, path: string): { route: GappRoute; params: Record<string, string> } | undefined {
  const parts = path.split('?')[0]!.split('/');
  for (const route of GAPP_ROUTES) {
    if (route.method !== method) continue;
    const pattern = route.path.split('/');
    if (pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    if (pattern.every((segment, index) => {
      if (segment.startsWith(':')) {
        params[segment.slice(1)] = decodeURIComponent(parts[index]!);
        return parts[index] !== '';
      }
      return segment === parts[index];
    })) return { route, params };
  }
  return undefined;
}
