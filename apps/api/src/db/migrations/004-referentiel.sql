-- Migration 4 : le référentiel en base (personnes, espaces, rattachements, comptes liés, coffre de documents),
-- et l'objet d'un défi par code (connexion, inscription, confirmation d'un paiement).
CREATE TABLE IF NOT EXISTS persons (
  id text PRIMARY KEY,
  nin text NOT NULL UNIQUE,
  document jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS spaces (
  id text PRIMARY KEY,
  kind text NOT NULL,
  document jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  person_id text NOT NULL REFERENCES persons (id),
  space_id text NOT NULL REFERENCES spaces (id),
  role text NOT NULL,
  PRIMARY KEY (person_id, space_id)
);
CREATE INDEX IF NOT EXISTS memberships_space ON memberships (space_id);

CREATE TABLE IF NOT EXISTS linked_accounts (
  id text PRIMARY KEY,
  space_id text NOT NULL REFERENCES spaces (id),
  document jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_documents (
  id text PRIMARY KEY,
  space_id text NOT NULL REFERENCES spaces (id),
  verification_code text UNIQUE,
  document jsonb NOT NULL
);

ALTER TABLE auth_challenges ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'signin';
ALTER TABLE auth_challenges ADD COLUMN IF NOT EXISTS payload jsonb;
