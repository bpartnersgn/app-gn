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

async function signIn(context: ReturnType<typeof setup>, nin = 'GN-NIN-0000000001', phone = '+224 620 00 00 01') {
  const asked = await context.server.inject({ method: 'POST', url: '/v1/auth/codes', payload: { nin } });
  assert.equal(asked.statusCode, 202);
  const code = context.sms.lastCodeFor(phone)!;
  return context.server.inject({ method: 'POST', url: '/v1/auth/sessions', payload: { challengeId: asked.json().challengeId, code } });
}

describe('connexion par NIN', () => {
  it('NIN → code par SMS → session, puis accès à ses espaces seulement', async () => {
    const context = setup();
    const created = await signIn(context);
    assert.equal(created.statusCode, 201);
    const { token, me } = created.json();
    assert.match(token, /^ags1\./);
    assert.equal(me.person.fullName, 'Mariama Camara');

    const headers = { authorization: `Bearer ${token}`, 'appgn-channel': 'phone' };
    assert.equal((await context.server.inject({ method: 'GET', url: '/v1/me', headers })).statusCode, 200);
    assert.equal((await context.server.inject({ method: 'GET', url: '/v1/spaces/spc_biz_boke/overview', headers })).statusCode, 403);
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
    assert.equal((await context.server.inject({ method: 'POST', url: '/v1/auth/sessions', payload: { challengeId, code } })).statusCode, 201);
    assert.equal((await context.server.inject({ method: 'POST', url: '/v1/auth/sessions', payload: { challengeId, code } })).statusCode, 401);

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
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), sub: 'per_alpha' })).toString('base64url');
    assert.equal((await context.server.inject({ method: 'GET', url: '/v1/me', headers: headers(`${version}.${forged}.${signature}`) })).statusCode, 401);

    assert.equal((await context.server.inject({ method: 'DELETE', url: '/v1/auth/sessions/current', headers: headers(token) })).statusCode, 204);
    assert.equal((await context.server.inject({ method: 'GET', url: '/v1/me', headers: headers(token) })).statusCode, 401);

    const second = (await signIn(context, 'GN-NIN-0000000002', '+224 660 00 00 02')).json().token;
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
