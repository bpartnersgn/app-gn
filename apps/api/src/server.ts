import { DEMO_WALLET_NUMBERS, loadDemoApp, loadDemoGapp, SimulatedOrchestrator } from '@app-gn/core';
import { buildServer } from './app.ts';
import { Auth, MemorySmsSender, sessionSecretFromEnvironment } from './auth.ts';
import { databaseFromEnvironment } from './db/connect.ts';
import { OrcheaOrchestrator, OrcheaWebhookReceiver, orcheaFromEnvironment } from './orchea.ts';

const port = Number(process.env.PORT ?? 3100);
const host = process.env.HOST ?? '127.0.0.1';

// Base : DATABASE_URL (PostgreSQL), APPGN_PGLITE_DIR (PostgreSQL embarqué) ou rien (mémoire). Voir db/connect.ts.
const database = await databaseFromEnvironment(process.env);

// Données fictives. Sans ORCHEA_* : tout est simulé. Avec : le paiement des factures depuis Orange Money
// ou MTN MoMo passe par ORCHEA (en mode test, son simulateur), le reste reste simulé.
const orchea = orcheaFromEnvironment(process.env);
const { app } = await loadDemoApp({
  store: database?.store,
  orchestrator: orchea
    ? (network, now) => new OrcheaOrchestrator({
        ...orchea.config,
        walletNumber: (account) => DEMO_WALLET_NUMBERS[account.id],
        fallback: new SimulatedOrchestrator(network, now),
      })
    : undefined,
});

// Tableaux de bord GAPP, dans la même base ; les données de démonstration n'y sont versées qu'une fois.
const gapp = await loadDemoGapp(app, { store: database?.store });

// Connexion par NIN + code SMS. Aucun fournisseur SMS n'est branché : en démonstration (APPGN_DEMO_LOGIN,
// activée par défaut), la réponse porte le code ; APPGN_DEMO_LOGIN=off ferme la connexion de démo et le code affiché.
const demoLogin = process.env.APPGN_DEMO_LOGIN !== 'off';
const sessionSecret = sessionSecretFromEnvironment(process.env);
const auth = new Auth({ app, sms: new MemorySmsSender(), secret: sessionSecret.secret, revealCodes: demoLogin, store: database?.store });

const server = buildServer(app, {
  logger: true,
  auth,
  demoLogin,
  gapp,
  ...(orchea ? { orcheaWebhooks: new OrcheaWebhookReceiver(app, orchea.webhookSecrets, { processed: database?.store }) } : {}),
});
if (database) server.addHook('onClose', database.close);
await server.listen({ port, host });
server.log.info({ database: database?.kind ?? 'mémoire' }, 'stockage');
if (orchea) server.log.info({ baseUrl: orchea.config.baseUrl, mode: orchea.config.mode ?? 'live' }, 'paiements de factures via ORCHEA');
if (sessionSecret.generated) server.log.warn('APPGN_SESSION_SECRET absente : clé tirée au démarrage, les sessions ne survivront pas à un redémarrage');
if (demoLogin) server.log.warn('connexion de démonstration ouverte (APPGN_DEMO_LOGIN=off pour la fermer)');

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void server.close());
