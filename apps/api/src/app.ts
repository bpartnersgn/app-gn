import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { OrcheaWebhookReceiver } from './orchea.ts';
import { AppError, isChannel, type Actor, type AppGn, type CardNetwork, type CardTier, type Currency, type ExchangeInput, type PaymentInput } from '@app-gn/core';

/**
 * Authentification de démonstration : `Authorization: Bearer demo:<personId>`.
 * Elle sera remplacée par l'identité numérique (NIN + OTP / eID) ; rien d'autre ne change,
 * puisque toutes les règles d'accès vivent dans la couche application (@app-gn/core).
 */
/**
 * Le format d'appareil est déclaré par le client (`AppGN-Channel: phone | tablet | desktop`, `phone` par défaut,
 * le plus restrictif). C'est une règle produit, pas une frontière de sécurité : la cible le liera à l'appareil enregistré.
 */
function actorOf(request: FastifyRequest): Actor {
  const header = request.headers.authorization ?? '';
  const match = /^Bearer demo:([\w-]+)$/.exec(header);
  if (!match?.[1]) throw new AppError('unauthenticated', 'en-tête Authorization: Bearer demo:<personId> attendu');
  const channel = request.headers['appgn-channel'] ?? 'phone';
  if (!isChannel(channel)) throw new AppError('invalid_request', 'AppGN-Channel : phone, tablet ou desktop');
  return { personId: match[1], channel };
}

function keyOf(request: FastifyRequest): string {
  const key = request.headers['idempotency-key'];
  return typeof key === 'string' ? key : '';
}

export function buildServer(app: AppGn, options: { logger?: boolean; orcheaWebhooks?: OrcheaWebhookReceiver } = {}): FastifyInstance {
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

  // Issues de paiement envoyées par ORCHEA. La signature porte sur le corps exact : il est lu brut,
  // dans un contexte à part pour ne pas changer la lecture JSON des autres routes.
  const orcheaWebhooks = options.orcheaWebhooks;
  if (orcheaWebhooks) {
    server.register(async (scope) => {
      scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => done(null, body));
      scope.post('/v1/webhooks/orchea', async (request, reply) => {
        const signature = request.headers['x-orchea-signature'];
        const handled = orcheaWebhooks.handle(typeof request.body === 'string' ? request.body : '', typeof signature === 'string' ? signature : undefined);
        if (handled.status === 200) request.log.info({ result: handled.result, paymentId: handled.paymentId }, 'webhook ORCHEA');
        return reply.status(handled.status).send({ result: handled.result });
      });
    });
  }

  server.get('/v1/demo/persons', async () => app.listPersons());
  server.get('/v1/catalog', async () => app.catalog());

  server.get('/v1/me', async (request) => app.me(actorOf(request)));

  server.get<{ Params: { spaceId: string } }>('/v1/spaces/:spaceId/overview', async (request) =>
    app.overview(actorOf(request), request.params.spaceId));

  server.get<{ Params: { spaceId: string } }>('/v1/spaces/:spaceId/services', async (request) =>
    app.services(actorOf(request), request.params.spaceId));

  server.get<{ Params: { spaceId: string; accountId: string }; Querystring: { limit?: string } }>(
    '/v1/spaces/:spaceId/accounts/:accountId/transactions',
    async (request) => app.transactions(actorOf(request), request.params.spaceId, request.params.accountId, Number(request.query.limit ?? 20) || 20),
  );

  server.get<{ Params: { spaceId: string } }>('/v1/spaces/:spaceId/payments', async (request) =>
    app.listPayments(actorOf(request), request.params.spaceId));

  server.post<{ Params: { spaceId: string }; Body: PaymentInput }>('/v1/spaces/:spaceId/payments', async (request, reply) => {
    const payment = await app.initiatePayment(actorOf(request), request.params.spaceId, request.body ?? ({} as PaymentInput), keyOf(request));
    return reply.status(201).send(payment);
  });

  server.post<{ Params: { spaceId: string; paymentId: string } }>('/v1/spaces/:spaceId/payments/:paymentId/approve', async (request) =>
    app.approvePayment(actorOf(request), request.params.spaceId, request.params.paymentId));

  server.post<{ Params: { spaceId: string; paymentId: string } }>('/v1/spaces/:spaceId/payments/:paymentId/reject', async (request) =>
    app.rejectPayment(actorOf(request), request.params.spaceId, request.params.paymentId));

  server.get<{ Params: { spaceId: string } }>('/v1/spaces/:spaceId/documents', async (request) =>
    app.documents(actorOf(request), request.params.spaceId));

  // Public : ce qu'un contrôleur voit en saisissant le code d'un document.
  server.get<{ Params: { code: string } }>('/v1/document-checks/:code', async (request) => app.verifyDocument(request.params.code));

  server.get<{ Params: { spaceId: string } }>('/v1/spaces/:spaceId/cards', async (request) =>
    app.cards(actorOf(request), request.params.spaceId));

  server.post<{ Params: { spaceId: string }; Body: { network: CardNetwork; tier: CardTier; currency?: Currency } }>('/v1/spaces/:spaceId/cards', async (request, reply) => {
    const card = await app.issueCard(actorOf(request), request.params.spaceId, request.body ?? ({} as never), keyOf(request));
    return reply.status(201).send(card);
  });

  server.post<{ Params: { spaceId: string; accountId: string } }>('/v1/spaces/:spaceId/cards/:accountId/freeze', async (request) =>
    app.setCardFrozen(actorOf(request), request.params.spaceId, request.params.accountId, true));

  server.post<{ Params: { spaceId: string; accountId: string } }>('/v1/spaces/:spaceId/cards/:accountId/unfreeze', async (request) =>
    app.setCardFrozen(actorOf(request), request.params.spaceId, request.params.accountId, false));

  server.post<{ Params: { spaceId: string }; Body: ExchangeInput }>('/v1/spaces/:spaceId/exchange-quotes', async (request, reply) =>
    reply.status(201).send(app.quoteExchange(actorOf(request), request.params.spaceId, request.body ?? ({} as ExchangeInput))));

  server.post<{ Params: { spaceId: string }; Body: { quoteId: string } }>('/v1/spaces/:spaceId/exchanges', async (request, reply) => {
    const exchange = await app.executeExchange(actorOf(request), request.params.spaceId, request.body?.quoteId ?? '', keyOf(request));
    return reply.status(201).send(exchange);
  });

  return server;
}
