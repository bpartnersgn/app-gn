-- Schéma App GN. Rejouable : chaque instruction ne crée que ce qui manque.
-- Les objets métier sont gardés en JSONB (forme exacte du noyau), avec en colonnes ce qui sert à chercher et à verrouiller.

CREATE TABLE IF NOT EXISTS schema_version (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  id text PRIMARY KEY,
  space_id text NOT NULL,
  status text NOT NULL,
  orchestrator_reference text,
  created_at timestamptz NOT NULL,
  document jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_space_created ON payments (space_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS payments_orchestrator_reference ON payments (orchestrator_reference) WHERE orchestrator_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope text PRIMARY KEY,
  fingerprint text NOT NULL,
  result_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS exchanges (
  id text PRIMARY KEY,
  space_id text NOT NULL,
  document jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS issued_cards (
  account_id text PRIMARY KEY,
  space_id text NOT NULL,
  card jsonb NOT NULL,
  account jsonb
);

CREATE TABLE IF NOT EXISTS processed_events (
  source text NOT NULL,
  event_id text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, event_id)
);

CREATE TABLE IF NOT EXISTS auth_challenges (
  id text PRIMARY KEY,
  person_id text,
  code_hash text,
  expires_at bigint NOT NULL,
  attempts integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS auth_code_requests (
  key text NOT NULL,
  requested_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_code_requests_key ON auth_code_requests (key, requested_at);

CREATE TABLE IF NOT EXISTS revoked_sessions (
  session_id text PRIMARY KEY,
  until bigint NOT NULL
);

INSERT INTO schema_version (version) VALUES (1) ON CONFLICT DO NOTHING;

-- Version 2 : bureaux GAPP (factures, fournisseurs, lots, TVA, équipe, budget, engagements, agents, audit).
-- Un enregistrement par objet, versionné : toute mise à jour vérifie la version lue (écriture conditionnelle).
CREATE TABLE IF NOT EXISTS desk_records (
  collection text NOT NULL,
  id text NOT NULL,
  space_id text NOT NULL,
  version integer NOT NULL,
  seq bigserial,
  document jsonb NOT NULL,
  PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS desk_records_space ON desk_records (collection, space_id, seq);

INSERT INTO schema_version (version) VALUES (2) ON CONFLICT DO NOTHING;
