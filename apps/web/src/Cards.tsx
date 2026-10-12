import { useEffect, useState } from 'react';
import {
  CARD_ISSUE_PRICE_GNF,
  CARD_TIER_LABELS,
  MAX_CARDS_PER_TIER,
  money,
  providerById,
  type AccountPosition,
  type CardNetwork,
  type CardTier,
  type CardView,
  type ExchangeQuote,
  type SpaceAccess,
} from '@app-gn/core';
import { useRead, useSession } from './context.ts';
import { FAILURE_REASONS, fmt } from './format.ts';

type Message = { tone: 'ok' | 'bad' | 'wait'; text: string };

/** Cartes virtuelles et conversions, sur le modèle Keecash : recharge Mobile Money ou crypto, blocage instantané. */
export function CardsSection({ access, positions, version, onChange }: { access: SpaceAccess; positions: AccountPosition[]; version: number; onChange: () => void }) {
  const spaceId = access.space.id;
  const cards = useRead<CardView[]>(`${spaceId}:cards`, ({ client, actor }) => client.base.cards(actor, spaceId), version);
  const [message, setMessage] = useState<Message | null>(null);
  const balances = new Map(positions.map((position) => [position.account.id, position.balance]));
  const cardIds = new Set((cards.data ?? []).map((card) => card.accountId));
  const crypto = positions.filter((position) => position.kind === 'crypto');
  const mobileMoney = positions.filter((position) => position.kind === 'mobile_money' || position.kind === 'app_wallet');

  const done = (next: Message) => { setMessage(next); onChange(); };

  return (
    <div className="columns">
      <div className="col-main">
        <section className="panel" aria-labelledby="cards-title">
          <h2 id="cards-title" className="panel-title">Mes cartes virtuelles</h2>
          {cards.error && !cards.data && <p className="notice notice-bad">{cards.error}</p>}
          <ul className="card-list">
            {(cards.data ?? []).map((card) => (
              <li key={card.accountId}><CardFace card={card} balance={balances.get(card.accountId)} spaceId={spaceId} onDone={done} /></li>
            ))}
          </ul>
          <IssueCard spaceId={spaceId} cards={cards.data ?? []} onDone={done} />
          {message && <p className={`notice notice-${message.tone}`} role="status">{message.text}</p>}
        </section>
      </div>
      <div className="col-side">
        <section className="panel" aria-labelledby="topup-title">
          <h2 id="topup-title" className="panel-title">Recharger une carte</h2>
          <ExchangeForm
            id="topup"
            spaceId={spaceId}
            sources={positions.filter((position) => !cardIds.has(position.account.id) && (position.kind !== 'bank'))}
            targets={positions.filter((position) => cardIds.has(position.account.id))}
            onDone={done}
          />
        </section>
        {crypto.length > 0 && (
          <section className="panel" aria-labelledby="cashout-title">
            <h2 id="cashout-title" className="panel-title">Crypto vers Mobile Money</h2>
            <ExchangeForm id="cashout" spaceId={spaceId} sources={crypto} targets={mobileMoney} onDone={done} />
          </section>
        )}
      </div>
    </div>
  );
}

function CardFace({ card, balance, spaceId, onDone }: { card: CardView; balance?: { amount: string; currency: 'GNF' | 'USD' | string }; spaceId: string; onDone: (message: Message) => void }) {
  const { client, actor } = useSession();
  const frozen = card.status === 'frozen';
  async function toggle() {
    try {
      await client.write(() => client.base.setCardFrozen(actor, spaceId, card.accountId, !frozen));
      onDone({ tone: frozen ? 'ok' : 'wait', text: frozen ? `Carte •••• ${card.last4} débloquée.` : `Carte •••• ${card.last4} bloquée : plus aucun paiement ne passe.` });
    } catch (cause) {
      onDone({ tone: 'bad', text: (cause as Error).message });
    }
  }
  return (
    <div className="vcard-wrap">
      <div className="vcard" data-tier={card.tier} data-frozen={frozen}>
        <div className="vcard-top">
          <span className="vcard-brand">App GN</span>
          <span className="vcard-tier">{CARD_TIER_LABELS[card.tier]}</span>
        </div>
        <div className="vcard-balance">{balance ? fmt(balance as never) : '—'}</div>
        <div className="vcard-number">•••• •••• •••• {card.last4}</div>
        <div className="vcard-bottom">
          <span>{card.holderName.toUpperCase()}</span>
          <span>{card.expiry}</span>
          <span className="vcard-network">{card.network === 'visa' ? 'VISA' : 'mastercard'}</span>
        </div>
        {frozen && <span className="vcard-frozen">Bloquée</span>}
      </div>
      <button type="button" className={`btn ${frozen ? 'btn-primary' : ''}`} onClick={toggle} aria-pressed={frozen}>
        {frozen ? 'Débloquer' : 'Bloquer la carte'}
      </button>
    </div>
  );
}

function IssueCard({ spaceId, cards, onDone }: { spaceId: string; cards: CardView[]; onDone: (message: Message) => void }) {
  const { client, actor } = useSession();
  const [network, setNetwork] = useState<CardNetwork>('visa');
  const [tier, setTier] = useState<CardTier>('standard');
  const [open, setOpen] = useState(false);
  const remaining = MAX_CARDS_PER_TIER - cards.filter((card) => card.tier === tier).length;
  async function issue() {
    try {
      const card = await client.write(() => client.base.issueCard(actor, spaceId, { network, tier }, crypto.randomUUID()));
      onDone({ tone: 'ok', text: `Carte ${card.label} •••• ${card.last4} émise. Rechargez-la pour l’utiliser.` });
      setOpen(false);
    } catch (cause) {
      onDone({ tone: 'bad', text: (cause as Error).message });
    }
  }
  if (!open) return <button type="button" className="btn" onClick={() => setOpen(true)}>Nouvelle carte</button>;
  return (
    <div className="issue">
      <div className="field-row">
        <label className="field">
          <span>Réseau</span>
          <select id="card-network" value={network} onChange={(event) => setNetwork(event.target.value as CardNetwork)}>
            <option value="visa">Visa</option>
            <option value="mastercard">Mastercard</option>
          </select>
        </label>
        <label className="field">
          <span>Type</span>
          <select id="card-tier" value={tier} onChange={(event) => setTier(event.target.value as CardTier)}>
            <option value="standard">Standard · recharge 2 %</option>
            <option value="gold">Gold · recharge sans frais</option>
          </select>
        </label>
      </div>
      <p className="fine">Prix d’émission : {fmt(money(CARD_ISSUE_PRICE_GNF[tier], 'GNF'))} (indicatif, non prélevé dans la démo). Encore {remaining} carte{remaining > 1 ? 's' : ''} de ce type possible{remaining > 1 ? 's' : ''}.</p>
      <div className="payment-actions">
        <button type="button" className="btn btn-primary" onClick={issue} disabled={remaining <= 0}>Émettre la carte</button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>Annuler</button>
      </div>
    </div>
  );
}

function ExchangeForm({ id, spaceId, sources, targets, onDone }: { id: string; spaceId: string; sources: AccountPosition[]; targets: AccountPosition[]; onDone: (message: Message) => void }) {
  const { client, actor } = useSession();
  const [chosenSource, setSource] = useState('');
  const [chosenTarget, setTarget] = useState('');
  const sourceId = sources.some((position) => position.account.id === chosenSource) ? chosenSource : sources[0]?.account.id ?? '';
  const targetId = targets.some((position) => position.account.id === chosenTarget) ? chosenTarget : targets[0]?.account.id ?? '';
  const source = sources.find((position) => position.account.id === sourceId);
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<ExchangeQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!quote) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [quote]);

  async function ask() {
    setError(null);
    try {
      setQuote(await client.write(() => client.base.quoteExchange(actor, spaceId, { sourceAccountId: sourceId, targetAccountId: targetId, amount: amount.replace(/\s/g, '') })));
      setNow(Date.now());
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  async function confirm() {
    if (!quote) return;
    try {
      const exchange = await client.write(() => client.base.executeExchange(actor, spaceId, quote.id, crypto.randomUUID()));
      onDone(exchange.status === 'completed'
        ? { tone: 'ok', text: `${fmt(exchange.credit)} crédités (${fmt(exchange.debit)} débités, dont ${fmt(exchange.fee)} de frais).` }
        : { tone: 'bad', text: `Conversion refusée : ${FAILURE_REASONS[exchange.failureReason ?? ''] ?? exchange.failureReason}.` });
      setQuote(null);
      setAmount('');
    } catch (cause) {
      setError((cause as Error).message);
      setQuote(null);
    }
  }

  const secondsLeft = quote ? Math.max(0, Math.ceil((Date.parse(quote.expiresAt) - now) / 1000)) : 0;

  if (sources.length === 0 || targets.length === 0) return <p className="fine">Aucun compte compatible.</p>;
  return (
    <div className="pay-form">
      <label className="field">
        <span>Depuis</span>
        <select id={`${id}-source`} value={sourceId} onChange={(event) => { setSource(event.target.value); setQuote(null); }}>
          {sources.map((position) => (
            <option key={position.account.id} value={position.account.id}>
              {position.providerName} · {position.account.label}{position.balance ? ` (${fmt(position.balance)})` : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Vers</span>
        <select id={`${id}-target`} value={targetId} onChange={(event) => { setTarget(event.target.value); setQuote(null); }}>
          {targets.map((position) => (
            <option key={position.account.id} value={position.account.id}>{providerById(position.account.providerId)?.name} · {position.account.label}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Montant débité ({source?.account.currency ?? ''}, frais compris)</span>
        <input id={`${id}-amount`} value={amount} onChange={(event) => { setAmount(event.target.value); setQuote(null); }} inputMode="decimal" placeholder={source?.account.currency === 'GNF' ? '500 000' : '25'} />
      </label>
      {!quote && <button type="button" className="btn btn-block" onClick={ask} disabled={!amount.trim()}>Voir le devis</button>}
      {quote && (
        <div className="quote">
          <dl>
            <div><dt>Débité</dt><dd>{fmt(quote.debit)}</dd></div>
            <div><dt>Frais ({(quote.feeBps / 100).toLocaleString('fr-FR')} %)</dt><dd>{fmt(quote.fee)}</dd></div>
            {quote.rates.map((rate) => (
              <div key={rate.currency}><dt>Cours</dt><dd>1 {rate.currency} = {Number(rate.gnfPerUnit).toLocaleString('fr-FR')} GNF</dd></div>
            ))}
            <div className="quote-total"><dt>Vous recevez</dt><dd>{fmt(quote.credit)}</dd></div>
          </dl>
          <p className="fine">{secondsLeft > 0 ? `Devis valable encore ${secondsLeft} s.` : 'Devis expiré : demandez-en un nouveau.'}</p>
          <div className="payment-actions">
            <button type="button" className="btn btn-primary" onClick={confirm} disabled={secondsLeft <= 0}>Confirmer</button>
            <button type="button" className="btn" onClick={() => setQuote(null)}>Annuler</button>
          </div>
        </div>
      )}
      {error && <p className="notice notice-bad">{error}</p>}
    </div>
  );
}
