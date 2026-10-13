import type { FastifyInstance, FastifyRequest } from 'fastify';
import { GAPP_ROUTES, type Actor, type Gapp } from '@app-gn/core';

/**
 * Enregistre la table des routes GAPP du noyau. Ces routes ne font que traduire HTTP : l'accès (session liée
 * à l'espace, rôle, appareil) et les règles métier sont vérifiés par les bureaux.
 */
export function registerGappRoutes(
  server: FastifyInstance,
  gapp: Gapp,
  actorOf: (request: FastifyRequest) => Promise<Actor>,
  keyOf: (request: FastifyRequest) => string,
): void {
  for (const route of GAPP_ROUTES) {
    server.route<{ Params: Record<string, string>; Body: Record<string, unknown> | undefined }>({
      method: route.method,
      url: route.path,
      handler: async (request, reply) => {
        const { spaceId, ...params } = request.params;
        const result = await route.handle(gapp, { actor: await actorOf(request), spaceId: spaceId!, params, body: request.body ?? {}, key: keyOf(request) });
        return reply.status(route.status).send(result);
      },
    });
  }
}
