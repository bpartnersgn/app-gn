import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDemoApp, DEMO_WALLET_NUMBERS, money, SimulatedOrchestrator, toMajor } from '@app-gn/core';
import { buildServer } from '../src/app.ts';
import { MemoryFeedCursors, OrcheaEventFeed, OrcheaOrchestrator, OrcheaWebhookReceiver, orcheaFromEnvironment, signOrcheaWebhook, verifyOrcheaSignature } from '../src/orchea.ts';

const SECRET = 'whsec_test_0123456789abcdef';
const as = (personId: string) => ({ authorization: `Bearer demo:${personId}`, 'appgn-channel': 'phone', 'idempotency-key': crypto.randomUUID() });

interface Call { url: string; headers: Record<string, string>; body: Record<string, unknown> }

/** Un ORCHEA de test : répond comme l'API publique, ou comme on le lui dit. */
function fakeOrchea(answer: (call: Call) => Response | Promise<Response> = () => Response.json({ id: 'pi_1', status: 'CREATED' }, { status: 201 })) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const call = { url: String(input), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function setup(answer?: Parameters<typeof fakeOrchea>[0]) {
  const orchea = fakeOrchea(answer);
  const { app } = createDemoApp({
    orchestrator: (network, now) => new OrcheaOrchestrator({
      baseUrl: 'https://orchea.test', apiKey: 'sk_test', mode: 'test',
      billerDestinations: { edg: 'dest-edg' },
      walletNumber: (account) => DEMO_WALLET_NUMBERS[account.id],
      fallback: new SimulatedOrchestrator(network, now),
      fetch: orchea.fetchImpl,
    }),
  });
  const server = buildServer(app, { orcheaWebhooks: new OrcheaWebhookReceiver(app, [SECRET]) });
  return { app, server, calls: orchea.calls };
}

const payBill = (server: ReturnType<typeof setup>['server'], sourceAccountId = 'acc_mc_om') => server.inject({
  method: 'POST', url: '/v1/spaces/spc_cit_mariama/payments', headers: as('per_mariama'),
  payload: { sourceAccountId, amount: '45000', destination: { type: 'biller', billerId: 'edg', customerReference: 'CPT-778899' } },
});

function event(type: string, payload: Record<string, unknown>, eventId: string = crypto.randomUUID()) {
  return JSON.stringify({ eventId, type, version: 1, occurredAt: new Date().toISOString(), tenantId: 'org', correlationId: 'c', idempotencyKey: 'k', payload });
}

const deliver = (server: ReturnType<typeof setup>['server'], body: string, signature = signOrcheaWebhook(SECRET, body)) =>
  server.inject({ method: 'POST', url: '/v1/webhooks/orchea', headers: { 'content-type': 'application/json', 'x-orchea-signature': signature }, payload: body });

describe('ORCHEA', () => {
  it('envoie la facture payée depuis Orange Money comme intention de paiement, puis la solde au webhook', async () => {
    const { server, calls } = setup();
    const created = await payBill(server);
    assert.equal(created.statusCode, 201);
    const payment = created.json();
    assert.equal(payment.status, 'processing');
    assert.equal(payment.orchestratorReference, 'orchea:pi_1');

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'https://orchea.test/v1/payment-intents');
    assert.equal(calls[0]!.headers.authorization, 'Bearer sk_test');
    assert.equal(calls[0]!.headers['orchea-mode'], 'test');
    assert.equal(calls[0]!.headers['idempotency-key'], `appgn-${payment.id}`);
    assert.deepEqual(calls[0]!.body, {
      amount: '45000', currency: 'GNF', paymentDestinationId: 'dest-edg', externalReference: payment.id,
      payer: { msisdn: '+224620000001', operator: 'orange_money' },
    });

    const confirmed = event('TransactionConfirmed', { paymentIntentId: 'pi_1', transactionId: 't1', status: 'CONFIRMED', externalReference: payment.id });
    const delivered = await deliver(server, confirmed);
    assert.equal(delivered.statusCode, 200);
    assert.equal(delivered.json().result, 'applied');
    const again = await deliver(server, confirmed);
    assert.equal(again.json().result, 'duplicate');

    const list = await server.inject({ method: 'GET', url: '/v1/spaces/spc_cit_mariama/payments', headers: as('per_mariama') });
    assert.equal(list.json().find((candidate: { id: string }) => candidate.id === payment.id).status, 'completed');
  });

  it('refuse un webhook mal signé, trop vieux ou illisible', async () => {
    const { server } = setup();
    const body = event('TransactionConfirmed', { paymentIntentId: 'pi_1', transactionId: 't1', status: 'CONFIRMED' });
    assert.equal((await deliver(server, body, signOrcheaWebhook('autre-secret-000000', body))).statusCode, 401);
    assert.equal((await deliver(server, body, signOrcheaWebhook(SECRET, body, Math.floor(Date.now() / 1000) - 301))).statusCode, 401);
    assert.equal((await deliver(server, `${body} `, signOrcheaWebhook(SECRET, body))).statusCode, 401);
    assert.equal((await deliver(server, '{"pas":"une enveloppe"}')).statusCode, 400);
  });

  it('un refus du Risk fait échouer le paiement avec sa raison ; une tentative incertaine le laisse en cours', async () => {
    const { server } = setup();
    const payment = (await payBill(server)).json();
    const unknown = await deliver(server, event('PaymentAttemptUnknown', { paymentIntentId: 'pi_1', transactionId: 't1', status: 'UNKNOWN', attemptId: 'a', providerReference: 'p' }));
    assert.equal(unknown.json().result, 'ignored');
    await deliver(server, event('TransactionRejected', { paymentIntentId: 'pi_1', transactionId: 't1', status: 'REJECTED', reason: 'AMOUNT_ABOVE_LIMIT', ruleVersion: '3' }));
    const list = await server.inject({ method: 'GET', url: '/v1/spaces/spc_cit_mariama/payments', headers: as('per_mariama') });
    const after = list.json().find((candidate: { id: string }) => candidate.id === payment.id);
    assert.equal(after.status, 'failed');
    assert.equal(after.failureReason, 'rejected_amount_above_limit');
  });

  it('ORCHEA injoignable : en cours, puis soldé par le webhook grâce à la référence externe', async () => {
    const { server } = setup(() => { throw new TypeError('fetch failed'); });
    const payment = (await payBill(server)).json();
    assert.equal(payment.status, 'processing');
    assert.equal(payment.orchestratorReference, `orchea:pending:${payment.id}`);
    const delivered = await deliver(server, event('TransactionConfirmed', { paymentIntentId: 'pi_9', transactionId: 't9', status: 'CONFIRMED', externalReference: payment.id }));
    assert.equal(delivered.json().result, 'applied');
    const list = await server.inject({ method: 'GET', url: '/v1/spaces/spc_cit_mariama/payments', headers: as('per_mariama') });
    const after = list.json().find((candidate: { id: string }) => candidate.id === payment.id);
    assert.equal(after.status, 'completed');
    assert.equal(after.orchestratorReference, 'orchea:pi_9');
  });

  it('une requête refusée par ORCHEA (400) fait échouer le paiement tout de suite', async () => {
    const { server } = setup(() => Response.json({ error: 'invalid_amount' }, { status: 400 }));
    const payment = (await payBill(server)).json();
    assert.equal(payment.status, 'failed');
    assert.equal(payment.failureReason, 'orchea_invalid_amount');
  });

  it('ce qu’ORCHEA ne porte pas encore passe par le repli simulé', async () => {
    const { server, calls } = setup();
    const toWallet = await server.inject({
      method: 'POST', url: '/v1/spaces/spc_cit_mariama/payments', headers: as('per_mariama'),
      payload: { sourceAccountId: 'acc_mc_om', amount: '1000', destination: { type: 'mobile_money', operator: 'mtn_momo', phone: '+224 660 11 22 33' } },
    });
    assert.equal(toWallet.json().status, 'completed');
    assert.equal(calls.length, 0);
  });

  it('signature : plusieurs v1 pendant une rotation, plusieurs secrets de notre côté', () => {
    const body = '{"a":1}';
    const now = 1_760_000_000;
    const current = signOrcheaWebhook('nouveau-secret-0000', body, now);
    const previous = signOrcheaWebhook('ancien-secret-00000', body, now).split(',')[1];
    assert.ok(verifyOrcheaSignature(['ancien-secret-00000'], `${current},${previous}`, body, now));
    assert.ok(verifyOrcheaSignature(['x', 'nouveau-secret-0000'], current, body, now));
    assert.ok(!verifyOrcheaSignature(['nouveau-secret-0000'], 't=abc,v1=00', body, now));
    assert.ok(!verifyOrcheaSignature([], current, body, now));
  });

  it('configuration : tout ou rien', () => {
    assert.equal(orcheaFromEnvironment({}), undefined);
    assert.throws(() => orcheaFromEnvironment({ ORCHEA_BASE_URL: 'http://127.0.0.1:3000' }));
    const parsed = orcheaFromEnvironment({ ORCHEA_BASE_URL: 'http://x', ORCHEA_API_KEY: 'k', ORCHEA_WEBHOOK_SECRET: 'a, b', ORCHEA_BILLER_DESTINATIONS: 'edg=d1, seg=d2', ORCHEA_MODE: 'test' });
    assert.deepEqual(parsed?.webhookSecrets, ['a', 'b']);
    assert.deepEqual(parsed?.config.billerDestinations, { edg: 'd1', seg: 'd2' });
  });

  it('montant décimal exact', () => {
    assert.equal(toMajor(money(45000, 'GNF')), '45000');
    assert.equal(toMajor(money(1050, 'USD')), '10.50');
    assert.equal(toMajor(money(5, 'EUR')), '0.05');
  });
});

describe('ORCHEA : rattrapage par le flux d’événements', () => {
  /** Un flux de test : des pages fixes, chaque `cursor` menant à la suivante. */
  function feedServer(pages: { items: unknown[]; nextCursor: string; hasMore: boolean }[], failAt?: number) {
    const asked: (string | null)[] = [];
    const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, '/v1/events');
      assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer sk_test');
      const cursor = url.searchParams.get('cursor');
      asked.push(cursor);
      const index = cursor ? Number(cursor.slice(1)) : 0;
      if (failAt === index) return Response.json({ error: 'unavailable' }, { status: 503 });
      return Response.json(pages[index] ?? { items: [], nextCursor: cursor, hasMore: false });
    }) as typeof fetch;
    return { asked, fetchImpl };
  }

  const body = (raw: string) => JSON.parse(raw) as Record<string, unknown>;

  it('un webhook perdu est rattrapé : le paiement passe de « en cours » à payé, une seule fois', async () => {
    const { app, server } = setup();
    const payment = (await payBill(server)).json();
    assert.equal(payment.status, 'processing');
    const lost = event('TransactionConfirmed', { paymentIntentId: 'pi_1', status: 'CONFIRMED', externalReference: payment.id }, 'evt-lost');
    const other = event('PaymentAttemptUnknown', { paymentIntentId: 'pi_x' }, 'evt-other');
    const flux = feedServer([
      { items: [body(other)], nextCursor: 'c1', hasMore: true },
      { items: [body(lost)], nextCursor: 'c2', hasMore: false },
    ]);
    const receiver = new OrcheaWebhookReceiver(app, [SECRET]);
    const cursors = new MemoryFeedCursors();
    const feed = new OrcheaEventFeed({ baseUrl: 'https://orchea.test', apiKey: 'sk_test', fetch: flux.fetchImpl }, receiver, { cursors });
    assert.deepEqual(await feed.catchUp(), { status: 'done', pages: 2, events: 2, applied: 1 });
    const list = await server.inject({ method: 'GET', url: '/v1/spaces/spc_cit_mariama/payments', headers: as('per_mariama') });
    assert.equal(list.json().find((candidate: { id: string }) => candidate.id === payment.id).status, 'completed');
    // Le passage suivant repart du curseur gardé ; le webhook arrivé en retard est un doublon.
    assert.deepEqual(await feed.catchUp(), { status: 'done', pages: 1, events: 0, applied: 0 });
    assert.deepEqual(flux.asked, [null, 'c1', 'c2']);
    assert.equal((await receiver.apply(JSON.parse(lost))).result, 'duplicate');
  });

  it('une page en erreur : le curseur reste à la dernière page traitée, le passage suivant la reprend', async () => {
    const { app } = setup();
    const flux = feedServer([
      { items: [body(event('PaymentAttemptUnknown', { paymentIntentId: 'pi_a' }))], nextCursor: 'c1', hasMore: true },
      { items: [], nextCursor: 'c1', hasMore: false },
    ], 1);
    const cursors = new MemoryFeedCursors();
    const feed = new OrcheaEventFeed({ baseUrl: 'https://orchea.test', apiKey: 'sk_test', fetch: flux.fetchImpl }, new OrcheaWebhookReceiver(app, [SECRET]), { cursors });
    const failed = await feed.catchUp();
    assert.equal(failed.status, 'error');
    assert.match(failed.error ?? '', /503/);
    await feed.catchUp();
    assert.deepEqual(flux.asked, [null, 'c1', 'c1']);
  });

  it('une seule instance lit le flux à la fois', async () => {
    const { app } = setup();
    const cursors = new MemoryFeedCursors();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = (async () => {
      await gate;
      return Response.json({ items: [], nextCursor: null, hasMore: false });
    }) as typeof fetch;
    const one = new OrcheaEventFeed({ baseUrl: 'https://orchea.test', apiKey: 'sk_test', fetch: slow }, new OrcheaWebhookReceiver(app, [SECRET]), { cursors });
    const two = new OrcheaEventFeed({ baseUrl: 'https://orchea.test', apiKey: 'sk_test', fetch: slow }, new OrcheaWebhookReceiver(app, [SECRET]), { cursors });
    const running = one.catchUp();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await two.catchUp()).status, 'busy');
    release();
    assert.equal((await running).status, 'done');
    assert.equal((await two.catchUp()).status, 'done');
  });
});
