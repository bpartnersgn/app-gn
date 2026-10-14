import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Protections HTTP communes à toutes les routes (DAT §5.5) : en-têtes, origines admises, limitation de débit.
 * Rien ici ne décide d'un droit : l'autorisation reste dans le noyau.
 */
export interface SecurityOptions {
  /** Origines du web autorisées à appeler l'API depuis un navigateur. Vide : aucune en-tête CORS, aucun contrôle d'origine (développement). */
  allowedOrigins?: readonly string[];
  /** `Strict-Transport-Security` : seulement derrière TLS (préproduction, production). */
  hsts?: boolean;
  rateLimit?: RateLimitOptions;
}

export interface RateLimitOptions {
  store: RateLimitStore;
  /** Requêtes par minute et par adresse IP, toutes routes. */
  perIp: number;
  /** Requêtes par minute et par session (jeton présenté). */
  perSession: number;
  /** Écritures (POST, PUT, PATCH, DELETE) par minute et par session, ou par IP sans session. */
  writes: number;
  now?: () => number;
}

/** Compteurs par fenêtre d'une minute. Partagé entre instances quand il vit en base. */
export interface RateLimitStore {
  /** Compte une requête pour chaque clé dans la fenêtre donnée et rend le total de chacune, dans l'ordre. */
  hit(keys: readonly string[], window: number): Promise<number[]>;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly counts = new Map<string, { window: number; count: number }>();
  async hit(keys: readonly string[], window: number): Promise<number[]> {
    if (this.counts.size > 50_000) for (const [key, entry] of this.counts) if (entry.window < window) this.counts.delete(key);
    return keys.map((key) => {
      const entry = this.counts.get(key);
      const next = entry && entry.window === window ? { window, count: entry.count + 1 } : { window, count: 1 };
      this.counts.set(key, next);
      return next.count;
    });
  }
}

const ALLOWED_HEADERS = 'authorization, content-type, idempotency-key, appgn-channel';
const ALLOWED_METHODS = 'GET, POST, DELETE';
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Routes que la limitation ne compte pas : sonde de l'hébergeur, webhooks signés d'ORCHEA. */
const UNLIMITED = new Set(['/health', '/v1/webhooks/orchea']);

export function registerSecurity(server: FastifyInstance, options: SecurityOptions): void {
  const origins = new Set(options.allowedOrigins ?? []);
  const checkOrigin = origins.size > 0;

  server.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    // L'API ne rend que du JSON : aucun contenu actif, jamais dans un cadre.
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    reply.header('cache-control', 'no-store');
    if (options.hsts) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');

    const origin = request.headers.origin;
    if (checkOrigin && typeof origin === 'string') {
      if (!origins.has(origin)) {
        // Le jeton n'est pas un cookie, donc rien ne part tout seul ; on refuse quand même une origine inconnue.
        request.log.warn({ origin, method: request.method }, 'origine refusée');
        return reply.status(403).send({ error: 'forbidden', message: 'origine non autorisée' });
      }
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'Origin');
      if (request.method === 'OPTIONS') {
        reply.header('access-control-allow-methods', ALLOWED_METHODS);
        reply.header('access-control-allow-headers', ALLOWED_HEADERS);
        reply.header('access-control-max-age', '600');
        return reply.status(204).send();
      }
    }

    const limit = options.rateLimit;
    const path = request.url.split('?')[0] ?? '';
    if (!limit || UNLIMITED.has(path) || request.method === 'OPTIONS') return;
    const now = (limit.now ?? Date.now)();
    const window = Math.floor(now / 60_000);
    const bearer = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
    // Le jeton n'est jamais gardé tel quel : seule son empreinte sert de clé.
    const session = bearer ? `s:${createHash('sha256').update(bearer).digest('base64url').slice(0, 22)}` : undefined;
    const checks: { key: string; max: number }[] = [{ key: `ip:${request.ip}`, max: limit.perIp }];
    if (session) checks.push({ key: session, max: limit.perSession });
    if (WRITES.has(request.method)) checks.push({ key: `w:${session ?? `ip:${request.ip}`}`, max: limit.writes });
    const counts = await limit.store.hit(checks.map((check) => check.key), window);
    const exceeded = checks.find((check, index) => (counts[index] ?? 0) > check.max);
    if (exceeded) {
      const retryAfter = Math.max(1, Math.ceil(((window + 1) * 60_000 - now) / 1000));
      request.log.warn({ bucket: exceeded.key.split(':')[0], method: request.method, path }, 'débit dépassé');
      return reply.status(429).header('retry-after', String(retryAfter)).send({ error: 'rate_limited', message: 'trop de requêtes : réessayez dans un instant' });
    }
  });
}

/** Réglages de sécurité lus dans l'environnement (voir DAT §8). */
export function securityFromEnvironment(environment: Readonly<Record<string, string | undefined>>, store: RateLimitStore): SecurityOptions {
  const number = (name: string, fallback: number) => {
    const value = environment[name]?.trim();
    if (!value) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} : un entier positif`);
    return parsed;
  };
  const origins = (environment.APPGN_ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);
  for (const origin of origins) {
    if (!/^https?:\/\/[^/\s]+$/.test(origin)) throw new Error(`APPGN_ALLOWED_ORIGINS : « ${origin} » n'est pas une origine (schéma://hôte[:port], sans chemin)`);
  }
  return {
    allowedOrigins: origins,
    hsts: environment.APPGN_HSTS === 'on' || environment.APPGN_ENV === 'production',
    rateLimit: {
      store,
      perIp: number('APPGN_RATE_PER_IP', 600),
      perSession: number('APPGN_RATE_PER_SESSION', 300),
      writes: number('APPGN_RATE_WRITES', 60),
    },
  };
}

/**
 * En production (`APPGN_ENV=production`), l'API refuse de démarrer tant qu'un réglage la laisserait ouverte
 * ou perdrait des données. Rend la liste des manques, vide si tout va bien.
 */
export function productionProblems(environment: Readonly<Record<string, string | undefined>>): string[] {
  if (environment.APPGN_ENV !== 'production') return [];
  const problems: string[] = [];
  if (environment.APPGN_DEMO_LOGIN !== 'off') problems.push('APPGN_DEMO_LOGIN=off est exigé (sinon le code SMS est rendu et « demo:… » ouvre une session)');
  if (!environment.APPGN_SESSION_SECRET?.trim()) problems.push('APPGN_SESSION_SECRET est exigée (sinon les sessions ne survivent pas à un redémarrage et diffèrent d\'une instance à l\'autre)');
  if (!environment.DATABASE_URL?.trim()) problems.push('DATABASE_URL est exigée (PGlite et la mémoire ne servent qu\'aux postes de travail)');
  if (!environment.APPGN_ALLOWED_ORIGINS?.trim()) problems.push('APPGN_ALLOWED_ORIGINS est exigée (origine du web)');
  if (!environment.APPGN_SMS_PROVIDER?.trim()) problems.push('APPGN_SMS_PROVIDER est exigé (sans fournisseur, aucun code de connexion ne part)');
  return problems;
}

/**
 * `APPGN_TRUST_PROXY` : adresses ou plages (CIDR) des relais de confiance devant l'API (répartiteur, terminaison TLS),
 * séparées par des virgules, ou `true` pour tout relais. Absent : aucun, l'adresse du client est celle de la connexion.
 */
export function trustProxyFromEnvironment(value: string | undefined): boolean | string[] {
  const text = value?.trim();
  if (!text) return false;
  if (text === 'true') return true;
  const entries = text.split(',').map((entry) => entry.trim()).filter(Boolean);
  for (const entry of entries) {
    if (!/^[\da-f.:]+(\/\d{1,3})?$/i.test(entry)) throw new Error(`APPGN_TRUST_PROXY : « ${entry} » n'est ni une adresse ni une plage CIDR`);
  }
  return entries;
}
