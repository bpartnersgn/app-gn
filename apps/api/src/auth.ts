import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError, normalizeNin, type AppGn } from '@app-gn/core';

/**
 * Connexion par NIN + code à usage unique envoyé par SMS, puis session signée.
 *
 * - Le code (6 chiffres) vit 5 minutes, se tente 5 fois au plus, ne sert qu'une fois ; seul son empreinte est gardée.
 * - Au plus 3 codes par personne en 15 minutes.
 * - La réponse est la même qu'un NIN soit connu ou non : elle ne dit ni si la personne existe, ni son numéro.
 * - La session est un jeton signé (HMAC-SHA256) de 12 h, révocable à la déconnexion.
 *
 * Tout tient en mémoire pour l'instant : un redémarrage efface les codes en cours et les révocations
 * (les jetons restent valides jusqu'à leur échéance). Les deux passeront en base avec PostgreSQL.
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
export const SESSION_TTL_MS = 12 * 60 * 60_000;

interface Challenge {
  personId?: string;
  codeHash?: string;
  expiresAt: number;
  attempts: number;
}

export interface AuthOptions {
  app: AppGn;
  sms: SmsSender;
  /** Clé de signature des sessions, au moins 32 caractères. */
  secret: string;
  /** Démonstration seulement, sans fournisseur SMS : la réponse porte le code (`demoCode`). Jamais en production. */
  revealCodes?: boolean;
  now?: () => number;
}

export interface Session {
  personId: string;
  sessionId: string;
  expiresAt: string;
}

export class Auth {
  private readonly app: AppGn;
  private readonly sms: SmsSender;
  private readonly secret: string;
  private readonly now: () => number;
  private readonly revealCodes: boolean;
  private readonly challenges = new Map<string, Challenge>();
  private readonly sentAt = new Map<string, number[]>();
  private readonly revoked = new Map<string, number>();

  constructor(options: AuthOptions) {
    if (options.secret.length < 32) throw new Error('la clé de session doit faire au moins 32 caractères');
    this.app = options.app;
    this.sms = options.sms;
    this.secret = options.secret;
    this.now = options.now ?? Date.now;
    this.revealCodes = options.revealCodes ?? false;
  }

  /** Étape 1 : demander un code. */
  async requestCode(nin: unknown): Promise<{ challengeId: string; expiresAt: string; demoCode?: string }> {
    if (typeof nin !== 'string' || nin.trim().length < 6 || nin.length > 40) throw new AppError('invalid_request', 'NIN requis');
    this.sweep();
    const now = this.now();
    const challengeId = randomUUID();
    const expiresAt = now + CODE_TTL_MS;
    // La limite vaut par NIN, connu ou non : un refus ne doit pas trahir qu'une personne existe.
    const key = normalizeNin(nin);
    const recent = (this.sentAt.get(key) ?? []).filter((at) => now - at < CODE_WINDOW_MS);
    if (recent.length >= CODES_PER_WINDOW) throw new AppError('rate_limited', 'trop de codes demandés : réessayez dans quelques minutes');
    this.sentAt.set(key, [...recent, now]);
    const person = this.app.personByNin(nin);
    if (!person) {
      // Même réponse qu'un NIN connu ; le défi ne pourra jamais aboutir.
      this.challenges.set(challengeId, { expiresAt, attempts: 0 });
      return { challengeId, expiresAt: new Date(expiresAt).toISOString() };
    }
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    this.challenges.set(challengeId, { personId: person.id, codeHash: this.hashCode(challengeId, code), expiresAt, attempts: 0 });
    await this.sms.send(person.phone, `App GN : votre code de connexion est ${code}. Il expire dans 5 minutes. Ne le donnez à personne.`);
    return { challengeId, expiresAt: new Date(expiresAt).toISOString(), ...(this.revealCodes ? { demoCode: code } : {}) };
  }

  /** Étape 2 : échanger le code contre une session. */
  verifyCode(challengeId: unknown, code: unknown): { token: string; session: Session } {
    const refused = new AppError('unauthenticated', 'code incorrect ou expiré');
    if (typeof challengeId !== 'string' || typeof code !== 'string') throw refused;
    const challenge = this.challenges.get(challengeId);
    if (!challenge || challenge.expiresAt <= this.now()) {
      this.challenges.delete(challengeId);
      throw refused;
    }
    challenge.attempts += 1;
    if (challenge.attempts > MAX_ATTEMPTS) {
      this.challenges.delete(challengeId);
      throw refused;
    }
    const ok = challenge.personId !== undefined && challenge.codeHash !== undefined && /^\d{6}$/.test(code)
      && safeEqual(this.hashCode(challengeId, code), challenge.codeHash);
    if (!ok) throw refused;
    this.challenges.delete(challengeId);
    return this.issue(challenge.personId!);
  }

  issue(personId: string): { token: string; session: Session } {
    const session: Session = { personId, sessionId: randomUUID(), expiresAt: new Date(this.now() + SESSION_TTL_MS).toISOString() };
    const payload = Buffer.from(JSON.stringify({ sub: personId, sid: session.sessionId, exp: Date.parse(session.expiresAt) })).toString('base64url');
    return { token: `ags1.${payload}.${this.sign(payload)}`, session };
  }

  /** La session d'un jeton, ou rien s'il est faux, expiré ou révoqué. Ne lève jamais. */
  read(token: string): Session | undefined {
    const [version, payload, signature, extra] = token.split('.');
    if (version !== 'ags1' || !payload || !signature || extra !== undefined) return undefined;
    if (!safeEqual(signature, this.sign(payload))) return undefined;
    try {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: unknown; sid?: unknown; exp?: unknown };
      if (typeof claims.sub !== 'string' || typeof claims.sid !== 'string' || typeof claims.exp !== 'number') return undefined;
      if (claims.exp <= this.now() || this.revoked.has(claims.sid)) return undefined;
      return { personId: claims.sub, sessionId: claims.sid, expiresAt: new Date(claims.exp).toISOString() };
    } catch {
      return undefined;
    }
  }

  revoke(session: Session): void {
    this.revoked.set(session.sessionId, Date.parse(session.expiresAt));
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(`session.${payload}`).digest('base64url');
  }

  private hashCode(challengeId: string, code: string): string {
    return createHash('sha256').update(`${this.secret}.${challengeId}.${code}`).digest('hex');
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, challenge] of this.challenges) if (challenge.expiresAt <= now) this.challenges.delete(id);
    for (const [id, until] of this.revoked) if (until <= now) this.revoked.delete(id);
    for (const [key, times] of this.sentAt) if (times.every((at) => now - at >= CODE_WINDOW_MS)) this.sentAt.delete(key);
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
