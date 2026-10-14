import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '@app-gn/core';
import { MemorySmsSender } from '../src/auth.ts';
import { OrangeSmsSender, smsFromEnvironment } from '../src/sms.ts';

type Call = { url: string; method: string; headers: Record<string, string>; body: string };

/** Faux Orange : rend, dans l'ordre, les réponses données ; garde les appels. */
function fakeOrange(responses: Array<{ status: number; body?: unknown } | 'down'>) {
  const calls: Call[] = [];
  const fetch = (async (input: URL | string, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers: init?.headers as Record<string, string>, body: String(init?.body ?? '') });
    const next = responses.shift();
    if (!next) throw new Error('appel inattendu');
    if (next === 'down') throw new TypeError('fetch failed');
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

const TOKEN = { status: 200, body: { access_token: 'jeton-1', expires_in: 3600 } };
const SENT = { status: 201, body: { outboundSMSMessageRequest: {} } };
const CONFIG = { clientId: 'id', clientSecret: 'secret', senderAddress: 'tel:+224000000', senderName: 'AppGN' };

describe('SMS par Orange', () => {
  it('obtient un jeton, envoie le message, puis réutilise le jeton', async () => {
    const orange = fakeOrange([TOKEN, SENT, SENT]);
    const sender = new OrangeSmsSender({ ...CONFIG, fetch: orange.fetch });
    await sender.send('+224 620 00 00 01', 'Votre code : 123456');
    await sender.send('+224 620 00 00 02', 'Votre code : 654321');
    assert.equal(orange.calls.length, 3);
    const [token, first] = orange.calls;
    assert.equal(token!.url, 'https://api.orange.com/oauth/v3/token');
    assert.equal(token!.headers.authorization, `Basic ${Buffer.from('id:secret').toString('base64')}`);
    assert.equal(token!.body, 'grant_type=client_credentials');
    assert.equal(first!.url, 'https://api.orange.com/smsmessaging/v1/outbound/tel%3A%2B224000000/requests');
    assert.equal(first!.headers.authorization, 'Bearer jeton-1');
    assert.deepEqual(JSON.parse(first!.body), {
      outboundSMSMessageRequest: { address: 'tel:+224620000001', senderAddress: 'tel:+224000000', senderName: 'AppGN', outboundSMSTextMessage: { message: 'Votre code : 123456' } },
    });
  });

  it('redemande un jeton une fois expiré', async () => {
    let now = 0;
    const orange = fakeOrange([TOKEN, SENT, { status: 200, body: { access_token: 'jeton-2', expires_in: 3600 } }, SENT]);
    const sender = new OrangeSmsSender({ ...CONFIG, fetch: orange.fetch, now: () => now });
    await sender.send('620000001', 'a');
    now += 3600_000;
    await sender.send('620000001', 'b');
    assert.equal(orange.calls[3]!.headers.authorization, 'Bearer jeton-2');
  });

  it('un jeton refusé (401) est renouvelé une fois', async () => {
    const orange = fakeOrange([TOKEN, { status: 401 }, { status: 200, body: { access_token: 'jeton-2' } }, SENT]);
    await new OrangeSmsSender({ ...CONFIG, fetch: orange.fetch }).send('620000001', 'a');
    assert.equal(orange.calls.length, 4);
    assert.equal(orange.calls[3]!.headers.authorization, 'Bearer jeton-2');
  });

  it('un refus ou une panne d’Orange devient une erreur 503', async () => {
    for (const responses of [[TOKEN, { status: 500 }], [{ status: 401 }], ['down' as const]]) {
      const orange = fakeOrange([...responses]);
      await assert.rejects(new OrangeSmsSender({ ...CONFIG, fetch: orange.fetch }).send('620000001', 'a'), (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'unavailable');
        assert.equal(error.status, 503);
        return true;
      });
    }
  });

  it('se configure par l’environnement', () => {
    assert.ok(smsFromEnvironment({}).sender instanceof MemorySmsSender);
    const orange = smsFromEnvironment({ APPGN_SMS_PROVIDER: 'orange', ORANGE_SMS_CLIENT_ID: 'id', ORANGE_SMS_CLIENT_SECRET: 's', ORANGE_SMS_SENDER: 'tel:+224000000' });
    assert.equal(orange.provider, 'orange');
    assert.ok(orange.sender instanceof OrangeSmsSender);
    assert.throws(() => smsFromEnvironment({ APPGN_SMS_PROVIDER: 'twilio' }), /orange/);
    assert.throws(() => smsFromEnvironment({ APPGN_SMS_PROVIDER: 'orange', ORANGE_SMS_CLIENT_ID: 'id' }), /ORANGE_SMS_CLIENT_SECRET/);
    assert.throws(() => smsFromEnvironment({ APPGN_SMS_PROVIDER: 'orange', ORANGE_SMS_CLIENT_ID: 'id', ORANGE_SMS_CLIENT_SECRET: 's', ORANGE_SMS_SENDER: '224000000' }), /tel:\+/);
  });
});
