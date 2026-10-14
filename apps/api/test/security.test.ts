import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDemoApp } from '@app-gn/core';
import { buildServer } from '../src/app.ts';
import { MemoryRateLimitStore, productionProblems, securityFromEnvironment, trustProxyFromEnvironment, type SecurityOptions } from '../src/security.ts';

const WEB = 'https://app.appgn.gn';

function server(security: SecurityOptions, trustProxy?: boolean | string[]) {
  return buildServer(createDemoApp({ aggregationTimeoutMs: 50 }).app, { security, ...(trustProxy !== undefined ? { trustProxy } : {}) });
}

const as = (personId: string) => ({ authorization: `Bearer demo:${personId}`, 'appgn-channel': 'desktop' });

describe('Sécurité HTTP', () => {
  it('pose les en-têtes de protection sur chaque réponse, HSTS seulement si demandé', async () => {
    const plain = await server({}).inject({ method: 'GET', url: '/health' });
    assert.equal(plain.headers['x-content-type-options'], 'nosniff');
    assert.equal(plain.headers['x-frame-options'], 'DENY');
    assert.equal(plain.headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'");
    assert.equal(plain.headers['cache-control'], 'no-store');
    assert.equal(plain.headers['strict-transport-security'], undefined);
    const tls = await server({ hsts: true }).inject({ method: 'GET', url: '/v1/me', headers: as('per_kadiatou') });
    assert.match(String(tls.headers['strict-transport-security']), /max-age=31536000/);
    // Les erreurs portent les mêmes en-têtes.
    const refused = await server({ hsts: true }).inject({ method: 'GET', url: '/v1/me' });
    assert.equal(refused.statusCode, 401);
    assert.equal(refused.headers['x-content-type-options'], 'nosniff');
  });

  it('n’ouvre CORS qu’aux origines déclarées et refuse les autres', async () => {
    const app = server({ allowedOrigins: [WEB] });
    const preflight = await app.inject({ method: 'OPTIONS', url: '/v1/spaces/spc_cit_kadiatou/payments', headers: { origin: WEB, 'access-control-request-method': 'POST' } });
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], WEB);
    assert.match(String(preflight.headers['access-control-allow-headers']), /idempotency-key/);
    const read = await app.inject({ method: 'GET', url: '/v1/me', headers: { ...as('per_kadiatou'), origin: WEB } });
    assert.equal(read.statusCode, 200);
    assert.equal(read.headers['access-control-allow-origin'], WEB);
    const foreign = await app.inject({ method: 'POST', url: '/v1/spaces/spc_cit_kadiatou/payments', headers: { ...as('per_kadiatou'), origin: 'https://evil.example' }, payload: {} });
    assert.equal(foreign.statusCode, 403);
    assert.equal(foreign.headers['access-control-allow-origin'], undefined);
    // Sans en-tête Origin (outil, serveur à serveur), rien ne change : le jeton reste exigé.
    const tool = await app.inject({ method: 'GET', url: '/v1/me', headers: as('per_kadiatou') });
    assert.equal(tool.statusCode, 200);
  });

  it('limite le débit par adresse, par session et pour les écritures, puis repart à la minute suivante', async () => {
    let now = Date.UTC(2026, 9, 14, 10, 0, 5);
    const store = new MemoryRateLimitStore();
    const app = server({ rateLimit: { store, perIp: 5, perSession: 3, writes: 1, now: () => now } });
    const me = () => app.inject({ method: 'GET', url: '/v1/me', headers: as('per_kadiatou') });
    for (let index = 0; index < 3; index += 1) assert.equal((await me()).statusCode, 200);
    const limited = await me();
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error, 'rate_limited');
    assert.equal(limited.headers['retry-after'], '55');
    // Une autre session sur la même adresse passe encore, jusqu'au plafond de l'adresse (5 par minute).
    const sekou = () => app.inject({ method: 'GET', url: '/v1/me', headers: as('per_sekou') });
    assert.equal((await sekou()).statusCode, 200);
    assert.equal((await sekou()).statusCode, 429);
    // La sonde de l'hébergeur n'est jamais limitée.
    assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
    now += 60_000;
    const write = (key: string) => app.inject({ method: 'POST', url: '/v1/spaces/spc_cit_kadiatou/payments', headers: { ...as('per_kadiatou'), 'idempotency-key': key }, payload: {} });
    assert.notEqual((await write('a')).statusCode, 429);
    assert.equal((await write('b')).statusCode, 429);
  });

  it('lit la vraie adresse derrière un répartiteur de confiance', async () => {
    const store = new MemoryRateLimitStore();
    const app = server({ rateLimit: { store, perIp: 1, perSession: 100, writes: 100 } }, ['127.0.0.1']);
    const from = (ip: string) => app.inject({ method: 'GET', url: '/v1/catalog', headers: { 'x-forwarded-for': ip } });
    assert.equal((await from('41.77.1.1')).statusCode, 200);
    assert.equal((await from('41.77.1.2')).statusCode, 200);
    assert.equal((await from('41.77.1.1')).statusCode, 429);
  });

  it('refuse un corps trop gros avant de le lire', async () => {
    const response = await server({}).inject({ method: 'POST', url: '/v1/spaces/spc_cit_kadiatou/payments', headers: { ...as('per_kadiatou'), 'content-type': 'application/json' }, payload: JSON.stringify({ note: 'x'.repeat(300 * 1024) }) });
    assert.equal(response.statusCode, 413);
  });
});

describe('Réglages de production', () => {
  const ready = {
    APPGN_ENV: 'production', APPGN_DEMO_LOGIN: 'off', APPGN_SESSION_SECRET: 'x'.repeat(40), DATABASE_URL: 'postgres://db/appgn',
    APPGN_ALLOWED_ORIGINS: WEB, APPGN_SMS_PROVIDER: 'orange',
  };

  it('hors production, aucune exigence', () => {
    assert.deepEqual(productionProblems({}), []);
  });

  it('en production, chaque manque est nommé', () => {
    assert.deepEqual(productionProblems(ready), []);
    const problems = productionProblems({ APPGN_ENV: 'production' });
    assert.equal(problems.length, 5);
    assert.ok(problems.some((problem) => problem.startsWith('APPGN_DEMO_LOGIN=off')));
    assert.deepEqual(productionProblems({ ...ready, APPGN_DEMO_LOGIN: 'on' }).length, 1);
  });

  it('lit les réglages et refuse une origine mal écrite', () => {
    const store = new MemoryRateLimitStore();
    const options = securityFromEnvironment({ ...ready, APPGN_ALLOWED_ORIGINS: `${WEB}, http://localhost:5173`, APPGN_RATE_WRITES: '20' }, store);
    assert.deepEqual(options.allowedOrigins, [WEB, 'http://localhost:5173']);
    assert.equal(options.hsts, true);
    assert.equal(options.rateLimit?.writes, 20);
    assert.throws(() => securityFromEnvironment({ APPGN_ALLOWED_ORIGINS: `${WEB}/app` }, store), /n'est pas une origine/);
    assert.throws(() => securityFromEnvironment({ APPGN_RATE_PER_IP: '0' }, store), /entier positif/);
    assert.equal(trustProxyFromEnvironment(undefined), false);
    assert.deepEqual(trustProxyFromEnvironment('10.0.0.0/8, 127.0.0.1'), ['10.0.0.0/8', '127.0.0.1']);
    assert.throws(() => trustProxyFromEnvironment('beaucoup'), /ni une adresse/);
  });
});
