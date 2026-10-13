import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Actor, BillInput, EmployeeInput, EngagementInput, Gapp, InvoiceInput } from '@app-gn/core';

type Params = { spaceId: string };
type WithId = Params & { id: string };
type Body = Record<string, unknown> | undefined;

/**
 * Routes des tableaux de bord GAPP. Elles ne font que traduire HTTP : l'accès (session liée à l'espace,
 * rôle, appareil) et les règles métier sont vérifiés par les bureaux du noyau.
 */
export function registerGappRoutes(
  server: FastifyInstance,
  gapp: Gapp,
  actorOf: (request: FastifyRequest) => Promise<Actor>,
  keyOf: (request: FastifyRequest) => string,
): void {
  const { business, administration } = gapp;
  const b = '/v1/spaces/:spaceId/business';
  const a = '/v1/spaces/:spaceId/administration';
  const body = (request: FastifyRequest) => (request.body ?? {}) as Record<string, unknown>;
  const csv = (name: string, content: string) => ({ name, content });

  // ── Entreprise ──
  server.get<{ Params: Params }>(`${b}/treasury`, async (request) => business.treasury(await actorOf(request), request.params.spaceId));
  server.get<{ Params: Params }>(`${b}/invoices`, async (request) => business.invoices(await actorOf(request), request.params.spaceId));
  server.post<{ Params: Params; Body: Body }>(`${b}/invoices`, async (request, reply) =>
    reply.status(201).send(await business.issueInvoice(await actorOf(request), request.params.spaceId, body(request) as unknown as InvoiceInput, keyOf(request))));
  server.post<{ Params: WithId; Body: Body }>(`${b}/invoices/:id/settle`, async (request) =>
    business.settleInvoice(await actorOf(request), request.params.spaceId, request.params.id, body(request) as { accountId: string; transactionId?: string; receivedOn?: string }));
  server.post<{ Params: WithId; Body: Body }>(`${b}/invoices/:id/cancel`, async (request) =>
    business.cancelInvoice(await actorOf(request), request.params.spaceId, request.params.id, String(body(request).reason ?? '')));
  server.get<{ Params: Params }>(`${b}/reconciliation`, async (request) => business.reconciliation(await actorOf(request), request.params.spaceId));

  server.get<{ Params: Params }>(`${b}/bills`, async (request) => business.bills(await actorOf(request), request.params.spaceId));
  server.post<{ Params: Params; Body: Body }>(`${b}/bills`, async (request, reply) =>
    reply.status(201).send(await business.recordBill(await actorOf(request), request.params.spaceId, body(request) as unknown as BillInput, keyOf(request))));
  server.post<{ Params: Params; Body: Body }>(`${b}/batches/preview`, async (request) =>
    business.previewSupplierBatch(await actorOf(request), request.params.spaceId, (body(request).billIds ?? []) as string[]));
  server.get<{ Params: Params }>(`${b}/batches`, async (request) => business.batches(await actorOf(request), request.params.spaceId));
  server.post<{ Params: Params; Body: Body }>(`${b}/batches`, async (request, reply) =>
    reply.status(201).send(await business.createSupplierBatch(await actorOf(request), request.params.spaceId, body(request) as { billIds: string[]; sourceAccountId: string }, keyOf(request))));
  server.post<{ Params: WithId }>(`${b}/batches/:id/approve`, async (request) => business.approveBatch(await actorOf(request), request.params.spaceId, request.params.id));
  server.post<{ Params: WithId; Body: Body }>(`${b}/batches/:id/reject`, async (request) =>
    business.rejectBatch(await actorOf(request), request.params.spaceId, request.params.id, String(body(request).reason ?? '')));

  server.get<{ Params: Params }>(`${b}/vat`, async (request) => business.vat(await actorOf(request), request.params.spaceId));
  server.get<{ Params: Params & { period: string } }>(`${b}/vat/:period`, async (request) => business.vatPreview(await actorOf(request), request.params.spaceId, request.params.period));
  server.post<{ Params: Params; Body: Body }>(`${b}/vat`, async (request, reply) =>
    reply.status(201).send(await business.fileVat(await actorOf(request), request.params.spaceId, body(request) as { period: string; sourceAccountId?: string }, keyOf(request))));

  server.get<{ Params: Params }>(`${b}/team`, async (request) => business.employees(await actorOf(request), request.params.spaceId));
  server.post<{ Params: Params; Body: Body }>(`${b}/team`, async (request, reply) =>
    reply.status(201).send(await business.hire(await actorOf(request), request.params.spaceId, body(request) as unknown as EmployeeInput, keyOf(request))));
  server.post<{ Params: WithId; Body: Body }>(`${b}/team/:id/leave`, async (request) =>
    business.endContract(await actorOf(request), request.params.spaceId, request.params.id, String(body(request).leftOn ?? '')));
  server.post<{ Params: WithId }>(`${b}/team/:id/certificates`, async (request, reply) =>
    reply.status(201).send(await business.issueCertificate(await actorOf(request), request.params.spaceId, request.params.id)));
  server.post<{ Params: Params; Body: Body }>(`${b}/payroll`, async (request, reply) =>
    reply.status(201).send(await business.preparePayroll(await actorOf(request), request.params.spaceId, body(request) as { period: string; sourceAccountId: string }, keyOf(request))));

  server.get<{ Params: Params }>(`${b}/score`, async (request) => business.score(await actorOf(request), request.params.spaceId));
  server.get<{ Params: Params }>(`${b}/audit`, async (request) => business.auditTrail(await actorOf(request), request.params.spaceId));
  server.get<{ Params: Params & { period: string } }>(`${b}/ledger/:period`, async (request) =>
    csv(`journal-${request.params.period}.csv`, await business.ledger(await actorOf(request), request.params.spaceId, request.params.period)));

  // ── Administration ──
  server.get<{ Params: Params }>(`${a}/budget`, async (request) => administration.budget(await actorOf(request), request.params.spaceId));
  server.post<{ Params: Params; Body: Body }>(`${a}/budget-lines`, async (request, reply) =>
    reply.status(201).send(await administration.openBudgetLine(await actorOf(request), request.params.spaceId, body(request) as never)));
  server.get<{ Params: Params }>(`${a}/engagements`, async (request) => administration.engagements(await actorOf(request), request.params.spaceId));
  server.post<{ Params: Params; Body: Body }>(`${a}/engagements`, async (request, reply) =>
    reply.status(201).send(await administration.engage(await actorOf(request), request.params.spaceId, body(request) as unknown as EngagementInput, keyOf(request))));
  server.post<{ Params: WithId }>(`${a}/engagements/:id/close`, async (request) => administration.closeEngagement(await actorOf(request), request.params.spaceId, request.params.id));
  server.post<{ Params: WithId; Body: Body }>(`${a}/engagements/:id/liquidations`, async (request, reply) =>
    reply.status(201).send(await administration.liquidate(await actorOf(request), request.params.spaceId, request.params.id, body(request) as { amount: string; invoiceReference: string; serviceDoneOn: string })));
  type Liquidation = WithId & { liquidationId: string };
  server.post<{ Params: Liquidation; Body: Body }>(`${a}/engagements/:id/liquidations/:liquidationId/mandate`, async (request) =>
    administration.mandate(await actorOf(request), request.params.spaceId, request.params.id, request.params.liquidationId, body(request) as { sourceAccountId: string }));
  server.post<{ Params: Liquidation }>(`${a}/engagements/:id/liquidations/:liquidationId/visa`, async (request) =>
    administration.visa(await actorOf(request), request.params.spaceId, request.params.id, request.params.liquidationId));
  server.post<{ Params: Liquidation; Body: Body }>(`${a}/engagements/:id/liquidations/:liquidationId/reject`, async (request) =>
    administration.rejectMandate(await actorOf(request), request.params.spaceId, request.params.id, request.params.liquidationId, String(body(request).reason ?? '')));

  server.get<{ Params: Params }>(`${a}/agents`, async (request) => administration.agents(await actorOf(request), request.params.spaceId));
  server.post<{ Params: Params; Body: Body }>(`${a}/agents`, async (request, reply) =>
    reply.status(201).send(await administration.enrolAgent(await actorOf(request), request.params.spaceId, body(request) as never)));
  server.post<{ Params: WithId }>(`${a}/agents/:id/suspend`, async (request) => administration.setAgentSuspended(await actorOf(request), request.params.spaceId, request.params.id, true));
  server.post<{ Params: WithId }>(`${a}/agents/:id/reinstate`, async (request) => administration.setAgentSuspended(await actorOf(request), request.params.spaceId, request.params.id, false));
  server.get<{ Params: Params & { period: string } }>(`${a}/payroll-check/:period`, async (request) =>
    administration.payrollCheck(await actorOf(request), request.params.spaceId, request.params.period));
  server.get<{ Params: Params }>(`${a}/payrolls`, async (request) => administration.payrolls(await actorOf(request), request.params.spaceId));
  server.post<{ Params: Params; Body: Body }>(`${a}/payrolls`, async (request, reply) =>
    reply.status(201).send(await administration.preparePayroll(await actorOf(request), request.params.spaceId, body(request) as { period: string; sourceAccountId: string }, keyOf(request))));
  server.post<{ Params: WithId }>(`${a}/payrolls/:id/pay`, async (request) => administration.payPayroll(await actorOf(request), request.params.spaceId, request.params.id));

  server.get<{ Params: Params }>(`${a}/revenue`, async (request) => administration.revenue(await actorOf(request), request.params.spaceId));
  server.get<{ Params: Params }>(`${a}/court-report`, async (request) =>
    csv('compte-execution.csv', await administration.courtReport(await actorOf(request), request.params.spaceId)));
  server.get<{ Params: Params }>(`${a}/audit`, async (request) => administration.auditTrail(await actorOf(request), request.params.spaceId));
}
