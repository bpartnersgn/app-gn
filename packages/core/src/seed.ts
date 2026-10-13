import type { SimulatedNetwork } from './connectors.ts';
import type { VirtualCard } from './cards.ts';
import type { AccountTransaction, LinkedAccount, Membership, Person, Space } from './model.ts';
import { CURRENCIES, money, type Currency, type FxTable } from './money.ts';

/** Taux indicatifs fictifs (GNF pour une unité). À remplacer par une source de cours datée. */
export const DEMO_FX: FxTable = {
  USD: 8_650n,
  EUR: 9_400n,
  XOF: 14n,
  USDT: 8_640n,
  BTC: 540_000_000n,
};

export const DEMO_PERSONS: Person[] = [
  { id: 'per_mariama', nin: 'GN-NIN-0000000001', fullName: 'Mariama Camara', phone: '+224 620 00 00 01' },
  { id: 'per_alpha', nin: 'GN-NIN-0000000002', fullName: 'Alpha Diallo', phone: '+224 660 00 00 02' },
  { id: 'per_fatoumata', nin: 'GN-NIN-0000000003', fullName: 'Fatoumata Bah', phone: '+224 621 00 00 03' },
  { id: 'per_ibrahima', nin: 'GN-NIN-0000000004', fullName: 'Ibrahima Sylla', phone: '+224 664 00 00 04' },
  { id: 'per_sekou', nin: 'GN-NIN-0000000005', fullName: 'Sékou Condé', phone: '+224 622 00 00 05' },
  // Le cas le plus courant : une personne qui n'a que son espace personnel.
  { id: 'per_kadiatou', nin: 'GN-NIN-0000000006', fullName: 'Kadiatou Sow', phone: '+224 625 00 00 06' },
];

export const DEMO_SPACES: Space[] = [
  { id: 'spc_cit_mariama', kind: 'citizen', name: 'Mariama Camara', ownerPersonId: 'per_mariama' },
  { id: 'spc_cit_alpha', kind: 'citizen', name: 'Alpha Diallo', ownerPersonId: 'per_alpha' },
  { id: 'spc_cit_fatoumata', kind: 'citizen', name: 'Fatoumata Bah', ownerPersonId: 'per_fatoumata' },
  { id: 'spc_cit_ibrahima', kind: 'citizen', name: 'Ibrahima Sylla', ownerPersonId: 'per_ibrahima' },
  { id: 'spc_cit_sekou', kind: 'citizen', name: 'Sékou Condé', ownerPersonId: 'per_sekou' },
  { id: 'spc_cit_kadiatou', kind: 'citizen', name: 'Kadiatou Sow', ownerPersonId: 'per_kadiatou' },
  { id: 'spc_biz_couture', kind: 'business', name: 'Couture Mariama', legalForm: 'SARLU', rccm: 'GN.TCC.2025.A.00001', nif: '000000001' },
  { id: 'spc_biz_boke', kind: 'business', name: 'Boké Logistique', legalForm: 'SA', rccm: 'GN.TCC.2019.B.00002', nif: '000000002' },
  { id: 'spc_adm_kaloum', kind: 'administration', name: 'Commune de Kaloum', entityType: 'collectivite' },
];

export const DEMO_MEMBERSHIPS: Membership[] = [
  { personId: 'per_mariama', spaceId: 'spc_cit_mariama', role: 'citizen' },
  { personId: 'per_mariama', spaceId: 'spc_biz_couture', role: 'business_owner' },
  { personId: 'per_alpha', spaceId: 'spc_cit_alpha', role: 'citizen' },
  { personId: 'per_alpha', spaceId: 'spc_biz_boke', role: 'business_finance' },
  { personId: 'per_sekou', spaceId: 'spc_cit_sekou', role: 'citizen' },
  { personId: 'per_sekou', spaceId: 'spc_biz_boke', role: 'business_owner' },
  { personId: 'per_fatoumata', spaceId: 'spc_cit_fatoumata', role: 'citizen' },
  { personId: 'per_fatoumata', spaceId: 'spc_adm_kaloum', role: 'admin_authorizing_officer' },
  { personId: 'per_ibrahima', spaceId: 'spc_cit_ibrahima', role: 'citizen' },
  { personId: 'per_ibrahima', spaceId: 'spc_adm_kaloum', role: 'admin_public_accountant' },
  { personId: 'per_kadiatou', spaceId: 'spc_cit_kadiatou', role: 'citizen' },
];

interface AccountSeed {
  id: string;
  spaceId: string;
  providerId: string;
  label: string;
  currency: Currency;
  masked: string;
  /** Solde visé, en unités majeures ; l'historique généré y aboutit exactement. */
  balance: number;
  /** Ordre de grandeur des mouvements, en unités majeures. */
  movement: number;
  counterparties: string[];
}

const ACCOUNT_SEEDS: AccountSeed[] = [
  // Mariama, citoyenne
  { id: 'acc_mc_om', spaceId: 'spc_cit_mariama', providerId: 'orange_money', label: 'Orange Money', currency: 'GNF', masked: '•••• 00 01', balance: 1_845_000, movement: 150_000, counterparties: ['Boutique Madina', 'EDG', 'Fanta Camara', 'Marché Niger'] },
  { id: 'acc_mc_mtn', spaceId: 'spc_cit_mariama', providerId: 'mtn_momo', label: 'MTN MoMo', currency: 'GNF', masked: '•••• 00 11', balance: 420_000, movement: 60_000, counterparties: ['Recharge', 'Moussa Keïta', 'Taxi'] },
  { id: 'acc_mc_eco', spaceId: 'spc_cit_mariama', providerId: 'ecobank', label: 'Compte courant', currency: 'GNF', masked: 'GN•• •••• 4821', balance: 6_300_000, movement: 900_000, counterparties: ['Salaire', 'Loyer', 'Retrait DAB'] },
  { id: 'acc_mc_card', spaceId: 'spc_cit_mariama', providerId: 'appgn_card', label: 'Carte virtuelle', currency: 'USD', masked: '•••• 7310', balance: 85, movement: 15, counterparties: ['Netflix', 'Jumia', 'Google Play'] },
  { id: 'acc_mc_wallet', spaceId: 'spc_cit_mariama', providerId: 'appgn_wallet', label: 'Wallet App GN', currency: 'GNF', masked: 'GN-W-0001', balance: 250_000, movement: 40_000, counterparties: ['Cashback', 'Transfert reçu'] },
  { id: 'acc_mc_usdt', spaceId: 'spc_cit_mariama', providerId: 'crypto_custody', label: 'USDT', currency: 'USDT', masked: 'T…9fA2', balance: 120.5, movement: 30, counterparties: ['Achat USDT', 'Envoi diaspora'] },

  // Alpha, citoyen
  { id: 'acc_ad_om', spaceId: 'spc_cit_alpha', providerId: 'orange_money', label: 'Orange Money', currency: 'GNF', masked: '•••• 00 02', balance: 980_000, movement: 120_000, counterparties: ['Pharmacie', 'SEG', 'Recharge'] },
  { id: 'acc_ad_uba', spaceId: 'spc_cit_alpha', providerId: 'uba', label: 'Compte épargne', currency: 'GNF', masked: 'GN•• •••• 1093', balance: 14_500_000, movement: 1_500_000, counterparties: ['Virement salaire', 'Épargne'] },

  // Kadiatou, citoyenne sans entreprise
  { id: 'acc_ks_om', spaceId: 'spc_cit_kadiatou', providerId: 'orange_money', label: 'Orange Money', currency: 'GNF', masked: '•••• 00 06', balance: 615_000, movement: 80_000, counterparties: ['Marché Madina', 'Recharge', 'Aminata Sow'] },
  { id: 'acc_ks_mtn', spaceId: 'spc_cit_kadiatou', providerId: 'mtn_momo', label: 'MTN MoMo', currency: 'GNF', masked: '•••• 00 16', balance: 190_000, movement: 30_000, counterparties: ['Taxi', 'Pharmacie'] },

  // Couture Mariama (micro-entreprise)
  { id: 'acc_cm_om', spaceId: 'spc_biz_couture', providerId: 'orange_money', label: 'Orange Money Pro', currency: 'GNF', masked: '•••• 10 01', balance: 3_200_000, movement: 250_000, counterparties: ['Cliente Aïssatou', 'Tissus Madina', 'Cliente Kadiatou'] },
  { id: 'acc_cm_wallet', spaceId: 'spc_biz_couture', providerId: 'appgn_wallet', label: 'Wallet App GN Pro', currency: 'GNF', masked: 'GN-W-1001', balance: 780_000, movement: 90_000, counterparties: ['Encaissement QR'] },

  // Boké Logistique (ETI)
  { id: 'acc_bl_eco', spaceId: 'spc_biz_boke', providerId: 'ecobank', label: 'Ecobank — exploitation', currency: 'GNF', masked: 'GN•• •••• 7702', balance: 845_000_000, movement: 40_000_000, counterparties: ['Client CBG', 'Carburant Total', 'Salaires', 'Client SMB'] },
  { id: 'acc_bl_eco_usd', spaceId: 'spc_biz_boke', providerId: 'ecobank', label: 'Ecobank — devises', currency: 'USD', masked: 'GN•• •••• 7703', balance: 182_400, movement: 12_000, counterparties: ['Client export', 'Pièces détachées'] },
  { id: 'acc_bl_uba', spaceId: 'spc_biz_boke', providerId: 'uba', label: 'UBA — investissement', currency: 'GNF', masked: 'GN•• •••• 5510', balance: 312_000_000, movement: 25_000_000, counterparties: ['Crédit-bail', 'Assurance'] },
  { id: 'acc_bl_om', spaceId: 'spc_biz_boke', providerId: 'orange_money', label: 'Orange Money Business', currency: 'GNF', masked: '•••• 20 01', balance: 46_800_000, movement: 3_000_000, counterparties: ['Chauffeurs', 'Péage', 'Client détail'] },
  { id: 'acc_bl_mtn', spaceId: 'spc_biz_boke', providerId: 'mtn_momo', label: 'MTN MoMo Business', currency: 'GNF', masked: '•••• 20 02', balance: 18_250_000, movement: 1_500_000, counterparties: ['Chauffeurs', 'Mécanicien'] },
  { id: 'acc_bl_cellcom', spaceId: 'spc_biz_boke', providerId: 'cellcom_money', label: 'Cellcom Money', currency: 'GNF', masked: '•••• 20 03', balance: 4_100_000, movement: 400_000, counterparties: ['Agents terrain'] },

  // Commune de Kaloum
  { id: 'acc_kal_tresor', spaceId: 'spc_adm_kaloum', providerId: 'tresor_public', label: 'Compte au Trésor', currency: 'GNF', masked: 'TP-KAL-001', balance: 2_450_000_000, movement: 120_000_000, counterparties: ['Dotation État', 'Taxes marchés', 'Mandat fournisseurs'] },
  { id: 'acc_kal_eco', spaceId: 'spc_adm_kaloum', providerId: 'ecobank', label: 'Ecobank — recettes', currency: 'GNF', masked: 'GN•• •••• 3301', balance: 380_000_000, movement: 18_000_000, counterparties: ['Taxe de stationnement', 'Location salles'] },
  { id: 'acc_kal_om', spaceId: 'spc_adm_kaloum', providerId: 'orange_money', label: 'Orange Money — encaissements', currency: 'GNF', masked: '•••• 30 01', balance: 27_600_000, movement: 2_000_000, counterparties: ['Taxe marché Niger', 'Actes d’état civil'] },
];

export interface DemoData {
  persons: Person[];
  spaces: Space[];
  memberships: Membership[];
  accounts: LinkedAccount[];
  cards: VirtualCard[];
}

/** Charge les données fictives dans le réseau simulé ; l'historique couvre les 30 jours précédant `now`. */
export function seedDemo(network: SimulatedNetwork, now: Date): DemoData {
  const accounts: LinkedAccount[] = [];
  for (const seed of ACCOUNT_SEEDS) {
    const account: LinkedAccount = {
      id: seed.id,
      spaceId: seed.spaceId,
      providerId: seed.providerId,
      label: seed.label,
      currency: seed.currency,
      maskedIdentifier: seed.masked,
      linkedAt: new Date(now.getTime() - 90 * DAY).toISOString(),
    };
    network.open(account, history(seed, now));
    accounts.push(account);
  }
  return {
    persons: structuredClone(DEMO_PERSONS),
    spaces: structuredClone(DEMO_SPACES),
    memberships: structuredClone(DEMO_MEMBERSHIPS),
    accounts,
    cards: [
      { accountId: 'acc_mc_card', spaceId: 'spc_cit_mariama', network: 'visa', tier: 'standard', status: 'active', last4: '7310', expiry: '08/28', holderName: 'Mariama Camara' },
    ],
  };
}

const DAY = 24 * 60 * 60 * 1000;

function history(seed: AccountSeed, now: Date): Omit<AccountTransaction, 'id' | 'accountId'>[] {
  const random = prng(seed.id);
  const scale = 10 ** CURRENCIES[seed.currency].decimals;
  const toMinor = (major: number) => BigInt(Math.round(major * scale));
  const entries: Omit<AccountTransaction, 'id' | 'accountId'>[] = [];
  let running = 0n;
  const count = 8 + Math.floor(random() * 6);
  for (let index = 0; index < count; index += 1) {
    const occurredAt = new Date(now.getTime() - (count - index) * 2.5 * DAY + Math.floor(random() * DAY / 2)).toISOString();
    const amount = toMinor(Math.max(1, Math.round(seed.movement * (0.3 + random() * 1.2))));
    const credit = random() < 0.5;
    const counterparty = seed.counterparties[Math.floor(random() * seed.counterparties.length)] ?? 'Divers';
    running += credit ? amount : -amount;
    entries.push({ occurredAt, direction: credit ? 'credit' : 'debit', amount: money(amount, seed.currency), label: credit ? `Reçu — ${counterparty}` : `Paiement — ${counterparty}`, counterparty });
  }
  // Solde d'ouverture daté avant tout mouvement, calculé pour que le solde final soit exactement celui visé.
  const opening = toMinor(seed.balance) - running;
  entries.unshift({
    occurredAt: new Date(now.getTime() - 40 * DAY).toISOString(),
    direction: opening >= 0n ? 'credit' : 'debit',
    amount: money(opening >= 0n ? opening : -opening, seed.currency),
    label: 'Solde reporté',
  });
  return entries;
}

function prng(key: string): () => number {
  let state = 2166136261;
  for (const char of key) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Numéros complets (fictifs) des wallets Mobile Money de la démo. L'application n'en montre que la forme
 * masquée ; seul le serveur les lit, pour les remettre à l'orchestrateur qui pousse le débit sur le téléphone.
 */
export const DEMO_WALLET_NUMBERS: Readonly<Record<string, string>> = {
  acc_mc_om: '+224620000001',
  acc_mc_mtn: '+224660000011',
  acc_ad_om: '+224620000002',
  acc_cm_om: '+224620001001',
  acc_bl_om: '+224620002001',
  acc_bl_mtn: '+224660002002',
  acc_kal_om: '+224620003001',
  acc_ks_om: '+224620000006',
};
