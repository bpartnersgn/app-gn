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
  { id: 'citizen.cards', spaceKind: 'citizen', title: 'Cartes virtuelles', description: 'Visa ou Mastercard, rechargées depuis le Mobile Money ou la crypto, bloquables en un geste.', permission: 'cards:manage', status: 'available', module: 'cards' },
  { id: 'citizen.exchange', spaceKind: 'citizen', title: 'Convertir', description: 'Crypto vers Mobile Money, Mobile Money vers carte, frais affichés avant de confirmer.', permission: 'payments:initiate', status: 'available', module: 'cards' },
  { id: 'citizen.link', spaceKind: 'citizen', title: 'Rattacher un compte', description: 'Ajouter une banque, un wallet ou un portefeuille crypto.', permission: 'accounts:link', status: 'planned', module: 'aggregation' },
  { id: 'citizen.documents', spaceKind: 'citizen', title: 'Mes documents', description: 'Identité, permis, carte grise, assurances, abonnements : présentables sans réseau.', permission: 'documents:read', status: 'available', module: 'documents' },
  { id: 'citizen.go-pro', spaceKind: 'citizen', title: 'Créer mon espace professionnel', description: 'Passer en GAPP avec votre RCCM et votre NIF.', permission: 'accounts:link', status: 'planned', module: 'onboarding' },

  // Entreprise (GAPP)
  { id: 'business.treasury', spaceKind: 'business', title: 'Trésorerie consolidée', description: 'Soldes bancaires et Mobile Money en temps réel, en un seul cockpit.', permission: 'accounts:read', status: 'available', module: 'aggregation' },
  { id: 'business.supplier-payment', spaceKind: 'business', title: 'Payer les fournisseurs', description: 'Lots de 50 factures au plus, routés au compte le moins cher, approbation du dirigeant au-delà du seuil.', permission: 'payments:initiate', status: 'available', module: 'payments' },
  { id: 'business.documents', spaceKind: 'business', title: 'Documents de l\u2019entreprise', description: 'RCCM, attestation fiscale, assurances, avec alerte avant expiration.', permission: 'documents:read', status: 'available', module: 'documents' },
  { id: 'business.invoicing', spaceKind: 'business', title: 'Facturation', description: 'Factures numérotées sans trou et scellées, relances, rapprochement des encaissements.', permission: 'invoices:write', status: 'available', module: 'invoicing' },
  { id: 'business.vat', spaceKind: 'business', title: 'TVA', description: 'Déclaration pré-remplie et paiement DGI en un clic.', permission: 'tax:declare', status: 'available', module: 'tax' },
  { id: 'business.payroll', spaceKind: 'business', title: 'Paie', description: 'Registre, attestations de travail remises au coffre du salarié, paie approuvée par le dirigeant.', permission: 'payroll:submit', status: 'available', module: 'payroll' },
  { id: 'business.score', spaceKind: 'business', title: 'Score B2B', description: 'Score indicatif sur cinq critères : encaissements, fournisseurs, TVA, trésorerie, dossier légal.', permission: 'reports:read', status: 'available', module: 'scoring' },

  // Administration (GAPP Institutionnel)
  { id: 'administration.treasury', spaceKind: 'administration', title: 'Situation des comptes', description: 'Comptes au Trésor, bancaires et Mobile Money de l’entité.', permission: 'accounts:read', status: 'available', module: 'aggregation' },
  { id: 'administration.mandate', spaceKind: 'administration', title: 'Engager et mandater', description: 'Engagement plafonné au crédit, service fait, mandat.', permission: 'payments:initiate', status: 'available', module: 'payments' },
  { id: 'administration.approve', spaceKind: 'administration', title: 'Viser et payer', description: 'Contrôle et paiement des mandats par le comptable public.', permission: 'payments:approve', status: 'available', module: 'payments' },
  { id: 'administration.documents', spaceKind: 'administration', title: 'Documents de l\u2019entité', description: 'Conventions, arrêtés et attestations de l\u2019entité.', permission: 'documents:read', status: 'available', module: 'documents' },
  { id: 'administration.payroll', spaceKind: 'administration', title: 'Paie des agents', description: 'Fichier de paie signé, vérifié ligne à ligne.', permission: 'payroll:submit', status: 'available', module: 'payroll' },
  { id: 'administration.budget', spaceKind: 'administration', title: 'Exécution budgétaire', description: 'Voté, engagé, liquidé, mandaté, payé, ligne par ligne.', permission: 'budget:read', status: 'available', module: 'budget' },
  { id: 'administration.reporting', spaceKind: 'administration', title: 'Reporting Cour des Comptes', description: 'États produits depuis la piste d’audit.', permission: 'reports:read', status: 'available', module: 'reporting' },
];

export function servicesFor(spaceKind: SpaceKind, role: Role): ServiceDefinition[] {
  return SERVICES.filter((service) => service.spaceKind === spaceKind && can(role, service.permission));
}
