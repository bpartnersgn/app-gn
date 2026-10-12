import { useEffect, useMemo, useState } from 'react';
import { CHANNEL_LABELS, CHANNELS, type Channel, type MeView, type Person, type SpaceAccess } from '@app-gn/core';
import { createBaseClient } from './client.ts';
import { SessionContext, useOfflineStatus, useViewportChannel } from './context.ts';
import { SPACE_KIND_LABELS, SPACE_KIND_SHORT, dateTime } from './format.ts';
import { OfflineClient } from './offline.ts';
import { SECTIONS, SpaceView, type Section } from './SpaceView.tsx';

const client = new OfflineClient(createBaseClient());

export function App() {
  const viewport = useViewportChannel();
  const [override, setOverride] = useState<Channel | 'auto'>('auto');
  const channel = override === 'auto' ? viewport : override;

  const [persons, setPersons] = useState<Person[]>([]);
  const [profiles, setProfiles] = useState<Record<string, MeView>>({});
  const [personId, setPersonId] = useState<string | null>(null);
  const [me, setMe] = useState<MeView | null>(null);
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [section, setSection] = useState<Section>('home');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const list = await client.base.persons();
      setPersons(list);
      const views = await Promise.all(list.map((person) => client.base.me({ personId: person.id, channel: 'desktop' })));
      setProfiles(Object.fromEntries(views.map((view) => [view.person.id, view])));
    })().catch((cause) => setError(String(cause.message ?? cause)));
  }, []);

  // Les espaces ouverts dépendent de l'appareil : on relit à chaque changement de format.
  useEffect(() => {
    if (!personId) return;
    client.read({ personId, channel }, 'me', () => client.base.me({ personId, channel }))
      .then((view) => {
        setMe(view);
        setSpaceId((current) => {
          const still = view.spaces.find((access) => access.space.id === current && access.opensOnChannel);
          if (still) return current;
          const pro = view.spaces.find((access) => access.space.kind !== 'citizen' && access.opensOnChannel);
          return (pro ?? view.spaces.find((access) => access.opensOnChannel))?.space.id ?? null;
        });
      })
      .catch((cause) => setError((cause as Error).message));
  }, [personId, channel]);

  const session = useMemo(() => (personId ? { client, actor: { personId, channel } } : null), [personId, channel]);

  if (error) return <main className="page"><p className="notice notice-bad">{error}</p></main>;

  const deviceBar = (
    <DeviceBar channel={channel} override={override} onOverride={setOverride} />
  );

  if (!session || !me || !spaceId) {
    return (
      <div className="device" data-device={channel} data-forced={override !== 'auto'}>
        <div className="device-screen">
          {deviceBar}
          <SignIn persons={persons} profiles={profiles} channel={channel} onPick={(id) => { setPersonId(id); setSection('home'); }} />
        </div>
      </div>
    );
  }

  const active = me.spaces.find((access) => access.space.id === spaceId)!;
  const kind = active.space.kind;
  const layout: 'app' | 'web' | 'dashboard' = kind !== 'citizen' ? 'dashboard' : channel === 'phone' ? 'app' : 'web';
  const sections = SECTIONS[kind];

  return (
    <SessionContext.Provider value={session}>
      <div className="device" data-device={channel} data-forced={override !== 'auto'}>
        <div className="device-screen shell" data-kind={kind} data-layout={layout}>
          {deviceBar}
          <header className="topbar">
            <div className="brand">
              <span className="brand-mark" aria-hidden="true">GN</span>
              <span className="brand-name">App GN</span>
              {layout === 'dashboard' && <span className="brand-sub">{kind === 'business' ? 'GAPP' : 'GAPP Institutionnel'}</span>}
            </div>
            <div className="who">
              <span className="who-name">{me.person.fullName}</span>
              <button type="button" className="link" onClick={() => { setPersonId(null); setMe(null); setSpaceId(null); }}>Changer d’utilisateur</button>
            </div>
          </header>
          <OfflineBanner />

          <nav className="spaces" aria-label="Espaces">
            {me.spaces.map((access) => (
              <SpaceTab key={access.space.id} access={access} active={access.space.id === spaceId}
                onSelect={() => { setSpaceId(access.space.id); setSection('home'); }} />
            ))}
          </nav>

          <div className="workspace">
            {layout !== 'app' && (
              <nav className={layout === 'dashboard' ? 'sidenav' : 'toptabs'} aria-label="Rubriques">
                {sections.map((item) => (
                  <button key={item.id} type="button" className="nav-item" aria-current={section === item.id ? 'page' : undefined} onClick={() => setSection(item.id)}>
                    {item.label}
                  </button>
                ))}
              </nav>
            )}
            <SpaceView key={`${me.person.id}:${spaceId}`} access={active} section={section} onNavigate={setSection} />
          </div>

          {layout === 'app' && (
            <nav className="tabbar" aria-label="Rubriques">
              {sections.map((item) => (
                <button key={item.id} type="button" className="tab" aria-current={section === item.id ? 'page' : undefined} onClick={() => setSection(item.id)}>
                  <TabIcon section={item.id} />
                  <span>{item.short ?? item.label}</span>
                </button>
              ))}
            </nav>
          )}

          <footer className="foot">
            Démo du socle. Données fictives, connecteurs simulés : aucun fournisseur réel n’est appelé et aucun argent ne bouge.
          </footer>
        </div>
      </div>
    </SessionContext.Provider>
  );
}

function DeviceBar({ channel, override, onOverride }: { channel: Channel; override: Channel | 'auto'; onOverride: (value: Channel | 'auto') => void }) {
  const status = useOfflineStatus(client);
  return (
    <div className="demo-bar" role="group" aria-label="Simulation">
      <label className="demo-control">
        <span>Appareil</span>
        <select id="demo-device" value={override} onChange={(event) => onOverride(event.target.value as Channel | 'auto')}>
          <option value="auto">Auto ({CHANNEL_LABELS[channel].toLowerCase()})</option>
          {CHANNELS.map((value) => <option key={value} value={value}>{CHANNEL_LABELS[value]}</option>)}
        </select>
      </label>
      <label className="demo-control demo-switch">
        <input id="demo-offline" type="checkbox" checked={status.simulatedOffline} onChange={(event) => client.setSimulatedOffline(event.target.checked)} />
        <span>Couper le réseau</span>
      </label>
    </div>
  );
}

function OfflineBanner() {
  const status = useOfflineStatus(client);
  const offline = !client.isOnline;
  const pending = status.pending.length;
  if (status.lastSync && !offline) {
    const { sent, rejected, expired } = status.lastSync;
    const parts = [
      sent ? `${sent} paiement${sent > 1 ? 's' : ''} envoyé${sent > 1 ? 's' : ''}` : '',
      rejected ? `${rejected} refusé${rejected > 1 ? 's' : ''}` : '',
      expired ? `${expired} expiré${expired > 1 ? 's' : ''} (plus de 24 h sans réseau)` : '',
    ].filter(Boolean);
    return (
      <div className={`banner ${rejected || expired ? 'banner-wait' : 'banner-ok'}`} role="status">
        <span>Réseau revenu, synchronisation faite : {parts.join(', ')}.</span>
        <button type="button" className="link" onClick={() => client.dismissSync()}>OK</button>
      </div>
    );
  }
  if (!offline && pending === 0) return null;
  return (
    <div className={`banner ${offline ? 'banner-off' : 'banner-wait'}`} role="status">
      <span className="banner-dot" aria-hidden="true" />
      <span>
        {offline ? 'Hors ligne' : 'Envoi en cours'}
        {offline && status.servedFromCacheAt && <> · données gardées sur l’appareil, du {dateTime(status.servedFromCacheAt)}</>}
        {pending > 0 && <> · {pending} paiement{pending > 1 ? 's' : ''} en attente d’envoi</>}
      </span>
    </div>
  );
}

function SpaceTab({ access, active, onSelect }: { access: SpaceAccess; active: boolean; onSelect: () => void }) {
  return (
    <button type="button" className="space-tab" data-kind={access.space.kind} aria-pressed={active} disabled={!access.opensOnChannel} onClick={onSelect}
      title={access.opensOnChannel ? SPACE_KIND_LABELS[access.space.kind] : 'S’ouvre sur tablette ou ordinateur'}>
      <span className="space-tab-kind">{SPACE_KIND_SHORT[access.space.kind]}</span>
      <span className="space-tab-name">{access.space.kind === 'citizen' ? 'Mon espace' : access.space.name}</span>
      <span className="space-tab-role">{access.opensOnChannel ? access.roleLabel : 'Tablette ou ordinateur'}</span>
    </button>
  );
}

function SignIn({ persons, profiles, channel, onPick }: {
  persons: Person[];
  profiles: Record<string, MeView>;
  channel: Channel;
  onPick: (personId: string) => void;
}) {
  return (
    <main className="signin">
      <div className="signin-head">
        <span className="brand-mark brand-mark-lg" aria-hidden="true">GN</span>
        <h1>App GN</h1>
        <p className="lede">Une seule application pour le citoyen, l’entreprise et l’administration. Comptes, wallets, cartes, crypto et documents réunis, utilisables même sans réseau.</p>
      </div>
      <h2 className="eyebrow">Se connecter en tant que (démo)</h2>
      <ul className="persona-list">
        {persons.map((person) => {
          const view = profiles[person.id];
          return (
            <li key={person.id}>
              <button type="button" className="persona" onClick={() => onPick(person.id)}>
                <span className="persona-name">{person.fullName}</span>
                <span className="persona-nin">{person.nin}</span>
                <span className="persona-spaces">
                  {view?.spaces.map((access) => (
                    <span key={access.space.id} className="chip" data-kind={access.space.kind} data-muted={channel === 'phone' && access.space.kind !== 'citizen'}>
                      {access.space.kind === 'citizen' ? 'Citoyen' : `${access.roleLabel} · ${access.space.name}`}
                    </span>
                  ))}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="fine">
        {channel === 'phone'
          ? 'Sur téléphone, seule l’application citoyenne s’ouvre. Les espaces entreprise et administration demandent une tablette ou un ordinateur.'
          : 'Les espaces entreprise et administration s’ouvrent en tableau de bord ; l’espace citoyen, en version web.'}
      </p>
    </main>
  );
}

function TabIcon({ section }: { section: Section }) {
  const paths: Record<Section, string> = {
    home: 'M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z',
    pay: 'M4 7h13l-3-3m6 13H7l3 3',
    cards: 'M3 6h18v12H3zM3 10h18',
    documents: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7',
    services: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  };
  return (
    <svg className="tab-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={paths[section]} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

