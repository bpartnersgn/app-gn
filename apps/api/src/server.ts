import { createDemoApp, DEMO_WALLET_NUMBERS, SimulatedOrchestrator } from '@app-gn/core';
import { buildServer } from './app.ts';
import { OrcheaOrchestrator, OrcheaWebhookReceiver, orcheaFromEnvironment } from './orchea.ts';

const port = Number(process.env.PORT ?? 3100);
const host = process.env.HOST ?? '127.0.0.1';

// Données fictives. Sans ORCHEA_* : tout est simulé. Avec : le paiement des factures depuis Orange Money
// ou MTN MoMo passe par ORCHEA (en mode test, son simulateur), le reste reste simulé.
const orchea = orcheaFromEnvironment(process.env);
const { app } = createDemoApp({
  orchestrator: orchea
    ? (network, now) => new OrcheaOrchestrator({
        ...orchea.config,
        walletNumber: (account) => DEMO_WALLET_NUMBERS[account.id],
        fallback: new SimulatedOrchestrator(network, now),
      })
    : undefined,
});
const server = buildServer(app, {
  logger: true,
  ...(orchea ? { orcheaWebhooks: new OrcheaWebhookReceiver(app, orchea.webhookSecrets) } : {}),
});
await server.listen({ port, host });
if (orchea) server.log.info({ baseUrl: orchea.config.baseUrl, mode: orchea.config.mode ?? 'live' }, 'paiements de factures via ORCHEA');
