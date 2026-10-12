import type { ProviderInfo } from './model.ts';

/**
 * Fournisseurs que la couche d'agrégation sait représenter. Aucun n'est branché en réel :
 * chacun est servi par un connecteur simulé (connectors.ts) en attendant les accords et les API.
 */
export const PROVIDERS: readonly ProviderInfo[] = [
  { id: 'orange_money', name: 'Orange Money', kind: 'mobile_money', currencies: ['GNF'], canDebit: true },
  { id: 'mtn_momo', name: 'MTN Mobile Money', kind: 'mobile_money', currencies: ['GNF'], canDebit: true },
  { id: 'cellcom_money', name: 'Cellcom Money', kind: 'mobile_money', currencies: ['GNF'], canDebit: true },
  { id: 'moov_money', name: 'Moov Money', kind: 'mobile_money', currencies: ['GNF'], canDebit: true },
  { id: 'ecobank', name: 'Ecobank Guinée', kind: 'bank', currencies: ['GNF', 'USD', 'EUR'], canDebit: true },
  { id: 'uba', name: 'UBA Guinée', kind: 'bank', currencies: ['GNF', 'USD'], canDebit: true },
  { id: 'tresor_public', name: 'Trésor public', kind: 'bank', currencies: ['GNF'], canDebit: true },
  { id: 'appgn_card', name: 'Carte virtuelle App GN', kind: 'virtual_card', currencies: ['GNF', 'USD'], canDebit: true },
  { id: 'appgn_wallet', name: 'Wallet App GN', kind: 'app_wallet', currencies: ['GNF'], canDebit: true },
  { id: 'crypto_custody', name: 'Portefeuille crypto', kind: 'crypto', currencies: ['USDT', 'BTC'], canDebit: false },
];

export const ACCOUNT_KIND_LABELS = {
  bank: 'Comptes bancaires',
  mobile_money: 'Mobile Money',
  virtual_card: 'Cartes virtuelles',
  crypto: 'Crypto',
  app_wallet: 'Wallet App GN',
} as const;

export function providerById(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}
