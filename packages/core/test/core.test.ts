import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError, convert, createDemoApp, formatMoney, MemoryStore, money, Outbox, parseMajor, SnapshotCache, toReference, type Actor, type Channel } from '../src/index.ts';

const fixedNow = () => new Date('2026-10-12T10:00:00Z');
const A = (personId: string, channel: Channel = 'desktop'): Actor => ({ personId, channel });

function demo() {
  return createDemoApp({ now: fixedNow, aggregationTimeoutMs: 50 });
}

async function rejects(promise: Promise<unknown> | (() => unknown), code: string) {
  await assert.rejects(async () => (typeof promise === 'function' ? promise() : promise), (error: unknown) => {
    assert.ok(error instanceof AppError, `AppError attendue, reçu ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

describe('montants', () => {
  it('lit un montant sans arrondir et refuse les décimales en trop', () => {
    assert.deepEqual(parseMajor('150000', 'GNF'), money(150000, 'GNF'));
    assert.equal(parseMajor('10.5', 'GNF'), null);
    assert.deepEqual(parseMajor('12,50', 'USD'), money(1250, 'USD'));
  });

  it('convertit vers le GNF au plus proche', () => {
    assert.deepEqual(toReference(money(1250, 'USD'), { USD: 8650n }), money(108125, 'GNF'));
    assert.deepEqual(toReference(money(1, 'USD'), { USD: 8650n }), money(87, 'GNF'));
    assert.equal(toReference(money(1, 'EUR'), {}), null);
  });

  it('formate selon la devise', () => {
    assert.equal(formatMoney(money(1845000, 'GNF')).replace(/\s/g, ' '), '1 845 000 GNF');
    assert.equal(formatMoney(money(8500, 'USD')).replace(/\s/g, ' '), '85,00 USD');
  });
});

describe('profils et accès', () => {
  it('une personne voit chacun de ses espaces avec son rôle', () => {
    const { app } = demo();
    const me = app.me(A('per_mariama'));
    assert.deepEqual(me.spaces.map((access) => [access.space.kind, access.role]), [
      ['citizen', 'citizen'],
      ['business', 'business_owner'],
    ]);
  });

  it('refuse un espace dont on n’est pas membre, sans dire s’il existe', async () => {
    const { app } = demo();
    await rejects(app.overview(A('per_mariama'), 'spc_adm_kaloum'), 'not_a_member');
    await rejects(app.overview(A('per_mariama'), 'spc_inexistant'), 'not_a_member');
  });

  it('le catalogue de services suit le rôle', () => {
    const { app } = demo();
    const ordonnateur = app.services(A('per_fatoumata'), 'spc_adm_kaloum').map((service) => service.id);
    const comptable = app.services(A('per_ibrahima'), 'spc_adm_kaloum').map((service) => service.id);
    assert.ok(ordonnateur.includes('administration.mandate'));
    assert.ok(!ordonnateur.includes('administration.approve'));
    assert.ok(comptable.includes('administration.approve'));
    assert.ok(!comptable.includes('administration.mandate'));
  });
});

describe('fonds personnels et fonds d’organisation séparés', () => {
  it('une session de l’espace personnel ne lit rien de l’entreprise, et l’inverse', async () => {
    const { app } = createDemoApp({ aggregationTimeoutMs: 50 });
    const personal: Actor = { personId: 'per_mariama', channel: 'desktop', spaceId: 'spc_cit_mariama' };
    const business: Actor = { personId: 'per_mariama', channel: 'desktop', spaceId: 'spc_biz_couture' };
    assert.ok(await app.overview(personal, 'spc_cit_mariama'));
    await assert.rejects(app.overview(personal, 'spc_biz_couture'), { code: 'not_a_member' });
    await assert.rejects(app.overview(business, 'spc_cit_mariama'), { code: 'not_a_member' });
    await assert.rejects(app.listPayments(business, 'spc_cit_mariama'), { code: 'not_a_member' });
    assert.throws(() => app.documents(business, 'spc_cit_mariama'), { code: 'not_a_member' });

    const me = app.me(business);
    assert.deepEqual(me.spaces.map((access) => access.space.id), ['spc_biz_couture']);
    assert.deepEqual(me.otherSpaces.map((entry) => entry.id), ['spc_cit_mariama']);
    assert.throws(() => app.me({ ...personal, spaceId: 'spc_biz_boke' }), { code: 'not_a_member' });
  });

  it('une personne sans entreprise n’a que son espace personnel', () => {
    const { app } = createDemoApp();
    assert.deepEqual(app.entrances('per_kadiatou', 'phone').map((entry) => entry.kind), ['citizen']);
    assert.deepEqual(app.entrances('per_mariama', 'phone').map((entry) => [entry.kind, entry.opensOnChannel]), [['citizen', true], ['business', false]]);
  });
});

describe('vue consolidée', () => {
  it('additionne tous les comptes en GNF, crypto et devises comprises', async () => {
    const { app } = demo();
    const view = await app.overview(A('per_mariama'), 'spc_cit_mariama');
    assert.equal(view.positions.length, 6);
    assert.equal(view.partial, false);
    // 1 845 000 + 420 000 + 6 300 000 + 250 000 + 85 USD × 8 650 + 120,5 USDT × 8 640
    assert.equal(view.total.amount, String(1_845_000 + 420_000 + 6_300_000 + 250_000 + 85 * 8_650 + 120.5 * 8_640));
    const kinds = view.byKind.map((bucket) => bucket.kind).sort();
    assert.deepEqual(kinds, ['app_wallet', 'bank', 'crypto', 'mobile_money', 'virtual_card']);
  });

  it('un fournisseur en panne ne bloque pas la vue : dernier solde connu, marqué ancien', async () => {
    const { app, network } = demo();
    await app.overview(A('per_alpha'), 'spc_biz_boke');
    network.setUnavailable('cellcom_money', true);
    const view = await app.overview(A('per_alpha'), 'spc_biz_boke');
    const cellcom = view.positions.find((position) => position.account.providerId === 'cellcom_money');
    assert.equal(cellcom?.freshness, 'stale');
    assert.equal(cellcom?.balance?.amount, '4100000');
    assert.equal(view.partial, true);
  });

  it('un fournisseur jamais joint est indisponible et exclu du total', async () => {
    const { app, network } = demo();
    network.setLatency('uba', 200);
    const view = await app.overview(A('per_alpha'), 'spc_biz_boke');
    const uba = view.positions.find((position) => position.account.providerId === 'uba');
    assert.equal(uba?.freshness, 'unavailable');
    assert.equal(uba?.balance, undefined);
    assert.equal(view.partial, true);
  });
});

describe('paiements', () => {
  it('un citoyen paie une facture : débit immédiat, solde à jour', async () => {
    const { app } = demo();
    const payment = await app.initiatePayment(A('per_mariama'), 'spc_cit_mariama', {
      sourceAccountId: 'acc_mc_om', amount: '45000', destination: { type: 'biller', billerId: 'edg', customerReference: 'CPT-778899' },
    }, 'k1');
    assert.equal(payment.status, 'completed');
    const view = await app.overview(A('per_mariama'), 'spc_cit_mariama');
    assert.equal(view.positions.find((position) => position.account.id === 'acc_mc_om')?.balance?.amount, '1800000');
  });

  it('rejoue la même clé d’idempotence sans débiter deux fois, refuse une autre demande sous la même clé', async () => {
    const { app } = demo();
    const input = { sourceAccountId: 'acc_mc_om', amount: '1000', destination: { type: 'own_account' as const, accountId: 'acc_mc_mtn' } };
    const first = await app.initiatePayment(A('per_mariama'), 'spc_cit_mariama', input, 'same');
    const second = await app.initiatePayment(A('per_mariama'), 'spc_cit_mariama', input, 'same');
    assert.equal(first.id, second.id);
    assert.equal((await app.listPayments(A('per_mariama'), 'spc_cit_mariama')).length, 1);
    await rejects(app.initiatePayment(A('per_mariama'), 'spc_cit_mariama', { ...input, amount: '2000' }, 'same'), 'idempotency_conflict');
  });

  it('refuse un débit au-delà du solde, sans toucher au compte', async () => {
    const { app } = demo();
    const payment = await app.initiatePayment(A('per_mariama'), 'spc_cit_mariama', {
      sourceAccountId: 'acc_mc_mtn', amount: '999999999', destination: { type: 'mobile_money', operator: 'orange_money', phone: '+224 620 11 22 33' },
    }, 'k2');
    assert.equal(payment.status, 'failed');
    assert.equal(payment.failureReason, 'insufficient_funds');
  });

  it('entreprise : au-delà du seuil, le DAF initie et le dirigeant approuve', async () => {
    const { app } = demo();
    const small = await app.initiatePayment(A('per_alpha'), 'spc_biz_boke', {
      sourceAccountId: 'acc_bl_om', amount: '1500000', destination: { type: 'mobile_money', operator: 'mtn_momo', phone: '+224 664 55 66 77' },
    }, 'k3');
    assert.equal(small.status, 'completed');

    const large = await app.initiatePayment(A('per_alpha'), 'spc_biz_boke', {
      sourceAccountId: 'acc_bl_eco', amount: '25000000', destination: { type: 'own_account', accountId: 'acc_bl_uba' },
    }, 'k4');
    assert.equal(large.status, 'pending_approval');
    await rejects(app.approvePayment(A('per_alpha'), 'spc_biz_boke', large.id), 'forbidden');
    const approved = await app.approvePayment(A('per_sekou'), 'spc_biz_boke', large.id);
    assert.equal(approved.status, 'completed');
    assert.equal(approved.decidedBy, 'per_sekou');
  });

  it('administration : l’ordonnateur mandate, le comptable public paie ou rejette', async () => {
    const { app } = demo();
    const input = {
      sourceAccountId: 'acc_kal_tresor', amount: '12000000', destination: { type: 'mobile_money' as const, operator: 'orange_money' as const, phone: '+224 620 98 76 54', name: 'Entreprise Nettoyage' },
    };
    // Hors du bureau GAPP Institutionnel (engagement, liquidation, mandat), aucune dépense publique ne part.
    await rejects(app.initiatePayment(A('per_fatoumata'), 'spc_adm_kaloum', input, 'k4'), 'invalid_request');
    const mandate = await app.initiatePayment(A('per_fatoumata'), 'spc_adm_kaloum', input, 'k5', 'desk');
    assert.equal(mandate.status, 'pending_approval');
    await rejects(app.approvePayment(A('per_fatoumata'), 'spc_adm_kaloum', mandate.id, 'desk'), 'forbidden');
    await rejects(app.approvePayment(A('per_ibrahima'), 'spc_adm_kaloum', mandate.id), 'invalid_request');
    const paid = await app.approvePayment(A('per_ibrahima'), 'spc_adm_kaloum', mandate.id, 'desk');
    assert.equal(paid.status, 'completed');
    await rejects(app.approvePayment(A('per_ibrahima'), 'spc_adm_kaloum', mandate.id, 'desk'), 'invalid_state');
  });

  it('le comptable public ne peut pas initier', async () => {
    const { app } = demo();
    await rejects(app.initiatePayment(A('per_ibrahima'), 'spc_adm_kaloum', {
      sourceAccountId: 'acc_kal_tresor', amount: '1000', destination: { type: 'own_account', accountId: 'acc_kal_eco' },
    }, 'k6'), 'forbidden');
  });

  it('refuse de débiter un compte crypto et un compte d’un autre espace', async () => {
    const { app } = demo();
    await rejects(app.initiatePayment(A('per_mariama'), 'spc_cit_mariama', {
      sourceAccountId: 'acc_mc_usdt', amount: '10', destination: { type: 'own_account', accountId: 'acc_mc_om' },
    }, 'k7'), 'invalid_request');
    await rejects(app.initiatePayment(A('per_mariama'), 'spc_cit_mariama', {
      sourceAccountId: 'acc_bl_eco', amount: '10', destination: { type: 'own_account', accountId: 'acc_mc_om' },
    }, 'k8'), 'not_found');
  });
});

describe('canaux', () => {
  it('sur téléphone, seul l\u2019espace citoyen s\u2019ouvre', async () => {
    const { app } = demo();
    const me = app.me(A('per_alpha', 'phone'));
    assert.deepEqual(me.spaces.map((access) => [access.space.kind, access.opensOnChannel]), [['citizen', true], ['business', false]]);
    await app.overview(A('per_alpha', 'phone'), 'spc_cit_alpha');
    await rejects(app.overview(A('per_alpha', 'phone'), 'spc_biz_boke'), 'channel_not_allowed');
    await app.overview(A('per_alpha', 'tablet'), 'spc_biz_boke');
  });
});

describe('documents', () => {
  it('classe les documents expirés et bientôt expirés en tête', () => {
    const { app } = demo();
    const docs = app.documents(A('per_mariama', 'phone'), 'spc_cit_mariama');
    assert.equal(docs[0]?.validity, 'expiring');
    const insurance = docs.find((doc) => doc.id === 'doc_mc_assurance');
    assert.equal(insurance?.validity, 'expiring');
    assert.equal(insurance?.daysLeft, 12);
    const expired = app.documents(A('per_alpha'), 'spc_cit_alpha')[0];
    assert.equal(expired?.validity, 'expired');
  });

  it('un contrôleur vérifie un code sans voir le reste du document', () => {
    const { app } = demo();
    const check = app.verifyDocument(' gn-pc-9d2f-h7rt ');
    assert.deepEqual(Object.keys(check).sort(), ['expiresAt', 'holderName', 'issuer', 'title', 'validity']);
    assert.equal(check.validity, 'valid');
    assert.throws(() => app.verifyDocument('GN-XX-0000'), AppError);
  });

  it('le coffre d\u2019un espace n\u2019est lisible que par ses membres', async () => {
    const { app } = demo();
    await rejects(() => app.documents(A('per_alpha'), 'spc_cit_mariama'), 'not_a_member');
  });
});

describe('cartes et conversions', () => {
  it('convertit en passant par le GNF, arrondi vers le bas', () => {
    assert.deepEqual(convert(money(865000, 'GNF'), 'USD', { USD: 8650n }), money(10000, 'USD'));
    assert.deepEqual(convert(money(100_000_000, 'USDT'), 'GNF', { USDT: 8640n }), money(864000, 'GNF'));
  });

  it('recharge une carte depuis Orange Money : frais et cours affichés, puis exécution', async () => {
    const { app } = demo();
    const me = A('per_mariama', 'phone');
    const quote = app.quoteExchange(me, 'spc_cit_mariama', { sourceAccountId: 'acc_mc_om', targetAccountId: 'acc_mc_card', amount: '432500' });
    assert.equal(quote.feeBps, 200);
    assert.equal(quote.fee.amount, '8650');
    // (432 500 − 8 650) / 8 650 = 49,00 USD
    assert.deepEqual(quote.credit, money(4900, 'USD'));
    const done = await app.executeExchange(me, 'spc_cit_mariama', quote.id, 'x1');
    assert.equal(done.status, 'completed');
    const again = await app.executeExchange(me, 'spc_cit_mariama', quote.id, 'x1');
    assert.equal(again.id, done.id);
    const view = await app.overview(me, 'spc_cit_mariama');
    assert.equal(view.positions.find((p) => p.account.id === 'acc_mc_card')?.balance?.amount, String(8500 + 4900));
    await rejects(app.executeExchange(me, 'spc_cit_mariama', quote.id, 'x2'), 'not_found');
  });

  it('un devis expire au bout d\u2019une minute', async () => {
    let clock = Date.parse('2026-10-12T10:00:00Z');
    const { app } = createDemoApp({ now: () => new Date(clock), aggregationTimeoutMs: 50 });
    const quote = app.quoteExchange(A('per_mariama'), 'spc_cit_mariama', { sourceAccountId: 'acc_mc_usdt', targetAccountId: 'acc_mc_om', amount: '50' });
    assert.equal(quote.feeBps, 100);
    clock += 61_000;
    await rejects(app.executeExchange(A('per_mariama'), 'spc_cit_mariama', quote.id, 'late'), 'invalid_state');
  });

  it('émet une carte, la bloque : plus aucun débit, puis la débloque', async () => {
    const { app } = demo();
    const me = A('per_mariama', 'phone');
    const card = await app.issueCard(me, 'spc_cit_mariama', { network: 'mastercard', tier: 'gold' }, 'c1');
    assert.equal(card.status, 'active');
    assert.equal(app.cards(me, 'spc_cit_mariama').length, 2);
    await app.setCardFrozen(me, 'spc_cit_mariama', 'acc_mc_card', true);
    await rejects(app.initiatePayment(me, 'spc_cit_mariama', {
      sourceAccountId: 'acc_mc_card', amount: '5', destination: { type: 'own_account', accountId: card.accountId },
    }, 'p1'), 'invalid_state');
    await app.setCardFrozen(me, 'spc_cit_mariama', 'acc_mc_card', false);
    const paid = await app.initiatePayment(me, 'spc_cit_mariama', {
      sourceAccountId: 'acc_mc_card', amount: '5', destination: { type: 'own_account', accountId: card.accountId },
    }, 'p1');
    assert.equal(paid.status, 'completed');
  });

  it('au plus trois cartes par type', async () => {
    const { app } = demo();
    const me = A('per_mariama');
    for (const key of ['a', 'b']) await app.issueCard(me, 'spc_cit_mariama', { network: 'visa', tier: 'standard' }, key);
    await rejects(app.issueCard(me, 'spc_cit_mariama', { network: 'visa', tier: 'standard' }, 'c'), 'invalid_state');
  });
});

describe('hors ligne', () => {
  const op = (id: string, createdAt: string) => ({ id, kind: 'payment', personId: 'per_mariama', spaceId: 'spc_cit_mariama', payload: { n: id }, createdAt });

  it('rejoue dans l\u2019ordre et s\u2019arrête à la première coupure', async () => {
    const outbox = new Outbox(new MemoryStore());
    await outbox.enqueue(op('k1', '2026-10-12T08:00:00Z'));
    await outbox.enqueue(op('k2', '2026-10-12T08:01:00Z'));
    await outbox.enqueue(op('k3', '2026-10-12T08:02:00Z'));
    const seen: string[] = [];
    await outbox.flush(async (pending) => {
      seen.push(pending.id);
      return pending.id === 'k2' ? { outcome: 'offline' } : { outcome: 'sent' };
    }, new Date('2026-10-12T09:00:00Z'));
    assert.deepEqual(seen, ['k1', 'k2']);
    assert.deepEqual((await outbox.list()).map((p) => p.status), ['sent', 'pending', 'pending']);
  });

  it('ne rejoue que les paiements de l’espace ouvert ; oublie les lectures de l’espace quitté', async () => {
    const store = new MemoryStore();
    const outbox = new Outbox(store);
    await outbox.enqueue(op('perso', '2026-10-12T08:00:00Z'));
    await outbox.enqueue({ ...op('pro', '2026-10-12T08:01:00Z'), spaceId: 'spc_biz_couture' });
    const seen: string[] = [];
    await outbox.flush(async (pending) => { seen.push(pending.id); return { outcome: 'sent' }; }, new Date('2026-10-12T09:00:00Z'),
      (pending) => pending.spaceId === 'spc_biz_couture');
    assert.deepEqual(seen, ['pro']);
    assert.deepEqual((await outbox.list()).map((p) => p.status), ['pending', 'sent']);

    const cache = new SnapshotCache(store);
    await cache.saveIn('per_mariama@spc_cit_mariama', 'a', { solde: 1 }, new Date());
    await cache.saveIn('per_mariama@spc_biz_couture', 'b', { solde: 2 }, new Date());
    await cache.forget('per_mariama@spc_cit_mariama');
    assert.equal(await cache.load('a'), null);
    assert.ok(await cache.load('b'));
  });

  it('expire un paiement resté plus de 24 h sans réseau, sans l\u2019envoyer', async () => {
    const outbox = new Outbox(new MemoryStore());
    await outbox.enqueue(op('old', '2026-10-10T08:00:00Z'));
    let called = false;
    await outbox.flush(async () => { called = true; return { outcome: 'sent' }; }, new Date('2026-10-12T09:00:00Z'));
    assert.equal(called, false);
    assert.equal((await outbox.list())[0]?.status, 'expired');
  });

  it('le rejeu d\u2019un paiement déjà reçu ne débite pas deux fois (même clé d\u2019idempotence)', async () => {
    const { app } = demo();
    const me = A('per_mariama', 'phone');
    const input = { sourceAccountId: 'acc_mc_om', amount: '10000', destination: { type: 'biller' as const, billerId: 'edg', customerReference: 'CPT-1' } };
    const outbox = new Outbox(new MemoryStore());
    await outbox.enqueue({ ...op('offline-1', '2026-10-12T09:59:00Z'), payload: input });
    // Premier envoi : le serveur traite, mais la réponse se perd.
    await app.initiatePayment(me, 'spc_cit_mariama', input, 'offline-1');
    await outbox.flush(async (pending) => {
      const payment = await app.initiatePayment(me, pending.spaceId, pending.payload as typeof input, pending.id);
      return { outcome: 'sent', detail: payment.id };
    }, fixedNow());
    assert.equal((await app.listPayments(me, 'spc_cit_mariama')).length, 1);
  });
});
