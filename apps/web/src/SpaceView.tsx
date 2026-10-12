import { useMemo, useState, type FormEvent } from 'react';
import {
  ACCOUNT_KIND_LABELS,
  BILLERS,
  BUSINESS_APPROVAL_THRESHOLD,
  describeDestination,
  parseMajor,
  providerById,
  type AccountKind,
  type AccountPosition,
  type AccountTransaction,
  type ConsolidatedView,
  type Currency,
  type MobileMoneyOperator,
  type Payment,
  type PaymentDestination,
  type ServiceDefinition,
  type SpaceAccess,
  type SpaceKind,
} from '@app-gn/core';
import { CardsSection } from './Cards.tsx';
import { useOfflineStatus, useRead, useSession } from './context.ts';
import { DocumentsSection } from './Documents.tsx';
import { FAILURE_REASONS, PAYMENT_STATUS, SPACE_KIND_LABELS, dateTime, fmt, shortDate } from './format.ts';

export type Section = 'home' | 'pay' | 'cards' | 'documents' | 'services';

export const SECTIONS: Record<SpaceKind, { id: Section; label: string; short?: string }[]> = {
  citizen: [
    { id: 'home', label: 'Accueil' },
    { id: 'pay', label: 'Payer' },
    { id: 'cards', label: 'Cartes et crypto', short: 'Cartes' },
    { id: 'documents', label: 'Documents' },
    { id: 'services', label: 'Services' },
  ],
  business: [
    { id: 'home', label: 'Trésorerie' },
    { id: 'pay', label: 'Paiements' },
    { id: 'documents', label: 'Documents' },
    { id: 'services', label: 'Services' },
  ],
  administration: [
    { id: 'home', label: 'Situation' },
    { id: 'pay', label: 'Mandats' },
    { id: 'documents', label: 'Documents' },
    { id: 'services', label: 'Services' },
  ],
};

const KIND_ORDER: AccountKind[] = ['bank', 'mobile_money', 'app_wallet', 'virtual_card', 'crypto'];

export function SpaceView({ access, section, onNavigate }: { access: SpaceAccess; section: Section; onNavigate: (section: Section) => void }) {
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((value) => value + 1);
  const spaceId = access.space.id;
  const overview = useRead<ConsolidatedView>(`${spaceId}:overview`, ({ client, actor: a }) => client.base.overview(a, spaceId), version);

  return (
    <main className="page">
      <section className="space-head">
        <p className="eyebrow">{SPACE_KIND_LABELS[access.space.kind]}</p>
        <h1>{access.space.kind === 'citizen' ? `Bonjour ${firstName(access)}` : access.space.name}</h1>
        <p className="space-meta">
          {access.space.kind === 'business' && <>{access.space.legalForm} · RCCM {access.space.rccm} · NIF {access.space.nif} · </>}
          Votre rôle : <strong>{access.roleLabel}</strong>
        </p>
      </section>

      {section === 'home' && <HomeSection access={access} overview={overview} onNavigate={onNavigate} />}
      {section === 'pay' && <PaySection access={access} positions={overview.data?.positions ?? []} version={version} onChange={bump} />}
      {section === 'cards' && <CardsSection access={access} positions={overview.data?.positions ?? []} version={version} onChange={bump} />}
      {section === 'documents' && <DocumentsSection access={access} />}
      {section === 'services' && <ServicesSection access={access} />}
    </main>
  );
}

function firstName(access: SpaceAccess): string {
  return access.space.name.split(' ')[0] ?? '';
}

function HomeSection({ access, overview, onNavigate }: { access: SpaceAccess; overview: { data?: ConsolidatedView; error?: string }; onNavigate: (section: Section) => void }) {
  return (
    <>
      {overview.error && !overview.data && <p className="notice notice-bad">{overview.error}</p>}
      {overview.data ? <Consolidated view={overview.data} kind={access.space.kind} /> : !overview.error && <p className="loading">Interrogation des fournisseurs…</p>}
      {overview.data && (
        <div className="columns">
          <div className="col-main"><Accounts spaceId={access.space.id} positions={overview.data.positions} /></div>
          <div className="col-side">
            <QuickActions access={access} onNavigate={onNavigate} />
          </div>
        </div>
      )}
    </>
  );
}

function QuickActions({ access, onNavigate }: { access: SpaceAccess; onNavigate: (section: Section) => void }) {
  const items = access.space.kind === 'citizen'
    ? [
      { section: 'pay' as const, title: 'Payer une facture ou envoyer', text: 'EDG, SEG, Mobile Money. Fonctionne hors ligne : le paiement part au retour du réseau.' },
      { section: 'cards' as const, title: 'Recharger ma carte', text: 'Depuis Orange Money, MTN ou la crypto, frais affichés avant de confirmer.' },
      { section: 'documents' as const, title: 'Mes documents', text: 'Permis, assurance, carte grise : présentables sans réseau.' },
    ]
    : access.space.kind === 'business'
      ? [
        { section: 'pay' as const, title: 'Payer un fournisseur', text: `Au-delà de ${fmt(BUSINESS_APPROVAL_THRESHOLD)}, approbation du dirigeant.` },
        { section: 'documents' as const, title: 'Documents de l’entreprise', text: 'RCCM, attestation fiscale, assurances, avec alerte avant expiration.' },
      ]
      : [
        { section: 'pay' as const, title: 'Mandats en cours', text: 'L’ordonnateur mandate, le comptable public vise et paie.' },
        { section: 'documents' as const, title: 'Documents de l’entité', text: 'Conventions et attestations.' },
      ];
  return (
    <section className="panel" aria-labelledby="quick-title">
      <h2 id="quick-title" className="panel-title">Raccourcis</h2>
      <ul className="services">
        {items.map((item) => (
          <li key={item.title}>
            <button type="button" className="service service-link" data-status="available" onClick={() => onNavigate(item.section)}>
              <span className="service-title">{item.title}</span>
              <span className="service-desc">{item.text}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Consolidated({ view, kind }: { view: ConsolidatedView; kind: SpaceKind }) {
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
        {view.partial && missing.length > 0 && (
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

function Accounts({ spaceId, positions }: { spaceId: string; positions: AccountPosition[] }) {
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
                {open === position.account.id && <Transactions spaceId={spaceId} accountId={position.account.id} />}
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

function Transactions({ spaceId, accountId }: { spaceId: string; accountId: string }) {
  const { data, error } = useRead<AccountTransaction[]>(`${spaceId}:txns:${accountId}`, ({ client, actor }) => client.base.transactions(actor, spaceId, accountId));
  if (!data && error) return <p className="fine inset">{error}</p>;
  if (!data) return <p className="loading inset">Chargement…</p>;
  if (data.length === 0) return <p className="fine inset">Aucun mouvement disponible.</p>;
  return (
    <ol className="txns">
      {data.map((txn) => (
        <li key={txn.id} className="txn">
          <span className="txn-date">{shortDate(txn.occurredAt)}</span>
          <span className="txn-label">{txn.label}</span>
          <span className={`txn-amount ${txn.direction === 'credit' ? 'pos' : 'neg'}`}>{txn.direction === 'credit' ? '+' : '−'}{fmt(txn.amount)}</span>
        </li>
      ))}
    </ol>
  );
}

function ServicesSection({ access }: { access: SpaceAccess }) {
  const { data, error } = useRead<ServiceDefinition[]>(`${access.space.id}:services`, ({ client, actor }) => client.base.services(actor, access.space.id));
  return (
    <section className="panel" aria-labelledby="services-title">
      <h2 id="services-title" className="panel-title">Services</h2>
      {error && !data && <p className="notice notice-bad">{error}</p>}
      <ul className="services services-grid">
        {(data ?? []).map((service) => (
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

type Message = { tone: 'ok' | 'bad' | 'wait'; text: string };

function PaySection({ access, positions, version, onChange }: { access: SpaceAccess; positions: AccountPosition[]; version: number; onChange: () => void }) {
  const { client, actor } = useSession();
  const status = useOfflineStatus(client);
  const spaceId = access.space.id;
  const payments = useRead<Payment[]>(`${spaceId}:payments`, ({ client: c, actor: a }) => c.base.payments(a, spaceId), version);
  const [message, setMessage] = useState<Message | null>(null);
  const accountsById = useMemo(() => new Map(positions.map((position) => [position.account.id, position.account])), [positions]);
  const canInitiate = access.permissions.includes('payments:initiate');
  const canApprove = access.permissions.includes('payments:approve');
  const queued = status.pending.filter((operation) => operation.spaceId === spaceId && operation.personId === actor.personId);

  async function decide(payment: Payment, approve: boolean) {
    try {
      const result = await client.write(() => approve
        ? client.base.approve(actor, spaceId, payment.id)
        : client.base.reject(actor, spaceId, payment.id));
      setMessage({ tone: result.status === 'completed' ? 'ok' : 'bad', text: `${result.label} : ${PAYMENT_STATUS[result.status].label.toLowerCase()}.` });
    } catch (cause) {
      setMessage({ tone: 'bad', text: (cause as Error).message });
    }
    onChange();
  }

  const list = payments.data ?? [];
  return (
    <div className="columns">
      <div className="col-main">
        {canInitiate && (
          <section className="panel" aria-labelledby="pay-title">
            <h2 id="pay-title" className="panel-title">{access.space.kind === 'administration' ? 'Émettre un mandat' : access.space.kind === 'business' ? 'Payer un fournisseur' : 'Payer ou envoyer'}</h2>
            <PaymentForm access={access} positions={positions} onDone={(result) => { setMessage(result); onChange(); }} />
            {message && <p className={`notice notice-${message.tone}`} role="status">{message.text}</p>}
          </section>
        )}
        {!canInitiate && message && <p className={`notice notice-${message.tone}`} role="status">{message.text}</p>}
      </div>
      <div className="col-side">
        <section className="panel" aria-labelledby="history-title">
          <h2 id="history-title" className="panel-title">{access.space.kind === 'administration' ? 'Mandats' : 'Historique'}</h2>
          {!canInitiate && access.space.kind === 'administration' && (
            <p className="fine">L’ordonnateur mandate ; en tant que comptable public, vous visez et payez ou rejetez.</p>
          )}
          {queued.length > 0 && (
            <ul className="payments">
              {queued.map((operation) => (
                <li key={operation.id} className="payment payment-queued">
                  <div className="payment-line">
                    <span className="payment-label">{operation.payload.label || describeDestination(operation.payload.destination)}</span>
                    <span className="payment-amount">{queuedAmount(operation.payload.amount, accountsById.get(operation.payload.sourceAccountId)?.currency)}</span>
                  </div>
                  <div className="payment-line payment-meta">
                    <span>Enregistré hors ligne le {dateTime(operation.createdAt)} · expire le {dateTime(operation.expiresAt)}</span>
                    <span className="pill pill-wait">En attente de réseau</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {list.length > 0 ? (
            <ul className="payments">
              {list.map((payment) => {
                const state = PAYMENT_STATUS[payment.status];
                const mayDecide = canApprove && payment.status === 'pending_approval' && payment.initiatedBy !== actor.personId;
                return (
                  <li key={payment.id} className="payment">
                    <div className="payment-line">
                      <span className="payment-label">{payment.label}</span>
                      <span className="payment-amount">{fmt(payment.amount)}</span>
                    </div>
                    <div className="payment-line payment-meta">
                      <span>{accountsById.get(payment.sourceAccountId)?.label ?? payment.sourceAccountId} → {describeDestination(payment.destination)}</span>
                      <span className={`pill pill-${state.tone}`}>{state.label}{payment.failureReason ? ` · ${FAILURE_REASONS[payment.failureReason] ?? payment.failureReason}` : ''}</span>
                    </div>
                    {mayDecide && (
                      <div className="payment-actions">
                        <button type="button" className="btn btn-primary" onClick={() => decide(payment, true)}>{access.space.kind === 'administration' ? 'Viser et payer' : 'Approuver'}</button>
                        <button type="button" className="btn" onClick={() => decide(payment, false)}>Rejeter</button>
                      </div>
                    )}
                    {payment.status === 'pending_approval' && payment.initiatedBy === actor.personId && (
                      <p className="fine">En attente d’une seconde personne habilitée.</p>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : queued.length === 0 && <p className="fine">Aucun paiement pour l’instant.</p>}
        </section>
      </div>
    </div>
  );
}

type DestinationKind = PaymentDestination['type'];

function queuedAmount(amount: string, currency?: Currency): string {
  const parsed = currency ? parseMajor(amount, currency) : null;
  return parsed ? fmt(parsed) : `${amount} ${currency ?? ''}`.trim();
}

function PaymentForm({ access, positions, onDone }: { access: SpaceAccess; positions: AccountPosition[]; onDone: (message: Message) => void }) {
  const { client, actor } = useSession();
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
  // Hors ligne, seul le citoyen peut mettre un paiement en file ; un paiement pro attend une approbation en ligne.
  const offlineBlocked = !client.isOnline && access.space.kind !== 'citizen';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!source) return;
    let destination: PaymentDestination;
    if (kind === 'own_account') destination = { type: 'own_account', accountId: targetId || targets[0]?.account.id || '' };
    else if (kind === 'mobile_money') destination = { type: 'mobile_money', operator, phone: phone.trim(), ...(name.trim() ? { name: name.trim() } : {}) };
    else destination = { type: 'biller', billerId, customerReference: reference.trim() };
    setBusy(true);
    try {
      const input = { sourceAccountId: source.id, amount: amount.replace(/\s/g, ''), destination };
      const result = offlineBlocked ? null : await client.pay(actor, access.space.id, input);
      if (!result) throw new Error('Hors ligne : les paiements de cet espace demandent une connexion.');
      if (result.kind === 'queued') {
        onDone({ tone: 'wait', text: `Enregistré sur l’appareil : ${queuedAmount(input.amount, source.currency)} partira au retour du réseau, avec la même clé (jamais deux fois). Sans réseau sous 24 h, il expire.` });
        setAmount('');
        return;
      }
      const payment = result.payment;
      const state = PAYMENT_STATUS[payment.status];
      onDone({
        tone: state.tone === 'ok' ? 'ok' : state.tone === 'wait' ? 'wait' : 'bad',
        text: payment.status === 'pending_approval'
          ? `${fmt(payment.amount)} : en attente d’approbation.`
          : `${fmt(payment.amount)} : ${state.label.toLowerCase()}${payment.failureReason ? ` (${FAILURE_REASONS[payment.failureReason] ?? payment.failureReason})` : ''}.`,
      });
      if (payment.status !== 'failed') setAmount('');
    } catch (cause) {
      onDone({ tone: 'bad', text: (cause as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const hint = access.space.kind === 'business'
    ? `Au-delà de ${fmt(BUSINESS_APPROVAL_THRESHOLD)}, le paiement attend l’approbation du dirigeant.`
    : access.space.kind === 'administration'
      ? 'Chaque mandat est visé et payé par le comptable public.'
      : !client.isOnline ? 'Hors ligne : le paiement sera gardé sur l’appareil et envoyé au retour du réseau.' : null;

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
      <button type="submit" className="btn btn-primary btn-block" disabled={busy || !source || offlineBlocked || (kind === 'own_account' && targets.length === 0)}>
        {access.space.kind === 'administration' ? 'Émettre le mandat' : !client.isOnline ? 'Enregistrer pour envoi' : 'Payer'}
      </button>
    </form>
  );
}
