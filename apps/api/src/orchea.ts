import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
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

export interface Envelope {
  eventId: string;
  type: string;
  payload: { paymentIntentId?: string; externalReference?: string; reason?: string; status?: string };
}

/** Événements déjà traités, pour le dédoublonnage sur `eventId` (en mémoire, ou en base : `db/postgres-store.ts`). */
export interface ProcessedEvents {
  has(eventId: string): Promise<boolean>;
  add(eventId: string): Promise<void>;
}

export class MemoryProcessedEvents implements ProcessedEvents {
  private readonly seen = new Set<string>();
  async has(eventId: string) { return this.seen.has(eventId); }
  async add(eventId: string) {
    this.seen.add(eventId);
    if (this.seen.size > 10_000) this.seen.delete(this.seen.values().next().value!);
  }
}

/**
 * Reçoit les événements d'ORCHEA et les traduit en issues de paiement App GN.
 * TransactionConfirmed → payé ; TransactionRejected (par le Risk) et TransactionFailed → échoué, avec la raison ;
 * PaymentAttemptUnknown et PaymentAttemptActionRequired laissent le paiement en cours ; un type inconnu est accepté
 * et ignoré. Dédoublonnage sur `eventId` ; l'issue elle-même ne s'applique qu'à un paiement encore en cours,
 * si bien qu'un événement traité deux fois (arrêt entre les deux écritures) reste sans effet.
 */
export class OrcheaWebhookReceiver {
  private readonly app: AppGn;
  private readonly secrets: readonly string[];
  private readonly seen: ProcessedEvents;
  private readonly now: () => number;

  constructor(app: AppGn, secrets: readonly string[], options: { processed?: ProcessedEvents; now?: () => number } = {}) {
    this.app = app;
    this.secrets = secrets;
    this.seen = options.processed ?? new MemoryProcessedEvents();
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async handle(rawBody: string, signature: string | undefined): Promise<WebhookHandling> {
    if (!verifyOrcheaSignature(this.secrets, signature, rawBody, this.now())) return { status: 401, result: 'invalid_signature' };
    const event = parseEnvelope(rawBody);
    if (!event) return { status: 400, result: 'malformed' };
    return this.apply(event);
  }

  /**
   * Applique un événement déjà authentifié : reçu par webhook signé, ou lu dans le flux `GET /v1/events` avec
   * notre clé d'API. Le même `eventId` venu par les deux voies n'est appliqué qu'une fois.
   */
  async apply(event: Envelope): Promise<Extract<WebhookHandling, { status: 200 }>> {
    if (await this.seen.has(event.eventId)) return { status: 200, result: 'duplicate' };
    const outcome = outcomeOf(event);
    const intentId = event.payload.paymentIntentId;
    if (!outcome || !intentId) {
      await this.seen.add(event.eventId);
      return { status: 200, result: 'ignored' };
    }
    const payment = await this.app.recordOutcome(`${ORCHEA_REFERENCE_PREFIX}${intentId}`, outcome, event.payload.externalReference);
    await this.seen.add(event.eventId);
    return payment
      ? { status: 200, result: 'applied', paymentId: payment.id }
      : { status: 200, result: 'unknown_payment' };
  }
}

// ── Flux d'événements : rattrapage ──────────────────────────────────────────

/**
 * Où en est la lecture du flux, partagé entre instances. Une seule instance le lit à la fois : elle prend un bail,
 * et n'avance le curseur que tant qu'elle le tient (un curseur ne recule jamais sous l'effet d'une instance lente).
 */
export interface FeedCursors {
  /** Prend le bail jusqu'à `until` s'il est libre (ou déjà à `holder`) ; rend le curseur gardé, `null` s'il n'y en a pas, `undefined` si le bail est pris. */
  lease(source: string, holder: string, until: number, now: number): Promise<string | null | undefined>;
  /** Avance le curseur, seulement si `holder` tient encore le bail. */
  advance(source: string, holder: string, cursor: string): Promise<boolean>;
  release(source: string, holder: string): Promise<void>;
}

export class MemoryFeedCursors implements FeedCursors {
  private readonly rows = new Map<string, { cursor: string | null; holder?: string; until: number }>();
  async lease(source: string, holder: string, until: number, now: number) {
    const row = this.rows.get(source) ?? { cursor: null, until: 0 };
    if (row.holder && row.holder !== holder && row.until > now) return undefined;
    this.rows.set(source, { cursor: row.cursor, holder, until });
    return row.cursor;
  }
  async advance(source: string, holder: string, cursor: string) {
    const row = this.rows.get(source);
    if (!row || row.holder !== holder) return false;
    row.cursor = cursor;
    return true;
  }
  async release(source: string, holder: string) {
    const row = this.rows.get(source);
    if (row?.holder === holder) this.rows.set(source, { cursor: row.cursor, until: 0 });
  }
}

export interface CatchUpReport {
  /** `busy` : une autre instance lit le flux. */
  status: 'done' | 'busy' | 'error';
  pages: number;
  events: number;
  applied: number;
  error?: string;
}

const FEED_SOURCE = 'orchea';
const FEED_PAGE = 100;
/** Au plus autant de pages par passage : le suivant reprendra où celui-ci s'est arrêté. */
const FEED_MAX_PAGES = 50;
const FEED_LEASE_MS = 2 * 60_000;

/**
 * Rattrape par `GET /v1/events` ce qu'un webhook n'a pas livré (service arrêté, livraison abandonnée).
 * Chaque page est appliquée puis le curseur gardé, jamais avant : un arrêt entre les deux relit la page,
 * sans effet grâce au dédoublonnage sur `eventId`.
 */
export class OrcheaEventFeed {
  private readonly config: Pick<OrcheaConfig, 'baseUrl' | 'apiKey' | 'mode' | 'fetch' | 'timeoutMs'>;
  private readonly receiver: OrcheaWebhookReceiver;
  private readonly cursors: FeedCursors;
  private readonly holder = randomUUID();
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(config: OrcheaEventFeed['config'], receiver: OrcheaWebhookReceiver, options: { cursors?: FeedCursors; now?: () => number } = {}) {
    this.config = config;
    this.receiver = receiver;
    this.cursors = options.cursors ?? new MemoryFeedCursors();
    this.fetch = config.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  async catchUp(): Promise<CatchUpReport> {
    const report: CatchUpReport = { status: 'done', pages: 0, events: 0, applied: 0 };
    const held = await this.cursors.lease(FEED_SOURCE, this.holder, this.now() + FEED_LEASE_MS, this.now());
    if (held === undefined) return { ...report, status: 'busy' };
    let cursor = held ?? undefined;
    try {
      while (report.pages < FEED_MAX_PAGES) {
        const url = new URL('/v1/events', this.config.baseUrl);
        url.searchParams.set('limit', String(FEED_PAGE));
        if (cursor) url.searchParams.set('cursor', cursor);
        const response = await this.fetch(url, {
          headers: { authorization: `Bearer ${this.config.apiKey}`, ...(this.config.mode ? { 'orchea-mode': this.config.mode } : {}) },
          signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
        });
        if (!response.ok) throw new Error(`GET /v1/events : ${response.status}`);
        const page = await response.json() as { items?: unknown[]; nextCursor?: string | null; hasMore?: boolean };
        if (!Array.isArray(page.items)) throw new Error('GET /v1/events : réponse sans items');
        for (const item of page.items) {
          const event = parseEnvelope(JSON.stringify(item));
          if (!event) continue;
          report.events += 1;
          if ((await this.receiver.apply(event)).result === 'applied') report.applied += 1;
        }
        report.pages += 1;
        if (page.nextCursor && page.nextCursor !== cursor) {
          // Le bail a pu passer à une autre instance (passage trop long) : elle reprend, on s'arrête.
          if (!await this.cursors.advance(FEED_SOURCE, this.holder, page.nextCursor)) return { ...report, status: 'busy' };
          cursor = page.nextCursor;
        }
        if (!page.hasMore) break;
      }
      return report;
    } catch (error) {
      return { ...report, status: 'error', error: (error as Error).message };
    } finally {
      await this.cursors.release(FEED_SOURCE, this.holder);
    }
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
