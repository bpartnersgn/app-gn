import type { ConfirmationProof } from './confirmation.ts';
import type { SpaceKind } from './model.ts';

/**
 * Format de l'appareil depuis lequel on agit, qu'il s'agisse de l'application installée ou du navigateur.
 * - Citoyen : application mobile ou version web, sur tout appareil.
 * - Entreprise et administration : tableau de bord, sur ordinateur ou tablette uniquement.
 */
export type Channel = 'phone' | 'tablet' | 'desktop';

export const CHANNELS: readonly Channel[] = ['phone', 'tablet', 'desktop'];

export const CHANNEL_LABELS: Record<Channel, string> = {
  phone: 'Téléphone',
  tablet: 'Tablette',
  desktop: 'Ordinateur',
};

export const SPACE_CHANNELS: Record<SpaceKind, readonly Channel[]> = {
  citizen: ['phone', 'tablet', 'desktop'],
  business: ['tablet', 'desktop'],
  administration: ['tablet', 'desktop'],
};

export function isChannel(value: unknown): value is Channel {
  return typeof value === 'string' && (CHANNELS as readonly string[]).includes(value);
}

export function spaceOpensOn(kind: SpaceKind, channel: Channel): boolean {
  return SPACE_CHANNELS[kind].includes(channel);
}

/**
 * Qui agit, depuis quel format d'appareil, et dans quel espace s'est ouverte sa session.
 *
 * `spaceId` sépare les fonds : une session ouverte dans l'espace personnel ne voit rien d'une entreprise ou
 * d'une administration, et l'inverse. Changer d'espace, c'est ouvrir une autre session (nouveau code).
 * Sans `spaceId` (tests, traitements internes), tous les espaces de la personne sont accessibles.
 */
export interface Actor {
  personId: string;
  channel: Channel;
  spaceId?: string;
  /** Le code de confirmation forte joint à cette demande, s'il y en a un (voir confirmation.ts). */
  confirmation?: ConfirmationProof;
}
