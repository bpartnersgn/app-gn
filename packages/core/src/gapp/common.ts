import { AppError } from '../errors.ts';
import { money, parseMajor, toBigInt, type Money } from '../money.ts';
import type { MobileMoneyOperator } from '../payments.ts';

export const DAY_MS = 24 * 60 * 60 * 1000;

export const OPERATORS: readonly MobileMoneyOperator[] = ['orange_money', 'mtn_momo', 'cellcom_money', 'moov_money'];

/** Date calendaire (AAAA-MM-JJ, UTC) d'un instant. */
export function dayOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  return dayOf(new Date(Date.parse(day) + days * DAY_MS));
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

export function isDay(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && dayOf(new Date(Date.parse(value))) === value;
}

export function isPeriod(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

export function periodOf(day: string): string {
  return day.slice(0, 7);
}

export function gnf(amount: bigint | number): Money {
  return money(amount, 'GNF');
}

/** Montant saisi en GNF (unités entières), strictement positif. */
export function parseGnf(input: unknown, what: string): Money {
  const parsed = typeof input === 'string' || typeof input === 'number' ? parseMajor(String(input), 'GNF') : null;
  if (!parsed || toBigInt(parsed) <= 0n) throw new AppError('invalid_request', `${what} : montant en GNF attendu`);
  return parsed;
}

export function sum(values: readonly Money[]): Money {
  return gnf(values.reduce((total, value) => total + toBigInt(value), 0n));
}

/** Part en points de base, arrondie au franc le plus proche. */
export function share(value: Money, bps: number): Money {
  return gnf((toBigInt(value) * BigInt(bps) + 5_000n) / 10_000n);
}

export function text(value: unknown, what: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim()) throw new AppError('invalid_request', `${what} requis`);
  return value.trim().slice(0, max);
}

export function optionalText(value: unknown, max = 200): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

export interface MobilePayee {
  operator: MobileMoneyOperator;
  phone: string;
}

export function payee(value: unknown, what: string): MobilePayee {
  const candidate = (value ?? {}) as Partial<MobilePayee>;
  if (!OPERATORS.includes(candidate.operator as MobileMoneyOperator)) throw new AppError('invalid_request', `${what} : opérateur Mobile Money inconnu`);
  if (!/^\+?224\s?\d[\d\s]{7,11}$/.test(candidate.phone ?? '')) throw new AppError('invalid_request', `${what} : numéro guinéen attendu (+224…)`);
  return { operator: candidate.operator as MobileMoneyOperator, phone: candidate.phone!.trim() };
}

/** NIN au format de la démo (GN-NIN- suivi de 10 chiffres), casse et espaces ignorés. */
export function normalizedNin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const nin = value.toUpperCase().replace(/\s+/g, '');
  return /^GN-NIN-\d{10}$/.test(nin) ? nin : undefined;
}

/** Code de vérification public d'un document émis (même forme que ceux du coffre). */
export function verificationCode(prefix: string): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8));
  const chars = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
  return `GN-${prefix}-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

export function csvCell(value: string | number): string {
  const raw = String(value);
  return /[;"\n]/.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw;
}

export function csv(rows: readonly (readonly (string | number)[])[]): string {
  return rows.map((row) => row.map(csvCell).join(';')).join('\n') + '\n';
}
