import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createDemoApp,
  loadDemoGapp,
  MemoryDeskStore,
  type Actor,
  type SalesInvoice,
  type SupplierBill,
} from '../src/index.ts';

const NOW = new Date('2026-10-13T09:00:00Z');

async function setup(seed = true) {
  const { app, network } = createDemoApp({ now: () => NOW });
  const store = new MemoryDeskStore();
  const gapp = await loadDemoGapp(app, { store, seed });
  return { app, network, ...gapp };
}

const at = (personId: string, spaceId: string, channel: Actor['channel'] = 'desktop'): Actor => ({ personId, channel, spaceId });
const sekou = at('per_sekou', 'spc_biz_boke');
const alpha = at('per_alpha', 'spc_biz_boke');
const aissatou = at('per_aissatou', 'spc_biz_boke');
const mariama = at('per_mariama', 'spc_biz_couture');
const fatoumata = at('per_fatoumata', 'spc_adm_kaloum');
const ibrahima = at('per_ibrahima', 'spc_adm_kaloum');
const mamadou = at('per_mamadou', 'spc_adm_kaloum');
const BOKE = 'spc_biz_boke';
const KALOUM = 'spc_adm_kaloum';

const bill = (reference: string, amount: string, extra: Partial<{ vat: string; dueDate: string; issueDate: string; operator: 'orange_money' | 'mtn_momo' }> = {}) => ({
  supplier: { name: `Fournisseur ${reference}` },
  payee: { operator: extra.operator ?? 'orange_money', phone: '+224 620 99 00 01' },
  reference,
  amount,
  ...(extra.vat ? { vat: extra.vat } : {}),
  issueDate: extra.issueDate ?? '2026-10-10',
  dueDate: extra.dueDate ?? '2026-10-20',
});

describe('GAPP Entreprise : accès selon l’espace et le rôle', () => {
  it('un tableau de bord d’entreprise ne s’ouvre que dans une session de cette entreprise, sur tablette ou ordinateur', async () => {
    const { business } = await setup(false);
    await assert.rejects(business.treasury(at('per_sekou', 'spc_cit_sekou'), BOKE), { code: 'not_a_member' });
    await assert.rejects(business.treasury({ ...sekou, channel: 'phone' }, BOKE), { code: 'channel_not_allowed' });
    // Même avec une session personnelle, l'espace personnel n'a pas de tableau de bord d'entreprise.
    await assert.rejects(business.invoices(at('per_sekou', 'spc_cit_sekou'), 'spc_cit_sekou'), { code: 'not_found' });
    await assert.rejects(business.treasury(mariama, BOKE), { code: 'not_a_member' });
  });

  it('chaque rôle voit son tableau de bord : la RH ni la trésorerie ni les factures, le financier pas l’équipe', async () => {
    const { business } = await setup();
    await assert.rejects(business.treasury(aissatou, BOKE), { code: 'forbidden' });
    await assert.rejects(business.invoices(aissatou, BOKE), { code: 'forbidden' });
    await assert.rejects(business.employees(alpha, BOKE), { code: 'forbidden' });
    assert.equal((await business.employees(aissatou, BOKE)).employees.length, 6);
    // La RH ne voit que les lots de paie ; le financier voit la paie sans le détail nominatif des salaires.
    assert.deepEqual([...new Set((await business.batches(aissatou, BOKE)).map((batch) => batch.kind))], ['payroll']);
    const payroll = (await business.batches(alpha, BOKE)).find((batch) => batch.kind === 'payroll')!;
    assert.equal(payroll.linesHidden, true);
    assert.ok(payroll.lines.every((line) => line.beneficiary === '' && line.amount === undefined));
  });
});

describe('GAPP Entreprise : factures', () => {
  it('numérote sans trou, même sous émissions simultanées, et scelle chaque facture en chaîne', async () => {
    const { business } = await setup(false);
    const input = (index: number) => ({ customer: { name: `Client ${index}` }, lines: [{ description: 'Prestation', quantity: 2, unitPrice: '1000000' }] });
    const issued = await Promise.all([1, 2, 3, 4].map((index) => business.issueInvoice(mariama, 'spc_biz_couture', input(index), `fac-${index}`)));
    assert.deepEqual(issued.map((invoice) => invoice.number).sort(), ['FAC-2026-0001', 'FAC-2026-0002', 'FAC-2026-0003', 'FAC-2026-0004']);
    const first = issued[0]!;
    assert.equal(first.subtotal.amount, '2000000');
    assert.equal(first.vat.amount, '360000');
    assert.equal(first.total.amount, '2360000');
    assert.equal(first.dueDate, '2026-11-12');
    assert.deepEqual((await business.invoices(mariama, 'spc_biz_couture')).chain, { intact: true, checked: 4 });
    // Même clé, même demande : même facture ; autre demande : refusée.
    assert.equal((await business.issueInvoice(mariama, 'spc_biz_couture', input(1), 'fac-1')).id, issued[0]!.id);
    await assert.rejects(business.issueInvoice(mariama, 'spc_biz_couture', input(9), 'fac-1'), { code: 'idempotency_conflict' });
  });

  it('une facture modifiée en base casse la chaîne de sceaux', async () => {
    const { business, store } = await setup();
    const record = (await store.list<SalesInvoice>('invoices', BOKE))[1]!;
    await store.update('invoices', { ...record.value, total: { amount: '1', currency: 'GNF' } }, record.version);
    const { chain } = await business.invoices(sekou, BOKE);
    assert.equal(chain.intact, false);
    assert.equal(chain.brokenAt, 2);
  });

  it('refuse l’antidate avant la facture précédente, un taux inconnu, une date future', async () => {
    const { business } = await setup();
    const base = { customer: { name: 'Client' }, lines: [{ description: 'x', quantity: 1, unitPrice: '1000' }] };
    await assert.rejects(business.issueInvoice(alpha, BOKE, { ...base, issueDate: '2026-10-01' }, 'k1'), { code: 'invalid_state' });
    await assert.rejects(business.issueInvoice(alpha, BOKE, { ...base, vatRateBps: 500 }, 'k2'), { code: 'invalid_request' });
    await assert.rejects(business.issueInvoice(alpha, BOKE, { ...base, issueDate: '2026-10-14' }, 'k3'), { code: 'invalid_request' });
  });

  it('suit l’état des créances : en retard après l’échéance, encaissée une fois, annulée sans perdre son numéro', async () => {
    const { business } = await setup();
    const { invoices, overdue } = await business.invoices(alpha, BOKE);
    assert.equal(invoices.find((invoice) => invoice.number === 'FAC-2026-0002')?.state, 'overdue');
    assert.equal(overdue.amount, '25960000');
    const open = invoices.find((invoice) => invoice.number === 'FAC-2026-0004')!;
    await business.settleInvoice(alpha, BOKE, open.id, { accountId: 'acc_bl_om' });
    await assert.rejects(business.settleInvoice(alpha, BOKE, open.id, { accountId: 'acc_bl_om' }), { code: 'invalid_state' });
    await assert.rejects(business.settleInvoice(alpha, BOKE, open.id, { accountId: 'acc_mc_om' }), { code: 'not_found' });
    const cancelled = await business.cancelInvoice(alpha, BOKE, invoices.find((invoice) => invoice.number === 'FAC-2026-0005')!.id, 'erreur de quantité');
    assert.equal(cancelled.state, 'cancelled');
    assert.equal((await business.invoices(alpha, BOKE)).chain.intact, true);
  });
});

describe('GAPP Entreprise : fournisseurs et lots de paiement', () => {
  it('au-delà de 5 M GNF, le lot du financier attend le dirigeant, qui ne peut être celui qui l’a préparé', async () => {
    const { business } = await setup();
    const pending = (await business.batches(sekou, BOKE)).find((batch) => batch.status === 'pending_approval')!;
    assert.equal(pending.total.amount, '28000000');
    await assert.rejects(business.approveBatch(alpha, BOKE, pending.id), { code: 'forbidden' });
    const approved = await business.approveBatch(sekou, BOKE, pending.id);
    assert.equal(approved.status, 'executed');
    assert.deepEqual(approved.counts, { completed: 2, processing: 0, failed: 0, pending: 0 });
    const bills = await business.bills(alpha, BOKE);
    assert.deepEqual(bills.filter((candidate) => candidate.state === 'paid').map((candidate) => candidate.reference).sort(), ['GM-2231', 'PCI-778', 'SKC-0912']);
    await assert.rejects(business.approveBatch(sekou, BOKE, pending.id), { code: 'invalid_state' });
  });

  it('le dirigeant qui prépare un lot le paie tout de suite ; deux approbations simultanées n’en passent qu’une', async () => {
    const { business, app } = await setup();
    const created = await business.recordBill(alpha, BOKE, bill('X-1', '7000000'), 'b1');
    const batch = await business.createSupplierBatch(alpha, BOKE, { billIds: [created.id], sourceAccountId: 'acc_bl_om' }, 'lot-x');
    assert.equal(batch.status, 'pending_approval');
    const [one, two] = await Promise.allSettled([business.approveBatch(sekou, BOKE, batch.id), business.approveBatch(sekou, BOKE, batch.id)]);
    assert.equal([one, two].filter((result) => result.status === 'fulfilled').length, 1);
    const payments = (await app.listPayments(sekou, BOKE)).filter((payment) => payment.label === 'Fournisseur X-1 · X-1');
    assert.equal(payments.length, 1);
  });

  it('sous le seuil, le lot du financier part sans approbation', async () => {
    const { business } = await setup();
    const created = await business.recordBill(alpha, BOKE, bill('S-1', '1200000'), 'b1');
    const batch = await business.createSupplierBatch(alpha, BOKE, { billIds: [created.id], sourceAccountId: 'acc_bl_om' }, 'lot-s');
    assert.equal(batch.status, 'executed');
  });

  it('une facture prise dans un lot ne repart pas dans un autre ; un lot refusé la libère', async () => {
    const { business } = await setup();
    const pending = (await business.batches(sekou, BOKE)).find((batch) => batch.status === 'pending_approval')!;
    const fuel = pending.lines[0]!.ref;
    await assert.rejects(business.createSupplierBatch(alpha, BOKE, { billIds: [fuel], sourceAccountId: 'acc_bl_eco' }, 'lot-y'), { code: 'invalid_state' });
    await assert.rejects(business.rejectBatch(sekou, BOKE, pending.id, ''), { code: 'invalid_request' });
    await business.rejectBatch(sekou, BOKE, pending.id, 'montant carburant à vérifier');
    const freed = (await business.bills(alpha, BOKE)).find((candidate) => candidate.id === fuel)!;
    assert.equal(freed.state, 'overdue');
    assert.match(freed.lastFailure ?? '', /carburant/);
    const again = await business.createSupplierBatch(alpha, BOKE, { billIds: [fuel], sourceAccountId: 'acc_bl_eco' }, 'lot-z');
    assert.equal(again.status, 'pending_approval');
  });

  it('recommande le compte le moins cher qui couvre le lot : le même opérateur que le fournisseur', async () => {
    const { business } = await setup();
    const created = await business.recordBill(alpha, BOKE, bill('M-1', '1000000', { operator: 'mtn_momo' }), 'b1');
    const preview = await business.previewSupplierBatch(alpha, BOKE, [created.id]);
    const recommended = preview.options.find((option) => option.recommended)!;
    assert.equal(recommended.accountId, 'acc_bl_mtn');
    assert.equal(recommended.fees.amount, '5000');
    assert.equal(preview.options.find((option) => option.accountId === 'acc_bl_om')?.fees.amount, '15000');
    assert.equal(preview.options.find((option) => option.accountId === 'acc_bl_eco')?.fees.amount, '10000');
  });

  it('refuse un lot vide, de plus de 50 lignes, en doublon, ou plus gros que le solde', async () => {
    const { business } = await setup();
    await assert.rejects(business.createSupplierBatch(alpha, BOKE, { billIds: [], sourceAccountId: 'acc_bl_om' }, 'v'), { code: 'invalid_request' });
    await assert.rejects(business.createSupplierBatch(alpha, BOKE, { billIds: Array.from({ length: 51 }, (_, index) => `b${index}`), sourceAccountId: 'acc_bl_om' }, 'w'), { code: 'invalid_request' });
    const created = await business.recordBill(alpha, BOKE, bill('D-1', '1000'), 'b1');
    await assert.rejects(business.createSupplierBatch(alpha, BOKE, { billIds: [created.id, created.id], sourceAccountId: 'acc_bl_om' }, 'x'), { code: 'invalid_request' });
    const big = await business.recordBill(alpha, BOKE, bill('G-1', '9000000'), 'b2');
    await assert.rejects(business.createSupplierBatch(alpha, BOKE, { billIds: [big.id], sourceAccountId: 'acc_bl_cellcom' }, 'y'), { code: 'insufficient_funds' });
    await assert.rejects(business.recordBill(alpha, BOKE, bill('D-1', '1000'), 'b3'), { code: 'invalid_state' });
  });
});

describe('GAPP Entreprise : TVA', () => {
  it('collectée moins déductible ; déclaration et paiement ensemble ; un mois ne se déclare qu’une fois', async () => {
    const { business, app } = await setup();
    const preview = await business.vatPreview(alpha, BOKE, '2026-09');
    // Ventes de septembre : FAC-0002 (3 960 000) et FAC-0003 (5 400 000) ; achats : Garage Matoto et Station Kolaboui.
    assert.equal(preview.collected.amount, String(3_960_000 + 5_400_000));
    assert.equal(preview.deductible.amount, String(488_136 + 2_806_780));
    assert.equal(preview.due.amount, String(9_360_000 - 3_294_916));
    assert.equal(preview.deadline, '2026-10-15');

    const filed = await business.fileVat(alpha, BOKE, { period: '2026-09', sourceAccountId: 'acc_bl_eco' }, 'tva-9');
    assert.equal(filed.state, 'awaiting_approval');
    await assert.rejects(business.fileVat(alpha, BOKE, { period: '2026-09', sourceAccountId: 'acc_bl_eco' }, 'tva-9b'), { code: 'invalid_state' });
    // Le mois est verrouillé : une facture de septembre ne s'annule plus.
    const september = (await business.invoices(alpha, BOKE)).invoices.find((invoice) => invoice.number === 'FAC-2026-0003')!;
    await assert.rejects(business.cancelInvoice(alpha, BOKE, september.id, 'erreur'), { code: 'invalid_state' });
    await app.approvePayment(sekou, BOKE, filed.paymentId!);
    const done = (await business.vat(alpha, BOKE)).returns.find((value) => value.period === '2026-09')!;
    assert.equal(done.state, 'filed');
    assert.match(done.acknowledgement!, /^DGI-TVA-202609-\d{6}$/);
  });

  it('un mois sans TVA due est déposé tout de suite, et son crédit passe au mois suivant', async () => {
    const { business } = await setup(false);
    await business.recordBill(mariama, 'spc_biz_couture', bill('C-1', '1180000', { vat: '180000', issueDate: '2026-08-20', dueDate: '2026-09-20' }), 'c1');
    const august = await business.fileVat(mariama, 'spc_biz_couture', { period: '2026-08' }, 'tva-8');
    assert.equal(august.state, 'filed');
    assert.equal(august.creditCarried.amount, '180000');
    const september = await business.vatPreview(mariama, 'spc_biz_couture', '2026-09');
    assert.equal(september.creditBrought.amount, '180000');
    await assert.rejects(business.vatPreview(mariama, 'spc_biz_couture', '2026-10'), { code: 'invalid_request' });
    await assert.rejects(business.vatPreview(mariama, 'spc_biz_couture', '2026-13'), { code: 'invalid_request' });
  });

  it('seul qui déclare la TVA la dépose', async () => {
    const { business } = await setup();
    await assert.rejects(business.fileVat(aissatou, BOKE, { period: '2026-09', sourceAccountId: 'acc_bl_eco' }, 'x'), { code: 'forbidden' });
  });
});

describe('GAPP Entreprise : équipe et paie', () => {
  it('l’attestation de travail arrive dans le coffre personnel du salarié et se vérifie par son code', async () => {
    const { business, app } = await setup();
    const kadiatou = (await business.employees(aissatou, BOKE)).employees.find((employee) => employee.fullName === 'Kadiatou Sow')!;
    const certificate = await business.issueCertificate(aissatou, BOKE, kadiatou.id);
    const vault = app.documents(at('per_kadiatou', 'spc_cit_kadiatou', 'phone'), 'spc_cit_kadiatou');
    const deposited = vault.find((document) => document.verificationCode === certificate.verificationCode)!;
    assert.equal(deposited.issuer, 'Boké Logistique SA');
    assert.equal(deposited.category, 'employment');
    assert.equal(app.verifyDocument(certificate.verificationCode).holderName, 'Kadiatou Sow');
    // L'entreprise n'y lit rien : le coffre de Kadiatou reste hors de sa session.
    assert.throws(() => app.documents(aissatou, 'spc_cit_kadiatou'), { code: 'not_a_member' });
  });

  it('pour un salarié qui n’utilise pas App GN, l’attestation est émise de la même façon, sans rien révéler', async () => {
    const { business } = await setup();
    const driver = (await business.employees(aissatou, BOKE)).employees.find((employee) => employee.fullName === 'Mamadou Bah')!;
    const certificate = await business.issueCertificate(aissatou, BOKE, driver.id);
    assert.deepEqual(Object.keys(certificate).sort(), ['documentId', 'employeeId', 'employerName', 'fields', 'holderName', 'holderNin', 'id', 'issuedBy', 'issuedOn', 'spaceId', 'verificationCode']);
  });

  it('la paie préparée par la RH attend le dirigeant ; un mois ne se paie qu’une fois', async () => {
    const { business } = await setup();
    const payroll = await business.preparePayroll(aissatou, BOKE, { period: '2026-10', sourceAccountId: 'acc_bl_eco' }, 'paie-10');
    assert.equal(payroll.status, 'pending_approval');
    assert.equal(payroll.total.amount, String(12_500_000 + 3_800_000 + 2_900_000 * 2 + 3_200_000 + 4_100_000));
    await assert.rejects(business.approveBatch(aissatou, BOKE, payroll.id), { code: 'forbidden' });
    await assert.rejects(business.preparePayroll(aissatou, BOKE, { period: '2026-10', sourceAccountId: 'acc_bl_eco' }, 'paie-10b'), { code: 'invalid_state' });
    assert.equal((await business.approveBatch(sekou, BOKE, payroll.id)).counts.completed, 6);
  });

  it('un NIN déjà au registre et une sortie avant l’embauche sont refusés', async () => {
    const { business } = await setup();
    const input = { fullName: 'Kadiatou Sow', nin: 'gn-nin-0000000006', position: 'x', hiredOn: '2026-01-01', monthlyNet: '1000000', payout: { operator: 'orange_money' as const, phone: '+224 625 00 00 06' } };
    await assert.rejects(business.hire(aissatou, BOKE, input, 'h1'), { code: 'invalid_state' });
    const employee = (await business.employees(aissatou, BOKE)).employees[0]!;
    await assert.rejects(business.endContract(aissatou, BOKE, employee.id, '2000-01-01'), { code: 'invalid_request' });
  });
});

describe('GAPP Entreprise : trésorerie, score, journal, audit', () => {
  it('projette la trésorerie à 7 jours et signale la tension', async () => {
    const { business } = await setup();
    const couture = await business.treasury(mariama, 'spc_biz_couture');
    assert.equal(couture.projection.length, 8);
    assert.equal(couture.cash.amount, '3980000');
    assert.equal(couture.tension, true);
    assert.deepEqual(couture.lowest, { date: '2026-10-17', balance: { amount: '-520000', currency: 'GNF' } });
    const boke = await business.treasury(sekou, BOKE);
    assert.equal(boke.tension, false);
    // SKC-0912 est échue depuis cinq jours : le lot qui la règle attend encore la validation, elle compte.
    assert.equal(boke.overduePayables.amount, '18400000');
    assert.ok(boke.projection.some((day) => day.items.some((item) => item.kind === 'vat' && item.label === 'TVA 2026-09')));
    // Les avoirs en dollars restent à part : ils ne paient pas une échéance en GNF.
    assert.deepEqual(boke.foreign.map((entry) => entry.accountId), ['acc_bl_eco_usd']);
  });

  it('le score est indicatif, sur cinq critères pondérés', async () => {
    const { business } = await setup();
    const score = await business.score(alpha, BOKE);
    assert.equal(score.criteria.reduce((total, criterion) => total + criterion.weight, 0), 100);
    assert.ok(score.score >= 0 && score.score <= 100);
    assert.match(score.notice, /indicatif/);
    await assert.rejects(business.score(aissatou, BOKE), { code: 'forbidden' });
  });

  it('le journal SYSCOHADA est équilibré', async () => {
    const { business } = await setup();
    for (const period of ['2026-08', '2026-09', '2026-10']) {
      const lines = (await business.ledger(alpha, BOKE, period)).trim().split('\n').slice(1).map((line) => line.split(';'));
      const debit = lines.reduce((total, line) => total + BigInt(line[5] || '0'), 0n);
      const credit = lines.reduce((total, line) => total + BigInt(line[6] || '0'), 0n);
      assert.equal(debit, credit, period);
    }
  });

  it('chaque action laisse une trace chaînée ; une trace effacée se voit', async () => {
    const { business, store } = await setup();
    const { entries, check } = await business.auditTrail(sekou, BOKE);
    assert.equal(check.intact, true);
    assert.ok(entries.some((entry) => entry.action === 'batch.submitted' && entry.personName === 'Alpha Diallo'));
    const third = (await store.list<{ id: string; spaceId: string; summary: string }>('audit', BOKE))[2]!;
    await store.update('audit', { ...third.value, summary: 'réécrit' }, third.version);
    assert.deepEqual((await business.auditTrail(sekou, BOKE)).check, { intact: false, checked: entries.length, brokenAt: 3 });
  });

  it('le rapprochement propose l’encaissement du montant exact d’une facture ouverte', async () => {
    const { business, network, app } = await setup();
    const account = app.linkedAccounts(BOKE).find((candidate) => candidate.id === 'acc_bl_eco')!;
    network.post(account, { occurredAt: NOW.toISOString(), direction: 'credit', amount: { amount: '8024000', currency: 'GNF' }, label: 'Virement Agro Boffa', counterparty: 'Agro Boffa SARL' });
    const [suggestion] = await business.reconciliation(alpha, BOKE);
    assert.equal(suggestion?.number, 'FAC-2026-0004');
    await business.settleInvoice(alpha, BOKE, suggestion!.invoiceId, { accountId: suggestion!.accountId, transactionId: suggestion!.transactionId });
    assert.deepEqual(await business.reconciliation(alpha, BOKE), []);
  });

  it('les factures fournisseurs gardent leur forme en base', async () => {
    const { store } = await setup();
    const [first] = await store.list<SupplierBill>('bills', BOKE);
    assert.equal(first?.value.supplier.name, 'Garage Matoto');
  });
});

describe('GAPP Administration : chaîne de la dépense', () => {
  it('l’engagement est refusé au-delà du crédit disponible, même sous demandes simultanées', async () => {
    const { administration } = await setup();
    const line = (await administration.budget(fatoumata, KALOUM)).lines.find((candidate) => candidate.code === '6.4')!;
    assert.equal(line.available.amount, '135000000');
    const input = (amount: string) => ({ lineId: line.id, supplier: { name: 'Prestataire' }, payee: { operator: 'orange_money' as const, phone: '+224 620 00 99 01' }, object: 'Travaux', amount });
    await assert.rejects(administration.engage(fatoumata, KALOUM, input('135000001'), 'e0'), { code: 'invalid_state' });
    const results = await Promise.allSettled([1, 2, 3].map((index) => administration.engage(fatoumata, KALOUM, input('50000000'), `e${index}`)));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 2);
    const after = (await administration.budget(fatoumata, KALOUM)).lines.find((candidate) => candidate.code === '6.4')!;
    assert.equal(after.engaged.amount, '145000000');
  });

  it('séparation des fonctions : l’ordonnateur engage et mandate, le comptable vise ; aucun ne fait l’autre', async () => {
    const { administration } = await setup();
    const [, , papeterie] = (await administration.engagements(fatoumata, KALOUM)).reverse().slice(0, 3).reverse();
    const awaiting = (await administration.engagements(ibrahima, KALOUM)).find((engagement) => engagement.liquidations.some((liquidation) => liquidation.state === 'awaiting_visa'))!;
    assert.ok(papeterie);
    const liquidation = awaiting.liquidations[0]!;
    await assert.rejects(administration.visa(fatoumata, KALOUM, awaiting.id, liquidation.id), { code: 'forbidden' });
    await assert.rejects(administration.engage(ibrahima, KALOUM, { lineId: awaiting.lineId, supplier: { name: 'x' }, payee: { operator: 'orange_money', phone: '+224 620 00 00 00' }, object: 'x', amount: '1' }, 'x'), { code: 'forbidden' });
    await assert.rejects(administration.engage(mamadou, KALOUM, { lineId: awaiting.lineId, supplier: { name: 'x' }, payee: { operator: 'orange_money', phone: '+224 620 00 00 00' }, object: 'x', amount: '1' }, 'x'), { code: 'forbidden' });
    const paid = await administration.visa(ibrahima, KALOUM, awaiting.id, liquidation.id);
    assert.equal(paid.liquidations[0]!.state, 'paid');
    await assert.rejects(administration.visa(ibrahima, KALOUM, awaiting.id, liquidation.id), { code: 'invalid_state' });
  });

  it('un mandat rejeté garde son motif et peut être réémis', async () => {
    const { administration } = await setup();
    const awaiting = (await administration.engagements(ibrahima, KALOUM)).find((engagement) => engagement.liquidations.some((liquidation) => liquidation.state === 'awaiting_visa'))!;
    const liquidationId = awaiting.liquidations[0]!.id;
    const rejected = await administration.rejectMandate(ibrahima, KALOUM, awaiting.id, liquidationId, 'facture non certifiée conforme');
    assert.equal(rejected.liquidations[0]!.state, 'rejected');
    assert.equal(rejected.liquidations[0]!.rejectionReason, 'facture non certifiée conforme');
    const reissued = await administration.mandate(fatoumata, KALOUM, awaiting.id, liquidationId, { sourceAccountId: 'acc_kal_tresor' });
    assert.equal(reissued.liquidations[0]!.state, 'awaiting_visa');
    assert.equal(reissued.liquidations[0]!.rejected?.[0]?.reason, 'facture non certifiée conforme');
    assert.notEqual(reissued.liquidations[0]!.mandate!.number, rejected.liquidations[0]!.mandate!.number);
  });

  it('on ne liquide pas plus qu’engagé ; la clôture rend le reste au disponible', async () => {
    const { administration } = await setup();
    const computers = (await administration.engagements(fatoumata, KALOUM)).find((engagement) => engagement.object.startsWith('20 ordinateurs'))!;
    await assert.rejects(administration.liquidate(fatoumata, KALOUM, computers.id, { amount: '80000001', invoiceReference: 'IC-2', serviceDoneOn: '2026-10-13' }), { code: 'invalid_state' });
    await assert.rejects(administration.liquidate(fatoumata, KALOUM, computers.id, { amount: '1', invoiceReference: 'IC-2', serviceDoneOn: '2026-10-14' }), { code: 'invalid_request' });
    const before = (await administration.budget(fatoumata, KALOUM)).lines.find((line) => line.code === '2.1')!;
    await administration.closeEngagement(fatoumata, KALOUM, computers.id);
    const after = (await administration.budget(fatoumata, KALOUM)).lines.find((line) => line.code === '2.1')!;
    assert.equal(BigInt(after.available.amount) - BigInt(before.available.amount), 80_000_000n);
    await assert.rejects(administration.liquidate(fatoumata, KALOUM, computers.id, { amount: '1', invoiceReference: 'IC-3', serviceDoneOn: '2026-10-13' }), { code: 'invalid_state' });
  });
});

describe('GAPP Administration : paie des agents, recettes, reporting', () => {
  it('le contrôle écarte NIN inconnu, identité discordante, doublon de NIN et wallet partagé', async () => {
    const { administration } = await setup();
    const check = await administration.payrollCheck(fatoumata, KALOUM, '2026-10');
    const issues = Object.fromEntries(check.excluded.map((line) => [line.matricule, line.issues]));
    assert.deepEqual(issues, {
      'KAL-001': ['shared_wallet'],
      'KAL-003': ['duplicate_nin'],
      'KAL-007': ['identity_mismatch', 'duplicate_nin'],
      'KAL-008': ['nin_unknown'],
      'KAL-009': ['shared_wallet'],
    });
    assert.deepEqual(check.eligible.map((line) => line.matricule), ['KAL-002', 'KAL-004', 'KAL-005', 'KAL-006']);
  });

  it('l’ordonnateur mandate la paie sur sa ligne, le comptable la vise ; jamais la même personne', async () => {
    const { administration } = await setup();
    const before = (await administration.budget(fatoumata, KALOUM)).lines.find((line) => line.payroll)!;
    const payroll = await administration.preparePayroll(fatoumata, KALOUM, { period: '2026-10', sourceAccountId: 'acc_kal_tresor' }, 'paie-10');
    assert.equal(payroll.state, 'awaiting_visa');
    assert.equal(payroll.excluded.length, 5);
    const engaged = (await administration.budget(fatoumata, KALOUM)).lines.find((line) => line.payroll)!;
    assert.equal(BigInt(engaged.engaged.amount) - BigInt(before.engaged.amount), BigInt(payroll.total.amount));
    await assert.rejects(administration.payPayroll(fatoumata, KALOUM, payroll.id), { code: 'forbidden' });
    await assert.rejects(administration.preparePayroll(ibrahima, KALOUM, { period: '2026-10', sourceAccountId: 'acc_kal_tresor' }, 'x'), { code: 'forbidden' });
    const paid = await administration.payPayroll(ibrahima, KALOUM, payroll.id);
    assert.equal(paid.state, 'paid');
    await assert.rejects(administration.preparePayroll(fatoumata, KALOUM, { period: '2026-10', sourceAccountId: 'acc_kal_tresor' }, 'paie-10b'), { code: 'invalid_state' });
  });

  it('le contrôle lit le budget, les recettes et l’état de la Cour des Comptes, sans rien pouvoir engager', async () => {
    const { administration } = await setup();
    const budget = await administration.budget(mamadou, KALOUM);
    assert.equal(budget.totals.total.allocated.amount, '4920000000');
    const revenue = await administration.revenue(mamadou, KALOUM);
    assert.ok(BigInt(revenue.total.amount) > 0n);
    const report = await administration.courtReport(mamadou, KALOUM);
    assert.match(report, /^Compte d'exécution 2026;Commune de Kaloum/);
    assert.match(report, /MDT-2026-0001;ENG-2026-0001;Kaloum Propreté SARL/);
    assert.match(report, /Piste d’audit;intègre/);
    await assert.rejects(administration.agents(mamadou, KALOUM), { code: 'forbidden' });
  });
});
