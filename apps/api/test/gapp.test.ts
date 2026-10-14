import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDemoApp, loadDemoGapp } from '@app-gn/core';
import { buildServer } from '../src/app.ts';

async function setup() {
  const { app } = createDemoApp();
  const gapp = await loadDemoGapp(app);
  return buildServer(app, { gapp });
}

const as = (person: string, space: string, channel = 'desktop') => ({ authorization: `Bearer demo:${person}@${space}`, 'appgn-channel': channel });

describe('API GAPP', () => {
  it('le tableau de bord d’entreprise répond dans la session de l’entreprise, jamais depuis l’espace personnel', async () => {
    const server = await setup();
    const treasury = await server.inject({ method: 'GET', url: '/v1/spaces/spc_biz_boke/business/treasury', headers: as('per_sekou', 'spc_biz_boke') });
    assert.equal(treasury.statusCode, 200);
    assert.equal(treasury.json().projection.length, 8);
    const fromPersonal = await server.inject({ method: 'GET', url: '/v1/spaces/spc_biz_boke/business/treasury', headers: as('per_sekou', 'spc_cit_sekou') });
    assert.equal(fromPersonal.statusCode, 403);
    assert.equal(fromPersonal.json().error, 'not_a_member');
    const onPhone = await server.inject({ method: 'GET', url: '/v1/spaces/spc_biz_boke/business/treasury', headers: as('per_sekou', 'spc_biz_boke', 'phone') });
    assert.equal(onPhone.json().error, 'channel_not_allowed');
    const hr = await server.inject({ method: 'GET', url: '/v1/spaces/spc_biz_boke/business/treasury', headers: as('per_aissatou', 'spc_biz_boke') });
    assert.equal(hr.statusCode, 403);
  });

  it('facture, lot fournisseur approuvé par le dirigeant, journal exporté', async () => {
    const server = await setup();
    const alpha = as('per_alpha', 'spc_biz_boke');
    const invoice = await server.inject({
      method: 'POST', url: '/v1/spaces/spc_biz_boke/business/invoices', headers: { ...alpha, 'idempotency-key': 'f-1' },
      payload: { customer: { name: 'Client test' }, lines: [{ description: 'Transport', quantity: 1, unitPrice: '1000000' }] },
    });
    assert.equal(invoice.statusCode, 201);
    assert.equal(invoice.json().number, 'FAC-2026-0006');

    const bill = await server.inject({
      method: 'POST', url: '/v1/spaces/spc_biz_boke/business/bills', headers: { ...alpha, 'idempotency-key': 'b-1' },
      payload: { supplier: { name: 'Huilerie' }, payee: { operator: 'orange_money', phone: '+224 620 12 34 56' }, reference: 'H-1', amount: '6000000', dueDate: '2099-01-01' },
    });
    assert.equal(bill.statusCode, 201);
    const batch = await server.inject({ method: 'POST', url: '/v1/spaces/spc_biz_boke/business/batches', headers: { ...alpha, 'idempotency-key': 'l-1' }, payload: { billIds: [bill.json().id], sourceAccountId: 'acc_bl_om' } });
    assert.equal(batch.json().status, 'pending_approval');
    const url = `/v1/spaces/spc_biz_boke/business/batches/${batch.json().id}/approve`;
    // Au-delà du seuil : 428 et un code (rendu ici, démonstration), puis la même demande avec le code.
    const asked = await server.inject({ method: 'POST', url, headers: as('per_sekou', 'spc_biz_boke') });
    assert.equal(asked.statusCode, 428);
    assert.equal(asked.json().error, 'confirmation_required');
    const { challengeId, demoCode } = asked.json().confirmation;
    assert.equal((await server.inject({ method: 'POST', url, headers: { ...as('per_sekou', 'spc_biz_boke'), 'appgn-confirmation': 'mauvais' } })).statusCode, 400);
    const approved = await server.inject({ method: 'POST', url, headers: { ...as('per_sekou', 'spc_biz_boke'), 'appgn-confirmation': `${challengeId}.${demoCode}` } });
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.json().status, 'executed');

    const ledger = await server.inject({ method: 'GET', url: '/v1/spaces/spc_biz_boke/business/ledger/2026-10', headers: alpha });
    assert.match(ledger.json().content, /^Date;Journal;Pièce;Compte;Libellé;Débit;Crédit\n/);
  });

  it('mandat visé par le comptable public, état pour la Cour des Comptes', async () => {
    const server = await setup();
    const engagements = await server.inject({ method: 'GET', url: '/v1/spaces/spc_adm_kaloum/administration/engagements', headers: as('per_ibrahima', 'spc_adm_kaloum') });
    const awaiting = engagements.json().find((engagement: { liquidations: { state: string }[] }) => engagement.liquidations.some((liquidation) => liquidation.state === 'awaiting_visa'));
    const url = `/v1/spaces/spc_adm_kaloum/administration/engagements/${awaiting.id}/liquidations/${awaiting.liquidations[0].id}/visa`;
    assert.equal((await server.inject({ method: 'POST', url, headers: as('per_fatoumata', 'spc_adm_kaloum') })).statusCode, 403);
    const visa = await server.inject({ method: 'POST', url, headers: as('per_ibrahima', 'spc_adm_kaloum') });
    assert.equal(visa.json().liquidations[0].state, 'paid');
    const report = await server.inject({ method: 'GET', url: '/v1/spaces/spc_adm_kaloum/administration/court-report', headers: as('per_mamadou', 'spc_adm_kaloum') });
    assert.match(report.json().content, /MDT-2026-0002/);
    // Un tableau de bord d'administration n'existe pas dans une entreprise.
    assert.equal((await server.inject({ method: 'GET', url: '/v1/spaces/spc_biz_boke/administration/budget', headers: as('per_sekou', 'spc_biz_boke') })).statusCode, 404);
  });
});
