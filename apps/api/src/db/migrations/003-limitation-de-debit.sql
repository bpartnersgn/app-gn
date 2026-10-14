-- Migration 3 : compteurs de la limitation de débit, partagés entre instances (une ligne par clé et par minute).
CREATE TABLE IF NOT EXISTS rate_limits (
  key text NOT NULL,
  window_start bigint NOT NULL,
  count integer NOT NULL,
  PRIMARY KEY (key, window_start)
);
