import { parseArgs } from 'node:util';
import { AppError, loadDemoApp, ROLE_LABELS, type AdministrationSpace, type BusinessSpace, type Role } from '@app-gn/core';
import { databaseFromEnvironment } from './db/connect.ts';

/**
 * Outil de l'exploitant, hors API publique : ouvrir une organisation et y rattacher des personnes déjà inscrites.
 * Agit sur la base de `DATABASE_URL` (ou `APPGN_PGLITE_DIR`).
 *
 *   node src/admin.ts open-business --id spc_biz_x --name "…" --legal-form SARL --rccm … --nif … --owner-nin …
 *   node src/admin.ts open-administration --id spc_adm_x --name "…" --entity-type collectivite --owner-nin …
 *   node src/admin.ts assign --space spc_adm_x --nin … --role admin_public_accountant
 *   node src/admin.ts roles
 */
const USAGE = 'usage : admin.ts open-business | open-administration | assign | roles  (voir l’en-tête du fichier)';
const ENTITY_TYPES = ['collectivite', 'epa', 'agence', 'entreprise_publique'] as const;

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    id: { type: 'string' }, name: { type: 'string' }, 'legal-form': { type: 'string' }, rccm: { type: 'string' }, nif: { type: 'string' },
    'entity-type': { type: 'string' }, 'owner-nin': { type: 'string' }, space: { type: 'string' }, nin: { type: 'string' }, role: { type: 'string' },
  },
});

function required(name: keyof typeof values): string {
  const value = values[name]?.trim();
  if (!value) throw new Error(`--${name} est requis`);
  return value;
}

if (command === 'roles') {
  for (const [role, label] of Object.entries(ROLE_LABELS)) console.log(`${role.padEnd(28)} ${label}`);
  process.exit(0);
}
if (!command || !['open-business', 'open-administration', 'assign'].includes(command)) {
  console.error(USAGE);
  process.exit(2);
}

const database = await databaseFromEnvironment(process.env);
if (!database) {
  console.error('DATABASE_URL (ou APPGN_PGLITE_DIR) est requise : l’outil agit sur le référentiel en base.');
  process.exit(2);
}
try {
  const { app } = await loadDemoApp({ store: database.store, directory: database.store, seedDirectory: false });
  if (command === 'open-business') {
    const space: BusinessSpace = { id: required('id'), kind: 'business', name: required('name'), legalForm: required('legal-form'), rccm: required('rccm'), nif: required('nif') };
    await app.openOrganization(space, required('owner-nin'));
    console.log(`entreprise ${space.id} ouverte ; dirigeant : ${required('owner-nin')}`);
  } else if (command === 'open-administration') {
    const entityType = required('entity-type');
    if (!(ENTITY_TYPES as readonly string[]).includes(entityType)) throw new Error(`--entity-type : ${ENTITY_TYPES.join(', ')}`);
    const space: AdministrationSpace = { id: required('id'), kind: 'administration', name: required('name'), entityType: entityType as AdministrationSpace['entityType'] };
    await app.openOrganization(space, required('owner-nin'));
    console.log(`administration ${space.id} ouverte ; ordonnateur : ${required('owner-nin')}`);
  } else {
    const role = required('role');
    if (!(role in ROLE_LABELS)) throw new Error('--role inconnu (voir : admin.ts roles)');
    const membership = await app.assignMember(required('space'), required('nin'), role as Role);
    console.log(`${membership.personId} : ${ROLE_LABELS[membership.role]} dans ${membership.spaceId}`);
  }
} catch (error) {
  console.error(error instanceof AppError ? `refusé : ${error.message}` : (error as Error).message);
  process.exitCode = 1;
} finally {
  await database.close();
}
