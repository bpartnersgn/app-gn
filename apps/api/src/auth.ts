import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError, maskPhone, normalizeNin, type AppGn, type ConfirmationChallenge, type ConfirmationProof, type Confirmer, type Operation, type Person, type SpaceEntry } from '@app-gn/core';

/**
 * Connexion par NIN + code à usage unique envoyé par SMS, puis session signée.
 *
 * - Le code (6 chiffres) vit 5 minutes, se tente 5 fois au plus, ne sert qu'une fois ; seul son empreinte est gardée.
 * - Au plus 3 codes par personne en 15 minutes.
 * - La réponse est la même qu'un NIN soit connu ou non : elle ne dit ni si la personne existe, ni son numéro.
 * - La session est un jeton signé (HMAC-SHA256) de 12 h, révocable à la déconnexion, et liée à un seul espace :
 *   l'espace personnel, ou une entreprise, ou une administration. Fonds personnels et fonds d'une organisation
 *   ne se lisent jamais dans la même session ; changer d'espace demande un nouveau code.
 * - Qui n'a que son espace personnel y entre directement. Qui a aussi une organisation choisit après le code
 *   (jeton de choix, 5 minutes, usage unique), ou nomme l'espace dès la demande de session.
 *
 * Inscription : NIN, nom et numéro ; le code part au numéro donné, qui est ainsi prouvé ; la personne et son espace
 * personnel naissent à la saisie du code, et elle y entre aussitôt. Un NIN déjà inscrit ne reçoit pas de code
 * (même réponse) : son titulaire est prévenu sur son propre numéro.
 *
 * Défis, demandes de code et révocations vivent dans un `AuthStore` : en mémoire, ou en base (`db/postgres-store.ts`),
 * qui les garde d'un redémarrage à l'autre et les partage entre instances.
 */

export interface SmsSender {
  send(phone: string, text: string): Promise<void>;
}

/** Garde les SMS au lieu de les envoyer : tests, et démonstration tant qu'aucun fournisseur SMS n'est branché. */
export class MemorySmsSender implements SmsSender {
  readonly sent: { phone: string; text: string; at: Date }[] = [];
  async send(phone: string, text: string): Promise<void> {
    this.sent.push({ phone, text, at: new Date() });
    if (this.sent.length > 200) this.sent.shift();
  }
  lastCodeFor(phone: string): string | undefined {
    const message = [...this.sent].reverse().find((candidate) => candidate.phone === phone);
    return message ? /\b(\d{6})\b/.exec(message.text)?.[1] : undefined;
  }
}

const CODE_TTL_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;
const CODES_PER_WINDOW = 3;
const CODE_WINDOW_MS = 15 * 60_000;
const CONFIRMATIONS_PER_WINDOW = 5;
export const SESSION_TTL_MS = 12 * 60 * 60_000;

/** Ce qu'un défi permet une fois le code donné : se connecter, s'inscrire, choisir l'espace, confirmer une opération. */
export type ChallengePurpose = 'signin' | 'registration' | 'selection' | 'confirmation';

export interface Challenge {
  /** `signin` si absent (défis écrits avant la migration 4). */
  purpose?: ChallengePurpose;
  personId?: string;
  codeHash?: string;
  expiresAt: number;
  attempts: number;
  /** Ce que le défi porte : la demande d'inscription, l'opération à confirmer. */
  payload?: unknown;
}

export interface AuthStore {
  saveChallenge(id: string, challenge: Challenge): Promise<void>;
  /** Compte un essai et rend le défi tel qu'il est après, ou rien s'il n'existe plus. */
  countAttempt(id: string): Promise<Challenge | undefined>;
  /** Vrai pour un seul appelant : c'est ce qui rend le code à usage unique, même sous essais concurrents. */
  consumeChallenge(id: string): Promise<boolean>;
  /** Inscrit une demande de code et rend le nombre de demandes de cette clé depuis `since` (celle-ci comprise). */
  recordCodeRequest(key: string, at: number, since: number): Promise<number>;
  revoke(sessionId: string, until: number): Promise<void>;
  isRevoked(sessionId: string): Promise<boolean>;
  sweep(now: number, requestsBefore: number): Promise<void>;
}

export class MemoryAuthStore implements AuthStore {
  private readonly challenges = new Map<string, Challenge>();
  private readonly requests = new Map<string, number[]>();
  private readonly revoked = new Map<string, number>();

  async saveChallenge(id: string, challenge: Challenge) { this.challenges.set(id, { ...challenge }); }
  async countAttempt(id: string) {
    const challenge = this.challenges.get(id);
    if (!challenge) return undefined;
    challenge.attempts += 1;
    return { ...challenge };
  }
  async consumeChallenge(id: string) { return this.challenges.delete(id); }
  async recordCodeRequest(key: string, at: number, since: number) {
    const times = [...(this.requests.get(key) ?? []).filter((time) => time >= since), at];
    this.requests.set(key, times);
    return times.length;
  }
  async revoke(sessionId: string, until: number) { this.revoked.set(sessionId, until); }
  async isRevoked(sessionId: string) { return this.revoked.has(sessionId); }
  async sweep(now: number, requestsBefore: number) {
    for (const [id, challenge] of this.challenges) if (challenge.expiresAt <= now) this.challenges.delete(id);
    for (const [id, until] of this.revoked) if (until <= now) this.revoked.delete(id);
    for (const [key, times] of this.requests) if (times.every((at) => at < requestsBefore)) this.requests.delete(key);
  }
}

export interface AuthOptions {
  app: AppGn;
  sms: SmsSender;
  /** Clé de signature des sessions, au moins 32 caractères. */
  secret: string;
  /** Démonstration seulement, sans fournisseur SMS : la réponse porte le code (`demoCode`). Jamais en production. */
  revealCodes?: boolean;
  store?: AuthStore;
  now?: () => number;
}

export interface Session {
  personId: string;
  /** L'espace de la session : rien d'autre n'y est lisible. */
  spaceId: string;
  sessionId: string;
  expiresAt: string;
}

export type SignInResult =
  | { kind: 'session'; token: string; session: Session }
  | { kind: 'choose_space'; selectionToken: string; spaces: SpaceEntry[] };

export class Auth implements Confirmer {
  private readonly app: AppGn;
  private readonly sms: SmsSender;
  private readonly secret: string;
  private readonly now: () => number;
  private readonly revealCodes: boolean;
  private readonly store: AuthStore;

  constructor(options: AuthOptions) {
    if (options.secret.length < 32) throw new Error('la clé de session doit faire au moins 32 caractères');
    this.app = options.app;
    this.sms = options.sms;
    this.secret = options.secret;
    this.now = options.now ?? Date.now;
    this.revealCodes = options.revealCodes ?? false;
    this.store = options.store ?? new MemoryAuthStore();
  }

  /** Étape 1 : demander un code. */
  async requestCode(nin: unknown): Promise<{ challengeId: string; expiresAt: string; demoCode?: string }> {
    if (typeof nin !== 'string' || nin.trim().length < 6 || nin.length > 40) throw new AppError('invalid_request', 'NIN requis');
    await this.store.sweep(this.now(), this.now() - CODE_WINDOW_MS);
    const now = this.now();
    const challengeId = randomUUID();
    const expiresAt = now + CODE_TTL_MS;
    // La limite vaut par NIN, connu ou non : un refus ne doit pas trahir qu'une personne existe.
    const key = normalizeNin(nin);
    if (await this.store.recordCodeRequest(key, now, now - CODE_WINDOW_MS + 1) > CODES_PER_WINDOW) {
      throw new AppError('rate_limited', 'trop de codes demandés : réessayez dans quelques minutes');
    }
    const person = await this.app.findPersonByNin(nin);
    if (!person) {
      // Même réponse qu'un NIN connu ; le défi ne pourra jamais aboutir.
      await this.store.saveChallenge(challengeId, { purpose: 'signin', expiresAt, attempts: 0 });
      return { challengeId, expiresAt: new Date(expiresAt).toISOString() };
    }
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.store.saveChallenge(challengeId, { purpose: 'signin', personId: person.id, codeHash: this.hashCode(challengeId, code), expiresAt, attempts: 0 });
    await this.sms.send(person.phone, `App GN : votre code de connexion est ${code}. Il expire dans 5 minutes. Ne le donnez à personne.`);
    return { challengeId, expiresAt: new Date(expiresAt).toISOString(), ...(this.revealCodes ? { demoCode: code } : {}) };
  }

  /** Étape 2 : échanger le code contre une session dans un espace, ou contre le choix de l'espace. */
  async verifyCode(challengeId: unknown, code: unknown, spaceId?: unknown): Promise<SignInResult> {
    const challenge = await this.checkCode(challengeId, code, 'signin');
    const personId = challenge.personId!;
    const spaces = this.app.entrances(personId, 'desktop');
    // L'espace demandé se vérifie avant de consommer le code : une erreur de choix ne coûte pas un nouveau SMS.
    if (spaceId !== undefined && !spaces.some((space) => space.id === spaceId)) throw new AppError('not_a_member', 'espace inaccessible');
    if (!await this.store.consumeChallenge(challengeId as string)) throw new AppError('unauthenticated', 'code incorrect ou expiré');
    if (typeof spaceId === 'string') return { kind: 'session', ...this.issue(personId, spaceId) };
    if (spaces.length === 1) return { kind: 'session', ...this.issue(personId, spaces[0]!.id) };
    const selectionToken = randomUUID();
    await this.store.saveChallenge(selectionToken, { purpose: 'selection', personId, expiresAt: this.now() + CODE_TTL_MS, attempts: 0 });
    return { kind: 'choose_space', selectionToken, spaces };
  }

  /** Étape 3, pour qui a plusieurs espaces : entrer dans celui choisi. */
  async selectSpace(selectionToken: unknown, spaceId: unknown): Promise<{ token: string; session: Session }> {
    const refused = new AppError('unauthenticated', 'choix expiré : reconnectez-vous');
    if (typeof selectionToken !== 'string' || selectionToken.length > 64 || typeof spaceId !== 'string') throw refused;
    const selection = await this.store.countAttempt(selectionToken);
    // Un défi de code (qui porte une empreinte) n'est pas un jeton de choix.
    if (!selection?.personId || selection.purpose !== 'selection' || selection.codeHash !== undefined || selection.expiresAt <= this.now() || selection.attempts > MAX_ATTEMPTS) throw refused;
    if (!this.app.entrances(selection.personId, 'desktop').some((space) => space.id === spaceId)) {
      throw new AppError('not_a_member', 'espace inaccessible');
    }
    if (!await this.store.consumeChallenge(selectionToken)) throw refused;
    return this.issue(selection.personId, spaceId);
  }

  /** Inscription, étape 1 : contrôler la demande et envoyer un code au numéro donné. */
  async requestRegistration(input: unknown): Promise<{ challengeId: string; expiresAt: string; demoCode?: string }> {
    const request = this.app.checkRegistration(input as never);
    await this.store.sweep(this.now(), this.now() - CODE_WINDOW_MS + 1);
    const now = this.now();
    // Mêmes plafonds que la connexion, par NIN et par numéro : ni SMS en rafale, ni NIN essayés en série.
    for (const key of [request.nin, `tel:${request.phone}`]) {
      if (await this.store.recordCodeRequest(key, now, now - CODE_WINDOW_MS + 1) > CODES_PER_WINDOW) {
        throw new AppError('rate_limited', 'trop de codes demandés : réessayez dans quelques minutes');
      }
    }
    const challengeId = randomUUID();
    const expiresAt = now + CODE_TTL_MS;
    const existing = await this.app.findPersonByNin(request.nin);
    if (existing) {
      // Même réponse que pour un nouveau NIN ; aucun code ne part. Le titulaire est prévenu sur son numéro.
      await this.store.saveChallenge(challengeId, { purpose: 'registration', expiresAt, attempts: 0 });
      await this.sms.send(existing.phone, 'App GN : une inscription a été demandée avec votre NIN. Vous avez déjà un compte : connectez-vous. Si ce n’est pas vous, ignorez ce message.');
      return { challengeId, expiresAt: new Date(expiresAt).toISOString() };
    }
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.store.saveChallenge(challengeId, { purpose: 'registration', codeHash: this.hashCode(challengeId, code), expiresAt, attempts: 0, payload: request });
    await this.sms.send(request.phone, `App GN : votre code d’inscription est ${code}. Il expire dans 5 minutes. Ne le donnez à personne.`);
    return { challengeId, expiresAt: new Date(expiresAt).toISOString(), ...(this.revealCodes ? { demoCode: code } : {}) };
  }

  /** Inscription, étape 2 : le code prouve le numéro ; la personne naît avec son espace personnel, et y entre. */
  async confirmRegistration(challengeId: unknown, code: unknown): Promise<{ token: string; session: Session }> {
    const challenge = await this.checkCode(challengeId, code, 'registration');
    if (!await this.store.consumeChallenge(challengeId as string)) throw new AppError('unauthenticated', 'code incorrect ou expiré');
    const { person, space } = await this.app.register(challenge.payload as never);
    return this.issue(person.id, space.id);
  }

  /**
   * Compte un essai et vérifie le code d'un défi de l'objet attendu. Ne consomme pas le défi : l'appelant le fait
   * quand tout le reste est vérifié (une erreur de choix ne coûte pas un nouveau SMS).
   */
  private async checkCode(challengeId: unknown, code: unknown, purpose: ChallengePurpose): Promise<Challenge> {
    const refused = new AppError('unauthenticated', 'code incorrect ou expiré');
    if (typeof challengeId !== 'string' || typeof code !== 'string' || challengeId.length > 64) throw refused;
    const challenge = await this.store.countAttempt(challengeId);
    if (!challenge || (challenge.purpose ?? 'signin') !== purpose) throw refused;
    if (challenge.expiresAt <= this.now() || challenge.attempts > MAX_ATTEMPTS) {
      await this.store.consumeChallenge(challengeId);
      throw refused;
    }
    const ok = challenge.codeHash !== undefined && /^\d{6}$/.test(code) && safeEqual(this.hashCode(challengeId, code), challenge.codeHash);
    if (!ok) throw refused;
    return challenge;
  }

  // ── Confirmation forte (au-delà du seuil d'entreprise) ──

  /** Code lié à l'opération exacte, envoyé au numéro de la personne ; au plus 5 en 15 minutes par personne. */
  async challenge(person: Person, operation: Operation): Promise<ConfirmationChallenge> {
    const now = this.now();
    if (await this.store.recordCodeRequest(`confirm:${person.id}`, now, now - CODE_WINDOW_MS + 1) > CONFIRMATIONS_PER_WINDOW) {
      throw new AppError('rate_limited', 'trop de codes de confirmation demandés : réessayez dans quelques minutes');
    }
    const challengeId = randomUUID();
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const expiresAt = now + CODE_TTL_MS;
    await this.store.saveChallenge(challengeId, { purpose: 'confirmation', personId: person.id, codeHash: this.hashCode(challengeId, code), expiresAt, attempts: 0, payload: { operation: operation.key } });
    await this.sms.send(person.phone, `App GN : code ${code} pour confirmer ${operation.summary}. Il expire dans 5 minutes. Si ce n’est pas vous, ne le donnez à personne.`);
    return { challengeId, expiresAt: new Date(expiresAt).toISOString(), sentTo: maskPhone(person.phone), ...(this.revealCodes ? { demoCode: code } : {}) };
  }

  /** Une seule tentative par code : juste ou faux, le défi est consommé. */
  async verify(person: Person, operation: Operation, proof: ConfirmationProof): Promise<boolean> {
    if (typeof proof?.challengeId !== 'string' || typeof proof.code !== 'string' || proof.challengeId.length > 64) return false;
    const challenge = await this.store.countAttempt(proof.challengeId);
    if (!challenge || challenge.purpose !== 'confirmation') return false;
    const consumed = await this.store.consumeChallenge(proof.challengeId);
    return consumed && challenge.personId === person.id && challenge.expiresAt > this.now()
      && (challenge.payload as { operation?: unknown } | undefined)?.operation === operation.key
      && challenge.codeHash !== undefined && /^\d{6}$/.test(proof.code) && safeEqual(this.hashCode(proof.challengeId, proof.code), challenge.codeHash);
  }

  issue(personId: string, spaceId: string): { token: string; session: Session } {
    const session: Session = { personId, spaceId, sessionId: randomUUID(), expiresAt: new Date(this.now() + SESSION_TTL_MS).toISOString() };
    const payload = Buffer.from(JSON.stringify({ sub: personId, spc: spaceId, sid: session.sessionId, exp: Date.parse(session.expiresAt) })).toString('base64url');
    return { token: `ags1.${payload}.${this.sign(payload)}`, session };
  }

  /** La session d'un jeton, ou rien s'il est faux, expiré ou révoqué. Ne lève jamais. */
  async read(token: string): Promise<Session | undefined> {
    const [version, payload, signature, extra] = token.split('.');
    if (version !== 'ags1' || !payload || !signature || extra !== undefined) return undefined;
    if (!safeEqual(signature, this.sign(payload))) return undefined;
    try {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: unknown; spc?: unknown; sid?: unknown; exp?: unknown };
      if (typeof claims.sub !== 'string' || typeof claims.spc !== 'string' || typeof claims.sid !== 'string' || typeof claims.exp !== 'number') return undefined;
      if (claims.exp <= this.now() || await this.store.isRevoked(claims.sid)) return undefined;
      return { personId: claims.sub, spaceId: claims.spc, sessionId: claims.sid, expiresAt: new Date(claims.exp).toISOString() };
    } catch {
      return undefined;
    }
  }

  async revoke(session: Session): Promise<void> {
    await this.store.revoke(session.sessionId, Date.parse(session.expiresAt));
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(`session.${payload}`).digest('base64url');
  }

  private hashCode(challengeId: string, code: string): string {
    return createHash('sha256').update(`${this.secret}.${challengeId}.${code}`).digest('hex');
  }
}

function safeEqual(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** `APPGN_SESSION_SECRET`, ou une clé tirée au démarrage (les sessions ne survivent alors pas à un redémarrage). */
export function sessionSecretFromEnvironment(environment: Readonly<Record<string, string | undefined>>): { secret: string; generated: boolean } {
  const secret = environment.APPGN_SESSION_SECRET?.trim();
  if (secret) {
    if (secret.length < 32) throw new Error('APPGN_SESSION_SECRET : au moins 32 caractères.');
    return { secret, generated: false };
  }
  return { secret: randomBytes(32).toString('base64url'), generated: true };
}
