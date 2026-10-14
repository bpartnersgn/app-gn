import { useState, type ReactNode } from 'react';
import { providerById, type AccountPosition, type Money } from '@app-gn/core';
import { useRead, useSession } from './context.ts';
import { fmt } from './format.ts';

/** Lecture d'un tableau de bord GAPP, gardée sur l'appareil comme les autres écrans. */
export function useDesk<T>(spaceId: string, path: string, version = 0) {
  return useRead<T>(`${spaceId}:desk:${path}`, ({ client, actor }) => client.base.desk<T>(actor, spaceId, 'GET', path), version);
}

export type Tone = 'ok' | 'wait' | 'bad' | 'neutral';
export type Message = { tone: 'ok' | 'wait' | 'bad'; text: string };

/** Action d'un tableau de bord : réseau exigé, message de retour, relecture des écrans. */
export function useDeskAction(spaceId: string, onDone: () => void) {
  const { client, actor } = useSession();
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  async function run<T>(method: 'GET' | 'POST', path: string, body: unknown, success: (result: T) => Message | null, withKey = false): Promise<T | undefined> {
    setBusy(true);
    try {
      // Une clé par action, gardée si la demande est renvoyée (avec le code de confirmation, par exemple).
      const key = withKey ? crypto.randomUUID() : undefined;
      const result = await client.write(() => client.base.desk<T>(actor, spaceId, method, path, body, key));
      setMessage(success(result));
      onDone();
      return result;
    } catch (cause) {
      setMessage({ tone: (cause as { code?: string }).code === 'cancelled' ? 'wait' : 'bad', text: (cause as Error).message });
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { run, message, setMessage, busy };
}

export function Notice({ message }: { message: Message | null }) {
  // Une date abrégée (« 12 nov. ») en fin de phrase ne doit pas laisser deux points.
  return message ? <p className={`notice notice-${message.tone}`} role="status">{message.text.replace(/\.\.(?=\s|$)/g, '.')}</p> : null;
}

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function Kpi({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: Tone; hint?: ReactNode }) {
  return (
    <div className="kpi" data-tone={tone}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {hint && <span className="kpi-hint">{hint}</span>}
    </div>
  );
}

export function Panel({ title, id, children, actions }: { title: string; id: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="panel" aria-labelledby={id}>
      <div className="panel-head">
        <h2 id={id} className="panel-title">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Loading({ state, children }: { state: { data?: unknown; error?: string }; children: ReactNode }) {
  if (state.error && !state.data) return <p className="notice notice-bad">{state.error}</p>;
  if (!state.data) return <p className="loading">Chargement…</p>;
  return <>{children}</>;
}

/** Date calendaire (AAAA-MM-JJ) lisible : « 13 oct. ». */
export function day(value: string, withYear = false): string {
  return new Date(`${value.slice(0, 10)}T00:00:00Z`).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });
}

export function period(value: string): string {
  return new Date(`${value}-01T00:00:00Z`).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDaysTo(value: string, days: number): string {
  return new Date(Date.parse(`${value}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Les mois clos les plus récents, du plus proche au plus ancien. */
export function recentPeriods(count: number, includeCurrent = false): string[] {
  const now = new Date();
  const periods: string[] = [];
  for (let offset = includeCurrent ? 0 : 1; periods.length < count; offset += 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
    periods.push(date.toISOString().slice(0, 7));
  }
  return periods;
}

export function money(value: Money | undefined): string {
  return value ? fmt(value) : '—';
}

/** Comptes en GNF qu'on peut débiter, pour un lot, une TVA, un mandat. */
export function debitableGnf(positions: readonly AccountPosition[]): AccountPosition[] {
  return positions.filter((position) => position.account.currency === 'GNF' && providerById(position.account.providerId)?.canDebit);
}

export function AccountSelect({ id, positions, value, onChange, label = 'Compte débité' }: { id: string; positions: readonly AccountPosition[]; value: string; onChange: (value: string) => void; label?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        {positions.map((position) => (
          <option key={position.account.id} value={position.account.id}>
            {position.account.label}{position.balance ? ` · ${fmt(position.balance)}` : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Téléchargement d'un export CSV rendu par le serveur (ou le noyau embarqué). */
export function download(file: { name: string; content: string }): void {
  // BOM : Excel lit l'UTF-8 et les accents.
  const blob = new Blob(['﻿', file.content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const OPERATOR_LABELS: Record<string, string> = {
  orange_money: 'Orange Money',
  mtn_momo: 'MTN MoMo',
  cellcom_money: 'Cellcom Money',
  moov_money: 'Moov Money',
};

export function OperatorSelect({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="field">
      <span>Opérateur</span>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        {Object.entries(OPERATOR_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
    </label>
  );
}

/** Une barre de proportion (exécution, répartition) ; `parts` en valeurs absolues. */
export function Meter({ total, parts, label }: { total: Money; parts: { value: Money; tone: string; label: string }[]; label: string }) {
  const max = BigInt(total.amount);
  return (
    <div className="meter" role="img" aria-label={label}>
      {parts.map((part) => {
        const share = max > 0n ? Number((BigInt(part.value.amount) * 10_000n) / max) / 100 : 0;
        return share > 0 ? <span key={part.label} className="meter-seg" data-tone={part.tone} style={{ width: `${Math.min(100, share)}%` }} title={`${part.label} : ${fmt(part.value)}`} /> : null;
      })}
    </div>
  );
}
