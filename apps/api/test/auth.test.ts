import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDemoApp } from '@app-gn/core';
import { buildServer } from '../src/app.ts';
import { Auth, MemorySmsSender, SESSION_TTL_MS } from '../src/auth.ts';

const SECRET = 'cle-de-session-de-test-0123456789abcdef';

function setup(options: { demoLogin?: boolean; revealCodes?: boolean } = {}) {
  let clock = Date.parse('2026-10-12T08:00:00Z');
  const { app } = createDemoApp();
  const sms = new MemorySmsSender();
  const auth = new Auth({ app, sms, secret: SECRET, revealCodes: options.revealCodes, now: () => clock });
  const server = buildServer(app, { auth, demoLogin: options.demoLogin ?? false });
  return { server, sms, auth, advance: (ms: number) => { clock += ms; } };
}

async function signIn(context: ReturnType<typeof setup>, nin = 'GN-NIN-0000000001', phone = '+224 620 00 00 01', spaceId: string | null = 'spc_cit_mariama') {
  const asked = await context.server.inject({ method: 'POST', url: '/v1/auth/codes', payload: { nin } });
  assert.equal(asked.statusCode, 202);
  const code = context.sms.lastCodeFor(phone)!;
  return context.server.inject({ method: 'POST', url: '/v1/auth/sessions', payload: { challengeId: asked.json().challengeId, code, ...(spaceId ? { spaceId } : {}) } });
}

describe('connexion par NIN', () => {
  it('NIN → code par SMS → session dans l’espace personnel, qui ne voit rien de l’entreprise', async () => {
    const context = setup();
    const created = await signIn(context);
    assert.equal(created.statusCode, 201);
    const { token, me } = created.json();
    assert.match(token, /^ags1\./);
    assert.equal(me.person.fullName, 'Mariama Camara');
    assert.deepEqual(me.spaces.map((access: { space: { id: string } }) => access.space.id), ['spc_cit_mariama']);
    // L'autre espace est nommé pour pouvoir en changer, sans montant ni droit.
    assert.deepEqual(me.otherSpaces, [{ id: 'spc_biz_couture', kind: 'business', name: 'Couture Mariama', opensOnChannel: false }]);

    const headers = { authorization: `Bearer ${token}`, 'appgn-channel': 'desktop' };
    assert.equal((await context.server.inject({ method: 'GET', url: '/v1/spaces/spc_cit_mariama/overview', headers })).statusCode, 200);
    for (const url of ['/v1/spaces/spc_biz_couture/overview', '/v1/spaces/spc_biz_couture/payments', '/v1/spaces/spc_biz_couture/accounts/acc_cm_om/transactions', '/v1/spaces/spc_biz_boke/overview']) {
      const refused = await context.server.inject({ method: 'GET', url, headers });
      assert.equal(refused.statusCode, 403, url);
      assert.equal(refused.json().error, 'not_a_member');
    }
  });

  it('session d’entreprise : les fonds personnels de la dirigeante n’y sont pas lisibles', async () => {
    const context = setup();
    const { token, me } = (await signIn(context, undefined, undefined, 'spc_biz_couture')).json();
    assert.deepEqual(me.spaces.map((access: { space: { id: string } }) => access.space.id), ['spc_biz_couture']);
    const headers = { authorization: `Bearer ${token}`, 'appgn-channel': 'desktop' };
    assert.equal((await context.server.inject({ method: 'GET', url: '/v1/spaces/spc_biz_couture/overview', headers })).statusCode, 200);
    assert.equal((await context.server.inject({ method: 'GET', url: '/v1/spaces/spc_cit_mariama/overview', headers })).statusCode, 403);
    const paying = await context.server.inject({
      method: 'POST', url: '/v1/spaces/spc_cit_mariama/payments', headers: { ...headers, 'idempotency-key': 'x-1' },
      payload: { sourceAccountId: 'acc_mc_om', amount: '1000', destination: { type: 'own_account', accountId: 'acc_mc_mtn' } },
    });
    assert.equal(paying.statusCode, 403);
  });

  it('avec plusieurs espaces, on choisit après le code ; le choix ne sert qu’une fois', async () => {
    const context = setup();
    const choice = await signIn(context, undefined, undefined, null);
    assert.equal(choice.statusCode, 200);
    const { selectionToken, spaces } = choice.json();
    assert.deepEqual(spaces.map((space: { id: string }) => space.id), ['spc_cit_mariama', 'spc_biz_couture']);
    assert.equal((await context.server.inject({ method: 'POST', url: '/v1/auth/sessions/space', payload: { selectionToken, spaceId: 'spc_biz_boke' } })).statusCode, 403);
    const entered = await context.server.inject({ method: 'POST', url: '/v1/auth/sessions/space', payload: { selectionToken, spaceId: 'spc_biz_couture' } });
    assert.equal(entered.statusCode, 201);
    assert.equal(entered.json().me.spaces[0].space.id, 'spc_biz_couture');
    assert.equal((await context.server.inject({ method: 'POST', url: '/v1/auth/sessions/space', payload: { selectionToken, spaceId: 'spc_cit_mariama' } })).statusCode, 401);
  });

  it('qui n’a que son espace personnel y entre directement, sans rien voir d’autre', async () => {
    const context = setup();
    const created = await signIn(context, 'GN-NIN-0000000006', '+224 625 00 00 06', null);
    assert.equal(created.statusCode, 201);
    const { me } = created.json();
    assert.deepEqual(me.spaces.map((access: { space: { kind: string } }) => access.space.kind), ['citizen']);
    assert.deepEqual(me.otherSpaces, []);
  });

  it('le SMS porte le code, la réponse non (hors démonstration)', async () => {
    const context = setup();
    const asked = await context.server.inject({ method: 'POST', url: '/v1/auth/codes', payload: { nin: ' gn-nin-0000000001 ' } });
    assert.equal(asked.json().demoCode, undefined);
    assert.equal(context.sms.sent.length, 1);
    assert.equal(context.sms.sent[0]!.phone, '+224 620 00 00 01');
    assert.match(context.sms.sent[0]!.text, /\b\d{6}\b/);
  });

  it('un NIN inconnu reçoit la même réponse, et aucun SMS ne part', async () => {
    const context = setup();
    const asked = await context.server.inject({ method: 'POST', url: '/v1/auth/codes', payload: { nin: 'GN-NIN-9999999999' } });
    assert.equal(asked.statusCode, 202);
    assert.deepEqual(Object.keys(asked.json()).sort(), ['challengeId', 'expiresAt']);
    assert.equal(context.sms.sent.length, 0);
    const tried = await context.server.inject({ method: 'POST', url: '/v1/auth/sessions', payload: { challengeId: asked.json().challengeId, code: '000000' } });
    assert.equal(tried.statusCode, 401);
  });

  it('un code ne sert qu’une fois, expire en 5 minutes et se tente 5 fois au plus', async () => {
    const context = setup();
    const asked = await context.server.inject({ method: 'POST', url: '/v1/auth/codes', payload: { nin: 'GN-NIN-0000000001' } });
    const { challengeId } = asked.json();
    const code = context.sms.lastCodeFor('+224 620 00 00 01')!;
    const wrong = code === '000000' ? '000001' : '000000';
    for (let attempt = 0; attempt < 4; attempt += 1) {
      assert.equal((await context.server.inject({ method: 'POST', url: '/v1/auth/sessions', payload: { challengeId, code: wrong } })).statusCode, 401);
    }
    assert.equal((await context.server.inject({ method: 'POST', url: '/v1/auth/sessions', payload: { challengeId, code, spaceId: 'spc_cit_mariama' } })).statusCode, 201);
    assert.equal((await context.server.inject({ method: 'POST', url: '/v1/auth/sessions', payload: { challengeId, code, spaceId: 'spc_cit_mariama' } })).statusCode, 401);

    const again = await context.server.inject({ method: 'POST', url: '/v1/auth/codes', payload: { nin: 'GN-NIN-0000000001' } });
    const fresh = context.sms.lastCodeFor('+224 620 00 00 01')!;
    context.advance(5 * 60_000 + 1);
    assert.equal((await context.server.inject({ method: 'POST', url: '/v1/auth/sessions', payload: { challengeId: again.json().challengeId, code: fresh } })).statusCode, 401);
  });

  it('cinq essais faux épuisent le code, même juste ensuite', async () => {
    const context = setup();
    const asked = await context.server.inject({ method: 'POST', url: '/v1/auth/codes', payload: { nin: 'GN-NIN-0000000002' } });
    const { challengeId } = asked.json();
    const code = context.sms.lastCodeFor('+224 660 00 00 02')!;
    const wrong = code === '000000' ? '000001' : '000000';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await context.server.inject({ method: 'POST', url: '/v1/auth/sessions', payload: { challengeId, code: wrong } });
    }
    assert.equal((await context.server.inject({ method: 'POST', url: '/v1/auth/sessions', payload: { challengeId, code } })).statusCode, 401);
  });

  it('au plus 3 codes en 15 minutes par NIN, connu ou non', async () => {
    const context = setup();
    for (const nin of ['GN-NIN-0000000001', 'GN-NIN-9999999999']) {
      for (let index = 0; index < 3; index += 1) {
        assert.equal((await context.server.inject({ method: 'POST', url: '/v1/auth/codes', payload: { nin } })).statusCode, 202);
      }
      assert.equal((await context.server.inject({ method: 'POST', url: '/v1/auth/codes', payload: { nin } })).statusCode, 429);
    }
    context.advance(15 * 60_000);
    assert.equal((await context.server.inject({ method: 'POST', url: '/v1/auth/codes', payload: { nin: 'GN-NIN-0000000001' } })).statusCode, 202);
  });

  it('la session expire en 12 h, se révoque à la déconnexion, et un jeton modifié est refusé', async () => {
    const context = setup();
    const { token } = (await signIn(context)).json();
    const headers = (value: string) => ({ authorization: `Bearer ${value}` });
    const [version, payload, signature] = token.split('.');
    for (const change of [{ sub: 'per_alpha' }, { spc: 'spc_biz_couture' }]) {
      const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), ...change })).toString('base64url');
      assert.equal((await context.server.inject({ method: 'GET', url: '/v1/me', headers: headers(`${version}.${forged}.${signature}`) })).statusCode, 401);
    }

    assert.equal((await context.server.inject({ method: 'DELETE', url: '/v1/auth/sessions/current', headers: headers(token) })).statusCode, 204);
    assert.equal((await context.server.inject({ method: 'GET', url: '/v1/me', headers: headers(token) })).statusCode, 401);

    const second = (await signIn(context, 'GN-NIN-0000000002', '+224 660 00 00 02', 'spc_cit_alpha')).json().token;
    context.advance(SESSION_TTL_MS);
    assert.equal((await context.server.inject({ method: 'GET', url: '/v1/me', headers: headers(second) })).statusCode, 401);
  });

  it('connexion de démo : refusée quand elle est fermée, et le code n’est montré qu’en démonstration', async () => {
    const closed = setup({ demoLogin: false });
    assert.equal((await closed.server.inject({ method: 'GET', url: '/v1/me', headers: { authorization: 'Bearer demo:per_mariama' } })).statusCode, 401);
    assert.equal((await closed.server.inject({ method: 'GET', url: '/v1/demo/persons' })).statusCode, 404);

    const demo = setup({ demoLogin: true, revealCodes: true });
    assert.equal((await demo.server.inject({ method: 'GET', url: '/v1/me', headers: { authorization: 'Bearer demo:per_mariama' } })).statusCode, 200);
    const asked = await demo.server.inject({ method: 'POST', url: '/v1/auth/codes', payload: { nin: 'GN-NIN-0000000001' } });
    assert.equal(asked.json().demoCode, demo.sms.lastCodeFor('+224 620 00 00 01'));
  });

  it('refuse une clé de session trop courte', () => {
    assert.throws(() => new Auth({ app: createDemoApp().app, sms: new MemorySmsSender(), secret: 'court' }));
  });
});

describe('inscription', () => {
  const asked = (context: ReturnType<typeof setup>, payload: unknown) => context.server.inject({ method: 'POST', url: '/v1/registrations', payload: payload as object });

  it('NIN, nom, numéro → code au numéro donné → personne et espace personnel, session ouverte', async () => {
    const context = setup();
    const request = await asked(context, { nin: 'gn-nin-0000009100', fullName: 'Oumou Diakité', phone: '00224 625 10 20 30' });
    assert.equal(request.statusCode, 202);
    const code = context.sms.lastCodeFor('+224 625 10 20 30');
    assert.match(code ?? '', /^\d{6}$/);
    const wrong = await context.server.inject({ method: 'POST', url: '/v1/registrations/confirm', payload: { challengeId: request.json().challengeId, code: code === '000000' ? '111111' : '000000' } });
    assert.equal(wrong.statusCode, 401);
    const created = await context.server.inject({ method: 'POST', url: '/v1/registrations/confirm', payload: { challengeId: request.json().challengeId, code } });
    assert.equal(created.statusCode, 201);
    const { token, me } = created.json();
    assert.equal(me.person.fullName, 'Oumou Diakité');
    assert.equal(me.person.identity, 'declared');
    assert.equal(me.spaces.length, 1);
    assert.equal(me.spaces[0].space.kind, 'citizen');
    assert.deepEqual(me.otherSpaces, []);
    // La personne inscrite se connecte ensuite par son NIN, comme tout le monde.
    const signedIn = await signIn(context, 'GN-NIN-0000009100', '+224 625 10 20 30', null);
    assert.equal(signedIn.statusCode, 201);
    assert.equal(signedIn.json().me.person.id, me.person.id);
    const headers = { authorization: `Bearer ${token}` };
    assert.equal((await context.server.inject({ method: 'GET', url: `/v1/spaces/${me.spaces[0].space.id}/overview`, headers })).json().positions.length, 0);
  });

  it('un NIN déjà inscrit : même réponse, aucun code, le titulaire est prévenu sur son numéro', async () => {
    const context = setup();
    const request = await asked(context, { nin: 'GN-NIN-0000000006', fullName: 'Usurpateur Test', phone: '+224 666 00 00 99' });
    assert.equal(request.statusCode, 202);
    assert.deepEqual(Object.keys(request.json()).sort(), ['challengeId', 'expiresAt']);
    assert.equal(context.sms.sent.some((message) => message.phone === '+224 666 00 00 99'), false);
    assert.match(context.sms.sent.at(-1)?.text ?? '', /déjà un compte/);
    assert.equal(context.sms.sent.at(-1)?.phone, '+224 625 00 00 06');
    for (const code of ['000000', '123456']) {
      const tried = await context.server.inject({ method: 'POST', url: '/v1/registrations/confirm', payload: { challengeId: request.json().challengeId, code } });
      assert.equal(tried.statusCode, 401);
    }
  });

  it('contrôle la demande et limite les codes par NIN et par numéro', async () => {
    const context = setup();
    assert.equal((await asked(context, { nin: 'GN-NIN-0000009101', fullName: 'A', phone: '+224 620 00 00 00' })).statusCode, 400);
    assert.equal((await asked(context, { nin: 'GN-NIN-0000009101', fullName: 'Awa Condé', phone: '+33 6 12 34 56 78' })).statusCode, 400);
    assert.equal((await asked(context, { nin: '%%', fullName: 'Awa Condé', phone: '+224 620 00 00 00' })).statusCode, 400);
    for (let index = 0; index < 3; index += 1) {
      assert.equal((await asked(context, { nin: `GN-NIN-000000920${index}`, fullName: 'Awa Condé', phone: '+224 629 00 00 00' })).statusCode, 202);
    }
    assert.equal((await asked(context, { nin: 'GN-NIN-0000009209', fullName: 'Awa Condé', phone: '+224 629 00 00 00' })).statusCode, 429);
  });

  it('un code d’inscription n’ouvre pas de session de connexion, et l’inverse', async () => {
    const context = setup();
    const request = await asked(context, { nin: 'GN-NIN-0000009102', fullName: 'Awa Condé', phone: '+224 629 11 11 11' });
    const code = context.sms.lastCodeFor('+224 629 11 11 11');
    const crossed = await context.server.inject({ method: 'POST', url: '/v1/auth/sessions', payload: { challengeId: request.json().challengeId, code } });
    assert.equal(crossed.statusCode, 401);
    const login = await context.server.inject({ method: 'POST', url: '/v1/auth/codes', payload: { nin: 'GN-NIN-0000000006' } });
    const loginCode = context.sms.lastCodeFor('+224 625 00 00 06');
    const crossedBack = await context.server.inject({ method: 'POST', url: '/v1/registrations/confirm', payload: { challengeId: login.json().challengeId, code: loginCode } });
    assert.equal(crossedBack.statusCode, 401);
  });
});

describe('membres d’une organisation', () => {
  const sekou = { authorization: 'Bearer demo:per_sekou@spc_biz_boke', 'appgn-channel': 'desktop' };

  it('le dirigeant rattache une personne inscrite, change son rôle, la retire ; les autres rôles ne le peuvent pas', async () => {
    const context = setup({ demoLogin: true });
    const url = '/v1/spaces/spc_biz_boke/members';
    const listed = await context.server.inject({ method: 'GET', url, headers: sekou });
    assert.deepEqual(listed.json().map((member: { fullName: string }) => member.fullName), ['Aïssatou Barry', 'Alpha Diallo', 'Sékou Condé']);
    const added = await context.server.inject({ method: 'POST', url, headers: sekou, payload: { nin: 'GN-NIN-0000000006', role: 'business_accountant' } });
    assert.equal(added.statusCode, 201);
    assert.equal(added.json().roleLabel, 'Comptable');
    const kadiatou = { authorization: 'Bearer demo:per_kadiatou@spc_biz_boke', 'appgn-channel': 'desktop' };
    assert.equal((await context.server.inject({ method: 'GET', url: '/v1/spaces/spc_biz_boke/overview', headers: kadiatou })).statusCode, 200);
    assert.equal((await context.server.inject({ method: 'GET', url, headers: kadiatou })).statusCode, 403);
    assert.equal((await context.server.inject({ method: 'POST', url, headers: sekou, payload: { nin: 'GN-NIN-0000000006', role: 'admin_viewer' } })).statusCode, 400);
    assert.equal((await context.server.inject({ method: 'POST', url, headers: sekou, payload: { nin: 'GN-NIN-0000009999', role: 'business_hr' } })).statusCode, 404);
    assert.equal((await context.server.inject({ method: 'POST', url, headers: sekou, payload: { nin: 'GN-NIN-0000000005', role: 'business_hr' } })).statusCode, 400);
    assert.equal((await context.server.inject({ method: 'DELETE', url: `${url}/per_kadiatou`, headers: sekou })).statusCode, 204);
    assert.equal((await context.server.inject({ method: 'GET', url: '/v1/spaces/spc_biz_boke/overview', headers: kadiatou })).statusCode, 403);
    assert.equal((await context.server.inject({ method: 'DELETE', url: `${url}/per_sekou`, headers: sekou })).statusCode, 400);
  });
});
