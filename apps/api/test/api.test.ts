import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDemoApp } from '@app-gn/core';
import { buildServer } from '../src/app.ts';

function server() {
  return buildServer(createDemoApp({ aggregationTimeoutMs: 50 }).app);
}

const as = (personId: string) => ({ authorization: `Bearer demo:${personId}` });

describe('API', () => {
  it('exige une identité', async () => {
    const response = await server().inject({ method: 'GET', url: '/v1/me' });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, 'unauthenticated');
  });

  it('rend les espaces de la personne', async () => {
    const response = await server().inject({ method: 'GET', url: '/v1/me', headers: as('per_fatoumata') });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().spaces.map((access: { space: { kind: string } }) => access.space.kind), ['citizen', 'administration']);
  });

  it('rend la vue consolidée et refuse un espace étranger', async () => {
    const app = server();
    const ok = await app.inject({ method: 'GET', url: '/v1/spaces/spc_biz_boke/overview', headers: as('per_alpha') });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().total.currency, 'GNF');
    const ko = await app.inject({ method: 'GET', url: '/v1/spaces/spc_biz_boke/overview', headers: as('per_mariama') });
    assert.equal(ko.statusCode, 403);
  });

  it('mandat → visa : 201 en attente, 403 pour l’ordonnateur, 200 pour le comptable', async () => {
    const app = server();
    const created = await app.inject({
      method: 'POST', url: '/v1/spaces/spc_adm_kaloum/payments',
      headers: { ...as('per_fatoumata'), 'idempotency-key': 'm-1' },
      payload: { sourceAccountId: 'acc_kal_tresor', amount: '5000000', destination: { type: 'own_account', accountId: 'acc_kal_eco' } },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().status, 'pending_approval');
    const id = created.json().id;
    const denied = await app.inject({ method: 'POST', url: `/v1/spaces/spc_adm_kaloum/payments/${id}/approve`, headers: as('per_fatoumata') });
    assert.equal(denied.statusCode, 403);
    const paid = await app.inject({ method: 'POST', url: `/v1/spaces/spc_adm_kaloum/payments/${id}/approve`, headers: as('per_ibrahima') });
    assert.equal(paid.statusCode, 200);
    assert.equal(paid.json().status, 'completed');
  });

  it('exige une clé d’idempotence', async () => {
    const response = await server().inject({
      method: 'POST', url: '/v1/spaces/spc_cit_mariama/payments', headers: as('per_mariama'),
      payload: { sourceAccountId: 'acc_mc_om', amount: '1000', destination: { type: 'own_account', accountId: 'acc_mc_mtn' } },
    });
    assert.equal(response.statusCode, 400);
  });
});
