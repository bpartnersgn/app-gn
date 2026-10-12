import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError, createDemoApp, formatMoney, money, parseMajor, toReference } from '../src/index.ts';

const fixedNow = () => new Date('2026-10-12T10:00:00Z');

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
    const me = app.me('per_mariama');
    assert.deepEqual(me.spaces.map((access) => [access.space.kind, access.role]), [
      ['citizen', 'citizen'],
      ['business', 'business_owner'],
    ]);
  });

  it('refuse un espace dont on n’est pas membre, sans dire s’il existe', async () => {
    const { app } = demo();
    await rejects(app.overview('per_mariama', 'spc_adm_kaloum'), 'not_a_member');
    await rejects(app.overview('per_mariama', 'spc_inexistant'), 'not_a_member');
  });

  it('le catalogue de services suit le rôle', () => {
    const { app } = demo();
    const ordonnateur = app.services('per_fatoumata', 'spc_adm_kaloum').map((service) => service.id);
    const comptable = app.services('per_ibrahima', 'spc_adm_kaloum').map((service) => service.id);
    assert.ok(ordonnateur.includes('administration.mandate'));
    assert.ok(!ordonnateur.includes('administration.approve'));
    assert.ok(comptable.includes('administration.approve'));
    assert.ok(!comptable.includes('administration.mandate'));
  });
});

describe('vue consolidée', () => {
  it('additionne tous les comptes en GNF, crypto et devises comprises', async () => {
    const { app } = demo();
    const view = await app.overview('per_mariama', 'spc_cit_mariama');
    assert.equal(view.positions.length, 6);
    assert.equal(view.partial, false);
    // 1 845 000 + 420 000 + 6 300 000 + 250 000 + 85 USD × 8 650 + 120,5 USDT × 8 640
    assert.equal(view.total.amount, String(1_845_000 + 420_000 + 6_300_000 + 250_000 + 85 * 8_650 + 120.5 * 8_640));
    const kinds = view.byKind.map((bucket) => bucket.kind).sort();
    assert.deepEqual(kinds, ['app_wallet', 'bank', 'crypto', 'mobile_money', 'virtual_card']);
  });

  it('un fournisseur en panne ne bloque pas la vue : dernier solde connu, marqué ancien', async () => {
    const { app, network } = demo();
    await app.overview('per_alpha', 'spc_biz_boke');
    network.setUnavailable('cellcom_money', true);
    const view = await app.overview('per_alpha', 'spc_biz_boke');
    const cellcom = view.positions.find((position) => position.account.providerId === 'cellcom_money');
    assert.equal(cellcom?.freshness, 'stale');
    assert.equal(cellcom?.balance?.amount, '4100000');
    assert.equal(view.partial, true);
  });

  it('un fournisseur jamais joint est indisponible et exclu du total', async () => {
    const { app, network } = demo();
    network.setLatency('uba', 200);
    const view = await app.overview('per_alpha', 'spc_biz_boke');
    const uba = view.positions.find((position) => position.account.providerId === 'uba');
    assert.equal(uba?.freshness, 'unavailable');
    assert.equal(uba?.balance, undefined);
    assert.equal(view.partial, true);
  });
});

describe('paiements', () => {
  it('un citoyen paie une facture : débit immédiat, solde à jour', async () => {
    const { app } = demo();
    const payment = await app.initiatePayment('per_mariama', 'spc_cit_mariama', {
      sourceAccountId: 'acc_mc_om', amount: '45000', destination: { type: 'biller', billerId: 'edg', customerReference: 'CPT-778899' },
    }, 'k1');
    assert.equal(payment.status, 'completed');
    const view = await app.overview('per_mariama', 'spc_cit_mariama');
    assert.equal(view.positions.find((position) => position.account.id === 'acc_mc_om')?.balance?.amount, '1800000');
  });

  it('rejoue la même clé d’idempotence sans débiter deux fois, refuse une autre demande sous la même clé', async () => {
    const { app } = demo();
    const input = { sourceAccountId: 'acc_mc_om', amount: '1000', destination: { type: 'own_account' as const, accountId: 'acc_mc_mtn' } };
    const first = await app.initiatePayment('per_mariama', 'spc_cit_mariama', input, 'same');
    const second = await app.initiatePayment('per_mariama', 'spc_cit_mariama', input, 'same');
    assert.equal(first.id, second.id);
    assert.equal(app.listPayments('per_mariama', 'spc_cit_mariama').length, 1);
    await rejects(app.initiatePayment('per_mariama', 'spc_cit_mariama', { ...input, amount: '2000' }, 'same'), 'idempotency_conflict');
  });

  it('refuse un débit au-delà du solde, sans toucher au compte', async () => {
    const { app } = demo();
    const payment = await app.initiatePayment('per_mariama', 'spc_cit_mariama', {
      sourceAccountId: 'acc_mc_mtn', amount: '999999999', destination: { type: 'mobile_money', operator: 'orange_money', phone: '+224 620 11 22 33' },
    }, 'k2');
    assert.equal(payment.status, 'failed');
    assert.equal(payment.failureReason, 'insufficient_funds');
  });

  it('entreprise : au-delà du seuil, le DAF initie et le dirigeant approuve', async () => {
    const { app } = demo();
    const small = await app.initiatePayment('per_alpha', 'spc_biz_boke', {
      sourceAccountId: 'acc_bl_om', amount: '1500000', destination: { type: 'mobile_money', operator: 'mtn_momo', phone: '+224 664 55 66 77' },
    }, 'k3');
    assert.equal(small.status, 'completed');

    const large = await app.initiatePayment('per_alpha', 'spc_biz_boke', {
      sourceAccountId: 'acc_bl_eco', amount: '25000000', destination: { type: 'own_account', accountId: 'acc_bl_uba' },
    }, 'k4');
    assert.equal(large.status, 'pending_approval');
    await rejects(app.approvePayment('per_alpha', 'spc_biz_boke', large.id), 'forbidden');
    const approved = await app.approvePayment('per_sekou', 'spc_biz_boke', large.id);
    assert.equal(approved.status, 'completed');
    assert.equal(approved.decidedBy, 'per_sekou');
  });

  it('administration : l’ordonnateur mandate, le comptable public paie ou rejette', async () => {
    const { app } = demo();
    const mandate = await app.initiatePayment('per_fatoumata', 'spc_adm_kaloum', {
      sourceAccountId: 'acc_kal_tresor', amount: '12000000', destination: { type: 'mobile_money', operator: 'orange_money', phone: '+224 620 98 76 54', name: 'Entreprise Nettoyage' },
    }, 'k5');
    assert.equal(mandate.status, 'pending_approval');
    await rejects(app.approvePayment('per_fatoumata', 'spc_adm_kaloum', mandate.id), 'forbidden');
    const paid = await app.approvePayment('per_ibrahima', 'spc_adm_kaloum', mandate.id);
    assert.equal(paid.status, 'completed');
    await rejects(app.approvePayment('per_ibrahima', 'spc_adm_kaloum', mandate.id), 'invalid_state');
  });

  it('le comptable public ne peut pas initier', async () => {
    const { app } = demo();
    await rejects(app.initiatePayment('per_ibrahima', 'spc_adm_kaloum', {
      sourceAccountId: 'acc_kal_tresor', amount: '1000', destination: { type: 'own_account', accountId: 'acc_kal_eco' },
    }, 'k6'), 'forbidden');
  });

  it('refuse de débiter un compte crypto et un compte d’un autre espace', async () => {
    const { app } = demo();
    await rejects(app.initiatePayment('per_mariama', 'spc_cit_mariama', {
      sourceAccountId: 'acc_mc_usdt', amount: '10', destination: { type: 'own_account', accountId: 'acc_mc_om' },
    }, 'k7'), 'invalid_request');
    await rejects(app.initiatePayment('per_mariama', 'spc_cit_mariama', {
      sourceAccountId: 'acc_bl_eco', amount: '10', destination: { type: 'own_account', accountId: 'acc_mc_om' },
    }, 'k8'), 'not_found');
  });
});
