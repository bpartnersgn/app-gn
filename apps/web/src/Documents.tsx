import { useState, type FormEvent } from 'react';
import { DOCUMENT_CATEGORY_LABELS, type DocumentVerification, type DocumentView, type SpaceAccess } from '@app-gn/core';
import { useRead, useSession } from './context.ts';

const VALIDITY: Record<DocumentView['validity'], { tone: 'ok' | 'wait' | 'bad' | 'neutral'; label: (doc: DocumentView) => string }> = {
  valid: { tone: 'ok', label: (doc) => `Valide jusqu’au ${formatDay(doc.expiresAt!)}` },
  expiring: { tone: 'wait', label: (doc) => doc.daysLeft === 0 ? 'Expire aujourd’hui' : `Expire dans ${doc.daysLeft} j` },
  expired: { tone: 'bad', label: (doc) => `Expiré depuis le ${formatDay(doc.expiresAt!)}` },
  no_expiry: { tone: 'neutral', label: () => 'Sans date d’expiration' },
};

function verificationLabel(result: DocumentVerification): string {
  if (!result.expiresAt) return 'sans date d’expiration';
  if (result.validity === 'expired') return `expiré depuis le ${formatDay(result.expiresAt)}`;
  return `valide jusqu’au ${formatDay(result.expiresAt)}`;
}

function formatDay(iso: string) {
  return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function DocumentsSection({ access }: { access: SpaceAccess }) {
  const spaceId = access.space.id;
  const { data, error } = useRead<DocumentView[]>(`${spaceId}:documents`, ({ client, actor }) => client.base.documents(actor, spaceId));
  const [shown, setShown] = useState<string | null>(null);
  const alerts = (data ?? []).filter((doc) => doc.validity === 'expired' || doc.validity === 'expiring');

  return (
    <div className="columns">
      <div className="col-main">
        <section className="panel" aria-labelledby="docs-title">
          <div className="panel-head">
            <h2 id="docs-title" className="panel-title">{access.space.kind === 'citizen' ? 'Mes documents' : 'Documents'}</h2>
            {data && <span className="pill pill-neutral">Gardés sur l’appareil</span>}
          </div>
          {error && !data && <p className="notice notice-bad">{error}</p>}
          {alerts.length > 0 && (
            <p className="notice notice-wait">
              À renouveler : {alerts.map((doc) => `${doc.title} (${VALIDITY[doc.validity].label(doc).toLowerCase()})`).join(', ')}.
            </p>
          )}
          <ul className="docs">
            {(data ?? []).map((doc) => (
              <li key={doc.id} className="doc" data-category={doc.category}>
                <div className="doc-head">
                  <span className="doc-cat">{DOCUMENT_CATEGORY_LABELS[doc.category]}</span>
                  <span className={`pill pill-${VALIDITY[doc.validity].tone}`}>{VALIDITY[doc.validity].label(doc)}</span>
                </div>
                <h3 className="doc-title">{doc.title}</h3>
                <p className="doc-issuer">{doc.issuer}</p>
                <dl className="doc-fields">
                  <div><dt>Titulaire</dt><dd>{doc.holderName}</dd></div>
                  <div><dt>N°</dt><dd className="mono">{doc.reference}</dd></div>
                  {doc.fields.map((field) => <div key={field.label}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}
                </dl>
                <div className="doc-foot">
                  <span className={`source source-${doc.source}`}>{doc.source === 'issuer' ? 'Émis par l’organisme' : 'Ajouté par vous'}</span>
                  {doc.verificationCode && (
                    <button type="button" className="link" onClick={() => setShown(shown === doc.id ? null : doc.id)}>
                      {shown === doc.id ? 'Masquer' : 'Présenter'}
                    </button>
                  )}
                </div>
                {shown === doc.id && doc.verificationCode && (
                  <div className="present">
                    <span className="fine">Code de vérification, à donner au contrôleur</span>
                    <span className="present-code">{doc.verificationCode}</span>
                    <span className="fine">Le contrôleur voit le titre, l’émetteur, le titulaire et la validité. Rien d’autre.</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
      <div className="col-side">
        <VerifyPanel />
      </div>
    </div>
  );
}

/** Vue « contrôleur » : vérifier un document présenté, à partir de son code. */
function VerifyPanel() {
  const { client } = useSession();
  const [code, setCode] = useState('');
  const [result, setResult] = useState<DocumentVerification | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setResult(null);
    try {
      setResult(await client.write(() => client.base.verifyDocument(code)));
    } catch (cause) {
      setError((cause as Error).message === 'code inconnu' ? 'Code inconnu : ce document n’a pas été émis par un organisme raccordé.' : (cause as Error).message);
    }
  }
  return (
    <section className="panel" aria-labelledby="verify-title">
      <h2 id="verify-title" className="panel-title">Vérifier un document</h2>
      <p className="fine">Pour un agent ou un guichet : saisissez le code présenté. Exemple : GN-PC-9D2F-H7RT.</p>
      <form className="pay-form" onSubmit={submit}>
        <label className="field">
          <span>Code</span>
          <input id="verify-code" className="mono" value={code} onChange={(event) => setCode(event.target.value)} placeholder="GN-…" required />
        </label>
        <button type="submit" className="btn btn-block">Vérifier</button>
      </form>
      {result && (
        <div className={`notice notice-${result.validity === 'expired' ? 'bad' : result.validity === 'expiring' ? 'wait' : 'ok'}`}>
          <strong>{result.title}</strong> · {result.holderName}<br />
          {result.issuer} · {verificationLabel(result)}
        </div>
      )}
      {error && <p className="notice notice-bad">{error}</p>}
    </section>
  );
}
