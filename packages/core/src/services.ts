import type { Role, SpaceKind } from './model.ts';
import { can, type Permission } from './rbac.ts';

export type ServiceStatus = 'available' | 'planned';

export interface ServiceDefinition {
  id: string;
  spaceKind: SpaceKind;
  title: string;
  description: string;
  permission: Permission;
  status: ServiceStatus;
  /** Module du produit qui portera le service (voir docs/architecture.md). */
  module: string;
}

/**
 * Catalogue des services par espace. « available » = branché dans ce socle ; « planned » = visible
 * pour donner la forme du produit, sans logique derrière.
 */
export const SERVICES: readonly ServiceDefinition[] = [
  // Citoyen
  { id: 'citizen.overview', spaceKind: 'citizen', title: 'Mes comptes', description: 'Vue consolidée de tous vos comptes et wallets.', permission: 'accounts:read', status: 'available', module: 'aggregation' },
  { id: 'citizen.transfer', spaceKind: 'citizen', title: 'Envoyer de l’argent', description: 'Transfert vers un numéro Mobile Money ou entre vos comptes.', permission: 'payments:initiate', status: 'available', module: 'payments' },
  { id: 'citizen.bills', spaceKind: 'citizen', title: 'Payer une facture', description: 'Électricité (EDG), eau (SEG), abonnements, frais scolaires.', permission: 'payments:initiate', status: 'available', module: 'payments' },
  { id: 'citizen.link', spaceKind: 'citizen', title: 'Rattacher un compte', description: 'Ajouter une banque, un wallet ou un portefeuille crypto.', permission: 'accounts:link', status: 'planned', module: 'aggregation' },
  { id: 'citizen.documents', spaceKind: 'citizen', title: 'Mes documents', description: 'Attestations et justificatifs reçus, signés numériquement.', permission: 'accounts:read', status: 'planned', module: 'documents' },
  { id: 'citizen.go-pro', spaceKind: 'citizen', title: 'Créer mon espace professionnel', description: 'Passer en GAPP avec votre RCCM et votre NIF.', permission: 'accounts:link', status: 'planned', module: 'onboarding' },

  // Entreprise (GAPP)
  { id: 'business.treasury', spaceKind: 'business', title: 'Trésorerie consolidée', description: 'Soldes bancaires et Mobile Money en temps réel, en un seul cockpit.', permission: 'accounts:read', status: 'available', module: 'aggregation' },
  { id: 'business.supplier-payment', spaceKind: 'business', title: 'Payer un fournisseur', description: 'Paiement routé au rail le moins cher, approbation du dirigeant au-delà du seuil.', permission: 'payments:initiate', status: 'available', module: 'payments' },
  { id: 'business.invoicing', spaceKind: 'business', title: 'Facturation', description: 'Factures signées numériquement, envoi SMS et email.', permission: 'invoices:write', status: 'planned', module: 'invoicing' },
  { id: 'business.vat', spaceKind: 'business', title: 'TVA', description: 'Déclaration pré-remplie et paiement DGI en un clic.', permission: 'tax:declare', status: 'planned', module: 'tax' },
  { id: 'business.payroll', spaceKind: 'business', title: 'Paie', description: 'Salaires versés sur le rail préféré de chaque employé.', permission: 'payroll:submit', status: 'planned', module: 'payroll' },
  { id: 'business.score', spaceKind: 'business', title: 'Score B2B', description: 'Votre crédibilité financière, partageable avec une banque.', permission: 'reports:read', status: 'planned', module: 'scoring' },

  // Administration (GAPP Institutionnel)
  { id: 'administration.treasury', spaceKind: 'administration', title: 'Situation des comptes', description: 'Comptes au Trésor, bancaires et Mobile Money de l’entité.', permission: 'accounts:read', status: 'available', module: 'aggregation' },
  { id: 'administration.mandate', spaceKind: 'administration', title: 'Mandater un paiement', description: 'L’ordonnateur engage, le comptable public paie.', permission: 'payments:initiate', status: 'available', module: 'payments' },
  { id: 'administration.approve', spaceKind: 'administration', title: 'Viser et payer', description: 'Contrôle et paiement des mandats par le comptable public.', permission: 'payments:approve', status: 'available', module: 'payments' },
  { id: 'administration.payroll', spaceKind: 'administration', title: 'Paie des agents', description: 'Fichier de paie signé, vérifié ligne à ligne.', permission: 'payroll:submit', status: 'planned', module: 'payroll' },
  { id: 'administration.budget', spaceKind: 'administration', title: 'Exécution budgétaire', description: 'Engagements, liquidations, paiements.', permission: 'budget:read', status: 'planned', module: 'budget' },
  { id: 'administration.reporting', spaceKind: 'administration', title: 'Reporting Cour des Comptes', description: 'États produits depuis la piste d’audit.', permission: 'reports:read', status: 'planned', module: 'reporting' },
];

export function servicesFor(spaceKind: SpaceKind, role: Role): ServiceDefinition[] {
  return SERVICES.filter((service) => service.spaceKind === spaceKind && can(role, service.permission));
}
