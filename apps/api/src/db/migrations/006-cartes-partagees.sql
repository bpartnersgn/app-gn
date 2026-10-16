-- Migration 6 : cartes et devis de conversion partagés entre instances.
-- Le plafond de cartes par type tient dans un index unique : chaque carte prend une place (1 à 3) de son espace
-- et de son type, et deux émissions simultanées ne peuvent pas prendre la même.
ALTER TABLE issued_cards ADD COLUMN IF NOT EXISTS tier text;
ALTER TABLE issued_cards ADD COLUMN IF NOT EXISTS slot integer;
UPDATE issued_cards SET tier = card->>'tier' WHERE tier IS NULL;
UPDATE issued_cards SET slot = numbered.slot FROM (SELECT account_id, row_number() OVER (PARTITION BY space_id, tier ORDER BY account_id) AS slot FROM issued_cards) AS numbered WHERE issued_cards.account_id = numbered.account_id AND issued_cards.slot IS NULL;
ALTER TABLE issued_cards ALTER COLUMN tier SET NOT NULL;
ALTER TABLE issued_cards ALTER COLUMN slot SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS issued_cards_slot ON issued_cards (space_id, tier, slot);

CREATE TABLE IF NOT EXISTS exchange_quotes (
  id text PRIMARY KEY,
  expires_at bigint NOT NULL,
  document jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS exchange_quotes_expiry ON exchange_quotes (expires_at);
