import { formatMoney, type Money, type PaymentStatus, type SpaceKind } from '@app-gn/core';

export const fmt = (value: Money) => formatMoney(value).replace(/ /g, ' ');

export const SPACE_KIND_LABELS: Record<SpaceKind, string> = {
  citizen: 'Citoyen',
  business: 'Entreprise · GAPP',
  administration: 'Administration · GAPP Institutionnel',
};

export const SPACE_KIND_SHORT: Record<SpaceKind, string> = {
  citizen: 'Citoyen',
  business: 'Entreprise',
  administration: 'Administration',
};

export const PAYMENT_STATUS: Record<PaymentStatus, { label: string; tone: 'ok' | 'wait' | 'bad' | 'neutral' }> = {
  pending_approval: { label: 'À approuver', tone: 'wait' },
  processing: { label: 'En cours', tone: 'neutral' },
  completed: { label: 'Exécuté', tone: 'ok' },
  failed: { label: 'Échoué', tone: 'bad' },
  rejected: { label: 'Rejeté', tone: 'bad' },
};

export const FAILURE_REASONS: Record<string, string> = {
  insufficient_funds: 'solde insuffisant',
  rail_unavailable: 'fournisseur indisponible',
};

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
}
