import type { AppGn } from '../app.ts';
import type { Actor } from '../channels.ts';
import { DEMO_CIVIL_REGISTRY } from '../seed.ts';
import { AdministrationDesk } from './administration.ts';
import { BusinessDesk } from './business.ts';
import { addDays, dayOf, periodOf } from './common.ts';
import { MemoryDeskStore, type DeskEntity, type DeskStore } from './desk.ts';

export interface Gapp {
  business: BusinessDesk;
  administration: AdministrationDesk;
  store: DeskStore;
}

const desk = (personId: string, spaceId: string): Actor => ({ personId, channel: 'desktop', spaceId });

/**
 * Monte les deux bureaux GAPP sur l'application et, à la première ouverture du magasin, y verse les données
 * de démonstration (factures, fournisseurs, équipe, budget de la commune…), par les mêmes actions qu'un
 * utilisateur : elles passent par les contrôles et laissent leur trace dans la piste d'audit.
 */
export async function loadDemoGapp(app: AppGn, options: { store?: DeskStore; seed?: boolean } = {}): Promise<Gapp> {
  const store = options.store ?? new MemoryDeskStore();
  const gapp: Gapp = {
    business: new BusinessDesk(app, store),
    administration: new AdministrationDesk(app, store, (nin) => DEMO_CIVIL_REGISTRY[nin]),
    store,
  };
  // Un seul démarrage verse les données, même si plusieurs instances partagent la base.
  if ((options.seed ?? true) && await store.insert<DeskEntity>('counters', { id: 'demo:seeded', spaceId: 'demo' })) {
    await seedBusiness(app, gapp.business);
    await seedAdministration(app, gapp.administration);
  }
  await gapp.business.load(app.spaceIdsOfKind('business'));
  return gapp;
}

async function seedBusiness(app: AppGn, business: BusinessDesk): Promise<void> {
  const today = dayOf(app.clock());
  const at = (days: number) => addDays(today, days);
  const sekou = desk('per_sekou', 'spc_biz_boke');
  const alpha = desk('per_alpha', 'spc_biz_boke');
  const aissatou = desk('per_aissatou', 'spc_biz_boke');
  const boke = 'spc_biz_boke';

  // Factures de vente de Boké Logistique, dans l'ordre des dates.
  const sales = [
    { customer: { name: 'Minière de Sangarédi SA', nif: '000104477' }, lines: [{ description: 'Transport de bauxite, rotation Sangarédi – Kamsar', quantity: 12, unitPrice: '3500000' }], issueDate: at(-55), dueInDays: 30 },
    { customer: { name: 'Transit Kamsar SARL' }, lines: [{ description: 'Acheminement de conteneurs, port de Kamsar', quantity: 8, unitPrice: '2750000' }], issueDate: at(-40), dueInDays: 30 },
    { customer: { name: 'Ciment de Conakry SA' }, lines: [{ description: 'Location de camion-benne avec chauffeur (mois)', quantity: 2, unitPrice: '15000000' }], issueDate: at(-20), dueInDays: 21 },
    { customer: { name: 'Agro Boffa SARL', phone: '+224 622 55 10 10' }, lines: [{ description: 'Transport de riz paddy, Boffa – Conakry', quantity: 1, unitPrice: '6800000' }], issueDate: at(-12), dueInDays: 15 },
    { customer: { name: 'Minière de Sangarédi SA', nif: '000104477' }, lines: [{ description: 'Transport de bauxite, rotation Sangarédi – Kamsar', quantity: 10, unitPrice: '3500000' }], issueDate: at(-3), dueInDays: 30 },
  ];
  const issued = [];
  for (const [index, input] of sales.entries()) issued.push(await business.issueInvoice(alpha, boke, input, `demo-fac-${index}`));
  await business.settleInvoice(alpha, boke, issued[0]!.id, { accountId: 'acc_bl_eco', receivedOn: at(-27) });

  const bill = (key: string, input: Parameters<BusinessDesk['recordBill']>[2]) => business.recordBill(alpha, boke, input, key);
  const garage = await bill('demo-bill-1', { supplier: { name: 'Garage Matoto' }, payee: { operator: 'orange_money', phone: '+224 620 77 12 31' }, reference: 'GM-2231', amount: '3200000', vat: '488136', issueDate: at(-35), dueDate: at(2) });
  const fuel = await bill('demo-bill-2', { supplier: { name: 'Station Kolaboui Carburant', nif: '000209911' }, payee: { operator: 'orange_money', phone: '+224 620 88 09 12' }, reference: 'SKC-0912', amount: '18400000', vat: '2806780', issueDate: at(-25), dueDate: at(-5) });
  const tyres = await bill('demo-bill-3', { supplier: { name: 'Pneus Conakry Import' }, payee: { operator: 'mtn_momo', phone: '+224 664 30 77 80' }, reference: 'PCI-778', amount: '9600000', vat: '1464407', issueDate: at(-10), dueDate: at(4) });
  await bill('demo-bill-4', { supplier: { name: 'Sécurité Escorte Boké' }, payee: { operator: 'cellcom_money', phone: '+224 655 10 41 04' }, reference: 'SEB-104', amount: '2400000', issueDate: at(-6), dueDate: at(6) });

  // Le dirigeant a déjà réglé le garage ; le directeur financier a préparé un lot qui attend son approbation.
  await business.createSupplierBatch(sekou, boke, { billIds: [garage.id], sourceAccountId: 'acc_bl_om' }, 'demo-lot-1');
  await business.createSupplierBatch(alpha, boke, { billIds: [fuel.id, tyres.id], sourceAccountId: 'acc_bl_eco' }, 'demo-lot-2');

  // Équipe, attestation remise dans le coffre de Kadiatou, paie du mois dernier versée.
  const staff = [
    { fullName: 'Alpha Diallo', nin: 'GN-NIN-0000000002', position: 'Directeur administratif et financier', hiredOn: '2021-03-01', monthlyNet: '12500000', payout: { operator: 'mtn_momo' as const, phone: '+224 660 00 00 02' } },
    { fullName: 'Kadiatou Sow', nin: 'GN-NIN-0000000006', position: 'Assistante logistique', hiredOn: '2024-09-16', monthlyNet: '3800000', payout: { operator: 'orange_money' as const, phone: '+224 625 00 00 06' } },
    { fullName: 'Mamadou Bah', nin: 'GN-NIN-0000000101', position: 'Chauffeur poids lourd', hiredOn: '2020-01-06', monthlyNet: '2900000', payout: { operator: 'orange_money' as const, phone: '+224 620 41 10 01' } },
    { fullName: 'Ousmane Keïta', nin: 'GN-NIN-0000000102', position: 'Chauffeur poids lourd', hiredOn: '2022-05-02', monthlyNet: '2900000', payout: { operator: 'mtn_momo' as const, phone: '+224 664 41 10 02' } },
    { fullName: 'Lansana Camara', nin: 'GN-NIN-0000000103', position: 'Mécanicien', hiredOn: '2019-11-18', monthlyNet: '3200000', payout: { operator: 'cellcom_money' as const, phone: '+224 655 41 10 03' } },
    { fullName: 'Fodé Soumah', nin: 'GN-NIN-0000000104', position: 'Chef de parc', hiredOn: '2018-02-12', monthlyNet: '4100000', payout: { operator: 'orange_money' as const, phone: '+224 622 41 10 04' } },
  ];
  const employees = [];
  for (const [index, input] of staff.entries()) employees.push(await business.hire(aissatou, boke, input, `demo-emp-${index}`));
  await business.issueCertificate(aissatou, boke, employees[1]!.id);
  const lastMonth = periodOf(addDays(`${periodOf(today)}-01`, -1));
  const payroll = await business.preparePayroll(aissatou, boke, { period: lastMonth, sourceAccountId: 'acc_bl_eco' }, 'demo-paie-1');
  await business.approveBatch(sekou, boke, payroll.id);

  // TVA d'il y a deux mois : déclarée par le directeur financier, paiement approuvé par le dirigeant.
  const twoMonthsAgo = periodOf(addDays(`${lastMonth}-01`, -1));
  const vat = await business.fileVat(alpha, boke, { period: twoMonthsAgo, sourceAccountId: 'acc_bl_eco' }, 'demo-tva-1');
  if (vat.paymentId && vat.state === 'awaiting_approval') await app.approvePayment(sekou, boke, vat.paymentId);

  // Couture Mariama : micro-entreprise en franchise de TVA, une facture fournisseur qui tend la trésorerie.
  const mariama = desk('per_mariama', 'spc_biz_couture');
  const couture = 'spc_biz_couture';
  await business.issueInvoice(mariama, couture, { customer: { name: 'Boutique Aïcha, Kaloum', phone: '+224 621 44 90 12' }, lines: [{ description: 'Tenue en bazin brodé', quantity: 12, unitPrice: '150000' }], vatRateBps: 0, issueDate: at(-18), dueInDays: 15 }, 'demo-cm-fac-1');
  await business.issueInvoice(mariama, couture, { customer: { name: 'Hôtel Camayenne' }, lines: [{ description: 'Uniforme du personnel d’accueil', quantity: 8, unitPrice: '150000' }], vatRateBps: 0, issueDate: at(-5), dueInDays: 11 }, 'demo-cm-fac-2');
  await business.recordBill(mariama, couture, { supplier: { name: 'Tissus Madina Wax' }, payee: { operator: 'orange_money', phone: '+224 620 56 56 56' }, reference: 'TMW-56', amount: '4500000', issueDate: at(-9), dueDate: at(4) }, 'demo-cm-bill-1');
  await business.hire(mariama, couture, { fullName: 'Aminata Diallo', nin: 'GN-NIN-0000000105', position: 'Apprentie couturière', hiredOn: '2025-10-01', monthlyNet: '1500000', payout: { operator: 'orange_money', phone: '+224 620 10 50 05' } }, 'demo-cm-emp-1');
}

async function seedAdministration(app: AppGn, administration: AdministrationDesk): Promise<void> {
  const today = dayOf(app.clock());
  const fatoumata = desk('per_fatoumata', 'spc_adm_kaloum');
  const ibrahima = desk('per_ibrahima', 'spc_adm_kaloum');
  const kaloum = 'spc_adm_kaloum';

  const lines = [
    { code: '6.1', label: 'Personnel : traitements et salaires', section: 'fonctionnement' as const, allocated: '1800000000', payroll: true },
    { code: '6.2', label: 'Fournitures de bureau et consommables', section: 'fonctionnement' as const, allocated: '240000000' },
    { code: '6.3', label: 'Entretien de la voirie et des marchés', section: 'fonctionnement' as const, allocated: '600000000' },
    { code: '6.4', label: 'Eau et électricité des bâtiments communaux', section: 'fonctionnement' as const, allocated: '180000000' },
    { code: '2.1', label: 'Équipement des services', section: 'investissement' as const, allocated: '900000000' },
    { code: '2.2', label: 'Assainissement et caniveaux', section: 'investissement' as const, allocated: '1200000000' },
  ];
  const opened = new Map<string, string>();
  for (const line of lines) opened.set(line.code, (await administration.openBudgetLine(fatoumata, kaloum, line)).id);

  const engage = (key: string, code: string, input: { supplier: string; phone: string; operator: 'orange_money' | 'mtn_momo'; object: string; amount: string }) =>
    administration.engage(fatoumata, kaloum, { lineId: opened.get(code)!, supplier: { name: input.supplier }, payee: { operator: input.operator, phone: input.phone }, object: input.object, amount: input.amount }, key);

  // Payé : engagé, service fait, mandaté, visé.
  const curage = await engage('demo-eng-1', '6.3', { supplier: 'Kaloum Propreté SARL', phone: '+224 620 63 00 01', operator: 'orange_money', object: 'Curage des caniveaux du marché Niger', amount: '85000000' });
  let view = await administration.liquidate(fatoumata, kaloum, curage.id, { amount: '85000000', invoiceReference: 'KP-2026-118', serviceDoneOn: today });
  view = await administration.mandate(fatoumata, kaloum, curage.id, view.liquidations[0]!.id, { sourceAccountId: 'acc_kal_tresor' });
  await administration.visa(ibrahima, kaloum, curage.id, view.liquidations[0]!.id);

  // En attente du visa du comptable public.
  const papeterie = await engage('demo-eng-2', '6.2', { supplier: 'Papeterie du Port', phone: '+224 664 62 00 02', operator: 'mtn_momo', object: 'Registres d’état civil et fournitures', amount: '14500000' });
  view = await administration.liquidate(fatoumata, kaloum, papeterie.id, { amount: '14500000', invoiceReference: 'PP-5531', serviceDoneOn: today });
  await administration.mandate(fatoumata, kaloum, papeterie.id, view.liquidations[0]!.id, { sourceAccountId: 'acc_kal_tresor' });

  // Liquidé en partie, à mandater.
  const ordinateurs = await engage('demo-eng-3', '2.1', { supplier: 'Informatique Conakry SARL', phone: '+224 620 21 00 03', operator: 'orange_money', object: '20 ordinateurs pour l’état civil', amount: '160000000' });
  await administration.liquidate(fatoumata, kaloum, ordinateurs.id, { amount: '80000000', invoiceReference: 'IC-0425 (1re livraison)', serviceDoneOn: today });

  // Engagé, service pas encore fait.
  await engage('demo-eng-4', '6.4', { supplier: 'Électricité des bâtiments (prestataire)', phone: '+224 620 64 00 04', operator: 'orange_money', object: 'Maintenance électrique de la mairie', amount: '45000000' });

  // Agents : dont trois anomalies que le contrôle de la paie écarte.
  const agents = [
    { matricule: 'KAL-001', fullName: 'Hawa Touré', nin: 'GN-NIN-0000000201', grade: 'Secrétaire générale', monthlyNet: '7500000', payout: { operator: 'orange_money' as const, phone: '+224 620 70 00 01' } },
    { matricule: 'KAL-002', fullName: 'Saliou Diallo', nin: 'GN-NIN-0000000202', grade: 'Agent d’état civil', monthlyNet: '3100000', payout: { operator: 'mtn_momo' as const, phone: '+224 664 70 00 02' } },
    { matricule: 'KAL-003', fullName: 'Mariame Kaba', nin: 'GN-NIN-0000000203', grade: 'Perceptrice des marchés', monthlyNet: '2800000', payout: { operator: 'orange_money' as const, phone: '+224 620 70 00 03' } },
    { matricule: 'KAL-004', fullName: 'Abdoulaye Sylla', nin: 'GN-NIN-0000000204', grade: 'Agent de voirie', monthlyNet: '2400000', payout: { operator: 'orange_money' as const, phone: '+224 620 70 00 04' } },
    { matricule: 'KAL-005', fullName: 'Djénabou Barry', nin: 'GN-NIN-0000000205', grade: 'Comptable matières', monthlyNet: '4200000', payout: { operator: 'mtn_momo' as const, phone: '+224 664 70 00 05' } },
    { matricule: 'KAL-006', fullName: 'Moussa Camara', nin: 'GN-NIN-0000000206', grade: 'Agent de voirie', monthlyNet: '2400000', payout: { operator: 'cellcom_money' as const, phone: '+224 655 70 00 06' } },
    // Un même NIN sous un autre nom, un NIN absent du registre, un wallet déjà utilisé par un autre agent.
    { matricule: 'KAL-007', fullName: 'Sékouba Kaba', nin: 'GN-NIN-0000000203', grade: 'Agent de voirie', monthlyNet: '2400000', payout: { operator: 'orange_money' as const, phone: '+224 620 70 00 07' } },
    { matricule: 'KAL-008', fullName: 'Ibrahima Conté', nin: 'GN-NIN-0000000299', grade: 'Gardien', monthlyNet: '1900000', payout: { operator: 'orange_money' as const, phone: '+224 620 70 00 08' } },
    { matricule: 'KAL-009', fullName: 'Aminata Diallo', nin: 'GN-NIN-0000000105', grade: 'Agente d’accueil', monthlyNet: '2100000', payout: { operator: 'orange_money' as const, phone: '+224 620 70 00 01' } },
  ];
  for (const agent of agents) await administration.enrolAgent(fatoumata, kaloum, agent);
  const lastMonth = periodOf(addDays(`${periodOf(today)}-01`, -1));
  const payroll = await administration.preparePayroll(fatoumata, kaloum, { period: lastMonth, sourceAccountId: 'acc_kal_tresor' }, 'demo-paie-1');
  await administration.payPayroll(ibrahima, kaloum, payroll.id);
}
