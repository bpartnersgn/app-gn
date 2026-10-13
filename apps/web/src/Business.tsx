import { useState, type FormEvent } from 'react';
import {
  ACCOUNT_KIND_LABELS,
  BUSINESS_APPROVAL_THRESHOLD,
  type AccountPosition,
  type AuditEntry,
  type BatchView,
  type BillState,
  type BillView,
  type BusinessScore,
  type Certificate,
  type ChainCheck,
  type Employee,
  type InvoiceState,
  type InvoiceView,
  type Money,
  type RailOption,
  type SpaceAccess,
  type TreasuryView,
  type VatComputation,
  type VatReturnView,
  type VatState,
} from '@app-gn/core';
import { useSession } from './context.ts';
import {
  AccountSelect,
  addDaysTo,
  day,
  debitableGnf,
  download,
  Kpi,
  Loading,
  money,
  Notice,
  OPERATOR_LABELS,
  OperatorSelect,
  Panel,
  period,
  Pill,
  recentPeriods,
  today,
  useDesk,
  useDeskAction,
  type Tone,
} from './desk.tsx';
import { dateTime, fmt, PAYMENT_STATUS } from './format.ts';

interface Props {
  access: SpaceAccess;
  positions: AccountPosition[];
  version: number;
  onChange: () => void;
}

const can = (access: SpaceAccess, permission: string) => (access.permissions as readonly string[]).includes(permission);

// ── Trésorerie ────────────────────────────────────────────────────────────────

const FORECAST_LABELS = { receivable: 'Encaissement attendu', payable: 'Fournisseur', payroll: 'Paie', vat: 'TVA' } as const;

export function TreasurySection({ access, version }: Props) {
  const treasury = useDesk<TreasuryView>(access.space.id, 'business/treasury', version);
  const view = treasury.data;
  return (
    <Loading state={treasury}>
      {view && (
        <>
          <section className="hero" aria-labelledby="treasury-title">
            <div className="hero-figure">
              <h2 id="treasury-title" className="eyebrow">Disponible en GNF, J+0</h2>
              <p className="hero-total">{fmt(view.cash)}</p>
              <p className="hero-sub">
                {view.accounts.length} comptes · {dateTime(view.asOf)}
                {view.foreign.length > 0 && <> · en devises, à part : {view.foreign.map((entry) => `${entry.label} ${fmt(entry.balance)}`).join(', ')}</>}
              </p>
              {view.partial && <p className="notice notice-wait">Vue partielle : un fournisseur ne répond pas, son dernier solde connu est utilisé ou il est exclu.</p>}
            </div>
            <div className="kpis">
              <Kpi label="Point bas sur 7 jours" value={fmt(view.lowest.balance)} tone={view.tension ? 'bad' : 'ok'} hint={view.tension ? `le ${day(view.lowest.date)} : prévoir un encaissement ou décaler un paiement` : `le ${day(view.lowest.date)}`} />
              <Kpi label="Créances en retard" value={fmt(view.overdueReceivables)} tone={BigInt(view.overdueReceivables.amount) > 0n ? 'wait' : 'ok'} hint="non comptées dans la projection" />
              <Kpi label="Fournisseurs échus" value={fmt(view.overduePayables)} tone={BigInt(view.overduePayables.amount) > 0n ? 'wait' : 'ok'} hint="comptés aujourd’hui" />
            </div>
          </section>

          <div className="columns columns-desk">
            <div className="col-main">
              <Panel title="Projection à 7 jours" id="forecast-title">
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Jour</th><th className="num">Entrées</th><th className="num">Sorties</th><th className="num">Solde prévu</th><th>Échéances</th></tr></thead>
                    <tbody>
                      {view.projection.map((row, index) => (
                        <tr key={row.date} data-tension={row.tension || undefined}>
                          <td>{index === 0 ? 'Aujourd’hui' : day(row.date)}</td>
                          <td className="num pos">{BigInt(row.inflows.amount) > 0n ? `+${fmt(row.inflows)}` : ''}</td>
                          <td className="num neg">{BigInt(row.outflows.amount) > 0n ? `−${fmt(row.outflows)}` : ''}</td>
                          <td className="num strong">{fmt(row.balance)}</td>
                          <td><div className="items">{row.items.map((item) => <span key={item.label} className="item" data-kind={item.kind}>{FORECAST_LABELS[item.kind]} · {item.label} · {fmt(item.amount)}</span>)}</div></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="fine">Entrées : factures émises à leur échéance (les retards ne sont pas comptés). Sorties : fournisseurs, paie du mois, TVA avant le 15.</p>
              </Panel>
            </div>
            <div className="col-side">
              <Panel title="Par rail" id="rails-title">
                <ul className="rows">
                  {view.byRail.map((rail) => (
                    <li key={rail.kind} className="row"><span><span className="swatch" data-account-kind={rail.kind} aria-hidden="true" />{ACCOUNT_KIND_LABELS[rail.kind]} · {rail.accounts}</span><strong>{fmt(rail.total)}</strong></li>
                  ))}
                </ul>
              </Panel>
              <Panel title="Comptes" id="treasury-accounts">
                <ul className="rows">
                  {view.accounts.map((account) => (
                    <li key={account.id} className="row">
                      <span>{account.label}</span>
                      <span className="row-end">{account.balance ? fmt(account.balance) : '—'} {account.freshness !== 'live' && <Pill tone="wait">{account.freshness === 'stale' ? 'ancien' : 'indisponible'}</Pill>}</span>
                    </li>
                  ))}
                </ul>
              </Panel>
            </div>
          </div>
        </>
      )}
    </Loading>
  );
}

// ── Factures de vente ─────────────────────────────────────────────────────────

const INVOICE_STATE: Record<InvoiceState, { label: string; tone: Tone }> = {
  issued: { label: 'À encaisser', tone: 'neutral' },
  overdue: { label: 'En retard', tone: 'bad' },
  paid: { label: 'Encaissée', tone: 'ok' },
  cancelled: { label: 'Annulée', tone: 'neutral' },
};

interface InvoiceList { invoices: InvoiceView[]; chain: ChainCheck; outstanding: Money; overdue: Money }
interface Suggestion { invoiceId: string; number: string; accountId: string; accountLabel: string; transactionId: string; occurredAt: string; amount: Money; counterparty?: string }

export function InvoicesSection({ access, positions, version, onChange }: Props) {
  const spaceId = access.space.id;
  const list = useDesk<InvoiceList>(spaceId, 'business/invoices', version);
  const writer = can(access, 'invoices:write');
  const suggestions = useDesk<Suggestion[]>(spaceId, writer ? 'business/reconciliation' : 'business/invoices', version);
  const action = useDeskAction(spaceId, onChange);
  const [acting, setActing] = useState<{ id: string; kind: 'settle' | 'cancel' } | null>(null);
  const [accountId, setAccountId] = useState('');
  const [reason, setReason] = useState('');
  const accounts = debitableGnf(positions);

  return (
    <div className="columns columns-desk">
      <div className="col-main">
        <Loading state={list}>
          {list.data && (
            <>
              <div className="kpis">
                <Kpi label="À encaisser" value={fmt(list.data.outstanding)} />
                <Kpi label="En retard" value={fmt(list.data.overdue)} tone={BigInt(list.data.overdue.amount) > 0n ? 'bad' : 'ok'} />
                <Kpi label="Chaîne des sceaux" value={list.data.chain.intact ? 'Intègre' : 'Rompue'} tone={list.data.chain.intact ? 'ok' : 'bad'} hint={list.data.chain.intact ? `${list.data.chain.checked} facture(s) vérifiée(s)` : `à partir de la facture n° ${list.data.chain.brokenAt}`} />
              </div>
              <Panel title="Factures" id="invoices-title">
                <Notice message={action.message} />
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>N° · émise</th><th>Client</th><th>Échéance</th><th className="num">TTC</th><th>État</th>{writer && <th />}</tr></thead>
                    <tbody>
                      {list.data.invoices.map((invoice) => (
                        <tr key={invoice.id}>
                          <td><span className="mono" title={`Sceau ${invoice.seal.hash}`}>{invoice.number}</span><span className="fine block">{day(invoice.issueDate)}</span></td>
                          <td className="name">{invoice.customer.name}</td>
                          <td className="date">{day(invoice.dueDate)}</td>
                          <td className="num">{fmt(invoice.total)}</td>
                          <td>
                            <Pill tone={INVOICE_STATE[invoice.state].tone}>{INVOICE_STATE[invoice.state].label}{invoice.daysOverdue ? ` · ${invoice.daysOverdue} j` : ''}</Pill>
                            {invoice.cancellation && <span className="fine block">{invoice.cancellation.reason}</span>}
                          </td>
                          {writer && (
                            <td className="actions">
                              {(invoice.state === 'issued' || invoice.state === 'overdue') && acting?.id !== invoice.id && (
                                <>
                                  <button type="button" className="btn btn-small" onClick={() => { setActing({ id: invoice.id, kind: 'settle' }); setAccountId(accounts[0]?.account.id ?? ''); }}>Encaissée</button>
                                  <button type="button" className="btn btn-small btn-quiet" onClick={() => { setActing({ id: invoice.id, kind: 'cancel' }); setReason(''); }}>Annuler</button>
                                </>
                              )}
                              {acting?.id === invoice.id && (
                                <form className="inline-form" onSubmit={(event) => {
                                  event.preventDefault();
                                  const done = () => setActing(null);
                                  if (acting.kind === 'settle') void action.run('POST', `business/invoices/${invoice.id}/settle`, { accountId }, () => ({ tone: 'ok', text: `${invoice.number} encaissée.` })).then(done);
                                  else void action.run('POST', `business/invoices/${invoice.id}/cancel`, { reason }, () => ({ tone: 'ok', text: `${invoice.number} annulée ; elle garde son numéro.` })).then(done);
                                }}>
                                  {acting.kind === 'settle'
                                    ? <select aria-label="Compte crédité" value={accountId} onChange={(event) => setAccountId(event.target.value)}>{accounts.map((position) => <option key={position.account.id} value={position.account.id}>{position.account.label}</option>)}</select>
                                    : <input aria-label="Motif d’annulation" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Motif" required />}
                                  <button type="submit" className="btn btn-small btn-primary" disabled={action.busy}>OK</button>
                                  <button type="button" className="btn btn-small btn-quiet" onClick={() => setActing(null)}>×</button>
                                </form>
                              )}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </>
          )}
        </Loading>
      </div>
      <div className="col-side">
        {writer && <InvoiceForm spaceId={spaceId} onChange={onChange} />}
        {writer && Array.isArray(suggestions.data) && suggestions.data.length > 0 && (
          <Panel title="Rapprochement" id="reconcile-title">
            <p className="fine">Encaissements reçus du montant exact d’une facture ouverte.</p>
            <ul className="rows">
              {suggestions.data.map((suggestion) => (
                <li key={suggestion.transactionId} className="row row-stack">
                  <span><strong>{suggestion.number}</strong> · {fmt(suggestion.amount)} reçu le {day(suggestion.occurredAt)} sur {suggestion.accountLabel}{suggestion.counterparty ? ` (${suggestion.counterparty})` : ''}</span>
                  <button type="button" className="btn btn-small" disabled={action.busy} onClick={() => void action.run('POST', `business/invoices/${suggestion.invoiceId}/settle`, { accountId: suggestion.accountId, transactionId: suggestion.transactionId, receivedOn: suggestion.occurredAt.slice(0, 10) }, () => ({ tone: 'ok', text: `${suggestion.number} rapprochée.` }))}>Rapprocher</button>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>
    </div>
  );
}

function InvoiceForm({ spaceId, onChange }: { spaceId: string; onChange: () => void }) {
  const action = useDeskAction(spaceId, onChange);
  const [customer, setCustomer] = useState('');
  const [phone, setPhone] = useState('');
  const [lines, setLines] = useState([{ description: '', quantity: '1', unitPrice: '' }]);
  const [vat, setVat] = useState(true);
  const [dueInDays, setDueInDays] = useState('30');
  const subtotal = lines.reduce((total, line) => total + (BigInt(/^\d+$/.test(line.unitPrice.replace(/\s/g, '')) ? line.unitPrice.replace(/\s/g, '') : '0') * BigInt(/^\d+$/.test(line.quantity) ? line.quantity : '0')), 0n);
  const vatAmount = vat ? (subtotal * 1800n + 5000n) / 10000n : 0n;
  const gnf = (value: bigint): Money => ({ amount: value.toString(), currency: 'GNF' });

  async function submit(event: FormEvent) {
    event.preventDefault();
    const issued = await action.run<InvoiceView>('POST', 'business/invoices', {
      customer: { name: customer, ...(phone.trim() ? { phone: phone.trim() } : {}) },
      lines: lines.map((line) => ({ description: line.description, quantity: Number(line.quantity), unitPrice: line.unitPrice.replace(/\s/g, '') })),
      vatRateBps: vat ? 1800 : 0,
      dueInDays: Number(dueInDays),
    }, (invoice) => ({ tone: 'ok', text: `${invoice.number} émise et scellée : ${fmt(invoice.total)}, échéance le ${day(invoice.dueDate)}.` }), true);
    if (issued) {
      setCustomer('');
      setPhone('');
      setLines([{ description: '', quantity: '1', unitPrice: '' }]);
    }
  }

  return (
    <Panel title="Nouvelle facture" id="invoice-form-title">
      <form className="pay-form" onSubmit={submit}>
        <div className="field-row">
          <label className="field"><span>Client</span><input id="inv-customer" value={customer} onChange={(event) => setCustomer(event.target.value)} required /></label>
          <label className="field"><span>Téléphone (relance)</span><input id="inv-phone" value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="tel" placeholder="+224 …" /></label>
        </div>
        {lines.map((line, index) => (
          <div key={index} className="field-row line-row">
            <label className="field field-wide"><span>Désignation</span><input id={`inv-desc-${index}`} value={line.description} onChange={(event) => setLines(lines.map((candidate, at) => at === index ? { ...candidate, description: event.target.value } : candidate))} required /></label>
            <label className="field"><span>Qté</span><input id={`inv-qty-${index}`} value={line.quantity} onChange={(event) => setLines(lines.map((candidate, at) => at === index ? { ...candidate, quantity: event.target.value } : candidate))} inputMode="numeric" required /></label>
            <label className="field"><span>Prix unitaire HT</span><input id={`inv-price-${index}`} value={line.unitPrice} onChange={(event) => setLines(lines.map((candidate, at) => at === index ? { ...candidate, unitPrice: event.target.value } : candidate))} inputMode="numeric" required /></label>
          </div>
        ))}
        <button type="button" className="link" onClick={() => setLines([...lines, { description: '', quantity: '1', unitPrice: '' }])}>+ Ajouter une ligne</button>
        <div className="field-row">
          <label className="field"><span>TVA</span><select id="inv-vat" value={vat ? '18' : '0'} onChange={(event) => setVat(event.target.value === '18')}><option value="18">18 %</option><option value="0">Exonéré</option></select></label>
          <label className="field"><span>Échéance</span><select id="inv-due" value={dueInDays} onChange={(event) => setDueInDays(event.target.value)}>{['0', '15', '30', '45', '60'].map((days) => <option key={days} value={days}>{days === '0' ? 'À réception' : `${days} jours`}</option>)}</select></label>
        </div>
        <dl className="totals">
          <dt>Total HT</dt><dd>{fmt(gnf(subtotal))}</dd>
          <dt>TVA</dt><dd>{fmt(gnf(vatAmount))}</dd>
          <dt>Total TTC</dt><dd className="strong">{fmt(gnf(subtotal + vatAmount))}</dd>
        </dl>
        <button type="submit" className="btn btn-primary btn-block" disabled={action.busy}>Émettre la facture</button>
        <p className="fine">Le numéro suit le dernier, sans trou ; la facture est scellée et ne se modifie plus.</p>
        <Notice message={action.message} />
      </form>
    </Panel>
  );
}

// ── Fournisseurs et lots ───────────────────────────────────────────────────────

const BILL_STATE: Record<BillState, { label: string; tone: Tone }> = {
  to_pay: { label: 'À payer', tone: 'neutral' },
  overdue: { label: 'Échue', tone: 'bad' },
  awaiting_approval: { label: 'Lot à approuver', tone: 'wait' },
  processing: { label: 'En cours', tone: 'neutral' },
  paid: { label: 'Payée', tone: 'ok' },
};

const BATCH_STATE: Record<BatchView['status'], { label: string; tone: Tone }> = {
  pending_approval: { label: 'À approuver', tone: 'wait' },
  executing: { label: 'En cours', tone: 'neutral' },
  executed: { label: 'Exécuté', tone: 'ok' },
  rejected: { label: 'Refusé', tone: 'bad' },
};

export function SuppliersSection({ access, positions, version, onChange }: Props) {
  const spaceId = access.space.id;
  const bills = useDesk<BillView[]>(spaceId, 'business/bills', version);
  const batches = useDesk<BatchView[]>(spaceId, 'business/batches', version);
  const payer = can(access, 'payments:initiate');
  const action = useDeskAction(spaceId, onChange);
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<{ total: Money; lines: number; options: RailOption[] } | null>(null);
  const [source, setSource] = useState('');
  const payable = (bills.data ?? []).filter((bill) => bill.state === 'to_pay' || bill.state === 'overdue');
  const selectedTotal = payable.filter((bill) => selected.includes(bill.id)).reduce((total, bill) => total + BigInt(bill.amount.amount), 0n);

  async function prepare() {
    const result = await action.run<{ total: Money; lines: number; options: RailOption[] }>('POST', 'business/batches/preview', { billIds: selected }, () => null);
    if (result) {
      setPreview(result);
      setSource(result.options.find((option) => option.recommended)?.accountId ?? result.options[0]?.accountId ?? '');
    }
  }

  async function submit() {
    const batch = await action.run<BatchView>('POST', 'business/batches', { billIds: selected, sourceAccountId: source }, (result) => ({
      tone: result.status === 'pending_approval' ? 'wait' : 'ok',
      text: result.status === 'pending_approval'
        ? `${result.lines.length} facture(s), ${fmt(result.total)} : au-delà de ${fmt(BUSINESS_APPROVAL_THRESHOLD)}, le lot attend l’approbation du dirigeant.`
        : `${result.counts.completed} paiement(s) exécuté(s) sur ${result.lines.length}, depuis ${result.sourceLabel}.`,
    }), true);
    if (batch) {
      setSelected([]);
      setPreview(null);
    }
  }

  return (
    <div className="columns columns-desk">
      <div className="col-main">
        <Panel title="Factures fournisseurs" id="bills-title">
          <Notice message={action.message} />
          <Loading state={bills}>
            <div className="table-wrap">
              <table className="table">
                <thead><tr>{payer && <th aria-label="Choisir" />}<th>Fournisseur</th><th>Réf.</th><th>Échéance</th><th className="num">TTC</th><th>Wallet</th><th>État</th></tr></thead>
                <tbody>
                  {(bills.data ?? []).map((bill) => {
                    const selectable = payer && (bill.state === 'to_pay' || bill.state === 'overdue');
                    return (
                      <tr key={bill.id}>
                        {payer && <td>{selectable && <input type="checkbox" aria-label={`Payer ${bill.reference}`} checked={selected.includes(bill.id)} onChange={(event) => { setPreview(null); setSelected(event.target.checked ? [...selected, bill.id] : selected.filter((id) => id !== bill.id)); }} />}</td>}
                        <td className="name">{bill.supplier.name}</td>
                        <td className="mono">{bill.reference}</td>
                        <td className="date">{day(bill.dueDate)}</td>
                        <td className="num">{fmt(bill.amount)}</td>
                        <td>{OPERATOR_LABELS[bill.payee.operator]}</td>
                        <td><Pill tone={BILL_STATE[bill.state].tone}>{BILL_STATE[bill.state].label}</Pill>{bill.lastFailure && <span className="fine block">{bill.lastFailure}</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Loading>
          {payer && selected.length > 0 && !preview && (
            <div className="bar">
              <span>{selected.length} facture(s) · {fmt({ amount: selectedTotal.toString(), currency: 'GNF' })}</span>
              <button type="button" className="btn btn-primary" disabled={action.busy} onClick={() => void prepare()}>Préparer le lot</button>
            </div>
          )}
          {preview && (
            <div className="batch-preview">
              <h3 className="group-title">Depuis quel compte ? (frais selon le rail)</h3>
              <ul className="rows">
                {preview.options.map((option) => (
                  <li key={option.accountId} className="row">
                    <label className="radio">
                      <input type="radio" name="batch-source" value={option.accountId} checked={source === option.accountId} disabled={!option.sufficient} onChange={() => setSource(option.accountId)} />
                      <span>{option.label} <span className="fine">· {ACCOUNT_KIND_LABELS[option.kind]}{option.balance ? ` · ${fmt(option.balance)}` : ' · solde indisponible'}</span></span>
                    </label>
                    <span className="row-end">frais {fmt(option.fees)} {option.recommended && <Pill tone="ok">moins cher</Pill>}{!option.sufficient && <Pill tone="bad">solde insuffisant</Pill>}</span>
                  </li>
                ))}
              </ul>
              <div className="bar">
                <span>{preview.lines} paiement(s) · {fmt(preview.total)}</span>
                <button type="button" className="btn btn-quiet" onClick={() => setPreview(null)}>Annuler</button>
                <button type="button" className="btn btn-primary" disabled={action.busy || !source} onClick={() => void submit()}>Payer le lot</button>
              </div>
              <p className="fine">Barème simulé : même opérateur 0,5 %, autre opérateur 1,5 %, banque 1 %. Chaque ligne part avec sa propre clé : un lot rejoué ne paie jamais deux fois.</p>
            </div>
          )}
        </Panel>
        <BatchesPanel access={access} batches={batches.data?.filter((batch) => batch.kind === 'suppliers') ?? []} onChange={onChange} title="Lots fournisseurs" />
      </div>
      <div className="col-side">
        {can(access, 'invoices:write') && <BillForm spaceId={spaceId} onChange={onChange} />}
        {!payer && <p className="fine">Votre rôle enregistre les factures ; le paiement est préparé par la direction financière.</p>}
        {positions.length === 0 && null}
      </div>
    </div>
  );
}

function BatchesPanel({ access, batches, onChange, title }: { access: SpaceAccess; batches: BatchView[]; onChange: () => void; title: string }) {
  const { actor } = useSession();
  const action = useDeskAction(access.space.id, onChange);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const approver = can(access, 'payments:approve');
  if (batches.length === 0) return null;
  return (
    <Panel title={title} id={`batches-${title}`}>
      <Notice message={action.message} />
      <ul className="cards-list">
        {batches.map((batch) => (
          <li key={batch.id} className="card-item" data-status={batch.status}>
            <div className="card-line">
              <button type="button" className="link-strong" aria-expanded={open === batch.id} onClick={() => setOpen(open === batch.id ? null : batch.id)}>{batch.reference}</button>
              <strong>{fmt(batch.total)}</strong>
            </div>
            <div className="card-line fine">
              <span>{batch.lines.length} ligne(s) · depuis {batch.sourceLabel} · frais estimés {fmt(batch.estimatedFees)} · {dateTime(batch.initiatedAt)}</span>
              <Pill tone={BATCH_STATE[batch.status].tone}>{BATCH_STATE[batch.status].label}</Pill>
            </div>
            {batch.status === 'executed' && <p className="fine">{batch.counts.completed} payé(s){batch.counts.processing ? `, ${batch.counts.processing} en cours` : ''}{batch.counts.failed ? `, ${batch.counts.failed} en échec` : ''}</p>}
            {batch.rejectionReason && <p className="fine">Refusé : {batch.rejectionReason}</p>}
            {open === batch.id && (batch.linesHidden
              ? <p className="fine">Détail nominatif réservé à la RH et au dirigeant.</p>
              : (
                <ul className="rows">
                  {batch.lines.map((line) => (
                    <li key={line.ref} className="row">
                      <span>{line.beneficiary}</span>
                      <span className="row-end">{line.amount ? fmt(line.amount) : ''} <Pill tone={line.status === 'completed' ? 'ok' : line.status === 'error' || line.status === 'failed' || line.status === 'rejected' ? 'bad' : 'neutral'}>{line.status === 'pending' ? 'en attente' : line.status === 'error' ? 'erreur' : PAYMENT_STATUS[line.status].label}</Pill></span>
                    </li>
                  ))}
                </ul>
              ))}
            {batch.status === 'pending_approval' && approver && batch.initiatedBy !== actor.personId && (
              rejecting === batch.id ? (
                <form className="inline-form" onSubmit={(event) => { event.preventDefault(); void action.run('POST', `business/batches/${batch.id}/reject`, { reason }, () => ({ tone: 'ok', text: `${batch.reference} refusé ; les factures redeviennent à payer.` })).then(() => setRejecting(null)); }}>
                  <input aria-label="Motif du refus" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Motif du refus" required />
                  <button type="submit" className="btn btn-small" disabled={action.busy}>Refuser</button>
                  <button type="button" className="btn btn-small btn-quiet" onClick={() => setRejecting(null)}>×</button>
                </form>
              ) : (
                <div className="payment-actions">
                  <button type="button" className="btn btn-primary" disabled={action.busy} onClick={() => void action.run<BatchView>('POST', `business/batches/${batch.id}/approve`, {}, (result) => ({ tone: 'ok', text: `${result.reference} approuvé : ${result.counts.completed} paiement(s) exécuté(s).` }))}>Approuver et payer</button>
                  <button type="button" className="btn" onClick={() => { setRejecting(batch.id); setReason(''); }}>Refuser</button>
                </div>
              )
            )}
            {batch.status === 'pending_approval' && batch.initiatedBy === actor.personId && <p className="fine">En attente d’une seconde personne habilitée.</p>}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function BillForm({ spaceId, onChange }: { spaceId: string; onChange: () => void }) {
  const action = useDeskAction(spaceId, onChange);
  const [supplier, setSupplier] = useState('');
  const [reference, setReference] = useState('');
  const [amount, setAmount] = useState('');
  const [vat, setVat] = useState('');
  const [dueDate, setDueDate] = useState(addDaysTo(today(), 30));
  const [operator, setOperator] = useState('orange_money');
  const [phone, setPhone] = useState('+224 ');
  async function submit(event: FormEvent) {
    event.preventDefault();
    const recorded = await action.run<BillView>('POST', 'business/bills', {
      supplier: { name: supplier }, reference, amount: amount.replace(/\s/g, ''), vat: vat.replace(/\s/g, '') || undefined, dueDate, payee: { operator, phone },
    }, (bill) => ({ tone: 'ok', text: `${bill.reference} enregistrée, à payer avant le ${day(bill.dueDate)}.` }), true);
    if (recorded) {
      setSupplier('');
      setReference('');
      setAmount('');
      setVat('');
    }
  }
  return (
    <Panel title="Enregistrer une facture fournisseur" id="bill-form-title">
      <form className="pay-form" onSubmit={submit}>
        <label className="field"><span>Fournisseur</span><input id="bill-supplier" value={supplier} onChange={(event) => setSupplier(event.target.value)} required /></label>
        <div className="field-row">
          <label className="field"><span>N° de facture</span><input id="bill-reference" value={reference} onChange={(event) => setReference(event.target.value)} required /></label>
          <label className="field"><span>Échéance</span><input id="bill-due" type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} required /></label>
        </div>
        <div className="field-row">
          <label className="field"><span>Montant TTC</span><input id="bill-amount" value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="numeric" required /></label>
          <label className="field"><span>dont TVA déductible</span><input id="bill-vat" value={vat} onChange={(event) => setVat(event.target.value)} inputMode="numeric" placeholder="0" /></label>
        </div>
        <div className="field-row">
          <OperatorSelect id="bill-operator" value={operator} onChange={setOperator} />
          <label className="field"><span>Wallet du fournisseur</span><input id="bill-phone" value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="tel" required /></label>
        </div>
        <button type="submit" className="btn btn-primary btn-block" disabled={action.busy}>Enregistrer</button>
        <Notice message={action.message} />
      </form>
    </Panel>
  );
}

// ── TVA ───────────────────────────────────────────────────────────────────────

const VAT_STATE: Record<VatState, { label: string; tone: Tone }> = {
  filed: { label: 'Déposée et payée', tone: 'ok' },
  awaiting_approval: { label: 'Paiement à approuver', tone: 'wait' },
  paying: { label: 'Paiement en cours', tone: 'neutral' },
  payment_failed: { label: 'Paiement échoué', tone: 'bad' },
};

export function VatSection({ access, positions, version, onChange }: Props) {
  const spaceId = access.space.id;
  const vat = useDesk<{ returns: VatReturnView[]; open: VatComputation[] }>(spaceId, 'business/vat', version);
  const action = useDeskAction(spaceId, onChange);
  const accounts = debitableGnf(positions);
  const [source, setSource] = useState('');
  const declarer = can(access, 'tax:declare');
  const chosen = source || accounts[0]?.account.id || '';
  return (
    <Loading state={vat}>
      {vat.data && (
        <div className="columns columns-desk">
          <div className="col-main">
            <Panel title="Mois à déclarer" id="vat-open-title">
              <Notice message={action.message} />
              {vat.data.open.length === 0 && <p className="fine">Tous les mois récents sont déclarés.</p>}
              {declarer && vat.data.open.some((computation) => BigInt(computation.due.amount) > 0n) && (
                <AccountSelect id="vat-source" positions={accounts} value={chosen} onChange={setSource} label="Payer la DGI depuis" />
              )}
              <ul className="cards-list">
                {vat.data.open.map((computation) => (
                  <li key={computation.period} className="card-item">
                    <div className="card-line"><strong className="capitalize">{period(computation.period)}</strong><span>avant le {day(computation.deadline)}</span></div>
                    <dl className="totals">
                      <dt>TVA collectée ({computation.invoices} facture(s))</dt><dd>{fmt(computation.collected)}</dd>
                      <dt>TVA déductible ({computation.bills} achat(s))</dt><dd>− {fmt(computation.deductible)}</dd>
                      {BigInt(computation.creditBrought.amount) > 0n && <><dt>Crédit reporté</dt><dd>− {fmt(computation.creditBrought)}</dd></>}
                      <dt>À payer</dt><dd className="strong">{fmt(computation.due)}</dd>
                      {BigInt(computation.creditCarried.amount) > 0n && <><dt>Crédit à reporter</dt><dd>{fmt(computation.creditCarried)}</dd></>}
                    </dl>
                    {declarer && (
                      <button type="button" className="btn btn-primary" disabled={action.busy} onClick={() => void action.run<VatReturnView>('POST', 'business/vat', { period: computation.period, sourceAccountId: chosen }, (result) => ({
                        tone: result.state === 'filed' ? 'ok' : result.state === 'payment_failed' ? 'bad' : 'wait',
                        text: result.state === 'filed' ? `TVA ${result.period} déposée, accusé ${result.acknowledgement}.` : result.state === 'awaiting_approval' ? `TVA ${result.period} : le paiement de ${fmt(result.due)} attend l’approbation du dirigeant ; la déclaration sera acquise une fois payée.` : `TVA ${result.period} : ${VAT_STATE[result.state].label.toLowerCase()}.`,
                      }), true)}>{BigInt(computation.due.amount) > 0n ? 'Déclarer et payer' : 'Déposer (rien à payer)'}</button>
                    )}
                  </li>
                ))}
              </ul>
              <p className="fine">La déclaration n’est acquise que si le paiement l’est. Un mois déclaré ne reçoit plus de facture ni d’annulation.</p>
            </Panel>
          </div>
          <div className="col-side">
            <Panel title="Déclarations" id="vat-history-title">
              {vat.data.returns.length === 0 ? <p className="fine">Aucune déclaration.</p> : (
                <ul className="rows">
                  {vat.data.returns.map((value) => (
                    <li key={value.id} className="row row-stack">
                      <span className="capitalize"><strong>{period(value.period)}</strong> · {fmt(value.due)}</span>
                      <span><Pill tone={VAT_STATE[value.state].tone}>{VAT_STATE[value.state].label}</Pill> {value.acknowledgement && <span className="mono fine">{value.acknowledgement}</span>}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </div>
      )}
    </Loading>
  );
}

// ── Équipe et paie ──────────────────────────────────────────────────────────

export function TeamSection({ access, positions, version, onChange }: Props) {
  const spaceId = access.space.id;
  const team = useDesk<{ employees: Employee[]; certificates: Certificate[]; monthlyPayroll: Money }>(spaceId, 'business/team', version);
  const batches = useDesk<BatchView[]>(spaceId, 'business/batches', version);
  const action = useDeskAction(spaceId, onChange);
  const accounts = debitableGnf(positions);
  const [payPeriod, setPayPeriod] = useState(recentPeriods(1, true)[0]!);
  const [source, setSource] = useState('');
  const [leaving, setLeaving] = useState<string | null>(null);
  const [leftOn, setLeftOn] = useState(today());
  const chosen = source || accounts[0]?.account.id || '';
  const certifies = can(access, 'documents:write');
  const names = new Map((team.data?.employees ?? []).map((employee) => [employee.id, employee.fullName]));

  return (
    <div className="columns columns-desk">
      <div className="col-main">
        <Loading state={team}>
          {team.data && (
            <Panel title="Registre du personnel" id="team-title" actions={<span className="fine">Masse salariale nette : <strong>{fmt(team.data.monthlyPayroll)}</strong> / mois</span>}>
              <Notice message={action.message} />
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Nom</th><th>Poste</th><th>Depuis</th><th className="num">Net mensuel</th><th>Versement</th><th /></tr></thead>
                  <tbody>
                    {team.data.employees.map((employee) => (
                      <tr key={employee.id} data-muted={employee.status === 'left' || undefined}>
                        <td>{employee.fullName}<span className="fine block mono">{employee.nin}</span></td>
                        <td>{employee.position}</td>
                        <td className="date">{day(employee.hiredOn, true)}</td>
                        <td className="num">{fmt(employee.monthlyNet)}</td>
                        <td>{OPERATOR_LABELS[employee.payout.operator]}</td>
                        <td className="actions">
                          {employee.status === 'left' ? <Pill tone="neutral">Sorti le {day(employee.leftOn!)}</Pill> : leaving === employee.id ? (
                            <form className="inline-form" onSubmit={(event) => { event.preventDefault(); void action.run('POST', `business/team/${employee.id}/leave`, { leftOn }, () => ({ tone: 'ok', text: `Sortie de ${employee.fullName} enregistrée.` })).then(() => setLeaving(null)); }}>
                              <input type="date" aria-label="Date de sortie" value={leftOn} onChange={(event) => setLeftOn(event.target.value)} required />
                              <button type="submit" className="btn btn-small">OK</button>
                              <button type="button" className="btn btn-small btn-quiet" onClick={() => setLeaving(null)}>×</button>
                            </form>
                          ) : (
                            <>
                              {certifies && <button type="button" className="btn btn-small" disabled={action.busy} onClick={() => void action.run<Certificate>('POST', `business/team/${employee.id}/certificates`, {}, (certificate) => ({ tone: 'ok', text: `Attestation de ${certificate.holderName} émise, code ${certificate.verificationCode}. Si ${certificate.holderName.split(' ')[0]} utilise App GN, elle est déjà dans son coffre personnel.` }))}>Attestation</button>}
                              <button type="button" className="btn btn-small btn-quiet" onClick={() => setLeaving(employee.id)}>Sortie</button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
        </Loading>
        <BatchesPanel access={access} batches={batches.data?.filter((batch) => batch.kind === 'payroll') ?? []} onChange={onChange} title="Paies" />
      </div>
      <div className="col-side">
        <Panel title="Préparer la paie" id="payroll-title">
          <div className="pay-form">
            <label className="field"><span>Mois</span><select id="payroll-period" value={payPeriod} onChange={(event) => setPayPeriod(event.target.value)}>{recentPeriods(3, true).map((value) => <option key={value} value={value}>{period(value)}</option>)}</select></label>
            <AccountSelect id="payroll-source" positions={accounts} value={chosen} onChange={setSource} />
            <button type="button" className="btn btn-primary btn-block" disabled={action.busy} onClick={() => void action.run<BatchView>('POST', 'business/payroll', { period: payPeriod, sourceAccountId: chosen }, (batch) => ({
              tone: batch.status === 'pending_approval' ? 'wait' : 'ok',
              text: batch.status === 'pending_approval' ? `${batch.reference} : ${batch.lines.length} salarié(s), ${fmt(batch.total)}, en attente de l’approbation du dirigeant.` : `${batch.reference} versée : ${batch.counts.completed} salaire(s).`,
            }), true)}>Préparer</button>
            <p className="fine">Un salaire par salarié actif, versé sur son wallet. Préparée par la RH, la paie part après l’approbation du dirigeant.</p>
          </div>
        </Panel>
        <HireForm spaceId={spaceId} onChange={onChange} />
        {team.data && team.data.certificates.length > 0 && (
          <Panel title="Attestations émises" id="certificates-title">
            <ul className="rows">
              {team.data.certificates.map((certificate) => (
                <li key={certificate.id} className="row row-stack"><span>{names.get(certificate.employeeId) ?? certificate.holderName} · {day(certificate.issuedOn)}</span><span className="mono fine">{certificate.verificationCode}</span></li>
              ))}
            </ul>
          </Panel>
        )}
      </div>
    </div>
  );
}

function HireForm({ spaceId, onChange }: { spaceId: string; onChange: () => void }) {
  const action = useDeskAction(spaceId, onChange);
  const [form, setForm] = useState({ fullName: '', nin: 'GN-NIN-', position: '', hiredOn: today(), monthlyNet: '', operator: 'orange_money', phone: '+224 ' });
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value });
  async function submit(event: FormEvent) {
    event.preventDefault();
    const hired = await action.run<Employee>('POST', 'business/team', {
      fullName: form.fullName, nin: form.nin, position: form.position, hiredOn: form.hiredOn, monthlyNet: form.monthlyNet.replace(/\s/g, ''), payout: { operator: form.operator, phone: form.phone },
    }, (employee) => ({ tone: 'ok', text: `${employee.fullName} inscrit au registre.` }), true);
    if (hired) setForm({ ...form, fullName: '', nin: 'GN-NIN-', position: '', monthlyNet: '' });
  }
  return (
    <Panel title="Embaucher" id="hire-title">
      <form className="pay-form" onSubmit={submit}>
        <div className="field-row">
          <label className="field"><span>Nom</span><input id="hire-name" value={form.fullName} onChange={set('fullName')} required /></label>
          <label className="field"><span>NIN</span><input id="hire-nin" value={form.nin} onChange={set('nin')} required /></label>
        </div>
        <div className="field-row">
          <label className="field"><span>Poste</span><input id="hire-position" value={form.position} onChange={set('position')} required /></label>
          <label className="field"><span>Embauché le</span><input id="hire-date" type="date" value={form.hiredOn} onChange={set('hiredOn')} required /></label>
        </div>
        <div className="field-row">
          <label className="field"><span>Net mensuel</span><input id="hire-net" value={form.monthlyNet} onChange={set('monthlyNet')} inputMode="numeric" required /></label>
          <OperatorSelect id="hire-operator" value={form.operator} onChange={(value) => setForm({ ...form, operator: value })} />
          <label className="field"><span>Wallet</span><input id="hire-phone" value={form.phone} onChange={set('phone')} inputMode="tel" required /></label>
        </div>
        <button type="submit" className="btn btn-primary btn-block" disabled={action.busy}>Inscrire</button>
        <Notice message={action.message} />
      </form>
    </Panel>
  );
}

// ── Score ───────────────────────────────────────────────────────────────────

export function ScoreSection({ access, version }: Props) {
  const score = useDesk<BusinessScore>(access.space.id, 'business/score', version);
  return (
    <Loading state={score}>
      {score.data && (
        <div className="columns columns-desk">
          <div className="col-main">
            <section className="hero score-hero" aria-labelledby="score-title">
              <div className="hero-figure">
                <h2 id="score-title" className="eyebrow">Score B2B indicatif</h2>
                <p className="hero-total">{score.data.score}<span className="hero-unit"> / 100</span> <span className="grade" data-grade={score.data.grade}>{score.data.grade}</span></p>
                <p className="hero-sub">{score.data.notice}</p>
              </div>
            </section>
            <Panel title="Critères" id="criteria-title">
              <ul className="criteria">
                {score.data.criteria.map((criterion) => (
                  <li key={criterion.key} className="criterion">
                    <div className="card-line"><strong>{criterion.label}</strong><span>{criterion.score} / 100 · poids {criterion.weight} %</span></div>
                    <div className="meter"><span className="meter-seg" data-tone={criterion.score >= 65 ? 'ok' : criterion.score >= 40 ? 'wait' : 'bad'} style={{ width: `${criterion.score}%` }} /></div>
                    <span className="fine">{criterion.detail}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
          <div className="col-side">
            <Panel title="Pour l’améliorer" id="score-tips">
              <ul className="tips">
                <li>Relancer les factures en retard et rapprocher les encaissements reçus.</li>
                <li>Payer les fournisseurs avant l’échéance, par lots.</li>
                <li>Déclarer et payer la TVA chaque mois avant le 15.</li>
                <li>Renouveler les pièces du dossier légal avant leur expiration.</li>
              </ul>
            </Panel>
          </div>
        </div>
      )}
    </Loading>
  );
}

// ── Journal (comptabilité et piste d'audit) ────────────────────────────────────

export function AuditSection({ access, version, onChange, kind }: Props & { kind: 'business' | 'administration' }) {
  const spaceId = access.space.id;
  const trail = useDesk<{ entries: AuditEntry[]; check: ChainCheck }>(spaceId, `${kind}/audit`, version);
  const action = useDeskAction(spaceId, onChange);
  const [ledgerPeriod, setLedgerPeriod] = useState(recentPeriods(1, true)[0]!);
  return (
    <div className="columns columns-desk">
      <div className="col-main">
        <Panel title="Piste d’audit" id="audit-title" actions={trail.data && <Pill tone={trail.data.check.intact ? 'ok' : 'bad'}>{trail.data.check.intact ? `Chaîne intègre · ${trail.data.check.checked} entrées` : `Chaîne rompue à l’entrée ${trail.data.check.brokenAt}`}</Pill>}>
          <Loading state={trail}>
            <ol className="audit">
              {(trail.data?.entries ?? []).map((entry) => (
                <li key={entry.id} className="audit-entry">
                  <span className="audit-seq mono">#{entry.sequence}</span>
                  <span className="audit-body"><strong>{entry.summary}</strong><span className="fine block">{entry.personName} · {dateTime(entry.at)} · <span className="mono">{entry.action}</span></span></span>
                  <span className="audit-hash mono" title={entry.hash}>{entry.hash.slice(0, 10)}…</span>
                </li>
              ))}
            </ol>
          </Loading>
        </Panel>
      </div>
      <div className="col-side">
        {kind === 'business' ? (
          <Panel title="Journal comptable" id="ledger-title">
            <div className="pay-form">
              <label className="field"><span>Mois</span><select id="ledger-period" value={ledgerPeriod} onChange={(event) => setLedgerPeriod(event.target.value)}>{recentPeriods(4, true).map((value) => <option key={value} value={value}>{period(value)}</option>)}</select></label>
              <button type="button" className="btn btn-primary btn-block" disabled={action.busy} onClick={() => void action.run<{ name: string; content: string }>('GET', `business/ledger/${ledgerPeriod}`, undefined, (file) => { download(file); return { tone: 'ok', text: `${file.name} téléchargé.` }; })}>Exporter (CSV)</button>
              <p className="fine">Écritures de ventes, d’achats et de banque au plan SYSCOHADA, pour l’expert-comptable ou l’ERP. Comptes indicatifs, à valider.</p>
              <Notice message={action.message} />
            </div>
          </Panel>
        ) : (
          <Panel title="Cour des Comptes" id="court-title">
            <div className="pay-form">
              <button type="button" className="btn btn-primary btn-block" disabled={action.busy} onClick={() => void action.run<{ name: string; content: string }>('GET', 'administration/court-report', undefined, (file) => { download(file); return { tone: 'ok', text: `${file.name} téléchargé.` }; })}>Compte d’exécution (CSV)</button>
              <p className="fine">Voté, engagé, liquidé, mandaté et payé par ligne, chaque mandat payé, et l’état de la piste d’audit.</p>
              <Notice message={action.message} />
            </div>
          </Panel>
        )}
        <p className="fine">Chaque entrée porte l’empreinte de la précédente : une entrée modifiée ou retirée en base casse la chaîne à cet endroit.</p>
      </div>
    </div>
  );
}
