import { useCallback, useEffect, useState } from 'react';
import type { MeView, Person, SpaceAccess } from '@app-gn/core';
import { createClient } from './client.ts';
import { SPACE_KIND_LABELS, SPACE_KIND_SHORT } from './format.ts';
import { SpaceView } from './SpaceView.tsx';

const client = createClient();

export function App() {
  const [persons, setPersons] = useState<Person[]>([]);
  const [profiles, setProfiles] = useState<Record<string, MeView>>({});
  const [me, setMe] = useState<MeView | null>(null);
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const list = await client.persons();
      setPersons(list);
      const views = await Promise.all(list.map((person) => client.me(person.id)));
      setProfiles(Object.fromEntries(views.map((view) => [view.person.id, view])));
    })().catch((cause) => setError(String(cause.message ?? cause)));
  }, []);

  const signIn = useCallback(async (personId: string, preferredKind?: string) => {
    const view = await client.me(personId);
    setMe(view);
    const preferred = view.spaces.find((access) => access.space.kind === preferredKind) ?? view.spaces[0];
    setSpaceId(preferred?.space.id ?? null);
  }, []);

  if (error) return <main className="page"><p className="notice notice-bad">{error}</p></main>;

  if (!me || !spaceId) {
    return <SignIn persons={persons} profiles={profiles} onPick={signIn} embedded={client.mode === 'embedded'} />;
  }

  const active = me.spaces.find((access) => access.space.id === spaceId)!;
  return (
    <div className="shell" data-kind={active.space.kind}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">GN</span>
          <span className="brand-name">App GN</span>
        </div>
        <div className="who">
          <span className="who-name">{me.person.fullName}</span>
          <button type="button" className="link" onClick={() => { setMe(null); setSpaceId(null); }}>Changer d’utilisateur</button>
        </div>
      </header>

      <nav className="spaces" aria-label="Espaces">
        {me.spaces.map((access) => (
          <SpaceTab key={access.space.id} access={access} active={access.space.id === spaceId} onSelect={() => setSpaceId(access.space.id)} />
        ))}
      </nav>

      <SpaceView key={`${me.person.id}:${spaceId}`} client={client} person={me.person} access={active} />

      <footer className="foot">
        Socle de démonstration. Données fictives, connecteurs simulés : aucun fournisseur réel n’est appelé et aucun argent ne bouge.
        {client.mode === 'embedded' ? ' Le noyau tourne dans le navigateur.' : ' Servi par l’API App GN.'}
      </footer>
    </div>
  );
}

function SpaceTab({ access, active, onSelect }: { access: SpaceAccess; active: boolean; onSelect: () => void }) {
  return (
    <button type="button" className="space-tab" data-kind={access.space.kind} aria-pressed={active} onClick={onSelect}>
      <span className="space-tab-kind">{SPACE_KIND_SHORT[access.space.kind]}</span>
      <span className="space-tab-name">{access.space.kind === 'citizen' ? 'Mon espace' : access.space.name}</span>
      <span className="space-tab-role">{access.roleLabel}</span>
    </button>
  );
}

function SignIn({ persons, profiles, onPick, embedded }: {
  persons: Person[];
  profiles: Record<string, MeView>;
  onPick: (personId: string, preferredKind?: string) => void;
  embedded: boolean;
}) {
  return (
    <main className="signin">
      <div className="signin-head">
        <span className="brand-mark brand-mark-lg" aria-hidden="true">GN</span>
        <h1>App GN</h1>
        <p className="lede">Une seule application pour le citoyen, l’entreprise et l’administration. Tous vos comptes, wallets, cartes et actifs crypto réunis, et les services qui s’en servent.</p>
      </div>
      <h2 className="eyebrow">Se connecter en tant que (démo)</h2>
      <ul className="persona-list">
        {persons.map((person) => {
          const view = profiles[person.id];
          const pro = view?.spaces.find((access) => access.space.kind !== 'citizen');
          return (
            <li key={person.id}>
              <button type="button" className="persona" onClick={() => onPick(person.id, pro?.space.kind)}>
                <span className="persona-name">{person.fullName}</span>
                <span className="persona-nin">{person.nin}</span>
                <span className="persona-spaces">
                  {view?.spaces.map((access) => (
                    <span key={access.space.id} className="chip" data-kind={access.space.kind} title={SPACE_KIND_LABELS[access.space.kind]}>
                      {access.space.kind === 'citizen' ? 'Citoyen' : `${access.roleLabel} · ${access.space.name}`}
                    </span>
                  ))}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="fine">{embedded ? 'Mode démo autonome : l’application embarque son noyau et ses données fictives.' : 'Connecté à l’API App GN locale.'}</p>
    </main>
  );
}
