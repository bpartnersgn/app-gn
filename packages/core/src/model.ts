import type { Currency, Money } from './money.ts';

/**
 * Une personne a une seule identité (NIN). Elle agit dans un ou plusieurs espaces :
 * son espace citoyen, et ceux des entreprises ou administrations dont elle est membre.
 */
export interface Person {
  id: string;
  nin: string;
  fullName: string;
  phone: string;
  /**
   * `declared` : inscrite par elle-même, numéro prouvé par code SMS, NIN déclaré (pas encore rapproché de
   * l'état civil). `verified` : identité rapprochée. Absent : donnée de démonstration, tenue pour vérifiée.
   */
  identity?: 'declared' | 'verified';
  registeredAt?: string;
}

export type SpaceKind = 'citizen' | 'business' | 'administration';

export interface CitizenSpace {
  id: string;
  kind: 'citizen';
  name: string;
  ownerPersonId: string;
}

export interface BusinessSpace {
  id: string;
  kind: 'business';
  name: string;
  legalForm: string;
  rccm: string;
  nif: string;
}

export interface AdministrationSpace {
  id: string;
  kind: 'administration';
  name: string;
  entityType: 'collectivite' | 'epa' | 'agence' | 'entreprise_publique';
}

export type Space = CitizenSpace | BusinessSpace | AdministrationSpace;

export type Role =
  | 'citizen'
  | 'business_owner'
  | 'business_finance'
  | 'business_accountant'
  | 'business_hr'
  | 'admin_authorizing_officer'
  | 'admin_public_accountant'
  | 'admin_viewer';

export interface Membership {
  personId: string;
  spaceId: string;
  role: Role;
}

export type AccountKind = 'bank' | 'mobile_money' | 'virtual_card' | 'crypto' | 'app_wallet';

export interface ProviderInfo {
  id: string;
  name: string;
  kind: AccountKind;
  currencies: Currency[];
  /** Le fournisseur sait-il débiter ce compte pour un paiement initié depuis App GN ? */
  canDebit: boolean;
}

export interface LinkedAccount {
  id: string;
  spaceId: string;
  providerId: string;
  label: string;
  currency: Currency;
  /** Identifiant masqué montré à l'utilisateur (jamais le numéro complet). */
  maskedIdentifier: string;
  linkedAt: string;
}

export interface AccountTransaction {
  id: string;
  accountId: string;
  occurredAt: string;
  direction: 'credit' | 'debit';
  amount: Money;
  label: string;
  counterparty?: string;
}
