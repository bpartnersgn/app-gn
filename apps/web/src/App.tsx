import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { CHANNEL_LABELS, CHANNELS, spaceOpensOn, type Actor, type Channel, type MeView, type Person, type SpaceEntry } from '@app-gn/core';
import { createBaseClient, type CodeChallenge, type OpenedSession, type SignInOutcome } from './client.ts';
import { SessionContext, useOfflineStatus, useViewportChannel } from './context.ts';
import { SPACE_KIND_SHORT, dateTime } from './format.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { OfflineClient } from './offline.ts';
import { sectionsFor, SpaceView, type Section } from './SpaceView.tsx';

const client = new OfflineClient(createBaseClient());

/**
 * Ce que montre l'écran avant d'entrer dans un espace :
 * - la connexion (NIN puis code) ;
 * - le choix de l'espace, pour qui a aussi une entreprise ou une administration ;
 * - la confirmation par un nouveau code, pour passer d'un espace à un autre.
 */
type Entry =
  | { kind: 'signin' }
  | { kind: 'choose'; spaces: SpaceEntry[]; pick: (spaceId: string) => Promise<void> }
  | { kind: 'switch'; nin: string; target: SpaceEntry };

export function App() {
  const viewport = useViewportChannel();
  const [override, setOverride] = useState<Channel | 'auto'>('auto');
  const channel = override === 'auto' ? viewport : override;

  const [persons, setPersons] = useState<Person[]>([]);
  const [profiles, setProfiles] = useState<Record<string, MeView>>({});
  const [opened, setOpened] = useState<OpenedSession | null>(null);
  const [me, setMe] = useState<MeView | null>(null);
  const [entry, setEntry] = useState<Entry>({ kind: 'signin' });
  const [section, setSection] = useState<Section>('home');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      // Sans connexion de démo côté serveur, la liste n'existe pas : on garde la seule connexion par NIN.
      const list = await client.base.persons().catch(() => [] as Person[]);
      setPersons(list);
      const views = await Promise.all(list.map((person) => client.base.me({ personId: person.id, channel: 'desktop' })));
      setProfiles(Object.fromEntries(views.map((view) => [view.person.id, view])));
    })().catch((cause) => setError(String(cause.message ?? cause)));
  }, []);

  const actor: Actor | null = useMemo(() => (opened ? { personId: opened.personId, spaceId: opened.spaceId, channel } : null), [opened, channel]);

  useEffect(() => {
    if (!actor) return;
    client.read(actor, 'me', () => client.base.me(actor))
      .then(setMe)
      .catch((cause) => setError((cause as Error).message));
  }, [actor]);

  const session = useMemo(() => (actor ? { client, actor } : null), [actor]);

  function enter(next: OpenedSession) {
    setOpened(next);
    setMe(null);
    setSection('home');
    setEntry({ kind: 'signin' });
    client.setSession({ ...next, channel });
  }

  async function leave() {
    if (actor && opened) {
      await client.forget(actor);
      await client.base.signOut(opened);
    }
    client.setSession(null);
    setOpened(null);
    setMe(null);
  }

  function chooseFrom(outcome: SignInOutcome) {
    if (outcome.kind === 'session') return enter(outcome);
    setEntry({
      kind: 'choose',
      spaces: outcome.spaces,
      pick: async (spaceId) => enter(await client.base.selectSpace(outcome.selectionToken, spaceId)),
    });
  }

  /** Accès rapide de démonstration : pas de code, mais le même choix d'espace. */
  function pickPersona(personId: string) {
    const spaces = (profiles[personId]?.spaces ?? []).map((access) => ({
      id: access.space.id, kind: access.space.kind, name: access.space.name, opensOnChannel: access.opensOnChannel,
    }));
    if (spaces.length === 1) return enter({ personId, spaceId: spaces[0]!.id });
    setEntry({ kind: 'choose', spaces, pick: async (spaceId) => enter({ personId, spaceId }) });
  }

  if (error) return <main className="page"><p className="notice notice-bad">{error}</p></main>;

  const deviceBar = <DeviceBar channel={channel} override={override} onOverride={setOverride} />;

  if (!session || !me) {
    return (
      <div className="device" data-device={channel} data-forced={override !== 'auto'}>
        <div className="device-screen">
          {deviceBar}
          {entry.kind === 'choose' ? (
            <SpaceChooser spaces={entry.spaces} channel={channel} onPick={entry.pick} onCancel={() => setEntry({ kind: 'signin' })} />
          ) : (
            <SignIn
              key={entry.kind === 'switch' ? entry.target.id : 'signin'}
              persons={entry.kind === 'switch' ? [] : persons}
              profiles={profiles}
              channel={channel}
              switching={entry.kind === 'switch' ? entry : undefined}
              onPick={pickPersona}
              onOutcome={chooseFrom}
              onCancelSwitch={() => setEntry({ kind: 'signin' })}
            />
          )}
        </div>
      </div>
    );
  }

  const active = me.spaces[0]!;
  const kind = active.space.kind;
  const layout: 'app' | 'web' | 'dashboard' = kind !== 'citizen' ? 'dashboard' : channel === 'phone' ? 'app' : 'web';
  const sections = sectionsFor(active);
  // Une rubrique que ce rôle n'a pas (la RH n'a pas la trésorerie) : on ouvre la première qu'il a.
  const current: Section = sections.some((item) => item.id === section) ? section : sections[0]?.id ?? 'documents';

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
              <SpaceSwitcher me={me} channel={channel} onSwitch={async (target) => {
                const nin = me.person.nin;
                await leave();
                setEntry({ kind: 'switch', nin, target });
              }} />
              <button type="button" className="link" onClick={() => void leave()}>Se déconnecter</button>
            </div>
          </header>
          <div className="space-bar" data-kind={kind}>
            <span className="space-bar-kind">{kind === 'citizen' ? 'Espace personnel' : SPACE_KIND_SHORT[kind]}</span>
            <span className="space-bar-name">{kind === 'citizen' ? 'Mes comptes' : active.space.name}</span>
            {kind !== 'citizen' && <span className="space-bar-role">{active.roleLabel}</span>}
          </div>
          <OfflineBanner />

          {!active.opensOnChannel ? (
            <main className="page">
              <p className="notice notice-wait">Cet espace s’ouvre sur tablette ou ordinateur. Sur téléphone, seul votre espace personnel est disponible.</p>
            </main>
          ) : (
            <div className="workspace">
              {layout !== 'app' && (
                <nav className={layout === 'dashboard' ? 'sidenav' : 'toptabs'} aria-label="Rubriques">
                  {sections.map((item) => (
                    <button key={item.id} type="button" className="nav-item" aria-current={current === item.id ? 'page' : undefined} onClick={() => setSection(item.id)}>
                      {item.label}
                    </button>
                  ))}
                </nav>
              )}
              <SpaceView key={`${me.person.id}:${active.space.id}`} access={active} section={current} onNavigate={setSection} />
            </div>
          )}

          {layout === 'app' && (
            <nav className="tabbar" aria-label="Rubriques">
              {sections.map((item) => (
                <button key={item.id} type="button" className="tab" aria-current={current === item.id ? 'page' : undefined} onClick={() => setSection(item.id)}>
                  <TabIcon section={item.id} />
                  <span>{item.short ?? item.label}</span>
                </button>
              ))}
            </nav>
          )}

          <ConfirmDialog client={client} />
          <footer className="foot">
            Démo du socle. Données fictives, connecteurs simulés : aucun fournisseur réel n’est appelé et aucun argent ne bouge.
          </footer>
        </div>
      </div>
    </SessionContext.Provider>
  );
}

/** Passer à un autre espace : on quitte celui-ci, et l'autre demande un nouveau code. Absent pour qui n'a qu'un espace. */
function SpaceSwitcher({ me, channel, onSwitch }: { me: MeView; channel: Channel; onSwitch: (target: SpaceEntry) => void }) {
  const [open, setOpen] = useState(false);
  if (me.otherSpaces.length === 0) return null;
  return (
    <div className="switcher">
      <button type="button" className="link" aria-expanded={open} onClick={() => setOpen(!open)}>Changer d’espace</button>
      {open && (
        <ul className="switcher-menu" role="menu">
          {me.otherSpaces.map((space) => {
            const opens = spaceOpensOn(space.kind, channel);
            return (
              <li key={space.id} role="none">
                <button type="button" role="menuitem" className="switcher-item" data-kind={space.kind} disabled={!opens} onClick={() => onSwitch(space)}>
                  <span className="switcher-name">{spaceTitle(space)}</span>
                  <span className="fine">{opens ? 'Nouveau code demandé' : 'Tablette ou ordinateur'}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function spaceTitle(space: SpaceEntry): string {
  return space.kind === 'citizen' ? 'Mon espace personnel' : space.name;
}

function SpaceChooser({ spaces, channel, onPick, onCancel }: { spaces: SpaceEntry[]; channel: Channel; onPick: (spaceId: string) => Promise<void>; onCancel: () => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <main className="signin">
      <div className="signin-head">
        <h1 className="chooser-title">Où voulez-vous entrer ?</h1>
        <p className="lede">Vos fonds personnels et ceux de vos organisations ne s’affichent jamais ensemble. Pour passer de l’un à l’autre, vous confirmez avec un nouveau code.</p>
      </div>
      <ul className="persona-list">
        {spaces.map((space) => {
          const opens = spaceOpensOn(space.kind, channel);
          return (
            <li key={space.id}>
              <button type="button" className="persona entrance" data-kind={space.kind} disabled={!opens}
                onClick={() => onPick(space.id).catch((cause) => setError((cause as Error).message))}>
                <span className="eyebrow">{space.kind === 'citizen' ? 'Personnel' : SPACE_KIND_SHORT[space.kind]}</span>
                <span className="persona-name">{spaceTitle(space)}</span>
                <span className="fine">
                  {space.kind === 'citizen'
                    ? 'Vos comptes, wallets, cartes et documents à vous'
                    : opens ? 'Tableau de bord de l’organisation' : 'S’ouvre sur tablette ou ordinateur'}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {error && <p className="notice notice-bad">{error}</p>}
      <button type="button" className="link" onClick={onCancel}>Annuler</button>
    </main>
  );
}

function SignIn({ persons, profiles, channel, switching, onPick, onOutcome, onCancelSwitch }: {
  persons: Person[];
  profiles: Record<string, MeView>;
  channel: Channel;
  switching?: { nin: string; target: SpaceEntry };
  onPick: (personId: string) => void;
  onOutcome: (outcome: SignInOutcome) => void;
  onCancelSwitch: () => void;
}) {
  return (
    <main className="signin">
      <div className="signin-head">
        <span className="brand-mark brand-mark-lg" aria-hidden="true">GN</span>
        <h1>App GN</h1>
        {switching
          ? <p className="lede">Pour entrer dans <strong>{spaceTitle(switching.target)}</strong>, confirmez avec un nouveau code. L’espace que vous quittez a été fermé et effacé de cet appareil.</p>
          : <p className="lede">Vos comptes, wallets, cartes, crypto et documents réunis, utilisables même sans réseau. Si vous gérez une entreprise ou une administration, elle a son propre espace, séparé du vôtre.</p>}
      </div>
      <NinSignIn presetNin={switching?.nin} spaceId={switching?.target.id} onOutcome={onOutcome} />
      {switching && <button type="button" className="link" onClick={onCancelSwitch}>Annuler</button>}
      {persons.length > 0 && <h2 className="eyebrow">Ou accès rapide (démo)</h2>}
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
                      {access.space.kind === 'citizen' ? 'Personnel' : `${access.roleLabel} · ${access.space.name}`}
                    </span>
                  ))}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {persons.length > 0 && (
        <p className="fine">
          {channel === 'phone'
            ? 'Sur téléphone, seul l’espace personnel s’ouvre. Les espaces entreprise et administration demandent une tablette ou un ordinateur.'
            : 'Chaque espace s’ouvre seul : l’espace personnel en version web, une entreprise ou une administration en tableau de bord.'}
        </p>
      )}
    </main>
  );
}

/** Connexion par NIN : le code arrive par SMS (montré ici en démonstration, aucun SMS n'étant branché). */
function NinSignIn({ presetNin, spaceId, onOutcome }: { presetNin?: string; spaceId?: string; onOutcome: (outcome: SignInOutcome) => void }) {
  const [nin, setNin] = useState(presetNin ?? '');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<CodeChallenge | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (!challenge) {
        setChallenge(await client.base.requestCode(nin));
      } else {
        onOutcome(await client.base.openSession(challenge.challengeId, code, spaceId));
      }
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel nin-form" onSubmit={submit} aria-labelledby="nin-title">
      <h2 id="nin-title" className="panel-title">{presetNin ? 'Confirmer avec un code' : 'Se connecter avec mon NIN'}</h2>
      {!challenge ? (
        <label className="field">
          <span>Numéro d’identification nationale</span>
          <input id="nin" className="mono" value={nin} onChange={(event) => setNin(event.target.value)} placeholder="GN-NIN-…" autoComplete="username" readOnly={Boolean(presetNin)} required />
        </label>
      ) : (
        <>
          <p className="fine">Si ce NIN est enregistré, un code à 6 chiffres vient d’être envoyé par SMS au numéro associé. Il expire dans 5 minutes.</p>
          {challenge.demoCode && <p className="notice notice-wait">Démo, aucun SMS envoyé : votre code est <strong className="mono">{challenge.demoCode}</strong></p>}
          <label className="field">
            <span>Code reçu par SMS</span>
            <input id="otp" className="mono" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} required />
          </label>
        </>
      )}
      {error && <p className="notice notice-bad">{error}</p>}
      <div className="nin-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>{challenge ? 'Se connecter' : 'Recevoir un code'}</button>
        {challenge && !presetNin && <button type="button" className="link" onClick={() => { setChallenge(null); setCode(''); setError(null); }}>Changer de NIN</button>}
      </div>
    </form>
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

function TabIcon({ section }: { section: Section }) {
  const paths: Partial<Record<Section, string>> = {
    home: 'M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z',
    pay: 'M4 7h13l-3-3m6 13H7l3 3',
    cards: 'M3 6h18v12H3zM3 10h18',
    documents: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7',
    services: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  };
  return (
    <svg className="tab-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={paths[section] ?? paths.services} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
