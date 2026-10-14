import type { Actor } from './channels.ts';
import { AppError } from './errors.ts';
import type { Person } from './model.ts';
import { toBigInt, type Money } from './money.ts';
import { BUSINESS_APPROVAL_THRESHOLD } from './payments.ts';

/**
 * Confirmation forte : au-delà du seuil d'entreprise (5 M GNF), la personne qui fait partir l'argent (le dirigeant
 * qui paie lui-même, ou qui approuve) confirme par un code à usage unique envoyé par SMS sur son numéro.
 * Le code est lié à l'opération exacte : il ne vaut que pour ce paiement, ce lot, cette déclaration.
 *
 * Le noyau décide quand c'est exigé et ce que l'opération est ; le `Confirmer` envoie et vérifie le code
 * (côté serveur : SMS et défis en base, `apps/api/src/auth.ts` ; en démonstration : code montré à l'écran).
 */
export interface Operation {
  /** Identité exacte de l'opération (espace, nature, cible, contenu). Deux opérations différentes n'ont jamais la même. */
  key: string;
  /** Ce que le SMS annonce : « le paiement de 28 000 000 GNF à … ». */
  summary: string;
}

/** Ce que l'appelant renvoie avec sa demande, après avoir reçu le code. */
export interface ConfirmationProof {
  challengeId: string;
  code: string;
}

export interface ConfirmationChallenge {
  challengeId: string;
  expiresAt: string;
  /** Numéro masqué où le code est parti. */
  sentTo: string;
  /** Démonstration seulement : aucun SMS ne part, le code est rendu ici. */
  demoCode?: string;
}

export interface Confirmer {
  /** Envoie un code au numéro de la personne pour cette opération. */
  challenge(person: Person, operation: Operation): Promise<ConfirmationChallenge>;
  /** Vrai si la preuve porte un code juste, frais, émis pour cette personne et cette opération ; il est alors consommé. */
  verify(person: Person, operation: Operation, proof: ConfirmationProof): Promise<boolean>;
}

/** Le montant appelle-t-il une confirmation forte ? En devises, toujours (pas de seuil converti). */
export function needsStrongConfirmation(amount: Money): boolean {
  if (amount.currency !== BUSINESS_APPROVAL_THRESHOLD.currency) return true;
  return toBigInt(amount) >= toBigInt(BUSINESS_APPROVAL_THRESHOLD);
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return `•• •• ${digits.slice(-2)}`;
}

/** Démonstration et tests : le code est rendu dans la réponse au lieu d'être envoyé. */
export class DemoConfirmer implements Confirmer {
  private readonly pending = new Map<string, { personId: string; key: string; code: string; expiresAt: number }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async challenge(person: Person, operation: Operation): Promise<ConfirmationChallenge> {
    const challengeId = globalThis.crypto.randomUUID();
    const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
    const expiresAt = this.now() + 5 * 60_000;
    this.pending.set(challengeId, { personId: person.id, key: operation.key, code, expiresAt });
    return { challengeId, expiresAt: new Date(expiresAt).toISOString(), sentTo: maskPhone(person.phone), demoCode: code };
  }

  async verify(person: Person, operation: Operation, proof: ConfirmationProof): Promise<boolean> {
    const pending = this.pending.get(proof.challengeId);
    if (!pending) return false;
    // Une seule tentative par code : juste ou faux, il est consommé.
    this.pending.delete(proof.challengeId);
    return pending.personId === person.id && pending.key === operation.key && pending.expiresAt > this.now() && pending.code === proof.code.trim();
  }
}

/**
 * Démonstration et tests : fait l'opération ; si une confirmation est demandée et que le code est rendu (démo),
 * la refait avec ce code, comme le ferait la personne. Sans code rendu (SMS réel), l'erreur remonte.
 */
export async function withDemoConfirmation<T>(actor: Actor, run: (actor: Actor) => Promise<T>): Promise<T> {
  try {
    return await run(actor);
  } catch (error) {
    const challenge = error instanceof AppError && error.code === 'confirmation_required' ? error.details?.confirmation as ConfirmationChallenge | undefined : undefined;
    if (!challenge?.demoCode) throw error;
    return run({ ...actor, confirmation: { challengeId: challenge.challengeId, code: challenge.demoCode } });
  }
}
