import { AppError } from '@app-gn/core';
import { MemorySmsSender, type SmsSender } from './auth.ts';

/**
 * Envoi des SMS (codes de connexion, d'inscription, de confirmation) par l'API SMS d'Orange
 * (developer.orange.com, offre « SMS » ouverte pour la Guinée) : jeton OAuth2 par identifiants client, puis
 * `POST /smsmessaging/v1/outbound/{expéditeur}/requests`.
 *
 * Écrit d'après la documentation publique d'Orange, sans contrat ni identifiants : à vérifier contre le compte
 * réel (expéditeur attribué, nom d'expéditeur, quotas) avant la préproduction.
 */
export interface OrangeSmsConfig {
  clientId: string;
  clientSecret: string;
  /** Adresse d'expéditeur attribuée par Orange, sous la forme `tel:+224…`. */
  senderAddress: string;
  /** Nom affiché à la place du numéro, s'il a été enregistré chez Orange. */
  senderName?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

export class OrangeSmsSender implements SmsSender {
  private readonly config: OrangeSmsConfig;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private token: { value: string; until: number } | undefined;

  constructor(config: OrangeSmsConfig) {
    this.config = config;
    this.fetch = config.fetch ?? globalThis.fetch;
    this.now = config.now ?? Date.now;
  }

  async send(phone: string, text: string): Promise<void> {
    const address = `tel:+${phone.replace(/\D/g, '')}`;
    const body = {
      outboundSMSMessageRequest: {
        address,
        senderAddress: this.config.senderAddress,
        ...(this.config.senderName ? { senderName: this.config.senderName } : {}),
        outboundSMSTextMessage: { message: text },
      },
    };
    let response = await this.post(body, await this.accessToken());
    // Jeton révoqué ou expiré plus tôt que prévu : un seul nouvel essai avec un jeton neuf.
    if (response.status === 401) {
      this.token = undefined;
      response = await this.post(body, await this.accessToken());
    }
    if (!response.ok) throw new AppError('unavailable', `envoi du SMS impossible (Orange ${response.status}) : réessayez dans un instant`);
  }

  private async post(body: unknown, token: string): Promise<Response> {
    const url = new URL(`/smsmessaging/v1/outbound/${encodeURIComponent(this.config.senderAddress)}/requests`, this.base());
    return this.request(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.until > this.now()) return this.token.value;
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
    const response = await this.request(new URL('/oauth/v3/token', this.base()), {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: 'grant_type=client_credentials',
    });
    const payload = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number };
    if (!response.ok || typeof payload.access_token !== 'string') throw new AppError('unavailable', `envoi du SMS impossible (jeton Orange ${response.status}) : réessayez dans un instant`);
    // Une minute de marge sur la durée annoncée.
    this.token = { value: payload.access_token, until: this.now() + Math.max(60, (payload.expires_in ?? 3600) - 60) * 1000 };
    return this.token.value;
  }

  private async request(url: URL, init: RequestInit): Promise<Response> {
    try {
      return await this.fetch(url, { ...init, signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000) });
    } catch {
      throw new AppError('unavailable', 'envoi du SMS impossible (Orange injoignable) : réessayez dans un instant');
    }
  }

  private base(): string {
    return this.config.baseUrl ?? 'https://api.orange.com';
  }
}

/**
 * `APPGN_SMS_PROVIDER` : `orange` (avec `ORANGE_SMS_CLIENT_ID`, `ORANGE_SMS_CLIENT_SECRET`, `ORANGE_SMS_SENDER`,
 * et en option `ORANGE_SMS_SENDER_NAME`), ou rien : les SMS sont gardés en mémoire (démonstration, essais).
 */
export function smsFromEnvironment(environment: Readonly<Record<string, string | undefined>>): { sender: SmsSender; provider: 'orange' | 'memory' } {
  const provider = environment.APPGN_SMS_PROVIDER?.trim();
  if (!provider) return { sender: new MemorySmsSender(), provider: 'memory' };
  if (provider !== 'orange') throw new Error('APPGN_SMS_PROVIDER : orange (seul fournisseur branché), ou rien pour garder les SMS en mémoire.');
  const clientId = environment.ORANGE_SMS_CLIENT_ID?.trim();
  const clientSecret = environment.ORANGE_SMS_CLIENT_SECRET?.trim();
  const senderAddress = environment.ORANGE_SMS_SENDER?.trim();
  if (!clientId || !clientSecret || !senderAddress) throw new Error('APPGN_SMS_PROVIDER=orange : ORANGE_SMS_CLIENT_ID, ORANGE_SMS_CLIENT_SECRET et ORANGE_SMS_SENDER sont exigés.');
  if (!/^tel:\+\d{4,15}$/.test(senderAddress)) throw new Error('ORANGE_SMS_SENDER : tel:+<chiffres> (adresse attribuée par Orange).');
  const senderName = environment.ORANGE_SMS_SENDER_NAME?.trim();
  return { sender: new OrangeSmsSender({ clientId, clientSecret, senderAddress, ...(senderName ? { senderName } : {}) }), provider: 'orange' };
}
