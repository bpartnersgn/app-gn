import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  toMajor,
  type AppGn,
  type ExchangeOrder,
  type LinkedAccount,
  type OrchestratorOutcome,
  type PaymentOrchestrator,
  type PaymentOrder,
} from '@app-gn/core';

/**
 * Adaptateur vers ORCHEA (XeyLink Router), le moteur de paiement, appelé par son API publique
 * (docs/integration de son dépôt). App GN n'en reprend que le contrat : aucune dépendance de code.
 *
 * Ce qu'ORCHEA porte aujourd'hui : le paiement d'une facture (EDG, SEG…) depuis un wallet Orange Money ou
 * MTN MoMo, en `POST /v1/payment-intents` avec le payeur, pour que le débit soit poussé sur son téléphone.
 * Le reste (vers un numéro Mobile Money, entre comptes, conversions, Cellcom et Moov) passe par
 * l'orchestrateur de repli tant que ses routes ORCHEA (payouts, comptes) ne sont pas branchées.
 */

const PAYER_OPERATORS = ['orange_money', 'mtn_momo'] as const;
type PayerOperator = (typeof PAYER_OPERATORS)[number];

export interface OrcheaConfig {
  baseUrl: string;
  apiKey: string;
  /** `test` ajoute `Orchea-Mode: test` : une clé live est alors refusée (403), rien ne bouge. */
  mode?: 'test' | 'live';
  /** Destination de paiement ORCHEA de chaque facturier App GN (`edg` → identifiant chez ORCHEA). */
  billerDestinations: Readonly<Record<string, string>>;
  /** Numéro complet du wallet, gardé côté serveur ; App GN n'affiche que sa forme masquée. */
  walletNumber: (account: LinkedAccount) => string | undefined;
  /** Pour ce qu'ORCHEA ne porte pas encore. Sans repli, ces paiements échouent avec `route_not_supported`. */
  fallback?: PaymentOrchestrator;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Préfixe des références App GN d'un paiement ORCHEA : `orchea:<paymentIntentId>`. */
export const ORCHEA_REFERENCE_PREFIX = 'orchea:';

export class OrcheaOrchestrator implements PaymentOrchestrator {
  private readonly config: OrcheaConfig;
  private readonly fetch: typeof fetch;

  constructor(config: OrcheaConfig) {
    this.config = config;
    this.fetch = config.fetch ?? globalThis.fetch;
  }

  async submit(order: PaymentOrder): Promise<OrchestratorOutcome> {
    const route = this.route(order);
    if (!route) {
      if (this.config.fallback) return this.config.fallback.submit(order);
      return { status: 'failed', reference: `${ORCHEA_REFERENCE_PREFIX}none:${order.paymentId}`, reason: 'route_not_supported' };
    }

    const body = {
      amount: toMajor(order.amount),
      currency: order.amount.currency,
      paymentDestinationId: route.destinationId,
      externalReference: order.paymentId,
      payer: { msisdn: route.msisdn, operator: route.operator },
    };
    let response: Response;
    try {
      response = await this.fetch(new URL('/v1/payment-intents', this.config.baseUrl), {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json', 'idempotency-key': `appgn-${order.paymentId}` }),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
      });
    } catch {
      // On ne sait pas si ORCHEA l'a reçu : le paiement reste en cours. Son issue arrivera par webhook,
      // retrouvée par sa référence externe (l'identifiant App GN), et un nouvel envoi sous la même clé
      // d'idempotence ne créerait pas un second paiement.
      return { status: 'processing', reference: `${ORCHEA_REFERENCE_PREFIX}pending:${order.paymentId}` };
    }

    const payload = await response.json().catch(() => ({})) as { id?: string; error?: string };
    if (response.ok && typeof payload.id === 'string') {
      // 201 n'est qu'un accusé de réception : le résultat viendra par webhook.
      return { status: 'processing', reference: `${ORCHEA_REFERENCE_PREFIX}${payload.id}` };
    }
    if (response.status >= 500 || response.status === 409) {
      // 503 : ORCHEA indisponible ; 409 `payment_in_progress` : un paiement est déjà ouvert sous cette référence.
      return { status: 'processing', reference: `${ORCHEA_REFERENCE_PREFIX}pending:${order.paymentId}` };
    }
    return { status: 'failed', reference: `${ORCHEA_REFERENCE_PREFIX}refused:${order.paymentId}`, reason: `orchea_${payload.error ?? response.status}` };
  }

  async convert(order: ExchangeOrder): Promise<OrchestratorOutcome> {
    if (this.config.fallback) return this.config.fallback.convert(order);
    return { status: 'failed', reference: `${ORCHEA_REFERENCE_PREFIX}none:${order.exchangeId}`, reason: 'route_not_supported' };
  }

  /** Ce qu'ORCHEA peut porter pour cet ordre, ou rien. */
  route(order: PaymentOrder): { destinationId: string; msisdn: string; operator: PayerOperator } | undefined {
    if (order.destination.type !== 'biller') return undefined;
    const destinationId = this.config.billerDestinations[order.destination.billerId];
    const operator = order.source.providerId as PayerOperator;
    if (!destinationId || !PAYER_OPERATORS.includes(operator)) return undefined;
    const msisdn = this.config.walletNumber(order.source);
    if (!msisdn || !/^\+2246\d{8}$/.test(msisdn)) return undefined;
    return { destinationId, msisdn, operator };
  }

  private headers(extra: Record<string, string>): Record<string, string> {
    return {
      authorization: `Bearer ${this.config.apiKey}`,
      ...(this.config.mode ? { 'orchea-mode': this.config.mode } : {}),
      ...extra,
    };
  }
}

// ── Webhooks ────────────────────────────────────────────────────────────────

export const ORCHEA_SIGNATURE_HEADER = 'x-orchea-signature';
const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Vérifie `X-Orchea-Signature: t=<secondes>,v1=<hex>[,v1=<hex>]` : HMAC-SHA256 de `<t>.<corps brut>`,
 * à 300 s près. Plusieurs `v1` pendant une rotation du secret ; plusieurs secrets acceptés de notre côté
 * pour la même raison. Ne lève jamais : tout ce qui n'est pas une signature fraîche et juste vaut `false`.
 */
export function verifyOrcheaSignature(secrets: readonly string[], header: string | undefined, body: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (!header || secrets.length === 0) return false;
  let timestamp: number | undefined;
  const candidates: string[] = [];
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't' && timestamp === undefined && /^\d{1,15}$/.test(value)) timestamp = Number(value);
    else if (key === 'v1' && value) candidates.push(value);
  }
  if (timestamp === undefined || candidates.length === 0) return false;
  if (Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;
  return secrets.filter(Boolean).some((secret) => {
    const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    return candidates.some((candidate) => candidate.length === expected.length && timingSafeEqual(Buffer.from(candidate), Buffer.from(expected)));
  });
}

/** Signe comme ORCHEA (pour les tests et la démonstration locale). */
export function signOrcheaWebhook(secret: string, body: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  return `t=${nowSeconds},v1=${createHmac('sha256', secret).update(`${nowSeconds}.${body}`).digest('hex')}`;
}

export type WebhookHandling =
  | { status: 401; result: 'invalid_signature' }
  | { status: 400; result: 'malformed' }
  | { status: 200; result: 'duplicate' | 'ignored' | 'applied' | 'unknown_payment'; paymentId?: string };

interface Envelope {
  eventId: string;
  type: string;
  payload: { paymentIntentId?: string; externalReference?: string; reason?: string; status?: string };
}

/**
 * Reçoit les événements d'ORCHEA et les traduit en issues de paiement App GN.
 * TransactionConfirmed → payé ; TransactionRejected (par le Risk) et TransactionFailed → échoué, avec la raison ;
 * PaymentAttemptUnknown et PaymentAttemptActionRequired laissent le paiement en cours ; un type inconnu est accepté
 * et ignoré. Dédoublonnage sur `eventId` (en mémoire pour l'instant ; persistant avec la base).
 */
export class OrcheaWebhookReceiver {
  private readonly app: AppGn;
  private readonly secrets: readonly string[];
  private readonly seen = new Set<string>();
  private readonly now: () => number;

  constructor(app: AppGn, secrets: readonly string[], now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.app = app;
    this.secrets = secrets;
    this.now = now;
  }

  handle(rawBody: string, signature: string | undefined): WebhookHandling {
    if (!verifyOrcheaSignature(this.secrets, signature, rawBody, this.now())) return { status: 401, result: 'invalid_signature' };
    const event = parseEnvelope(rawBody);
    if (!event) return { status: 400, result: 'malformed' };
    if (this.seen.has(event.eventId)) return { status: 200, result: 'duplicate' };

    const outcome = outcomeOf(event);
    const intentId = event.payload.paymentIntentId;
    if (!outcome || !intentId) {
      this.remember(event.eventId);
      return { status: 200, result: 'ignored' };
    }
    const payment = this.app.recordOutcome(`${ORCHEA_REFERENCE_PREFIX}${intentId}`, outcome, event.payload.externalReference);
    this.remember(event.eventId);
    return payment
      ? { status: 200, result: 'applied', paymentId: payment.id }
      : { status: 200, result: 'unknown_payment' };
  }

  private remember(eventId: string): void {
    this.seen.add(eventId);
    if (this.seen.size > 10_000) this.seen.delete(this.seen.values().next().value!);
  }
}

function parseEnvelope(body: string): Envelope | undefined {
  try {
    const value = JSON.parse(body) as Partial<Envelope>;
    if (typeof value?.eventId !== 'string' || typeof value.type !== 'string' || typeof value.payload !== 'object' || value.payload === null) return undefined;
    return value as Envelope;
  } catch {
    return undefined;
  }
}

function outcomeOf(event: Envelope): OrchestratorOutcome | undefined {
  const reference = `${ORCHEA_REFERENCE_PREFIX}${event.payload.paymentIntentId}`;
  switch (event.type) {
    case 'TransactionConfirmed':
      return { status: 'completed', reference };
    case 'TransactionRejected':
      return { status: 'failed', reference, reason: `rejected_${event.payload.reason ?? 'unknown'}`.toLowerCase() };
    case 'TransactionFailed':
      return { status: 'failed', reference, reason: (event.payload.reason ?? 'failed').toLowerCase() };
    default:
      return undefined;
  }
}

// ── Configuration par l'environnement ───────────────────────────────────────

/**
 * `ORCHEA_BASE_URL`, `ORCHEA_API_KEY` et `ORCHEA_WEBHOOK_SECRET` (plusieurs séparés par des virgules pendant
 * une rotation) vont ensemble ; `ORCHEA_BILLER_DESTINATIONS` = `edg=<id>,seg=<id>` ; `ORCHEA_MODE` = test | live.
 * Rien de réglé : `undefined`, App GN reste entièrement simulé.
 */
export function orcheaFromEnvironment(environment: Readonly<Record<string, string | undefined>>):
  | { config: Omit<OrcheaConfig, 'walletNumber' | 'fallback'>; webhookSecrets: string[] }
  | undefined {
  const baseUrl = environment.ORCHEA_BASE_URL?.trim();
  const apiKey = environment.ORCHEA_API_KEY?.trim();
  const secrets = (environment.ORCHEA_WEBHOOK_SECRET ?? '').split(',').map((secret) => secret.trim()).filter(Boolean);
  if (!baseUrl && !apiKey && secrets.length === 0) return undefined;
  if (!baseUrl || !apiKey || secrets.length === 0) {
    throw new Error('ORCHEA_BASE_URL, ORCHEA_API_KEY et ORCHEA_WEBHOOK_SECRET vont ensemble.');
  }
  const mode = environment.ORCHEA_MODE?.trim();
  if (mode && mode !== 'test' && mode !== 'live') throw new Error('ORCHEA_MODE : test ou live.');
  const billerDestinations: Record<string, string> = {};
  for (const pair of (environment.ORCHEA_BILLER_DESTINATIONS ?? '').split(',')) {
    const [billerId, destinationId] = pair.split('=').map((part) => part.trim());
    if (billerId && destinationId) billerDestinations[billerId] = destinationId;
  }
  return {
    config: { baseUrl, apiKey, billerDestinations, ...(mode ? { mode: mode as 'test' | 'live' } : {}) },
    webhookSecrets: secrets,
  };
}
