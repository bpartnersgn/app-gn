import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { loadDemoApp, type Actor } from '@app-gn/core';
import { Auth, MemorySmsSender } from '../src/auth.ts';
import { migrate, PostgresStore, type Sql } from '../src/db/postgres-store.ts';
import { OrcheaWebhookReceiver, signOrcheaWebhook } from '../src/orchea.ts';

// PostgreSQL embarqué (PGlite) par défaut : même moteur, même SQL qu'en service, sans serveur à lancer.
// TEST_DATABASE_URL=postgres://… : contre un vrai serveur (base jetable : le schéma y est vidé), où les
// requêtes simultanées passent par des connexions distinctes.
let sql: Sql;
let store: PostgresStore;
let close: () => Promise<void>;

before(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: url, max: 6 });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    sql = pool as unknown as Sql;
    close = () => pool.end();
  } else {
    const database = new PGlite();
    sql = database as unknown as Sql;
    close = () => database.close();
  }
  await migrate(sql);
  store = new PostgresStore(sql);
});
after(async () => {
  await close();
});

const citizen: Actor = { personId: 'per_mariama', channel: 'phone' };
const ordonnateur: Actor = { personId: 'per_fatoumata', channel: 'desktop' };
const comptable: Actor = { personId: 'per_ibrahima', channel: 'desktop' };

describe('PostgreSQL', () => {
  it('le schéma se rejoue sans erreur', async () => {
    await migrate(sql);
    const { rows } = await sql.query<{ version: number }>('SELECT version FROM schema_version');
    assert.deepEqual(rows.map((row) => row.version), [1]);
  });

  it('un paiement et sa clé d’idempotence survivent à un redémarrage', async () => {
    const first = (await loadDemoApp({ store })).app;
    const input = { sourceAccountId: 'acc_mc_om', amount: '1000', destination: { type: 'own_account' as const, accountId: 'acc_mc_mtn' } };
    const paid = await first.initiatePayment(citizen, 'spc_cit_mariama', input, 'pg-restart-1');
    assert.equal(paid.status, 'completed');

    const restarted = (await loadDemoApp({ store })).app;
    const list = await restarted.listPayments(citizen, 'spc_cit_mariama');
    assert.ok(list.some((payment) => payment.id === paid.id && payment.status === 'completed'));
    const replay = await restarted.initiatePayment(citizen, 'spc_cit_mariama', input, 'pg-restart-1');
    assert.equal(replay.id, paid.id);
    await assert.rejects(
      restarted.initiatePayment(citizen, 'spc_cit_mariama', { ...input, amount: '2000' }, 'pg-restart-1'),
      { code: 'idempotency_conflict' },
    );
  });

  it('une demande refusée libère sa clé', async () => {
    const app = (await loadDemoApp({ store })).app;
    const bad = { sourceAccountId: 'acc_mc_om', amount: 'abc', destination: { type: 'own_account' as const, accountId: 'acc_mc_mtn' } };
    await assert.rejects(app.initiatePayment(citizen, 'spc_cit_mariama', bad, 'pg-fix-1'), { code: 'invalid_request' });
    const fixed = await app.initiatePayment(citizen, 'spc_cit_mariama', { ...bad, amount: '500' }, 'pg-fix-1');
    assert.equal(fixed.status, 'completed');
  });

  it('deux requêtes identiques simultanées ne créent qu’un paiement', async () => {
    const app = (await loadDemoApp({ store })).app;
    const input = { sourceAccountId: 'acc_mc_om', amount: '700', destination: { type: 'own_account' as const, accountId: 'acc_mc_mtn' } };
    const results = await Promise.allSettled([1, 2, 3].map(() => app.initiatePayment(citizen, 'spc_cit_mariama', input, 'pg-race-1')));
    const ids = new Set(results.filter((result) => result.status === 'fulfilled').map((result) => (result as PromiseFulfilledResult<{ id: string }>).value.id));
    assert.equal(ids.size, 1);
    const { rows } = await sql.query("SELECT 1 FROM idempotency_keys WHERE scope LIKE '%:pg-race-1'");
    assert.equal(rows.length, 1);
  });

  it('deux visas simultanés d’un même mandat : un seul passe', async () => {
    const app = (await loadDemoApp({ store })).app;
    const mandate = await app.initiatePayment(ordonnateur, 'spc_adm_kaloum', {
      sourceAccountId: 'acc_kal_tresor', amount: '5000000', destination: { type: 'own_account', accountId: 'acc_kal_eco' },
    }, 'pg-mandat-1');
    assert.equal(mandate.status, 'pending_approval');
    const other = (await loadDemoApp({ store })).app;
    const results = await Promise.allSettled([
      app.approvePayment(comptable, 'spc_adm_kaloum', mandate.id),
      other.approvePayment(comptable, 'spc_adm_kaloum', mandate.id),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal((await store.payment(mandate.id))?.status, 'completed');
  });

  it('une carte émise puis bloquée le reste après un redémarrage', async () => {
    const app = (await loadDemoApp({ store })).app;
    const card = await app.issueCard(citizen, 'spc_cit_mariama', { network: 'visa', tier: 'gold' }, 'pg-card-1');
    await app.setCardFrozen(citizen, 'spc_cit_mariama', card.accountId, true);

    const restarted = (await loadDemoApp({ store })).app;
    const cards = await restarted.cards(citizen, 'spc_cit_mariama');
    assert.equal(cards.find((candidate) => candidate.accountId === card.accountId)?.status, 'frozen');
    const overview = await restarted.overview(citizen, 'spc_cit_mariama');
    assert.ok(overview.positions.some((position) => position.account.id === card.accountId));
  });

  it('un webhook déjà traité l’est encore après un redémarrage', async () => {
    const app = (await loadDemoApp({ store })).app;
    const secret = 'secret-webhook-de-test-0000';
    const body = JSON.stringify({ eventId: 'evt-pg-1', type: 'TransactionConfirmed', payload: { paymentIntentId: 'inconnu', transactionId: 't' } });
    const first = await new OrcheaWebhookReceiver(app, [secret], { processed: store }).handle(body, signOrcheaWebhook(secret, body));
    assert.equal(first.result, 'unknown_payment');
    const again = await new OrcheaWebhookReceiver(app, [secret], { processed: store }).handle(body, signOrcheaWebhook(secret, body));
    assert.equal(again.result, 'duplicate');
  });

  it('connexion : code à usage unique sous essais simultanés, limite et révocation partagées entre instances', async () => {
    const app = (await loadDemoApp({ store })).app;
    const sms = new MemorySmsSender();
    const secret = 'cle-de-session-postgres-0123456789abcdef';
    const one = new Auth({ app, sms, secret, store });
    const two = new Auth({ app, sms, secret, store });

    const { challengeId } = await one.requestCode('GN-NIN-0000000003');
    const code = sms.lastCodeFor('+224 621 00 00 03')!;
    const attempts = await Promise.allSettled([one.verifyCode(challengeId, code, 'spc_cit_fatoumata'), two.verifyCode(challengeId, code, 'spc_cit_fatoumata')]);
    assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
    const { token } = (attempts.find((attempt) => attempt.status === 'fulfilled') as PromiseFulfilledResult<{ token: string }>).value;

    const session = await two.read(token);
    assert.equal(session?.personId, 'per_fatoumata');
    await one.revoke(session!);
    assert.equal(await two.read(token), undefined);

    await one.requestCode('GN-NIN-0000000004');
    await two.requestCode('GN-NIN-0000000004');
    await one.requestCode('GN-NIN-0000000004');
    await assert.rejects(two.requestCode('GN-NIN-0000000004'), { code: 'rate_limited' });
  });
});
