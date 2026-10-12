import type { Role, SpaceKind } from './model.ts';

export type Permission =
  | 'accounts:read'
  | 'accounts:link'
  | 'payments:initiate'
  | 'payments:approve'
  | 'invoices:write'
  | 'tax:declare'
  | 'payroll:submit'
  | 'budget:read'
  | 'reports:read'
  | 'members:manage';

export const ROLE_SPACE_KIND: Record<Role, SpaceKind> = {
  citizen: 'citizen',
  business_owner: 'business',
  business_finance: 'business',
  business_accountant: 'business',
  business_hr: 'business',
  admin_authorizing_officer: 'administration',
  admin_public_accountant: 'administration',
  admin_viewer: 'administration',
};

export const ROLE_LABELS: Record<Role, string> = {
  citizen: 'Titulaire',
  business_owner: 'Dirigeant',
  business_finance: 'Directeur financier',
  business_accountant: 'Comptable',
  business_hr: 'Ressources humaines',
  admin_authorizing_officer: 'Ordonnateur',
  admin_public_accountant: 'Comptable public',
  admin_viewer: 'Contrôle (lecture)',
};

/**
 * Matrice rôle → permissions. Côté administration, l'ordonnateur engage et le comptable public paie :
 * la séparation ordonnateur / comptable est portée par la matrice ET par la règle d'approbation
 * (celui qui initie ne peut pas approuver, voir payments.ts).
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  citizen: ['accounts:read', 'accounts:link', 'payments:initiate', 'payments:approve'],
  business_owner: [
    'accounts:read', 'accounts:link', 'payments:initiate', 'payments:approve',
    'invoices:write', 'tax:declare', 'payroll:submit', 'reports:read', 'members:manage',
  ],
  business_finance: ['accounts:read', 'accounts:link', 'payments:initiate', 'invoices:write', 'tax:declare', 'reports:read'],
  business_accountant: ['accounts:read', 'invoices:write', 'reports:read'],
  business_hr: ['accounts:read', 'payroll:submit'],
  admin_authorizing_officer: ['accounts:read', 'payments:initiate', 'payroll:submit', 'budget:read', 'reports:read'],
  admin_public_accountant: ['accounts:read', 'payments:approve', 'budget:read', 'reports:read'],
  admin_viewer: ['accounts:read', 'budget:read', 'reports:read'],
};

export function permissionsOf(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
