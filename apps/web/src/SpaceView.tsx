import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  ACCOUNT_KIND_LABELS,
  BILLERS,
  BUSINESS_APPROVAL_THRESHOLD,
  describeDestination,
  providerById,
  type AccountKind,
  type AccountPosition,
  type AccountTransaction,
  type ConsolidatedView,
  type MobileMoneyOperator,
  type Payment,
  type PaymentDestination,
  type Person,
  type ServiceDefinition,
  type SpaceAccess,
} from '@app-gn/core';
import type { AppGnClient } from './client.ts';
import { FAILURE_REASONS, PAYMENT_STATUS, SPACE_KIND_LABELS, dateTime, fmt, shortDate } from './format.ts';

const KIND_ORDER: AccountKind[] = ['bank', 'mobile_money', 'app_wallet', 'virtual_card', 'crypto'];

interface Props {
  client: AppGnClient;
  person: Person;
  access: SpaceAccess;
}

export function SpaceView({ client, person, access }: Props) {
  const spaceId = access.space.id;
  const [view, setView] = useState<ConsolidatedView | null>(null);
  const [services, setServices] = useState<ServiceDefinition[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [overview, catalog, list] = await Promise.all([
        client.overview(person.id, spaceId),
        client.services(person.id, spaceId),
        client.payments(person.id, spaceId),
      ]);
      setView(overview);
      setServices(catalog);
      setPayments(list);
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, [client, person.id, spaceId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const canInitiate = access.permissions.includes('payments:initiate');
  const canApprove = access.permissions.includes('payments:approve');

  return (
    <main className="page">
      <section className="space-head">
        <p className="eyebrow">{SPACE_KIND_LABELS[access.space.kind]}</p>
        <h1>{access.space.kind === 'citizen' ? `Bonjour ${person.fullName.split(' ')[0]}` : access.space.name}</h1>
        <p className="space-meta">
          {access.space.kind === 'business' && <>{access.space.legalForm} · RCCM {access.space.rccm} · NIF {access.space.nif} · </>}
          Votre rôle : <strong>{access.roleLabel}</strong>
        </p>
      </section>

      {error && <p className="notice notice-bad">{error}</p>}
      {view ? <Consolidated view={view} kind={access.space.kind} /> : <p className="loading">Interrogation des fournisseurs…</p>}

      <div className="columns">
        <div className="col-main">
          {view && <Accounts client={client} person={person} spaceId={spaceId} positions={view.positions} />}
        </div>
        <div className="col-side">
          <Payments
            client={client}
            person={person}
            access={access}
            positions={view?.positions ?? []}
            payments={payments}
            canInitiate={canInitiate}
            canApprove={canApprove}
            onChange={refresh}
          />
          <Services services={services} />
        </div>
      </div>
    </main>
  );
}

function Consolidated({ view, kind }: { view: ConsolidatedView; kind: string }) {
  const total = BigInt(view.total.amount);
  const buckets = KIND_ORDER
    .map((accountKind) => view.byKind.find((bucket) => bucket.kind === accountKind))
    .filter((bucket) => bucket !== undefined);
  const missing = view.positions.filter((position) => position.freshness !== 'live');
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-figure">
        <h2 id="hero-title" className="eyebrow">{kind === 'citizen' ? 'Tous mes avoirs' : kind === 'business' ? 'Trésorerie consolidée J+0' : 'Disponibilités de l’entité'}</h2>
        <p className="hero-total">{fmt(view.total)}</p>
        <p className="hero-sub">
          {view.positions.length} comptes chez {new Set(view.positions.map((position) => position.account.providerId)).size} fournisseurs · contre-valeur indicative en GNF · {dateTime(view.generatedAt)}
        </p>
        {view.partial && (
          <p className="notice notice-wait">
            Vue partielle : {missing.map((position) => `${position.providerName} (${position.freshness === 'stale' ? 'dernier solde connu' : 'sans réponse'})`).join(', ')}.
          </p>
        )}
      </div>
      <div className="split" role="img" aria-label="Répartition par type de compte">
        {buckets.map((bucket) => {
          const share = total > 0n ? Number((BigInt(bucket.total.amount) * 10000n) / total) / 100 : 0;
          return share > 0 ? <span key={bucket.kind} className="split-seg" data-account-kind={bucket.kind} style={{ flexGrow: share }} /> : null;
        })}
      </div>
      <ul className="legend">
        {buckets.map((bucket) => {
          const share = total > 0n ? Number((BigInt(bucket.total.amount) * 1000n) / total) / 10 : 0;
          return (
            <li key={bucket.kind}>
              <span className="swatch" data-account-kind={bucket.kind} aria-hidden="true" />
              <span className="legend-label">{ACCOUNT_KIND_LABELS[bucket.kind]}</span>
              <span className="legend-value">{fmt(bucket.total)}</span>
              <span className="legend-share">{share.toLocaleString('fr-FR')} %</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Accounts({ client, person, spaceId, positions }: { client: AppGnClient; person: Person; spaceId: string; positions: AccountPosition[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const groups = KIND_ORDER
    .map((kind) => ({ kind, items: positions.filter((position) => position.kind === kind) }))
    .filter((group) => group.items.length > 0);
  return (
    <section className="panel" aria-labelledby="accounts-title">
      <h2 id="accounts-title" className="panel-title">Comptes rattachés</h2>
      {groups.map((group) => (
        <div key={group.kind} className="account-group">
          <h3 className="group-title"><span className="swatch" data-account-kind={group.kind} aria-hidden="true" />{ACCOUNT_KIND_LABELS[group.kind]}</h3>
          <ul className="accounts">
            {group.items.map((position) => (
              <li key={position.account.id}>
                <button type="button" className="account" aria-expanded={open === position.account.id} onClick={() => setOpen(open === position.account.id ? null : position.account.id)}>
                  <span className="account-id">
                    <span className="account-provider">{position.providerName}</span>
                    <span className="account-label">{position.account.label} · <span className="mono">{position.account.maskedIdentifier}</span></span>
                  </span>
                  <span className="account-amounts">
                    <span className="account-balance">{position.balance ? fmt(position.balance) : '—'}</span>
                    {position.balance && position.balance.currency !== 'GNF' && position.referenceValue && (
                      <span className="account-ref">≈ {fmt(position.referenceValue)}</span>
                    )}
                    <Freshness position={position} />
                  </span>
                </button>
                {open === position.account.id && <Transactions client={client} person={person} spaceId={spaceId} accountId={position.account.id} />}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function Freshness({ position }: { position: AccountPosition }) {
  if (position.freshness === 'live') return <span className="pill pill-ok">À jour</span>;
  if (position.freshness === 'stale') return <span className="pill pill-wait">Ancien · {position.asOf ? dateTime(position.asOf) : ''}</span>;
  return <span className="pill pill-bad">Indisponible</span>;
}

function Transactions({ client, person, spaceId, accountId }: { client: AppGnClient; person: Person; spaceId: string; accountId: string }) {
  const [items, setItems] = useState<AccountTransaction[] | null>(null);
  useEffect(() => {
    client.transactions(person.id, spaceId, accountId).then(setItems).catch(() => setItems([]));
  }, [client, person.id, spaceId, accountId]);
  if (!items) return <p className="loading inset">Chargement…</p>;
  if (items.length === 0) return <p className="fine inset">Aucun mouvement disponible.</p>;
  return (
    <ol className="txns">
      {items.map((txn) => (
        <li key={txn.id} className="txn">
          <span className="txn-date">{shortDate(txn.occurredAt)}</span>
          <span className="txn-label">{txn.label}</span>
          <span className={`txn-amount ${txn.direction === 'credit' ? 'pos' : 'neg'}`}>{txn.direction === 'credit' ? '+' : '−'}{fmt(txn.amount)}</span>
        </li>
      ))}
    </ol>
  );
}

function Services({ services }: { services: ServiceDefinition[] }) {
  return (
    <section className="panel" aria-labelledby="services-title">
      <h2 id="services-title" className="panel-title">Services</h2>
      <ul className="services">
        {services.map((service) => (
          <li key={service.id} className="service" data-status={service.status}>
            <span className="service-title">{service.title}</span>
            <span className="service-desc">{service.description}</span>
            {service.status === 'planned' && <span className="pill pill-neutral">Prévu</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

type DestinationKind = PaymentDestination['type'];

function Payments(props: {
  client: AppGnClient;
  person: Person;
  access: SpaceAccess;
  positions: AccountPosition[];
  payments: Payment[];
  canInitiate: boolean;
  canApprove: boolean;
  onChange: () => Promise<void>;
}) {
  const { client, person, access, positions, payments, canInitiate, canApprove, onChange } = props;
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad' | 'wait'; text: string } | null>(null);
  const accountsById = useMemo(() => new Map(positions.map((position) => [position.account.id, position.account])), [positions]);

  async function decide(payment: Payment, approve: boolean) {
    try {
      const result = approve
        ? await client.approve(person.id, access.space.id, payment.id)
        : await client.reject(person.id, access.space.id, payment.id);
      setMessage({ tone: result.status === 'completed' ? 'ok' : 'bad', text: `${result.label} : ${PAYMENT_STATUS[result.status].label.toLowerCase()}.` });
    } catch (cause) {
      setMessage({ tone: 'bad', text: (cause as Error).message });
    }
    await onChange();
  }

  const title = access.space.kind === 'administration' ? 'Mandats et paiements' : 'Paiements';
  return (
    <section className="panel" aria-labelledby="payments-title">
      <h2 id="payments-title" className="panel-title">{title}</h2>
      {canInitiate && (
        <PaymentForm
          client={client}
          person={person}
          access={access}
          positions={positions}
          onDone={async (result) => {
            setMessage(result);
            await onChange();
          }}
        />
      )}
      {!canInitiate && access.space.kind === 'administration' && (
        <p className="fine">L’ordonnateur mandate ; en tant que comptable public, vous visez et payez ou rejetez.</p>
      )}
      {message && <p className={`notice notice-${message.tone}`} role="status">{message.text}</p>}
      {payments.length > 0 && (
        <ul className="payments">
          {payments.map((payment) => {
            const status = PAYMENT_STATUS[payment.status];
            const mayDecide = canApprove && payment.status === 'pending_approval' && payment.initiatedBy !== person.id;
            return (
              <li key={payment.id} className="payment">
                <div className="payment-line">
                  <span className="payment-label">{payment.label}</span>
                  <span className="payment-amount">{fmt(payment.amount)}</span>
                </div>
                <div className="payment-line payment-meta">
                  <span>{accountsById.get(payment.sourceAccountId)?.label ?? payment.sourceAccountId} → {describeDestination(payment.destination)}</span>
                  <span className={`pill pill-${status.tone}`}>{status.label}{payment.failureReason ? ` · ${FAILURE_REASONS[payment.failureReason] ?? payment.failureReason}` : ''}</span>
                </div>
                {mayDecide && (
                  <div className="payment-actions">
                    <button type="button" className="btn btn-primary" onClick={() => decide(payment, true)}>{access.space.kind === 'administration' ? 'Viser et payer' : 'Approuver'}</button>
                    <button type="button" className="btn" onClick={() => decide(payment, false)}>Rejeter</button>
                  </div>
                )}
                {payment.status === 'pending_approval' && payment.initiatedBy === person.id && (
                  <p className="fine">En attente d’une seconde personne habilitée.</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {payments.length === 0 && !canInitiate && <p className="fine">Aucun paiement pour l’instant.</p>}
    </section>
  );
}

function PaymentForm({ client, person, access, positions, onDone }: {
  client: AppGnClient;
  person: Person;
  access: SpaceAccess;
  positions: AccountPosition[];
  onDone: (message: { tone: 'ok' | 'bad' | 'wait'; text: string }) => Promise<void>;
}) {
  const debitable = positions.filter((position) => providerById(position.account.providerId)?.canDebit);
  const [chosenSourceId, setSourceId] = useState('');
  // Les comptes arrivent après le premier rendu : tant que rien n'est choisi, on prend le premier débitable.
  const sourceId = debitable.some((position) => position.account.id === chosenSourceId) ? chosenSourceId : debitable[0]?.account.id ?? '';
  const [kind, setKind] = useState<DestinationKind>(access.space.kind === 'citizen' ? 'biller' : 'mobile_money');
  const [amount, setAmount] = useState('');
  const [operator, setOperator] = useState<MobileMoneyOperator>('orange_money');
  const [phone, setPhone] = useState('+224 ');
  const [name, setName] = useState('');
  const [billerId, setBillerId] = useState<string>(BILLERS[0].id);
  const [reference, setReference] = useState('');
  const [targetId, setTargetId] = useState('');
  const [busy, setBusy] = useState(false);

  const source = debitable.find((position) => position.account.id === sourceId)?.account;
  const targets = positions.filter((position) => position.account.id !== sourceId && position.account.currency === source?.currency);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!source) return;
    let destination: PaymentDestination;
    if (kind === 'own_account') destination = { type: 'own_account', accountId: targetId || targets[0]?.account.id || '' };
    else if (kind === 'mobile_money') destination = { type: 'mobile_money', operator, phone: phone.trim(), ...(name.trim() ? { name: name.trim() } : {}) };
    else destination = { type: 'biller', billerId, customerReference: reference.trim() };
    setBusy(true);
    try {
      const payment = await client.pay(person.id, access.space.id, { sourceAccountId: source.id, amount: amount.replace(/\s/g, ''), destination }, crypto.randomUUID());
      const status = PAYMENT_STATUS[payment.status];
      await onDone({
        tone: status.tone === 'ok' ? 'ok' : status.tone === 'wait' ? 'wait' : 'bad',
        text: payment.status === 'pending_approval'
          ? `${fmt(payment.amount)} : en attente d’approbation.`
          : `${fmt(payment.amount)} : ${status.label.toLowerCase()}${payment.failureReason ? ` (${FAILURE_REASONS[payment.failureReason] ?? payment.failureReason})` : ''}.`,
      });
      if (payment.status !== 'failed') setAmount('');
    } catch (cause) {
      await onDone({ tone: 'bad', text: (cause as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const hint = access.space.kind === 'business'
    ? `Au-delà de ${fmt(BUSINESS_APPROVAL_THRESHOLD)}, le paiement attend l’approbation du dirigeant.`
    : access.space.kind === 'administration'
      ? 'Chaque mandat est visé et payé par le comptable public.'
      : null;

  return (
    <form className="pay-form" onSubmit={submit}>
      <div className="seg" role="radiogroup" aria-label="Destination">
        {(['biller', 'mobile_money', 'own_account'] as const).map((option) => (
          <button key={option} type="button" role="radio" aria-checked={kind === option} className="seg-btn" onClick={() => setKind(option)}>
            {option === 'biller' ? 'Facture' : option === 'mobile_money' ? 'Mobile Money' : 'Entre comptes'}
          </button>
        ))}
      </div>
      <label className="field">
        <span>Depuis</span>
        <select id="pay-source" value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
          {debitable.map((position) => (
            <option key={position.account.id} value={position.account.id}>
              {position.providerName} · {position.account.label}{position.balance ? ` (${fmt(position.balance)})` : ''}
            </option>
          ))}
        </select>
      </label>
      {kind === 'biller' && (
        <div className="field-row">
          <label className="field">
            <span>Facturier</span>
            <select id="pay-biller" value={billerId} onChange={(event) => setBillerId(event.target.value)}>
              {BILLERS.map((biller) => <option key={biller.id} value={biller.id}>{biller.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Référence client</span>
            <input id="pay-reference" value={reference} onChange={(event) => setReference(event.target.value)} placeholder="N° de compteur, de contrat…" required />
          </label>
        </div>
      )}
      {kind === 'mobile_money' && (
        <div className="field-row">
          <label className="field">
            <span>Opérateur</span>
            <select id="pay-operator" value={operator} onChange={(event) => setOperator(event.target.value as MobileMoneyOperator)}>
              <option value="orange_money">Orange Money</option>
              <option value="mtn_momo">MTN MoMo</option>
              <option value="cellcom_money">Cellcom Money</option>
              <option value="moov_money">Moov Money</option>
            </select>
          </label>
          <label className="field">
            <span>Numéro</span>
            <input id="pay-phone" value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="tel" required />
          </label>
          <label className="field field-wide">
            <span>Bénéficiaire (facultatif)</span>
            <input id="pay-name" value={name} onChange={(event) => setName(event.target.value)} placeholder={access.space.kind === 'citizen' ? 'Fanta Camara' : 'Fournisseur'} />
          </label>
        </div>
      )}
      {kind === 'own_account' && (
        <label className="field">
          <span>Vers</span>
          <select id="pay-target" value={targetId || targets[0]?.account.id || ''} onChange={(event) => setTargetId(event.target.value)}>
            {targets.map((position) => <option key={position.account.id} value={position.account.id}>{position.providerName} · {position.account.label}</option>)}
          </select>
        </label>
      )}
      <label className="field">
        <span>Montant ({source?.currency ?? 'GNF'})</span>
        <input id="pay-amount" value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="150 000" required />
      </label>
      {hint && <p className="fine">{hint}</p>}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy || !source || (kind === 'own_account' && targets.length === 0)}>
        {access.space.kind === 'administration' ? 'Émettre le mandat' : 'Payer'}
      </button>
    </form>
  );
}
