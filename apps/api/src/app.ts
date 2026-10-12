import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { AppError, type AppGn, type PaymentInput } from '@app-gn/core';

/**
 * Authentification de démonstration : `Authorization: Bearer demo:<personId>`.
 * Elle sera remplacée par l'identité numérique (NIN + OTP / eID) ; rien d'autre ne change,
 * puisque toutes les règles d'accès vivent dans la couche application (@app-gn/core).
 */
function personOf(request: FastifyRequest): string {
  const header = request.headers.authorization ?? '';
  const match = /^Bearer demo:([\w-]+)$/.exec(header);
  if (!match?.[1]) throw new AppError('unauthenticated', 'en-tête Authorization: Bearer demo:<personId> attendu');
  return match[1];
}

export function buildServer(app: AppGn, options: { logger?: boolean } = {}): FastifyInstance {
  const server = Fastify({ logger: options.logger ?? false });

  server.setErrorHandler((error, _request, reply: FastifyReply) => {
    if (error instanceof AppError) {
      return reply.status(error.status).send({ error: error.code, message: error.message });
    }
    const status = typeof (error as { statusCode?: number }).statusCode === 'number' ? (error as { statusCode: number }).statusCode : 500;
    if (status < 500) return reply.status(status).send({ error: 'invalid_request', message: (error as Error).message });
    server.log.error(error);
    return reply.status(500).send({ error: 'internal', message: 'erreur interne' });
  });

  server.get('/health', async () => ({ status: 'ok' }));

  server.get('/v1/demo/persons', async () => app.listPersons());
  server.get('/v1/catalog', async () => app.catalog());

  server.get('/v1/me', async (request) => app.me(personOf(request)));

  server.get<{ Params: { spaceId: string } }>('/v1/spaces/:spaceId/overview', async (request) =>
    app.overview(personOf(request), request.params.spaceId));

  server.get<{ Params: { spaceId: string } }>('/v1/spaces/:spaceId/services', async (request) =>
    app.services(personOf(request), request.params.spaceId));

  server.get<{ Params: { spaceId: string; accountId: string }; Querystring: { limit?: string } }>(
    '/v1/spaces/:spaceId/accounts/:accountId/transactions',
    async (request) => app.transactions(personOf(request), request.params.spaceId, request.params.accountId, Number(request.query.limit ?? 20) || 20),
  );

  server.get<{ Params: { spaceId: string } }>('/v1/spaces/:spaceId/payments', async (request) =>
    app.listPayments(personOf(request), request.params.spaceId));

  server.post<{ Params: { spaceId: string }; Body: PaymentInput }>('/v1/spaces/:spaceId/payments', async (request, reply) => {
    const key = request.headers['idempotency-key'];
    const payment = await app.initiatePayment(personOf(request), request.params.spaceId, request.body ?? ({} as PaymentInput), typeof key === 'string' ? key : '');
    return reply.status(201).send(payment);
  });

  server.post<{ Params: { spaceId: string; paymentId: string } }>('/v1/spaces/:spaceId/payments/:paymentId/approve', async (request) =>
    app.approvePayment(personOf(request), request.params.spaceId, request.params.paymentId));

  server.post<{ Params: { spaceId: string; paymentId: string } }>('/v1/spaces/:spaceId/payments/:paymentId/reject', async (request) =>
    app.rejectPayment(personOf(request), request.params.spaceId, request.params.paymentId));

  return server;
}
