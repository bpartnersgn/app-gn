import { DEMO_WALLET_NUMBERS, loadDemoApp, loadDemoGapp, SimulatedOrchestrator } from '@app-gn/core';
import { buildServer } from './app.ts';
import { Auth, MemorySmsSender, sessionSecretFromEnvironment } from './auth.ts';
import { databaseFromEnvironment } from './db/connect.ts';
import { MemoryRateLimitStore, productionProblems, securityFromEnvironment, trustProxyFromEnvironment } from './security.ts';
import { OrcheaEventFeed, OrcheaOrchestrator, OrcheaWebhookReceiver, orcheaFromEnvironment } from './orchea.ts';

// En production, refuser de démarrer plutôt que de tourner ouvert (démo, secret, base, origines, SMS).
const problems = productionProblems(process.env);
if (problems.length > 0) {
  console.error(`APPGN_ENV=production : démarrage refusé.\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

const port = Number(process.env.PORT ?? 3100);
const host = process.env.HOST ?? '127.0.0.1';

// Base : DATABASE_URL (PostgreSQL), APPGN_PGLITE_DIR (PostgreSQL embarqué) ou rien (mémoire). Voir db/connect.ts.
const database = await databaseFromEnvironment(process.env);

// Données fictives. Sans ORCHEA_* : tout est simulé. Avec : le paiement des factures depuis Orange Money
// ou MTN MoMo passe par ORCHEA (en mode test, son simulateur), le reste reste simulé.
const orchea = orcheaFromEnvironment(process.env);
// Référentiel : en base quand il y en a une. Les données de démonstration n'y sont versées (une fois, base vide)
// qu'hors production.
const production = process.env.APPGN_ENV === 'production';
const { app } = await loadDemoApp({
  store: database?.store,
  ...(database ? { directory: database.store, seedDirectory: !production } : {}),
  orchestrator: orchea
    ? (network, now) => new OrcheaOrchestrator({
        ...orchea.config,
        walletNumber: (account) => DEMO_WALLET_NUMBERS[account.id],
        fallback: new SimulatedOrchestrator(network, now),
      })
    : undefined,
});

// Tableaux de bord GAPP, dans la même base ; les données de démonstration n'y sont versées qu'une fois.
const gapp = await loadDemoGapp(app, { store: database?.store, seed: !production });

// Une autre instance a pu inscrire, rattacher ou retirer quelqu'un : relecture du référentiel à intervalle régulier
// (et, pour un NIN ou un espace inconnu, aussitôt).
const refreshEvery = Number(process.env.APPGN_DIRECTORY_REFRESH_MS ?? 30_000);
const refresher = database && refreshEvery > 0
  ? setInterval(() => void app.refresh().catch((error: unknown) => console.error('relecture du référentiel', error)), refreshEvery).unref()
  : undefined;

// Connexion par NIN + code SMS. Aucun fournisseur SMS n'est branché : en démonstration (APPGN_DEMO_LOGIN,
// activée par défaut), la réponse porte le code ; APPGN_DEMO_LOGIN=off ferme la connexion de démo et le code affiché.
const demoLogin = process.env.APPGN_DEMO_LOGIN !== 'off';
const sessionSecret = sessionSecretFromEnvironment(process.env);
const auth = new Auth({ app, sms: new MemorySmsSender(), secret: sessionSecret.secret, revealCodes: demoLogin, store: database?.store });
// Les codes de confirmation forte (au-delà de 5 M GNF) partent par le même canal que ceux de connexion. Les données de
// démonstration ont été versées avant, avec des codes rendus à l'écran.
app.useConfirmer(auth);

const orcheaReceiver = orchea ? new OrcheaWebhookReceiver(app, orchea.webhookSecrets, { processed: database?.store }) : undefined;
// Rattrapage : un webhook perdu ne laisse pas un paiement « en cours ». Au démarrage, puis à intervalle régulier.
const feed = orchea && orcheaReceiver ? new OrcheaEventFeed(orchea.config, orcheaReceiver, { cursors: database?.store }) : undefined;
const feedEvery = Number(process.env.ORCHEA_FEED_INTERVAL_MS ?? 60_000);

const server = buildServer(app, {
  logger: true,
  auth,
  demoLogin,
  gapp,
  security: securityFromEnvironment(process.env, database?.store ?? new MemoryRateLimitStore()),
  trustProxy: trustProxyFromEnvironment(process.env.APPGN_TRUST_PROXY),
  ...(orcheaReceiver ? { orcheaWebhooks: orcheaReceiver } : {}),
});
if (refresher) server.addHook('onClose', async () => clearInterval(refresher));
if (database) server.addHook('onClose', database.close);
if (feed) {
  const catchUp = async () => {
    const report = await feed.catchUp();
    if (report.status === 'error') server.log.warn(report, 'rattrapage ORCHEA en échec');
    else if (report.applied > 0) server.log.info(report, 'rattrapage ORCHEA');
  };
  void catchUp();
  if (feedEvery > 0) {
    const timer = setInterval(() => void catchUp(), feedEvery).unref();
    server.addHook('onClose', async () => clearInterval(timer));
  }
}
await server.listen({ port, host });
server.log.info({ database: database?.kind ?? 'mémoire' }, 'stockage');
if (orchea) server.log.info({ baseUrl: orchea.config.baseUrl, mode: orchea.config.mode ?? 'live' }, 'paiements de factures via ORCHEA');
if (sessionSecret.generated) server.log.warn('APPGN_SESSION_SECRET absente : clé tirée au démarrage, les sessions ne survivront pas à un redémarrage');
if (demoLogin) server.log.warn('connexion de démonstration ouverte (APPGN_DEMO_LOGIN=off pour la fermer)');

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void server.close());
