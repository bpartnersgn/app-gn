import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { CodeRequest, OfflineClient } from './offline.ts';

/**
 * Confirmation forte : au-delà de 5 M GNF, le serveur envoie un code par SMS au dirigeant et attend la même demande
 * avec ce code. Cette boîte le demande, puis l'action reprend toute seule. Renoncer n'envoie rien.
 */
export function ConfirmDialog({ client }: { client: OfflineClient }) {
  const [pending, setPending] = useState<{ request: CodeRequest; resolve: (code: string | null) => void } | null>(null);
  const [code, setCode] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    client.askCode = (request) => new Promise((resolve) => {
      setCode('');
      setPending({ request, resolve });
    });
    return () => { client.askCode = null; };
  }, [client]);

  useEffect(() => {
    if (pending) input.current?.focus();
  }, [pending]);

  if (!pending) return null;
  const { request, resolve } = pending;
  const close = (value: string | null) => {
    setPending(null);
    resolve(value);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (/^\d{6}$/.test(code.trim())) close(code.trim());
  };

  return (
    <div className="overlay" role="presentation" onKeyDown={(event) => { if (event.key === 'Escape') close(null); }}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onSubmit={submit}>
        <h2 id="confirm-title" className="dialog-title">Confirmer par code</h2>
        <p>Vous allez confirmer {request.challenge.summary}.</p>
        <p className="fine">{request.message.charAt(0).toUpperCase() + request.message.slice(1)}.</p>
        {request.challenge.demoCode && <p className="notice notice-wait">Démonstration : aucun SMS ne part. Code : <strong className="mono">{request.challenge.demoCode}</strong></p>}
        <label className="field">
          <span>Code à 6 chiffres</span>
          <input ref={input} id="confirm-code" value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="\d{6}" required />
        </label>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={() => close(null)}>Renoncer</button>
          <button type="submit" className="btn btn-primary" disabled={!/^\d{6}$/.test(code.trim())}>Confirmer</button>
        </div>
      </form>
    </div>
  );
}
