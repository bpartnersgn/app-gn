# ADR-008 — Vers la production : ce qui bloquait le pilote M1

Date : 14/10/2026. Statut : accepté.

## Contexte

Demande du 14/10/2026 : « attaque le BackEnd ». L'API tournait, mais en démonstration : en-têtes HTTP par défaut, aucune limite de débit, référentiel (personnes, espaces, rattachements) issu des données de démonstration et perdu à l'arrêt, aucun moyen de s'inscrire, un paiement resté « en cours » si un webhook ORCHEA se perdait, et la confirmation forte des paiements d'entreprise au-delà de 5 M GNF annoncée mais absente. Ordre retenu : ce qui empêche d'ouvrir le pilote d'abord.

## Décision

1. **Durcissement HTTP** (`apps/api/src/security.ts`) : CSP `default-src 'none'`, `nosniff`, `DENY`, `no-store`, HSTS ; CORS limité à `APPGN_ALLOWED_ORIGINS` (une origine inconnue reçoit 403) ; limites de débit par IP, par session et pour les écritures, comptées en base pour être partagées entre instances ; corps de 256 Ko au plus ; mandataires de confiance nommés (`APPGN_TRUST_PROXY`).
2. **Refus de démarrer mal réglé** : avec `APPGN_ENV=production`, le serveur s'arrête si la connexion de démo est ouverte, ou si le secret de session, la base, les origines ou le fournisseur SMS manquent. Aucune donnée de démonstration n'est alors versée.
3. **Migrations numérotées** (`apps/api/src/db/migrations/NNN-*.sql`), chacune dans sa transaction, sous un verrou consultatif : deux instances qui démarrent ensemble n'appliquent rien deux fois.
4. **Le référentiel en base** (port `DirectoryStore`) : le magasin fait foi, le noyau en garde une copie relue au démarrage, toutes les 30 s et aussitôt pour un NIN ou un espace inconnu.
5. **Inscription** : NIN, nom, mobile guinéen ; le code part au numéro saisi ; personne et espace personnel sont créés d'une seule instruction. Un NIN déjà inscrit reçoit la même réponse, aucun code ne part, et le titulaire est prévenu. Les organisations s'ouvrent par l'outil de l'exploitant (`npm run admin`), pas par l'API publique ; le dirigeant gère ensuite ses membres par l'API.
6. **Rattrapage ORCHEA** : en plus des webhooks, `GET /v1/events` est lu page à page au démarrage et toutes les 60 s ; chaque événement passe par le même traitement (dédoublonné), le curseur est gardé en base sous bail, une seule instance lit à la fois.
7. **Confirmation forte** : en entreprise, à partir de 5 M GNF (ou en devises), la personne qui fait partir l'argent (dirigeant qui paie, approbateur, lot exécuté, TVA déclarée) reçoit un code par SMS lié à l'opération exacte. L'API répond `428 confirmation_required` avec le défi ; la demande est renvoyée avec `AppGN-Confirmation: <défi>.<code>`. Un essai par code, 5 codes par 15 minutes.
8. **SMS par Orange** (`apps/api/src/sms.ts`) : API SMS d'Orange (jeton OAuth, expéditeur attribué). Écrit d'après la documentation publique, non essayé faute de compte ; une panne rend `503 unavailable`.

## Conséquences

- Le pilote attend encore : le contrat SMS (identifiants, expéditeur), le connecteur Mobile Money réel via ORCHEA, l'hébergement, et la validation des règles métier (seuil, frais, TVA, nomenclature).
- Une organisation ne se crée pas en libre-service : c'est voulu tant que le contrôle RCCM/NIF n'est pas raccordé.
- L'identité reste déclarative (`identity: 'declared'`) jusqu'au raccordement à l'identité numérique nationale.
