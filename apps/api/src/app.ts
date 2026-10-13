import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Auth, Session } from './auth.ts';
import { registerGappRoutes } from './gapp-routes.ts';
import type { OrcheaWebhookReceiver } from './orchea.ts';
import { AppError, isChannel, type Actor, type Channel, type AppGn, type CardNetwork, type CardTier, type Currency, type ExchangeInput, type Gapp, type PaymentInput } from '@app-gn/core';

/**
 * Identité : `Authorization: Bearer <jeton de session>` (connexion par NIN + code SMS, voir auth.ts), liée à un
 * seul espace ; et, tant que la démonstration est permise, `Bearer demo:<personId>@<spaceId>` (liée de même) ou
 * `Bearer demo:<personId>` (tous ses espaces, pour les essais de l'API). Toutes les règles d'accès vivent
 * dans la couche application (@app-gn/core) : seule la façon d'établir la personne change.
 *
 * Le format d'appareil est déclaré par le client (`AppGN-Channel: phone | tablet | desktop`, `phone` par défaut,
 * le plus restrictif). C'est une règle produit, pas une frontière de sécurité : la cible le liera à l'appareil enregistré.
 */
async function resolveActor(request: FastifyRequest, auth: Auth | undefined, allowDemo: boolean): Promise<Actor> {
  const header = request.headers.authorization ?? '';
  const bearer = /^Bearer (\S+)$/.exec(header)?.[1];
  const demo = allowDemo ? /^demo:([\w-]+)(?:@([\w-]+))?$/.exec(bearer ?? '') : null;
  const session = !demo && bearer && auth ? await auth.read(bearer) : undefined;
  const personId = demo?.[1] ?? session?.personId;
  const spaceId = demo ? demo[2] : session?.spaceId;
  if (!personId) throw new AppError('unauthenticated', 'session absente ou expirée : connectez-vous');
  return { personId, channel: channelOf(request), ...(spaceId ? { spaceId } : {}) };
}

function channelOf(request: FastifyRequest): Channel {
  const channel = request.headers['appgn-channel'] ?? 'phone';
  if (!isChannel(channel)) throw new AppError('invalid_request', 'AppGN-Channel : phone, tablet ou desktop');
  return channel;
}

function keyOf(request: FastifyRequest): string {
  const key = request.headers['idempotency-key'];
  return typeof key === 'string' ? key : '';
}

export interface ServerOptions {
  logger?: boolean;
  orcheaWebhooks?: OrcheaWebhookReceiver;
  /** Connexion par NIN + code SMS. */
  auth?: Auth;
  /** Accepter `Bearer demo:<personId>` et la liste des personnes de démo. Par défaut : oui. */
  demoLogin?: boolean;
  /** Tableaux de bord GAPP (entreprise, administration). */
  gapp?: Gapp;
}

export function buildServer(app: AppGn, options: ServerOptions = {}): FastifyInstance {
  const server = Fastify({ logger: options.logger ?? false });
  const auth = options.auth;
  const demoLogin = options.demoLogin ?? true;
  const actorOf = (request: FastifyRequest) => resolveActor(request, auth, demoLogin);

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
        const handled = await orcheaWebhooks.handle(typeof request.body === 'string' ? request.body : '', typeof signature === 'string' ? signature : undefined);
        if (handled.status === 200) request.log.info({ result: handled.result, paymentId: handled.paymentId }, 'webhook ORCHEA');
        return reply.status(handled.status).send({ result: handled.result });
      });
    });
  }

  if (demoLogin) server.get('/v1/demo/persons', async () => app.listPersons());

  if (auth) {
    server.post<{ Body: { nin?: unknown } }>('/v1/auth/codes', async (request, reply) =>
      reply.status(202).send(await auth.requestCode(request.body?.nin)));
    const opened = (request: FastifyRequest, reply: FastifyReply, { token, session }: { token: string; session: Session }) =>
      reply.status(201).send({ token, expiresAt: session.expiresAt, me: app.me({ personId: session.personId, channel: channelOf(request), spaceId: session.spaceId }) });
    server.post<{ Body: { challengeId?: unknown; code?: unknown; spaceId?: unknown } }>('/v1/auth/sessions', async (request, reply) => {
      const result = await auth.verifyCode(request.body?.challengeId, request.body?.code, request.body?.spaceId);
      if (result.kind === 'choose_space') return reply.status(200).send({ chooseSpace: true, selectionToken: result.selectionToken, spaces: result.spaces });
      return opened(request, reply, result);
    });
    server.post<{ Body: { selectionToken?: unknown; spaceId?: unknown } }>('/v1/auth/sessions/space', async (request, reply) =>
      opened(request, reply, await auth.selectSpace(request.body?.selectionToken, request.body?.spaceId)));
    server.delete('/v1/auth/sessions/current', async (request, reply) => {
      const bearer = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
      const session = bearer ? await auth.read(bearer) : undefined;
      if (session) await auth.revoke(session);
      return reply.status(204).send();
    });
  }
  server.get('/v1/catalog', async () => app.catalog());

  server.get('/v1/me', async (request) => app.me(await actorOf(request)));

  server.get<{ Params: { spaceId: string } }>('/v1/spaces/:spaceId/overview', async (request) =>
    app.overview(await actorOf(request), request.params.spaceId));

  server.get<{ Params: { spaceId: string } }>('/v1/spaces/:spaceId/services', async (request) =>
    app.services(await actorOf(request), request.params.spaceId));

  server.get<{ Params: { spaceId: string; accountId: string }; Querystring: { limit?: string } }>(
    '/v1/spaces/:spaceId/accounts/:accountId/transactions',
    async (request) => app.transactions(await actorOf(request), request.params.spaceId, request.params.accountId, Number(request.query.limit ?? 20) || 20),
  );

  server.get<{ Params: { spaceId: string } }>('/v1/spaces/:spaceId/payments', async (request) =>
    app.listPayments(await actorOf(request), request.params.spaceId));

  server.post<{ Params: { spaceId: string }; Body: PaymentInput }>('/v1/spaces/:spaceId/payments', async (request, reply) => {
    const payment = await app.initiatePayment(await actorOf(request), request.params.spaceId, request.body ?? ({} as PaymentInput), keyOf(request));
    return reply.status(201).send(payment);
  });

  server.post<{ Params: { spaceId: string; paymentId: string } }>('/v1/spaces/:spaceId/payments/:paymentId/approve', async (request) =>
    app.approvePayment(await actorOf(request), request.params.spaceId, request.params.paymentId));

  server.post<{ Params: { spaceId: string; paymentId: string }; Body: { reason?: string } | undefined }>('/v1/spaces/:spaceId/payments/:paymentId/reject', async (request) =>
    app.rejectPayment(await actorOf(request), request.params.spaceId, request.params.paymentId, request.body?.reason));

  server.get<{ Params: { spaceId: string } }>('/v1/spaces/:spaceId/documents', async (request) =>
    app.documents(await actorOf(request), request.params.spaceId));

  // Public : ce qu'un contrôleur voit en saisissant le code d'un document.
  server.get<{ Params: { code: string } }>('/v1/document-checks/:code', async (request) => app.verifyDocument(request.params.code));

  server.get<{ Params: { spaceId: string } }>('/v1/spaces/:spaceId/cards', async (request) =>
    app.cards(await actorOf(request), request.params.spaceId));

  server.post<{ Params: { spaceId: string }; Body: { network: CardNetwork; tier: CardTier; currency?: Currency } }>('/v1/spaces/:spaceId/cards', async (request, reply) => {
    const card = await app.issueCard(await actorOf(request), request.params.spaceId, request.body ?? ({} as never), keyOf(request));
    return reply.status(201).send(card);
  });

  server.post<{ Params: { spaceId: string; accountId: string } }>('/v1/spaces/:spaceId/cards/:accountId/freeze', async (request) =>
    app.setCardFrozen(await actorOf(request), request.params.spaceId, request.params.accountId, true));

  server.post<{ Params: { spaceId: string; accountId: string } }>('/v1/spaces/:spaceId/cards/:accountId/unfreeze', async (request) =>
    app.setCardFrozen(await actorOf(request), request.params.spaceId, request.params.accountId, false));

  server.post<{ Params: { spaceId: string }; Body: ExchangeInput }>('/v1/spaces/:spaceId/exchange-quotes', async (request, reply) =>
    reply.status(201).send(app.quoteExchange(await actorOf(request), request.params.spaceId, request.body ?? ({} as ExchangeInput))));

  server.post<{ Params: { spaceId: string }; Body: { quoteId: string } }>('/v1/spaces/:spaceId/exchanges', async (request, reply) => {
    const exchange = await app.executeExchange(await actorOf(request), request.params.spaceId, request.body?.quoteId ?? '', keyOf(request));
    return reply.status(201).send(exchange);
  });

  if (options.gapp) registerGappRoutes(server, options.gapp, actorOf, keyOf);

  return server;
}
