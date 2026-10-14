-- Migration 2 : bureaux GAPP (factures, fournisseurs, lots, TVA, équipe, budget, engagements, agents, audit).
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
