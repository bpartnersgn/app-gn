// Montants en unités mineures entières, portés comme chaînes (même convention que le `Money` d'ORCHEA) :
// jamais de flottant, jamais d'arrondi implicite. Le franc guinéen n'a pas de décimale.

export const CURRENCIES = {
  GNF: { decimals: 0, label: 'Franc guinéen' },
  XOF: { decimals: 0, label: 'Franc CFA (BCEAO)' },
  USD: { decimals: 2, label: 'Dollar américain' },
  EUR: { decimals: 2, label: 'Euro' },
  USDT: { decimals: 6, label: 'Tether (USDT)' },
  BTC: { decimals: 8, label: 'Bitcoin' },
} as const;

export type Currency = keyof typeof CURRENCIES;

export interface Money {
  amount: string;
  currency: Currency;
}

export const REFERENCE_CURRENCY: Currency = 'GNF';

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && Object.hasOwn(CURRENCIES, value);
}

export function money(amount: bigint | number | string, currency: Currency): Money {
  const value = BigInt(amount);
  return { amount: value.toString(), currency };
}

export function toBigInt(value: Money): bigint {
  return BigInt(value.amount);
}

export function add(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new Error(`devises différentes : ${a.currency} et ${b.currency}`);
  return money(toBigInt(a) + toBigInt(b), a.currency);
}

/** Lit un montant saisi en unités majeures (« 12500 », « 10.5 ») sans arrondir. */
export function parseMajor(input: string, currency: Currency): Money | null {
  const decimals = CURRENCIES[currency].decimals;
  const match = /^(\d+)(?:[.,](\d+))?$/.exec(input.trim());
  if (!match) return null;
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) return null;
  return money(BigInt(match[1] + fraction.padEnd(decimals, '0')), currency);
}

/** Montant en unités majeures, en chaîne décimale exacte (« 12500 », « 10.50 »), l'inverse de `parseMajor`. */
export function toMajor(value: Money): string {
  const decimals = CURRENCIES[value.currency].decimals;
  const amount = toBigInt(value);
  const sign = amount < 0n ? '-' : '';
  const digits = (amount < 0n ? -amount : amount).toString().padStart(decimals + 1, '0');
  return decimals === 0 ? `${sign}${digits}` : `${sign}${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

/** Taux indicatif : nombre d'unités mineures de GNF pour une unité majeure de la devise. */
export type FxTable = Partial<Record<Currency, bigint>>;

/**
 * Conversion indicative vers la devise de référence, arrondie au plus proche (demi vers le haut).
 * Sert uniquement à la vue consolidée : aucun paiement n'est jamais calculé sur ce montant.
 */
export function toReference(value: Money, fx: FxTable): Money | null {
  if (value.currency === REFERENCE_CURRENCY) return value;
  const rate = fx[value.currency];
  if (rate === undefined) return null;
  const scale = 10n ** BigInt(CURRENCIES[value.currency].decimals);
  const product = toBigInt(value) * rate;
  const negative = product < 0n;
  const magnitude = negative ? -product : product;
  const rounded = (magnitude + scale / 2n) / scale;
  return money(negative ? -rounded : rounded, REFERENCE_CURRENCY);
}

export function formatMoney(value: Money, locale = 'fr-FR'): string {
  const decimals = CURRENCIES[value.currency].decimals;
  const raw = toBigInt(value);
  const negative = raw < 0n;
  const digits = (negative ? -raw : raw).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals) || '0';
  const fraction = decimals > 0 ? digits.slice(digits.length - decimals) : '';
  const groupedWhole = BigInt(whole).toLocaleString(locale);
  const shownFraction = fraction.replace(/0+$/, '');
  const minFraction = value.currency === 'USD' || value.currency === 'EUR' ? fraction : shownFraction;
  const separator = (1.5).toLocaleString(locale).charAt(1);
  return `${negative ? '-' : ''}${groupedWhole}${minFraction ? separator + minFraction : ''} ${value.currency}`;
}

function gnfPerMajor(currency: Currency, fx: FxTable): bigint | undefined {
  return currency === REFERENCE_CURRENCY ? 1n : fx[currency];
}

/**
 * Conversion d'une devise à l'autre en passant par le GNF, arrondie vers le bas (jamais en faveur du client
 * au-delà de ce qui est affiché). Rend null si un taux manque.
 */
export function convert(value: Money, target: Currency, fx: FxTable): Money | null {
  if (value.currency === target) return value;
  const sourceRate = gnfPerMajor(value.currency, fx);
  const targetRate = gnfPerMajor(target, fx);
  if (sourceRate === undefined || targetRate === undefined) return null;
  const numerator = toBigInt(value) * sourceRate * 10n ** BigInt(CURRENCIES[target].decimals);
  const denominator = 10n ** BigInt(CURRENCIES[value.currency].decimals) * targetRate;
  return money(numerator / denominator, target);
}
