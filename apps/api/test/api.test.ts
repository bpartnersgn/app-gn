import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDemoApp } from '@app-gn/core';
import { buildServer } from '../src/app.ts';

function server() {
  return buildServer(createDemoApp({ aggregationTimeoutMs: 50 }).app);
}

const as = (personId: string, channel = 'desktop') => ({ authorization: `Bearer demo:${personId}`, 'appgn-channel': channel });

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

  it('en administration, pas de paiement direct : la dépense passe par le bureau GAPP Institutionnel', async () => {
    const app = server();
    const created = await app.inject({
      method: 'POST', url: '/v1/spaces/spc_adm_kaloum/payments',
      headers: { ...as('per_fatoumata'), 'idempotency-key': 'm-1' },
      payload: { sourceAccountId: 'acc_kal_tresor', amount: '5000000', destination: { type: 'own_account', accountId: 'acc_kal_eco' } },
    });
    assert.equal(created.statusCode, 400);
    assert.match(created.json().message, /engagement/);
  });

  it('exige une clé d’idempotence', async () => {
    const response = await server().inject({
      method: 'POST', url: '/v1/spaces/spc_cit_mariama/payments', headers: as('per_mariama'),
      payload: { sourceAccountId: 'acc_mc_om', amount: '1000', destination: { type: 'own_account', accountId: 'acc_mc_mtn' } },
    });
    assert.equal(response.statusCode, 400);
  });

  it('refuse l\u2019espace entreprise depuis un téléphone', async () => {
    const response = await server().inject({ method: 'GET', url: '/v1/spaces/spc_biz_boke/overview', headers: as('per_alpha', 'phone') });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error, 'channel_not_allowed');
  });

  it('vérifie un document sans authentification et sert le coffre à son porteur', async () => {
    const app = server();
    const check = await app.inject({ method: 'GET', url: '/v1/document-checks/GN-PC-9D2F-H7RT' });
    assert.equal(check.statusCode, 200);
    assert.equal(check.json().holderName, 'Mariama Camara');
    const vault = await app.inject({ method: 'GET', url: '/v1/spaces/spc_cit_mariama/documents', headers: as('per_mariama', 'phone') });
    assert.equal(vault.statusCode, 200);
    assert.ok(vault.json().length >= 5);
  });

  it('devis puis conversion', async () => {
    const app = server();
    const quote = await app.inject({
      method: 'POST', url: '/v1/spaces/spc_cit_mariama/exchange-quotes', headers: as('per_mariama', 'phone'),
      payload: { sourceAccountId: 'acc_mc_usdt', targetAccountId: 'acc_mc_om', amount: '20' },
    });
    assert.equal(quote.statusCode, 201);
    const done = await app.inject({
      method: 'POST', url: '/v1/spaces/spc_cit_mariama/exchanges', headers: { ...as('per_mariama', 'phone'), 'idempotency-key': 'e1' },
      payload: { quoteId: quote.json().id },
    });
    assert.equal(done.statusCode, 201);
    assert.equal(done.json().status, 'completed');
  });
});
