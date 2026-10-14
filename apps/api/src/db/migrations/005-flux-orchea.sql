-- Migration 5 : où en est la lecture du flux d'événements ORCHEA (rattrapage des webhooks perdus), et qui la tient.
CREATE TABLE IF NOT EXISTS feed_cursors (
  source text PRIMARY KEY,
  cursor text,
  holder text,
  leased_until bigint NOT NULL DEFAULT 0
);
