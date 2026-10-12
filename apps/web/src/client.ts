import {
  AppError,
  createDemoApp,
  type AccountTransaction,
  type Actor,
  type CardNetwork,
  type CardTier,
  type CardView,
  type ConsolidatedView,
  type DocumentVerification,
  type DocumentView,
  type Exchange,
  type ExchangeInput,
  type ExchangeQuote,
  type MeView,
  type Payment,
  type PaymentInput,
  type Person,
  type ServiceDefinition,
} from '@app-gn/core';

/** Ce dont l'interface a besoin, servi soit par l'API HTTP, soit par le noyau embarqué (mode démo). */
export interface CodeChallenge {
  challengeId: string;
  expiresAt: string;
  /** Démonstration seulement : aucun SMS ne part, le code est rendu ici. */
  demoCode?: string;
}

export interface AppGnClient {
  readonly mode: 'api' | 'embedded';
  /** Connexion : NIN → code par SMS → session. */
  requestCode(nin: string): Promise<CodeChallenge>;
  openSession(challengeId: string, code: string): Promise<{ personId: string }>;
  signOut(personId: string): Promise<void>;
  persons(): Promise<Person[]>;
  me(actor: Actor): Promise<MeView>;
  overview(actor: Actor, spaceId: string): Promise<ConsolidatedView>;
  services(actor: Actor, spaceId: string): Promise<ServiceDefinition[]>;
  transactions(actor: Actor, spaceId: string, accountId: string): Promise<AccountTransaction[]>;
  payments(actor: Actor, spaceId: string): Promise<Payment[]>;
  pay(actor: Actor, spaceId: string, input: PaymentInput, idempotencyKey: string): Promise<Payment>;
  approve(actor: Actor, spaceId: string, paymentId: string): Promise<Payment>;
  reject(actor: Actor, spaceId: string, paymentId: string): Promise<Payment>;
  documents(actor: Actor, spaceId: string): Promise<DocumentView[]>;
  verifyDocument(code: string): Promise<DocumentVerification>;
  cards(actor: Actor, spaceId: string): Promise<CardView[]>;
  issueCard(actor: Actor, spaceId: string, request: { network: CardNetwork; tier: CardTier }, idempotencyKey: string): Promise<CardView>;
  setCardFrozen(actor: Actor, spaceId: string, accountId: string, frozen: boolean): Promise<CardView>;
  quoteExchange(actor: Actor, spaceId: string, input: ExchangeInput): Promise<ExchangeQuote>;
  executeExchange(actor: Actor, spaceId: string, quoteId: string, idempotencyKey: string): Promise<Exchange>;
}

export class ClientError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Code réservé aux pannes de réseau : tout autre code est une réponse du serveur. */
export const NETWORK_ERROR = 'network';

const SESSIONS_KEY = 'appgn.sessions';

/** Jetons de session par personne, gardés sur l'appareil pour rester connecté hors ligne. */
function loadSessions(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(SESSIONS_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

function saveSessions(sessions: Record<string, string>): void {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  } catch {
    // Stockage indisponible (navigation privée) : la session vit le temps de la page.
  }
}

class HttpClient implements AppGnClient {
  readonly mode = 'api' as const;
  private readonly base: string;
  private readonly sessions = loadSessions();
  constructor(base: string) {
    this.base = base.replace(/\/$/, '');
  }

  private authorization(personId: string): string {
    const token = this.sessions[personId];
    return token ? `Bearer ${token}` : `Bearer demo:${personId}`;
  }

  requestCode(nin: string) { return this.call<CodeChallenge>(null, 'POST', '/v1/auth/codes', { nin }); }
  async openSession(challengeId: string, code: string) {
    const { token, me } = await this.call<{ token: string; me: MeView }>(null, 'POST', '/v1/auth/sessions', { challengeId, code });
    this.sessions[me.person.id] = token;
    saveSessions(this.sessions);
    return { personId: me.person.id };
  }
  async signOut(personId: string) {
    const token = this.sessions[personId];
    if (!token) return;
    delete this.sessions[personId];
    saveSessions(this.sessions);
    await this.call<void>(null, 'DELETE', '/v1/auth/sessions/current', undefined, { authorization: `Bearer ${token}` }).catch(() => undefined);
  }

  private async call<T>(actor: Actor | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          ...(actor ? { authorization: this.authorization(actor.personId), 'appgn-channel': actor.channel } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ClientError(NETWORK_ERROR, 'réseau indisponible');
    }
    if (response.status === 204) return undefined as T;
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new ClientError(payload.error ?? 'http_error', payload.message ?? `HTTP ${response.status}`);
    return payload as T;
  }

  persons() { return this.call<Person[]>(null, 'GET', '/v1/demo/persons'); }
  me(actor: Actor) { return this.call<MeView>(actor, 'GET', '/v1/me'); }
  overview(actor: Actor, spaceId: string) { return this.call<ConsolidatedView>(actor, 'GET', `/v1/spaces/${spaceId}/overview`); }
  services(actor: Actor, spaceId: string) { return this.call<ServiceDefinition[]>(actor, 'GET', `/v1/spaces/${spaceId}/services`); }
  transactions(actor: Actor, spaceId: string, accountId: string) {
    return this.call<AccountTransaction[]>(actor, 'GET', `/v1/spaces/${spaceId}/accounts/${accountId}/transactions?limit=8`);
  }
  payments(actor: Actor, spaceId: string) { return this.call<Payment[]>(actor, 'GET', `/v1/spaces/${spaceId}/payments`); }
  pay(actor: Actor, spaceId: string, input: PaymentInput, idempotencyKey: string) {
    return this.call<Payment>(actor, 'POST', `/v1/spaces/${spaceId}/payments`, input, { 'idempotency-key': idempotencyKey });
  }
  approve(actor: Actor, spaceId: string, paymentId: string) { return this.call<Payment>(actor, 'POST', `/v1/spaces/${spaceId}/payments/${paymentId}/approve`, {}); }
  reject(actor: Actor, spaceId: string, paymentId: string) { return this.call<Payment>(actor, 'POST', `/v1/spaces/${spaceId}/payments/${paymentId}/reject`, {}); }
  documents(actor: Actor, spaceId: string) { return this.call<DocumentView[]>(actor, 'GET', `/v1/spaces/${spaceId}/documents`); }
  verifyDocument(code: string) { return this.call<DocumentVerification>(null, 'GET', `/v1/document-checks/${encodeURIComponent(code)}`); }
  cards(actor: Actor, spaceId: string) { return this.call<CardView[]>(actor, 'GET', `/v1/spaces/${spaceId}/cards`); }
  issueCard(actor: Actor, spaceId: string, request: { network: CardNetwork; tier: CardTier }, key: string) {
    return this.call<CardView>(actor, 'POST', `/v1/spaces/${spaceId}/cards`, request, { 'idempotency-key': key });
  }
  setCardFrozen(actor: Actor, spaceId: string, accountId: string, frozen: boolean) {
    return this.call<CardView>(actor, 'POST', `/v1/spaces/${spaceId}/cards/${accountId}/${frozen ? 'freeze' : 'unfreeze'}`, {});
  }
  quoteExchange(actor: Actor, spaceId: string, input: ExchangeInput) { return this.call<ExchangeQuote>(actor, 'POST', `/v1/spaces/${spaceId}/exchange-quotes`, input); }
  executeExchange(actor: Actor, spaceId: string, quoteId: string, key: string) {
    return this.call<Exchange>(actor, 'POST', `/v1/spaces/${spaceId}/exchanges`, { quoteId }, { 'idempotency-key': key });
  }
}

class EmbeddedClient implements AppGnClient {
  readonly mode = 'embedded' as const;
  private readonly app = createDemoApp().app;
  private readonly challenges = new Map<string, { personId?: string; code: string; expiresAt: number }>();

  // Démonstration sans serveur : même parcours que l'API, le code est montré au lieu d'être envoyé par SMS.
  async requestCode(nin: string): Promise<CodeChallenge> {
    if (nin.trim().length < 6) throw new ClientError('invalid_request', 'NIN requis');
    const person = this.app.personByNin(nin);
    const challengeId = crypto.randomUUID();
    const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
    const expiresAt = Date.now() + 5 * 60_000;
    this.challenges.set(challengeId, { personId: person?.id, code, expiresAt });
    return { challengeId, expiresAt: new Date(expiresAt).toISOString(), ...(person ? { demoCode: code } : {}) };
  }
  async openSession(challengeId: string, code: string) {
    const challenge = this.challenges.get(challengeId);
    if (!challenge?.personId || challenge.code !== code.trim() || challenge.expiresAt < Date.now()) {
      throw new ClientError('unauthenticated', 'code incorrect ou expiré');
    }
    this.challenges.delete(challengeId);
    return { personId: challenge.personId };
  }
  async signOut() {}

  private async run<T>(work: () => T | Promise<T>): Promise<T> {
    try {
      // Copie profonde : l'interface ne doit jamais tenir une référence vers l'état du noyau.
      return structuredClone(await work());
    } catch (error) {
      if (error instanceof AppError) throw new ClientError(error.code, error.message);
      throw error;
    }
  }

  persons() { return this.run(() => this.app.listPersons()); }
  me(actor: Actor) { return this.run(() => this.app.me(actor)); }
  overview(actor: Actor, spaceId: string) { return this.run(() => this.app.overview(actor, spaceId)); }
  services(actor: Actor, spaceId: string) { return this.run(() => this.app.services(actor, spaceId)); }
  transactions(actor: Actor, spaceId: string, accountId: string) { return this.run(() => this.app.transactions(actor, spaceId, accountId, 8)); }
  payments(actor: Actor, spaceId: string) { return this.run(() => this.app.listPayments(actor, spaceId)); }
  pay(actor: Actor, spaceId: string, input: PaymentInput, key: string) { return this.run(() => this.app.initiatePayment(actor, spaceId, input, key)); }
  approve(actor: Actor, spaceId: string, paymentId: string) { return this.run(() => this.app.approvePayment(actor, spaceId, paymentId)); }
  reject(actor: Actor, spaceId: string, paymentId: string) { return this.run(() => this.app.rejectPayment(actor, spaceId, paymentId)); }
  documents(actor: Actor, spaceId: string) { return this.run(() => this.app.documents(actor, spaceId)); }
  verifyDocument(code: string) { return this.run(() => this.app.verifyDocument(code)); }
  cards(actor: Actor, spaceId: string) { return this.run(() => this.app.cards(actor, spaceId)); }
  issueCard(actor: Actor, spaceId: string, request: { network: CardNetwork; tier: CardTier }, key: string) { return this.run(() => this.app.issueCard(actor, spaceId, request, key)); }
  setCardFrozen(actor: Actor, spaceId: string, accountId: string, frozen: boolean) { return this.run(() => this.app.setCardFrozen(actor, spaceId, accountId, frozen)); }
  quoteExchange(actor: Actor, spaceId: string, input: ExchangeInput) { return this.run(() => this.app.quoteExchange(actor, spaceId, input)); }
  executeExchange(actor: Actor, spaceId: string, quoteId: string, key: string) { return this.run(() => this.app.executeExchange(actor, spaceId, quoteId, key)); }
}

export function createBaseClient(): AppGnClient {
  const base = import.meta.env.VITE_API_URL as string | undefined;
  return base ? new HttpClient(base === '/' ? '' : base) : new EmbeddedClient();
}
