# Plan de travail App GN

Mis à jour le 16/10/2026. Sources : `docs/adr/adr-008-*.md`, `docs/architecture.md` §11-12.

## Fait (jusqu'à v0.5.0)

- v0.1–0.3 : socle (espaces citoyen, entreprise, administration), agrégation des comptes, paiements avec approbation, hors ligne d'abord, coffre de documents, cartes et conversions simulées, connexion NIN + code SMS, paiements de factures via ORCHEA (webhooks signés), PostgreSQL pour l'état transactionnel.
- v0.4.0 : bureaux GAPP Entreprise et Administration (ADR-007), une session = un espace.
- v0.5.0 (ADR-008) : durcissement HTTP, refus de démarrer mal réglé en production, migrations numérotées, référentiel en base, inscription par SMS, membres d'organisation, rattrapage ORCHEA par `GET /v1/events`, confirmation forte au-delà de 5 M GNF, SMS Orange (non essayé).
- Après v0.5.0 (16/10/2026) : plusieurs instances de l'API possibles. Cartes relues en base à chaque demande, blocage écrit en base, plafond de 3 par type tenu par un index unique, devis de conversion en base (migration 6, ADR-008 point 9).
- Tests : 138/138 verts sur PGlite et sur PostgreSQL 16 (Docker, `TEST_DATABASE_URL`) le 16/10/2026.

## Reste pour le pilote M1

Dépend de tiers :
- Contrat SMS Orange (identifiants, expéditeur) puis premier essai réel.
- Connecteur Mobile Money réel via ORCHEA (Orange Money, MTN MoMo).
- Hébergement de production (PostgreSQL, origines, mandataires, secrets).
- Validation des règles métier : seuil de 5 M GNF, frais, TVA, nomenclature budgétaire.

Technique :
- Piste d'audit chaînée pour l'espace citoyen.
- Notifications, rattachement d'un compte, bascule citoyen → pro.

Hors M1 (assumé) : identité déclarative jusqu'à l'identité numérique nationale ; organisations ouvertes par l'exploitant tant que RCCM/NIF n'est pas raccordé ; émetteur de cartes, documents et connecteurs bancaires simulés.

## Prochaines étapes

1. Obtenir le contrat SMS Orange et tester l'envoi réel.
2. Brancher ORCHEA en réel sur un environnement de recette.
3. Choisir l'hébergement et faire un premier déploiement `APPGN_ENV=production`.
4. ~~Lever la limite « une instance » des cartes.~~ Fait le 16/10/2026.
5. Audit chaîné citoyen, puis notifications.
6. Faire valider les règles métier avant l'ouverture du pilote.
