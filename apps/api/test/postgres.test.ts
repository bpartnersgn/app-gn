import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { loadDemoApp, loadDemoGapp, type Actor } from '@app-gn/core';
import { Auth, MemorySmsSender } from '../src/auth.ts';
import { loadMigrations, migrate, PostgresStore, type Sql } from '../src/db/postgres-store.ts';
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
    // Une migration tient dans une transaction : elle demande une seule connexion, pas le pool.
    const client = await pool.connect();
    await migrate(client as unknown as Sql);
    client.release();
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
    assert.deepEqual(rows.map((row) => row.version), [1, 2, 3, 4]);
  });

  it('une base déjà en version 2 ne reçoit que les migrations suivantes ; une migration qui échoue ne laisse rien', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const database = new PGlite();
    const local = database as unknown as Sql;
    try {
      const migrations = await loadMigrations();
      assert.deepEqual(await migrate(local, migrations.slice(0, 2)), [1, 2]);
      assert.deepEqual(await migrate(local, migrations), [3, 4]);
      assert.deepEqual(await migrate(local, migrations), []);
      const broken = { version: 5, name: 'essai', statements: ['CREATE TABLE essai_rollback (id text)', 'SELECT * FROM table_absente'] };
      await assert.rejects(migrate(local, [...migrations, broken]), /migration 5 \(essai\)/);
      const { rows } = await local.query<{ found: string | null }>("SELECT to_regclass('essai_rollback')::text AS found");
      assert.equal(rows[0]?.found, null);
      const versions = await local.query<{ version: number }>('SELECT version FROM schema_version ORDER BY version');
      assert.deepEqual(versions.rows.map((row) => row.version), [1, 2, 3, 4]);
    } finally {
      await database.close();
    }
  });

  it('les compteurs de débit sont partagés et repartent à chaque minute', async () => {
    const other = new PostgresStore(sql);
    assert.deepEqual(await store.hit(['ip:essai', 's:essai'], 1000), [1, 1]);
    assert.deepEqual(await other.hit(['ip:essai'], 1000), [2]);
    assert.deepEqual(await store.hit(['ip:essai'], 1001), [1]);
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
    }, 'pg-mandat-1', 'desk');
    assert.equal(mandate.status, 'pending_approval');
    const other = (await loadDemoApp({ store })).app;
    const results = await Promise.allSettled([
      app.approvePayment(comptable, 'spc_adm_kaloum', mandate.id, 'desk'),
      other.approvePayment(comptable, 'spc_adm_kaloum', mandate.id, 'desk'),
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

describe('PostgreSQL : bureaux GAPP', () => {
  it('écriture conditionnelle : deux mises à jour sur la même version, une seule passe', async () => {
    const record = { id: 'pg-desk-1', spaceId: 'spc_essai', n: 1 };
    assert.equal(await store.insert('invoices', record), true);
    assert.equal(await store.insert('invoices', record), false);
    const results = await Promise.all([store.update('invoices', { ...record, n: 2 }, 1), store.update('invoices', { ...record, n: 3 }, 1)]);
    assert.deepEqual(results.sort(), [false, true]);
    assert.equal((await store.get('invoices', 'pg-desk-1'))?.version, 2);
  });

  it('les données de démonstration ne sont versées qu’une fois et survivent au redémarrage', async () => {
    const sekou: Actor = { personId: 'per_sekou', channel: 'desktop', spaceId: 'spc_biz_boke' };
    const first = (await loadDemoApp({ store })).app;
    const gapp = await loadDemoGapp(first, { store });
    const before = await gapp.business.invoices(sekou, 'spc_biz_boke');
    assert.equal(before.chain.intact, true);
    const restarted = (await loadDemoApp({ store })).app;
    const again = await loadDemoGapp(restarted, { store });
    const after = await again.business.invoices(sekou, 'spc_biz_boke');
    assert.deepEqual(after.invoices.map((invoice) => invoice.number), before.invoices.map((invoice) => invoice.number));
    assert.equal((await again.business.auditTrail(sekou, 'spc_biz_boke')).check.intact, true);
    // L'attestation de Kadiatou est redéposée dans son coffre après le redémarrage.
    const vault = restarted.documents({ personId: 'per_kadiatou', channel: 'phone', spaceId: 'spc_cit_kadiatou' }, 'spc_cit_kadiatou');
    assert.ok(vault.some((document) => document.category === 'employment'));
  });

  it('référentiel : versé une fois, une inscription survit au redémarrage et se voit d’une autre instance', async () => {
    const first = (await loadDemoApp({ store, directory: store })).app;
    assert.equal(first.personByNin('GN-NIN-0000000006')?.fullName, 'Kadiatou Sow');
    const { person, space } = await first.register({ nin: 'gn-nin-0000009001', fullName: 'Néné  Kaba', phone: '620 11 22 33' });
    assert.equal(person.nin, 'GN-NIN-0000009001');
    assert.equal(person.fullName, 'Néné Kaba');
    assert.equal(person.phone, '+224 620 11 22 33');
    assert.equal(person.identity, 'declared');
    // Une autre instance, démarrée avant l'inscription, la trouve à la première recherche (relecture sur absence).
    const second = (await loadDemoApp({ store, directory: store })).app;
    assert.equal((await second.findPersonByNin('GN-NIN-0000009001'))?.id, person.id);
    assert.deepEqual(second.me({ personId: person.id, channel: 'phone', spaceId: space.id }).spaces.map((access) => access.space.id), [space.id]);
    await assert.rejects(second.register({ nin: 'GN-NIN-0000009001', fullName: 'Autre Nom', phone: '+224 621 00 00 00' }), { code: 'conflict' });
    const { rows } = await sql.query<{ count: string }>('SELECT count(*) FROM persons');
    assert.equal(Number(rows[0]?.count), 9);
  });

  it('référentiel : deux inscriptions simultanées d’un même NIN, une seule passe', async () => {
    const one = (await loadDemoApp({ store, directory: store })).app;
    const two = (await loadDemoApp({ store, directory: store })).app;
    const results = await Promise.allSettled([
      one.register({ nin: 'GN-NIN-0000009002', fullName: 'Fanta Cissé', phone: '+224 622 33 44 55' }),
      two.register({ nin: 'GN-NIN-0000009002', fullName: 'Fanta Cissé', phone: '+224 622 33 44 55' }),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
    const { rows } = await sql.query<{ count: string }>("SELECT count(*) FROM spaces WHERE document->>'ownerPersonId' IN (SELECT id FROM persons WHERE nin = 'GN-NIN-0000009002')");
    assert.equal(Number(rows[0]?.count), 1);
  });

  it('membres : rattacher, retirer, et l’autre instance le voit après relecture', async () => {
    const one = (await loadDemoApp({ store, directory: store })).app;
    const two = (await loadDemoApp({ store, directory: store })).app;
    const sekou: Actor = { personId: 'per_sekou', channel: 'desktop', spaceId: 'spc_biz_boke' };
    const added = await one.addMember(sekou, 'spc_biz_boke', { nin: 'GN-NIN-0000000006', role: 'business_accountant' });
    assert.equal(added.roleLabel, 'Comptable');
    const kadiatou: Actor = { personId: 'per_kadiatou', channel: 'desktop', spaceId: 'spc_biz_boke' };
    await assert.rejects(two.overview(kadiatou, 'spc_biz_boke'), { code: 'not_a_member' });
    await two.refresh();
    assert.equal((await two.overview(kadiatou, 'spc_biz_boke')).total.currency, 'GNF');
    await one.removeMember(sekou, 'spc_biz_boke', 'per_kadiatou');
    await two.refresh();
    await assert.rejects(two.overview(kadiatou, 'spc_biz_boke'), { code: 'not_a_member' });
  });

  it('inscription par l’API : code au numéro donné, personne et espace en base, session ouverte', async () => {
    const { app } = await loadDemoApp({ store, directory: store });
    const sms = new MemorySmsSender();
    const auth = new Auth({ app, sms, secret: 'cle-de-session-de-test-0123456789abcdef', store });
    const asked = await auth.requestRegistration({ nin: 'GN-NIN-0000009003', fullName: 'Ibrahim Fofana', phone: '+224 623 45 67 89' });
    const code = sms.lastCodeFor('+224 623 45 67 89')!;
    const { session } = await auth.confirmRegistration(asked.challengeId, code);
    const { rows } = await sql.query<{ nin: string }>('SELECT p.nin FROM persons p JOIN memberships m ON m.person_id = p.id WHERE m.space_id = $1', [session.spaceId]);
    assert.deepEqual(rows.map((row) => row.nin), ['GN-NIN-0000009003']);
    await assert.rejects(auth.confirmRegistration(asked.challengeId, code), { code: 'unauthenticated' });
  });
});
