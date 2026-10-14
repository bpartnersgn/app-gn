import type { VaultDocument } from './documents.ts';
import type { CitizenSpace, LinkedAccount, Membership, Person, Space } from './model.ts';

/**
 * Le référentiel : qui existe (personnes), quels espaces, qui y fait quoi (rattachements), quels comptes
 * y sont liés, quels documents sont au coffre. Le noyau en garde une copie en mémoire pour répondre sans
 * aller-retour ; toute écriture passe d'abord par ce magasin, qui est la référence (PostgreSQL côté serveur).
 */
export interface Directory {
  persons: Person[];
  spaces: Space[];
  memberships: Membership[];
  accounts: LinkedAccount[];
  documents: VaultDocument[];
}

export interface DirectoryStore {
  load(): Promise<Directory>;
  /**
   * Inscrit une personne avec son espace personnel, d'un seul geste. Rend `false` si le NIN est déjà inscrit
   * (y compris par une inscription simultanée) : rien n'est alors écrit.
   */
  addPerson(person: Person, space: CitizenSpace): Promise<boolean>;
  /** Crée un espace d'organisation ; `false` s'il existe déjà. */
  addSpace(space: Space): Promise<boolean>;
  /** Crée ou change le rôle d'une personne dans un espace. */
  setMembership(membership: Membership): Promise<void>;
  removeMembership(personId: string, spaceId: string): Promise<boolean>;
  addAccount(account: LinkedAccount): Promise<void>;
  /** `false` si le document est déjà au coffre. */
  addDocument(document: VaultDocument): Promise<boolean>;
}

export class MemoryDirectoryStore implements DirectoryStore {
  private readonly data: Directory;

  constructor(initial?: Partial<Directory>) {
    this.data = {
      persons: structuredClone(initial?.persons ?? []),
      spaces: structuredClone(initial?.spaces ?? []),
      memberships: structuredClone(initial?.memberships ?? []),
      accounts: structuredClone(initial?.accounts ?? []),
      documents: structuredClone(initial?.documents ?? []),
    };
  }

  async load(): Promise<Directory> {
    return structuredClone(this.data);
  }

  async addPerson(person: Person, space: CitizenSpace): Promise<boolean> {
    if (this.data.persons.some((candidate) => candidate.nin === person.nin || candidate.id === person.id)) return false;
    this.data.persons.push(structuredClone(person));
    this.data.spaces.push(structuredClone(space));
    this.data.memberships.push({ personId: person.id, spaceId: space.id, role: 'citizen' });
    return true;
  }

  async addSpace(space: Space): Promise<boolean> {
    if (this.data.spaces.some((candidate) => candidate.id === space.id)) return false;
    this.data.spaces.push(structuredClone(space));
    return true;
  }

  async setMembership(membership: Membership): Promise<void> {
    const index = this.data.memberships.findIndex((candidate) => candidate.personId === membership.personId && candidate.spaceId === membership.spaceId);
    if (index >= 0) this.data.memberships[index] = { ...membership };
    else this.data.memberships.push({ ...membership });
  }

  async removeMembership(personId: string, spaceId: string): Promise<boolean> {
    const index = this.data.memberships.findIndex((candidate) => candidate.personId === personId && candidate.spaceId === spaceId);
    if (index < 0) return false;
    this.data.memberships.splice(index, 1);
    return true;
  }

  async addAccount(account: LinkedAccount): Promise<void> {
    const index = this.data.accounts.findIndex((candidate) => candidate.id === account.id);
    if (index >= 0) this.data.accounts[index] = structuredClone(account);
    else this.data.accounts.push(structuredClone(account));
  }

  async addDocument(document: VaultDocument): Promise<boolean> {
    if (this.data.documents.some((candidate) => candidate.id === document.id)) return false;
    this.data.documents.push(structuredClone(document));
    return true;
  }
}

/** NIN tel qu'on le compare et le garde : majuscules, sans espaces. */
export function normalizeNin(nin: string): string {
  return typeof nin === 'string' ? nin.toUpperCase().replace(/\s+/g, '') : '';
}

/**
 * Numéro de mobile guinéen sous la forme gardée et affichée : `+224 6XX XX XX XX`. Accepte les saisies
 * courantes (`620000001`, `00224 620 00 00 01`, `+224620000001`) ; rend `undefined` pour tout le reste.
 */
export function normalizeGuineaMobile(input: string): string | undefined {
  if (typeof input !== 'string') return undefined;
  let digits = input.replace(/[\s.\-()]/g, '');
  if (digits.startsWith('+224')) digits = digits.slice(4);
  else if (digits.startsWith('00224')) digits = digits.slice(5);
  if (!/^6\d{8}$/.test(digits)) return undefined;
  return `+224 ${digits.slice(0, 3)} ${digits.slice(3, 5)} ${digits.slice(5, 7)} ${digits.slice(7, 9)}`;
}
