import {
  AppError,
  createDemoApp,
  loadDemoGapp,
  matchGappRoute,
  type AccountTransaction,
  type Actor,
  type CardNetwork,
  type CardTier,
  type CardView,
  type ConsolidatedView,
  type DocumentVerification,
  type ConfirmationProof,
  type DocumentView,
  type Exchange,
  type ExchangeInput,
  type ExchangeQuote,
  type MeView,
  type Payment,
  type PaymentInput,
  type Person,
  type ServiceDefinition,
  type SpaceEntry,
} from '@app-gn/core';

/** Ce dont l'interface a besoin, servi soit par l'API HTTP, soit par le noyau embarqué (mode démo). */
export interface CodeChallenge {
  challengeId: string;
  expiresAt: string;
  /** Démonstration seulement : aucun SMS ne part, le code est rendu ici. */
  demoCode?: string;
}

/** Une session s'ouvre dans un seul espace : personnel, ou une organisation. */
export interface OpenedSession {
  personId: string;
  spaceId: string;
}

export type SignInOutcome =
  | ({ kind: 'session' } & OpenedSession)
  | { kind: 'choose_space'; selectionToken: string; spaces: SpaceEntry[] };

export interface AppGnClient {
  readonly mode: 'api' | 'embedded';
  /** Joint un code de confirmation forte à la prochaine demande, et à elle seule. */
  confirmNext(proof: ConfirmationProof): void;
  /** Connexion : NIN → code par SMS → session dans un espace (nommé d'avance, ou choisi ensuite). */
  requestCode(nin: string): Promise<CodeChallenge>;
  openSession(challengeId: string, code: string, spaceId?: string): Promise<SignInOutcome>;
  selectSpace(selectionToken: string, spaceId: string): Promise<OpenedSession>;
  signOut(session: OpenedSession): Promise<void>;
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
  /** Tableaux de bord GAPP : `path` sous `/v1/spaces/:spaceId/` (`business/treasury`, `administration/budget`…). */
  desk<T>(actor: Actor, spaceId: string, method: 'GET' | 'POST', path: string, body?: unknown, idempotencyKey?: string): Promise<T>;
}

export class ClientError extends Error {
  readonly code: string;
  /** Ce que le serveur joint à l'erreur (le défi d'une confirmation forte). */
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    if (details) this.details = details;
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
  private proof: ConfirmationProof | undefined;
  confirmNext(proof: ConfirmationProof) { this.proof = proof; }
  constructor(base: string) {
    this.base = base.replace(/\/$/, '');
  }

  /** Jeton de la session ouverte dans cet espace ; à défaut (accès rapide de démo), la connexion de démo liée au même espace. */
  private authorization(actor: Actor): string {
    const token = actor.spaceId ? this.sessions[`${actor.personId}@${actor.spaceId}`] : undefined;
    if (token) return `Bearer ${token}`;
    return actor.spaceId ? `Bearer demo:${actor.personId}@${actor.spaceId}` : `Bearer demo:${actor.personId}`;
  }

  private keep(token: string, me: MeView): OpenedSession {
    const session = { personId: me.person.id, spaceId: me.spaces[0]!.space.id };
    this.sessions[`${session.personId}@${session.spaceId}`] = token;
    saveSessions(this.sessions);
    return session;
  }

  requestCode(nin: string) { return this.call<CodeChallenge>(null, 'POST', '/v1/auth/codes', { nin }); }
  async openSession(challengeId: string, code: string, spaceId?: string): Promise<SignInOutcome> {
    const result = await this.call<{ token: string; me: MeView } | { chooseSpace: true; selectionToken: string; spaces: SpaceEntry[] }>(
      null, 'POST', '/v1/auth/sessions', { challengeId, code, ...(spaceId ? { spaceId } : {}) });
    if ('chooseSpace' in result) return { kind: 'choose_space', selectionToken: result.selectionToken, spaces: result.spaces };
    return { kind: 'session', ...this.keep(result.token, result.me) };
  }
  async selectSpace(selectionToken: string, spaceId: string) {
    const { token, me } = await this.call<{ token: string; me: MeView }>(null, 'POST', '/v1/auth/sessions/space', { selectionToken, spaceId });
    return this.keep(token, me);
  }
  async signOut(session: OpenedSession) {
    const key = `${session.personId}@${session.spaceId}`;
    const token = this.sessions[key];
    if (!token) return;
    delete this.sessions[key];
    saveSessions(this.sessions);
    await this.call<void>(null, 'DELETE', '/v1/auth/sessions/current', undefined, { authorization: `Bearer ${token}` }).catch(() => undefined);
  }

  private async call<T>(actor: Actor | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const proof = actor ? this.proof : undefined;
    if (proof) this.proof = undefined;
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          ...(actor ? { authorization: this.authorization(actor), 'appgn-channel': actor.channel } : {}),
          ...(proof ? { 'appgn-confirmation': `${proof.challengeId}.${proof.code}` } : {}),
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
    if (!response.ok) {
      const { error, message, ...details } = payload as { error?: string; message?: string };
      throw new ClientError(error ?? 'http_error', message ?? `HTTP ${response.status}`, Object.keys(details).length > 0 ? details : undefined);
    }
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
  desk<T>(actor: Actor, spaceId: string, method: 'GET' | 'POST', path: string, body?: unknown, key?: string) {
    return this.call<T>(actor, method, `/v1/spaces/${spaceId}/${path}`, method === 'POST' ? body ?? {} : undefined, key ? { 'idempotency-key': key } : {});
  }
}

class EmbeddedClient implements AppGnClient {
  readonly mode = 'embedded' as const;
  private readonly app = createDemoApp().app;
  private readonly gapp = loadDemoGapp(this.app);
  private readonly challenges = new Map<string, { personId?: string; code: string; expiresAt: number }>();
  private readonly selections = new Map<string, string>();
  private proof: ConfirmationProof | undefined;
  confirmNext(proof: ConfirmationProof) { this.proof = proof; }

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
  async openSession(challengeId: string, code: string, spaceId?: string): Promise<SignInOutcome> {
    const challenge = this.challenges.get(challengeId);
    if (!challenge?.personId || challenge.code !== code.trim() || challenge.expiresAt < Date.now()) {
      throw new ClientError('unauthenticated', 'code incorrect ou expiré');
    }
    const spaces = this.app.entrances(challenge.personId, 'desktop');
    if (spaceId && !spaces.some((space) => space.id === spaceId)) throw new ClientError('not_a_member', 'espace inaccessible');
    this.challenges.delete(challengeId);
    if (spaceId || spaces.length === 1) return { kind: 'session', personId: challenge.personId, spaceId: spaceId ?? spaces[0]!.id };
    const selectionToken = crypto.randomUUID();
    this.selections.set(selectionToken, challenge.personId);
    return { kind: 'choose_space', selectionToken, spaces };
  }
  async selectSpace(selectionToken: string, spaceId: string) {
    const personId = this.selections.get(selectionToken);
    if (!personId) throw new ClientError('unauthenticated', 'choix expiré : reconnectez-vous');
    if (!this.app.entrances(personId, 'desktop').some((space) => space.id === spaceId)) throw new ClientError('not_a_member', 'espace inaccessible');
    this.selections.delete(selectionToken);
    return { personId, spaceId };
  }
  async signOut() {}

  private async run<T>(work: () => T | Promise<T>): Promise<T> {
    try {
      // Copie profonde : l'interface ne doit jamais tenir une référence vers l'état du noyau.
      return structuredClone(await work());
    } catch (error) {
      if (error instanceof AppError) throw new ClientError(error.code, error.message, error.details && structuredClone(error.details));
      throw error;
    }
  }

  /** L'acteur de la demande, avec le code de confirmation joint s'il y en a un (comme l'en-tête côté API). Usage unique. */
  private as(actor: Actor): Actor {
    const proof = this.proof;
    this.proof = undefined;
    return proof ? { ...actor, confirmation: proof } : actor;
  }

  persons() { return this.run(() => this.app.listPersons()); }
  me(actor: Actor) { return this.run(() => this.app.me(actor)); }
  overview(actor: Actor, spaceId: string) { return this.run(() => this.app.overview(actor, spaceId)); }
  services(actor: Actor, spaceId: string) { return this.run(() => this.app.services(actor, spaceId)); }
  transactions(actor: Actor, spaceId: string, accountId: string) { return this.run(() => this.app.transactions(actor, spaceId, accountId, 8)); }
  payments(actor: Actor, spaceId: string) { return this.run(() => this.app.listPayments(actor, spaceId)); }
  pay(actor: Actor, spaceId: string, input: PaymentInput, key: string) { const acting = this.as(actor); return this.run(() => this.app.initiatePayment(acting, spaceId, input, key)); }
  approve(actor: Actor, spaceId: string, paymentId: string) { const acting = this.as(actor); return this.run(() => this.app.approvePayment(acting, spaceId, paymentId)); }
  reject(actor: Actor, spaceId: string, paymentId: string) { return this.run(() => this.app.rejectPayment(actor, spaceId, paymentId)); }
  documents(actor: Actor, spaceId: string) { return this.run(() => this.app.documents(actor, spaceId)); }
  verifyDocument(code: string) { return this.run(() => this.app.verifyDocument(code)); }
  cards(actor: Actor, spaceId: string) { return this.run(() => this.app.cards(actor, spaceId)); }
  issueCard(actor: Actor, spaceId: string, request: { network: CardNetwork; tier: CardTier }, key: string) { return this.run(() => this.app.issueCard(actor, spaceId, request, key)); }
  setCardFrozen(actor: Actor, spaceId: string, accountId: string, frozen: boolean) { return this.run(() => this.app.setCardFrozen(actor, spaceId, accountId, frozen)); }
  quoteExchange(actor: Actor, spaceId: string, input: ExchangeInput) { return this.run(() => this.app.quoteExchange(actor, spaceId, input)); }
  executeExchange(actor: Actor, spaceId: string, quoteId: string, key: string) { return this.run(() => this.app.executeExchange(actor, spaceId, quoteId, key)); }
  // Même table de routes que l'API : le mode démo sert les tableaux de bord GAPP sans serveur.
  desk<T>(actor: Actor, spaceId: string, method: 'GET' | 'POST', path: string, body?: unknown, key?: string) {
    const acting = this.as(actor);
    return this.run(async () => {
      const match = matchGappRoute(method, `/v1/spaces/${encodeURIComponent(spaceId)}/${path}`);
      if (!match) throw new AppError('not_found', 'route inconnue');
      const { spaceId: _space, ...params } = match.params;
      return match.route.handle(await this.gapp, { actor: acting, spaceId, params, body: (structuredClone(body) ?? {}) as Record<string, unknown>, key: key ?? '' }) as Promise<T>;
    });
  }
}

export function createBaseClient(): AppGnClient {
  const base = import.meta.env.VITE_API_URL as string | undefined;
  return base ? new HttpClient(base === '/' ? '' : base) : new EmbeddedClient();
}
