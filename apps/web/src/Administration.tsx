import { useState, type FormEvent } from 'react';
import {
  PAYROLL_ISSUE_LABELS,
  type AccountPosition,
  type AdminPayrollView,
  type Agent,
  type BudgetView,
  type EngagementView,
  type LiquidationView,
  type MandateState,
  type Money,
  type PayrollCheck,
  type SpaceAccess,
} from '@app-gn/core';
import {
  AccountSelect,
  day,
  debitableGnf,
  Kpi,
  Loading,
  Meter,
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
import { fmt } from './format.ts';

interface Props {
  access: SpaceAccess;
  positions: AccountPosition[];
  version: number;
  onChange: () => void;
}

const can = (access: SpaceAccess, permission: string) => (access.permissions as readonly string[]).includes(permission);
const minus = (a: Money, b: Money): Money => ({ amount: (BigInt(a.amount) - BigInt(b.amount)).toString(), currency: a.currency });

// ── Exécution budgétaire ───────────────────────────────────────────────────────

export function BudgetSection({ access, version }: Props) {
  const budget = useDesk<BudgetView>(access.space.id, 'administration/budget', version);
  return (
    <Loading state={budget}>
      {budget.data && (
        <>
          <div className="kpis">
            <Kpi label={`Crédits votés ${budget.data.year}`} value={fmt(budget.data.totals.total.allocated)} />
            <Kpi label="Engagé" value={fmt(budget.data.totals.total.engaged)} />
            <Kpi label="Payé" value={fmt(budget.data.totals.total.paid)} tone="ok" />
            <Kpi label="Disponible" value={fmt(budget.data.totals.total.available)} />
          </div>
          <Panel title="Exécution par ligne" id="budget-title">
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Ligne</th><th className="num">Voté</th><th className="num">Engagé</th><th className="num">Liquidé</th><th className="num">Mandaté</th><th className="num">Payé</th><th className="num">Disponible</th><th>Exécution</th></tr></thead>
                <tbody>
                  {(['fonctionnement', 'investissement'] as const).map((section) => [
                    <tr key={section} className="table-group"><td colSpan={8}>{section === 'fonctionnement' ? 'Fonctionnement' : 'Investissement'} · voté {fmt(budget.data!.totals[section].allocated)} · payé {fmt(budget.data!.totals[section].paid)}</td></tr>,
                    ...budget.data!.lines.filter((line) => line.section === section).map((line) => (
                      <tr key={line.id}>
                        <td><span className="mono">{line.code}</span> {line.label}{line.payroll && <span className="fine block">porte la paie des agents</span>}</td>
                        <td className="num">{fmt(line.allocated)}</td>
                        <td className="num">{fmt(line.engaged)}</td>
                        <td className="num">{fmt(line.liquidated)}</td>
                        <td className="num">{fmt(line.mandated)}</td>
                        <td className="num">{fmt(line.paid)}</td>
                        <td className="num strong">{fmt(line.available)}</td>
                        <td className="meter-cell">
                          <Meter total={line.allocated} label={`Ligne ${line.code}`} parts={[{ value: line.paid, tone: 'ok', label: 'payé' }, { value: minus(line.engaged, line.paid), tone: 'wait', label: 'engagé non payé' }]} />
                          <span className="fine">{line.executionRate.toLocaleString('fr-FR')} % payé</span>
                        </td>
                      </tr>
                    )),
                  ])}
                </tbody>
              </table>
            </div>
            <p className="fine">Un engagement est refusé au-delà du disponible de sa ligne. Payé : mandats visés par le comptable public.</p>
          </Panel>
        </>
      )}
    </Loading>
  );
}

// ── Chaîne de la dépense ──────────────────────────────────────────────────────

const MANDATE_STATE: Record<MandateState, { label: string; tone: Tone }> = {
  to_mandate: { label: 'Liquidé, à mandater', tone: 'neutral' },
  awaiting_visa: { label: 'Mandat à viser', tone: 'wait' },
  paying: { label: 'Paiement en cours', tone: 'neutral' },
  paid: { label: 'Payé', tone: 'ok' },
  rejected: { label: 'Mandat rejeté', tone: 'bad' },
  failed: { label: 'Paiement échoué', tone: 'bad' },
};

export function SpendingSection({ access, positions, version, onChange }: Props) {
  const spaceId = access.space.id;
  const engagements = useDesk<EngagementView[]>(spaceId, 'administration/engagements', version);
  const budget = useDesk<BudgetView>(spaceId, 'administration/budget', version);
  const action = useDeskAction(spaceId, onChange);
  const ordonnateur = can(access, 'budget:engage');
  const comptable = can(access, 'payments:approve');
  const accounts = debitableGnf(positions);
  const [source, setSource] = useState('');
  const chosen = source || accounts[0]?.account.id || '';
  const [form, setForm] = useState<{ engagementId: string; kind: 'liquidate' | 'reject'; liquidationId?: string } | null>(null);
  const [liquidation, setLiquidation] = useState({ amount: '', invoiceReference: '', serviceDoneOn: today() });
  const [reason, setReason] = useState('');
  const queue = (engagements.data ?? []).flatMap((engagement) => engagement.liquidations.filter((candidate) => candidate.state === 'awaiting_visa').map((candidate) => ({ engagement, liquidation: candidate })));

  const mandateMessage = (view: EngagementView) => ({ tone: 'wait' as const, text: `${view.liquidations.find((candidate) => candidate.state === 'awaiting_visa')?.mandate?.number ?? 'Mandat'} émis : il attend le visa du comptable public.` });

  function LiquidationLine({ engagement, item }: { engagement: EngagementView; item: LiquidationView }) {
    return (
      <li className="row row-stack">
        <span>
          <strong>{fmt(item.amount)}</strong> · facture {item.invoiceReference} · service fait le {day(item.serviceDoneOn)}
          {item.mandate && <> · <span className="mono">{item.mandate.number}</span></>}
        </span>
        <span>
          <Pill tone={MANDATE_STATE[item.state].tone}>{MANDATE_STATE[item.state].label}</Pill>
          {item.rejectionReason && <span className="fine"> · {item.rejectionReason}</span>}
          {ordonnateur && (item.state === 'to_mandate' || item.state === 'rejected' || item.state === 'failed') && (
            <button type="button" className="btn btn-small" disabled={action.busy || !chosen} onClick={() => void action.run<EngagementView>('POST', `administration/engagements/${engagement.id}/liquidations/${item.id}/mandate`, { sourceAccountId: chosen }, mandateMessage)}>
              {item.state === 'to_mandate' ? 'Mandater' : 'Réémettre le mandat'}
            </button>
          )}
        </span>
      </li>
    );
  }

  return (
    <div className="columns columns-desk">
      <div className="col-main">
        <Notice message={action.message} />
        {comptable && (
          <Panel title="Mandats à viser" id="visa-title">
            {queue.length === 0 ? <p className="fine">Aucun mandat en attente.</p> : (
              <ul className="cards-list">
                {queue.map(({ engagement, liquidation: item }) => (
                  <li key={item.id} className="card-item" data-status="pending_approval">
                    <div className="card-line"><strong className="mono">{item.mandate!.number}</strong><strong>{fmt(item.amount)}</strong></div>
                    <dl className="checks">
                      <dt>Engagement</dt><dd>{engagement.number} · ligne {engagement.lineCode} {engagement.lineLabel}</dd>
                      <dt>Objet</dt><dd>{engagement.object}</dd>
                      <dt>Bénéficiaire</dt><dd>{engagement.supplier.name} · {OPERATOR_LABELS[engagement.payee.operator]} {engagement.payee.phone}</dd>
                      <dt>Service fait</dt><dd>le {day(item.serviceDoneOn)}, facture {item.invoiceReference}</dd>
                    </dl>
                    {form?.liquidationId === item.id && form.kind === 'reject' ? (
                      <form className="inline-form" onSubmit={(event) => { event.preventDefault(); void action.run('POST', `administration/engagements/${engagement.id}/liquidations/${item.id}/reject`, { reason }, () => ({ tone: 'ok', text: `${item.mandate!.number} rejeté ; l’ordonnateur peut le réémettre corrigé.` })).then(() => setForm(null)); }}>
                        <input aria-label="Motif du rejet" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Motif du rejet" required />
                        <button type="submit" className="btn btn-small" disabled={action.busy}>Rejeter</button>
                        <button type="button" className="btn btn-small btn-quiet" onClick={() => setForm(null)}>×</button>
                      </form>
                    ) : (
                      <div className="payment-actions">
                        <button type="button" className="btn btn-primary" disabled={action.busy} onClick={() => void action.run<EngagementView>('POST', `administration/engagements/${engagement.id}/liquidations/${item.id}/visa`, {}, () => ({ tone: 'ok', text: `${item.mandate!.number} visé et payé : ${fmt(item.amount)} à ${engagement.supplier.name}.` }))}>Viser et payer</button>
                        <button type="button" className="btn" onClick={() => { setForm({ engagementId: engagement.id, kind: 'reject', liquidationId: item.id }); setReason(''); }}>Rejeter</button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="fine">Le visa vérifie que le mandat suit une liquidation certifiée, au même montant et au même bénéficiaire que l’engagement.</p>
          </Panel>
        )}
        <Panel title="Engagements" id="engagements-title" actions={ordonnateur && accounts.length > 0 ? <AccountSelect id="mandate-source" positions={accounts} value={chosen} onChange={setSource} label="Mandats payés depuis" /> : undefined}>
          <Loading state={engagements}>
            <ul className="cards-list">
              {(engagements.data ?? []).map((engagement) => (
                <li key={engagement.id} className="card-item" data-status={engagement.status}>
                  <div className="card-line"><span><strong className="mono">{engagement.number}</strong> · ligne {engagement.lineCode}</span><strong>{fmt(engagement.amount)}</strong></div>
                  <div className="card-line fine"><span>{engagement.object} · {engagement.supplier.name} · engagé le {day(engagement.createdOn)}</span>{engagement.status === 'closed' ? <Pill tone="neutral">Clôturé</Pill> : <span>reste à liquider {fmt(engagement.remaining)}</span>}</div>
                  {engagement.liquidations.length > 0 && <ul className="rows">{engagement.liquidations.map((item) => <LiquidationLine key={item.id} engagement={engagement} item={item} />)}</ul>}
                  {ordonnateur && engagement.status === 'engaged' && (
                    form?.engagementId === engagement.id && form.kind === 'liquidate' ? (
                      <form className="inline-form wrap" onSubmit={(event) => {
                        event.preventDefault();
                        void action.run('POST', `administration/engagements/${engagement.id}/liquidations`, { ...liquidation, amount: liquidation.amount.replace(/\s/g, '') }, () => ({ tone: 'ok', text: `Service fait certifié et liquidé sur ${engagement.number}.` })).then(() => setForm(null));
                      }}>
                        <input aria-label="Montant liquidé" value={liquidation.amount} onChange={(event) => setLiquidation({ ...liquidation, amount: event.target.value })} placeholder="Montant" inputMode="numeric" required />
                        <input aria-label="Référence de la facture" value={liquidation.invoiceReference} onChange={(event) => setLiquidation({ ...liquidation, invoiceReference: event.target.value })} placeholder="Facture n°" required />
                        <input aria-label="Service fait le" type="date" value={liquidation.serviceDoneOn} onChange={(event) => setLiquidation({ ...liquidation, serviceDoneOn: event.target.value })} required />
                        <button type="submit" className="btn btn-small btn-primary" disabled={action.busy}>Certifier le service fait</button>
                        <button type="button" className="btn btn-small btn-quiet" onClick={() => setForm(null)}>×</button>
                      </form>
                    ) : (
                      <div className="payment-actions">
                        {BigInt(engagement.remaining.amount) > 0n && <button type="button" className="btn btn-small" onClick={() => { setForm({ engagementId: engagement.id, kind: 'liquidate' }); setLiquidation({ amount: engagement.remaining.amount, invoiceReference: '', serviceDoneOn: today() }); }}>Service fait</button>}
                        <button type="button" className="btn btn-small btn-quiet" disabled={action.busy} onClick={() => void action.run('POST', `administration/engagements/${engagement.id}/close`, {}, () => ({ tone: 'ok', text: `${engagement.number} clôturé ; le reste revient au disponible de la ligne.` }))}>Clôturer</button>
                      </div>
                    )
                  )}
                </li>
              ))}
            </ul>
          </Loading>
        </Panel>
      </div>
      <div className="col-side">
        {ordonnateur && budget.data && <EngageForm spaceId={spaceId} budget={budget.data} onChange={onChange} />}
        <Panel title="La chaîne de la dépense" id="chain-title">
          <ol className="steps">
            <li><strong>Engagement</strong> · l’ordonnateur réserve le crédit sur une ligne</li>
            <li><strong>Liquidation</strong> · il certifie le service fait et arrête le montant</li>
            <li><strong>Mandat</strong> · il ordonne le paiement</li>
            <li><strong>Visa et paiement</strong> · le comptable public contrôle et paie, ou rejette</li>
          </ol>
        </Panel>
      </div>
    </div>
  );
}

function EngageForm({ spaceId, budget, onChange }: { spaceId: string; budget: BudgetView; onChange: () => void }) {
  const action = useDeskAction(spaceId, onChange);
  const lines = budget.lines.filter((line) => !line.payroll);
  const [form, setForm] = useState({ lineId: lines[0]?.id ?? '', supplier: '', object: '', amount: '', operator: 'orange_money', phone: '+224 ' });
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value });
  const line = lines.find((candidate) => candidate.id === form.lineId);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const created = await action.run<EngagementView>('POST', 'administration/engagements', {
      lineId: form.lineId, supplier: { name: form.supplier }, object: form.object, amount: form.amount.replace(/\s/g, ''), payee: { operator: form.operator, phone: form.phone },
    }, (engagement) => ({ tone: 'ok', text: `${engagement.number} : ${fmt(engagement.amount)} engagés sur la ligne ${engagement.lineCode}.` }), true);
    if (created) setForm({ ...form, supplier: '', object: '', amount: '' });
  }
  return (
    <Panel title="Engager une dépense" id="engage-title">
      <form className="pay-form" onSubmit={submit}>
        <label className="field"><span>Ligne budgétaire</span>
          <select id="engage-line" value={form.lineId} onChange={set('lineId')}>
            {lines.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.code} · {candidate.label}</option>)}
          </select>
        </label>
        {line && <p className="fine">Disponible : <strong>{fmt(line.available)}</strong> sur {fmt(line.allocated)}</p>}
        <label className="field"><span>Objet</span><input id="engage-object" value={form.object} onChange={set('object')} required /></label>
        <div className="field-row">
          <label className="field"><span>Fournisseur</span><input id="engage-supplier" value={form.supplier} onChange={set('supplier')} required /></label>
          <label className="field"><span>Montant</span><input id="engage-amount" value={form.amount} onChange={set('amount')} inputMode="numeric" required /></label>
        </div>
        <div className="field-row">
          <OperatorSelect id="engage-operator" value={form.operator} onChange={(value) => setForm({ ...form, operator: value })} />
          <label className="field"><span>Wallet du fournisseur</span><input id="engage-phone" value={form.phone} onChange={set('phone')} inputMode="tel" required /></label>
        </div>
        <button type="submit" className="btn btn-primary btn-block" disabled={action.busy}>Engager</button>
        <Notice message={action.message} />
      </form>
    </Panel>
  );
}

// ── Paie des agents ───────────────────────────────────────────────────────────

const PAYROLL_STATE: Record<AdminPayrollView['state'], { label: string; tone: Tone }> = {
  awaiting_visa: { label: 'À viser', tone: 'wait' },
  partly_paid: { label: 'En partie payée', tone: 'wait' },
  paid: { label: 'Payée', tone: 'ok' },
  closed: { label: 'Close', tone: 'neutral' },
};

export function AgentsSection({ access, positions, version, onChange }: Props) {
  const spaceId = access.space.id;
  const [payPeriod, setPayPeriod] = useState(recentPeriods(1, true)[0]!);
  const check = useDesk<PayrollCheck>(spaceId, `administration/payroll-check/${payPeriod}`, version);
  const payrolls = useDesk<AdminPayrollView[]>(spaceId, 'administration/payrolls', version);
  const agents = useDesk<Agent[]>(spaceId, 'administration/agents', version);
  const action = useDeskAction(spaceId, onChange);
  const ordonnateur = can(access, 'payroll:submit') && can(access, 'payments:initiate');
  const comptable = can(access, 'payments:approve');
  const accounts = debitableGnf(positions);
  const [source, setSource] = useState('');
  const chosen = source || accounts[0]?.account.id || '';
  const already = (payrolls.data ?? []).some((payroll) => payroll.period === payPeriod);

  return (
    <div className="columns columns-desk">
      <div className="col-main">
        <Notice message={action.message} />
        <Panel title="Contrôle de la paie" id="payroll-check-title" actions={
          <label className="field field-inline"><span>Mois</span><select id="agents-period" value={payPeriod} onChange={(event) => setPayPeriod(event.target.value)}>{recentPeriods(3, true).map((value) => <option key={value} value={value}>{period(value)}</option>)}</select></label>
        }>
          <Loading state={check}>
            {check.data && (
              <>
                <div className="kpis">
                  <Kpi label="Agents éligibles" value={check.data.eligible.length} tone="ok" />
                  <Kpi label="Écartés" value={check.data.excluded.length} tone={check.data.excluded.length ? 'bad' : 'ok'} hint="à vérifier avant tout mandat" />
                  <Kpi label="Masse à mandater" value={fmt(check.data.total)} hint={check.data.available ? `disponible sur la ligne : ${fmt(check.data.available)}` : undefined} />
                </div>
                {check.data.excluded.length > 0 && (
                  <div className="table-wrap">
                    <table className="table">
                      <thead><tr><th>Matricule</th><th>Nom</th><th className="num">Net</th><th>Motif</th></tr></thead>
                      <tbody>
                        {check.data.excluded.map((line) => (
                          <tr key={line.agentId} data-tension>
                            <td className="mono">{line.matricule}</td><td>{line.fullName}</td><td className="num">{fmt(line.amount)}</td>
                            <td>{line.issues.map((issue) => <Pill key={issue} tone="bad">{PAYROLL_ISSUE_LABELS[issue]}</Pill>)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="fine">Chaque NIN est vérifié au registre national (forme, existence, nom) ; un NIN en double ou un wallet partagé entre agents écarte les lignes concernées.</p>
                {ordonnateur && !already && (
                  <div className="bar">
                    <AccountSelect id="payroll-source" positions={accounts} value={chosen} onChange={setSource} />
                    <button type="button" className="btn btn-primary" disabled={action.busy || check.data.eligible.length === 0} onClick={() => void action.run<AdminPayrollView>('POST', 'administration/payrolls', { period: payPeriod, sourceAccountId: chosen }, (payroll) => ({ tone: 'wait', text: `${payroll.number} mandatée : ${payroll.lines.length} agent(s), ${fmt(payroll.total)} imputés sur la ligne de la paie. Elle attend le visa du comptable public.` }), true)}>Mandater la paie</button>
                  </div>
                )}
              </>
            )}
          </Loading>
        </Panel>
        <Panel title="Paies mandatées" id="payrolls-title">
          <Loading state={payrolls}>
            {(payrolls.data ?? []).length === 0 ? <p className="fine">Aucune paie mandatée.</p> : (
              <ul className="cards-list">
                {(payrolls.data ?? []).map((payroll) => (
                  <li key={payroll.id} className="card-item">
                    <div className="card-line"><strong className="capitalize">{period(payroll.period)}</strong><strong>{fmt(payroll.total)}</strong></div>
                    <div className="card-line fine"><span>{payroll.lines.length} agent(s) · {payroll.excluded.length} écarté(s) · mandatée le {day(payroll.preparedOn)}</span><Pill tone={PAYROLL_STATE[payroll.state].tone}>{PAYROLL_STATE[payroll.state].label}</Pill></div>
                    {comptable && payroll.state === 'awaiting_visa' && (
                      <button type="button" className="btn btn-primary" disabled={action.busy} onClick={() => void action.run<AdminPayrollView>('POST', `administration/payrolls/${encodeURIComponent(payroll.id)}/pay`, {}, (result) => ({ tone: 'ok', text: `${result.number} visée : ${result.lineStates.filter((status) => status === 'completed').length} traitement(s) payé(s).` }))}>Viser et payer la paie</button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Loading>
        </Panel>
      </div>
      <div className="col-side">
        <Panel title="Agents" id="agents-title">
          <Loading state={agents}>
            <ul className="rows">
              {(agents.data ?? []).map((agent) => (
                <li key={agent.id} className="row row-stack">
                  <span><span className="mono">{agent.matricule}</span> · {agent.fullName} · {agent.grade}</span>
                  <span className="row-end">{fmt(agent.monthlyNet)}
                    {agent.status === 'suspended' && <Pill tone="wait">suspendu</Pill>}
                    {ordonnateur && <button type="button" className="btn btn-small btn-quiet" disabled={action.busy} onClick={() => void action.run('POST', `administration/agents/${encodeURIComponent(agent.id)}/${agent.status === 'suspended' ? 'reinstate' : 'suspend'}`, {}, () => ({ tone: 'ok', text: `${agent.fullName} ${agent.status === 'suspended' ? 'rétabli' : 'suspendu'}.` }))}>{agent.status === 'suspended' ? 'Rétablir' : 'Suspendre'}</button>}
                  </span>
                </li>
              ))}
            </ul>
          </Loading>
        </Panel>
        {ordonnateur && <EnrolForm spaceId={spaceId} onChange={onChange} />}
      </div>
    </div>
  );
}

function EnrolForm({ spaceId, onChange }: { spaceId: string; onChange: () => void }) {
  const action = useDeskAction(spaceId, onChange);
  const [form, setForm] = useState({ matricule: '', fullName: '', nin: 'GN-NIN-', grade: '', monthlyNet: '', operator: 'orange_money', phone: '+224 ' });
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value });
  async function submit(event: FormEvent) {
    event.preventDefault();
    const done = await action.run<Agent>('POST', 'administration/agents', {
      matricule: form.matricule, fullName: form.fullName, nin: form.nin, grade: form.grade, monthlyNet: form.monthlyNet.replace(/\s/g, ''), payout: { operator: form.operator, phone: form.phone },
    }, (agent) => ({ tone: 'ok', text: `${agent.matricule} inscrit ; le contrôle de la paie vérifiera son NIN.` }));
    if (done) setForm({ ...form, matricule: '', fullName: '', nin: 'GN-NIN-', grade: '', monthlyNet: '' });
  }
  return (
    <Panel title="Inscrire un agent" id="enrol-title">
      <form className="pay-form" onSubmit={submit}>
        <div className="field-row">
          <label className="field"><span>Matricule</span><input id="enrol-matricule" value={form.matricule} onChange={set('matricule')} required /></label>
          <label className="field"><span>NIN</span><input id="enrol-nin" value={form.nin} onChange={set('nin')} required /></label>
        </div>
        <div className="field-row">
          <label className="field"><span>Nom</span><input id="enrol-name" value={form.fullName} onChange={set('fullName')} required /></label>
          <label className="field"><span>Grade</span><input id="enrol-grade" value={form.grade} onChange={set('grade')} required /></label>
        </div>
        <div className="field-row">
          <label className="field"><span>Traitement net</span><input id="enrol-net" value={form.monthlyNet} onChange={set('monthlyNet')} inputMode="numeric" required /></label>
          <OperatorSelect id="enrol-operator" value={form.operator} onChange={(value) => setForm({ ...form, operator: value })} />
          <label className="field"><span>Wallet</span><input id="enrol-phone" value={form.phone} onChange={set('phone')} inputMode="tel" required /></label>
        </div>
        <button type="submit" className="btn btn-primary btn-block" disabled={action.busy}>Inscrire</button>
        <Notice message={action.message} />
      </form>
    </Panel>
  );
}

// ── Recettes ────────────────────────────────────────────────────────────────

interface Revenue { since: string; total: Money; byNature: { nature: string; total: Money; count: number }[]; byAccount: { accountId: string; label: string; total: Money }[] }

export function RevenueSection({ access, version }: Props) {
  const revenue = useDesk<Revenue>(access.space.id, 'administration/revenue', version);
  return (
    <Loading state={revenue}>
      {revenue.data && (
        <div className="columns columns-desk">
          <div className="col-main">
            <div className="kpis"><Kpi label={`Recettes depuis le ${day(revenue.data.since)}`} value={fmt(revenue.data.total)} tone="ok" /></div>
            <Panel title="Par nature" id="revenue-nature">
              <ul className="rows">
                {revenue.data.byNature.map((entry) => (
                  <li key={entry.nature} className="row row-stack">
                    <span>{entry.nature} · {entry.count} encaissement(s)</span>
                    <span className="row-end"><strong>{fmt(entry.total)}</strong></span>
                    <Meter total={revenue.data!.total} label={entry.nature} parts={[{ value: entry.total, tone: 'ok', label: entry.nature }]} />
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
          <div className="col-side">
            <Panel title="Par compte" id="revenue-account">
              <ul className="rows">
                {revenue.data.byAccount.map((entry) => <li key={entry.accountId} className="row"><span>{entry.label}</span><strong>{fmt(entry.total)}</strong></li>)}
              </ul>
            </Panel>
          </div>
        </div>
      )}
    </Loading>
  );
}
