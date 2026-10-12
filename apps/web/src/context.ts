import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { Actor, Channel } from '@app-gn/core';
import type { OfflineClient } from './offline.ts';

export interface Session {
  client: OfflineClient;
  actor: Actor;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('session absente');
  return session;
}

export function useOfflineStatus(client: OfflineClient) {
  return useSyncExternalStore(client.subscribe, client.snapshot);
}

/** Lecture hors ligne d'abord, relancée à chaque `version` (après une action) et au retour du réseau. */
export function useRead<T>(key: string, fetcher: (session: Session) => Promise<T>, version = 0) {
  const session = useSession();
  const status = useOfflineStatus(session.client);
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  const online = session.client.isOnline;
  const load = useCallback(() => {
    session.client.read(session.actor, key, () => fetcher(session))
      .then((data) => setState({ data }))
      .catch((error: Error) => setState((previous) => ({ data: previous.data, error: error.message })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, key]);
  useEffect(load, [load, version, online, status.lastSync?.at]);
  return state;
}

/** Format d'appareil déduit de la largeur, que la démo peut forcer. */
export function detectChannel(width: number): Channel {
  if (width < 700) return 'phone';
  if (width < 1100) return 'tablet';
  return 'desktop';
}

export function useViewportChannel(): Channel {
  const [channel, setChannel] = useState<Channel>(() => detectChannel(typeof window === 'undefined' ? 1280 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setChannel(detectChannel(window.innerWidth));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return channel;
}
