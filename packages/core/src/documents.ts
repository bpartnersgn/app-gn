/**
 * Coffre de documents dématérialisés : pièces d'identité, permis, carte grise, assurances, abonnements,
 * cartes de fidélité, attestations d'entreprise. Un document est soit émis par l'organisme (il porte un
 * code de vérification qu'un tiers peut contrôler), soit ajouté par la personne (déclaratif, sans valeur probante).
 * Tous sont gardés sur l'appareil pour être présentés sans réseau.
 */

export type DocumentCategory =
  | 'identity'
  | 'driving'
  | 'vehicle'
  | 'insurance'
  | 'health'
  | 'subscription'
  | 'loyalty'
  | 'employment'
  | 'company';

export const DOCUMENT_CATEGORY_LABELS: Record<DocumentCategory, string> = {
  identity: 'Identité',
  driving: 'Permis',
  vehicle: 'Véhicule',
  insurance: 'Assurance',
  health: 'Santé',
  subscription: 'Abonnement',
  loyalty: 'Carte de fidélité',
  employment: 'Emploi',
  company: 'Entreprise',
};

export interface DocumentField {
  label: string;
  value: string;
}

export interface VaultDocument {
  id: string;
  spaceId: string;
  category: DocumentCategory;
  title: string;
  issuer: string;
  holderName: string;
  /** Numéro masqué ; le numéro complet n'est montré qu'au porteur, sur demande. */
  reference: string;
  issuedAt: string;
  expiresAt?: string;
  source: 'issuer' | 'self';
  /** Présent pour un document émis par l'organisme : ce qu'un contrôleur saisit (ou scanne) pour vérifier. */
  verificationCode?: string;
  fields: DocumentField[];
}

export type DocumentValidity = 'valid' | 'expiring' | 'expired' | 'no_expiry';

export interface DocumentView extends VaultDocument {
  validity: DocumentValidity;
  daysLeft?: number;
}

/** Fenêtre d'alerte avant expiration. */
export const EXPIRY_WARNING_DAYS = 30;

const DAY = 24 * 60 * 60 * 1000;

export function documentView(document: VaultDocument, now: Date): DocumentView {
  if (!document.expiresAt) return { ...document, validity: 'no_expiry' };
  // Un document reste valide jusqu'à la fin de son jour d'expiration.
  const endOfValidity = Date.parse(document.expiresAt.slice(0, 10)) + DAY;
  const daysLeft = Math.ceil((endOfValidity - now.getTime()) / DAY) - 1;
  const validity: DocumentValidity = daysLeft < 0 ? 'expired' : daysLeft <= EXPIRY_WARNING_DAYS ? 'expiring' : 'valid';
  return { ...document, validity, daysLeft };
}

/** Ce qu'un contrôleur voit en vérifiant un code : le strict nécessaire, jamais le contenu complet. */
export interface DocumentVerification {
  title: string;
  issuer: string;
  holderName: string;
  validity: DocumentValidity;
  expiresAt?: string;
}

export function seedDocuments(now: Date): VaultDocument[] {
  const at = (days: number) => new Date(now.getTime() + days * DAY).toISOString().slice(0, 10);
  return [
    // Mariama, citoyenne
    {
      id: 'doc_mc_cni', spaceId: 'spc_cit_mariama', category: 'identity', title: 'Carte nationale d’identité',
      issuer: 'Ministère de la Sécurité (simulé)', holderName: 'Mariama Camara', reference: '•••• •••• 0001',
      issuedAt: at(-900), expiresAt: at(2750), source: 'issuer', verificationCode: 'GN-CNI-7Q4M-2KXA',
      fields: [{ label: 'NIN', value: 'GN-NIN-0000000001' }, { label: 'Né(e) le', value: '14/03/1991' }, { label: 'Lieu', value: 'Conakry' }],
    },
    {
      id: 'doc_mc_permis', spaceId: 'spc_cit_mariama', category: 'driving', title: 'Permis de conduire',
      issuer: 'Ministère des Transports (simulé)', holderName: 'Mariama Camara', reference: 'PC •••• 4410',
      issuedAt: at(-1500), expiresAt: at(1800), source: 'issuer', verificationCode: 'GN-PC-9D2F-H7RT',
      fields: [{ label: 'Catégories', value: 'B' }, { label: 'Délivré à', value: 'Conakry' }],
    },
    {
      id: 'doc_mc_cartegrise', spaceId: 'spc_cit_mariama', category: 'vehicle', title: 'Carte grise',
      issuer: 'Ministère des Transports (simulé)', holderName: 'Mariama Camara', reference: 'RC-•••-AF',
      issuedAt: at(-600), source: 'issuer', verificationCode: 'GN-CG-3LMP-82QZ',
      fields: [{ label: 'Véhicule', value: 'Toyota Corolla, 2016' }, { label: 'Immatriculation', value: 'RC 4417 AF' }],
    },
    {
      id: 'doc_mc_assurance', spaceId: 'spc_cit_mariama', category: 'insurance', title: 'Attestation d’assurance auto',
      issuer: 'Assurance de démonstration', holderName: 'Mariama Camara', reference: 'POL •••• 3381',
      issuedAt: at(-353), expiresAt: at(12), source: 'issuer', verificationCode: 'GN-AS-6VBN-T1KD',
      fields: [{ label: 'Véhicule', value: 'RC 4417 AF' }, { label: 'Garantie', value: 'Responsabilité civile' }],
    },
    {
      id: 'doc_mc_sante', spaceId: 'spc_cit_mariama', category: 'health', title: 'Carte d’assurance maladie',
      issuer: 'Mutuelle de démonstration', holderName: 'Mariama Camara', reference: 'AM •••• 0927',
      issuedAt: at(-200), expiresAt: at(165), source: 'issuer', verificationCode: 'GN-AM-4HJS-PP03',
      fields: [{ label: 'Ayants droit', value: '2' }, { label: 'Taux de prise en charge', value: '80 %' }],
    },
    {
      id: 'doc_mc_canal', spaceId: 'spc_cit_mariama', category: 'subscription', title: 'Abonnement télévision',
      issuer: 'Canal+ Guinée', holderName: 'Mariama Camara', reference: 'Abonné •••• 5521',
      issuedAt: at(-25), expiresAt: at(5), source: 'self',
      fields: [{ label: 'Formule', value: 'Évasion' }, { label: 'Renouvellement', value: 'mensuel' }],
    },
    {
      id: 'doc_mc_fidelite', spaceId: 'spc_cit_mariama', category: 'loyalty', title: 'Carte de fidélité supermarché',
      issuer: 'Supermarché de quartier', holderName: 'Mariama Camara', reference: '•••• 8812',
      issuedAt: at(-400), source: 'self', fields: [{ label: 'Points', value: '1 240' }],
    },
    // Alpha, citoyen
    {
      id: 'doc_ad_permis', spaceId: 'spc_cit_alpha', category: 'driving', title: 'Permis de conduire',
      issuer: 'Ministère des Transports (simulé)', holderName: 'Alpha Diallo', reference: 'PC •••• 1187',
      issuedAt: at(-3700), expiresAt: at(-20), source: 'issuer', verificationCode: 'GN-PC-2WQE-88LM',
      fields: [{ label: 'Catégories', value: 'B, C' }],
    },
    // Boké Logistique
    {
      id: 'doc_bl_rccm', spaceId: 'spc_biz_boke', category: 'company', title: 'Extrait RCCM',
      issuer: 'Registre du commerce (simulé)', holderName: 'Boké Logistique SA', reference: 'GN.TCC.2019.B.00002',
      issuedAt: at(-60), expiresAt: at(30), source: 'issuer', verificationCode: 'GN-RC-5TYU-0OPA',
      fields: [{ label: 'Forme', value: 'SA' }, { label: 'Dirigeant', value: 'Sékou Condé' }],
    },
    {
      id: 'doc_bl_nif', spaceId: 'spc_biz_boke', category: 'company', title: 'Attestation de situation fiscale',
      issuer: 'Direction générale des impôts (simulé)', holderName: 'Boké Logistique SA', reference: 'NIF 000000002',
      issuedAt: at(-40), expiresAt: at(50), source: 'issuer', verificationCode: 'GN-DGI-1ASD-KK29',
      fields: [{ label: 'Régime', value: 'Réel normal' }],
    },
    {
      id: 'doc_bl_flotte', spaceId: 'spc_biz_boke', category: 'insurance', title: 'Assurance flotte (14 véhicules)',
      issuer: 'Assurance de démonstration', holderName: 'Boké Logistique SA', reference: 'FLT •••• 0042',
      issuedAt: at(-300), expiresAt: at(65), source: 'issuer', verificationCode: 'GN-AS-8XCV-LL11',
      fields: [{ label: 'Véhicules', value: '14 camions' }],
    },
    // Commune de Kaloum
    {
      id: 'doc_kal_convention', spaceId: 'spc_adm_kaloum', category: 'company', title: 'Convention de compte au Trésor',
      issuer: 'Trésor public (simulé)', holderName: 'Commune de Kaloum', reference: 'TP-KAL-001',
      issuedAt: at(-700), source: 'issuer', verificationCode: 'GN-TP-3ZXC-MN55',
      fields: [{ label: 'Comptable assignataire', value: 'Ibrahima Sylla' }],
    },
  ];
}
