# ADR-005 — PostgreSQL derrière un port de magasin, PGlite pour les postes sans serveur

Date : 12/10/2026. Statut : accepté.

## Contexte

Jusqu'ici tout l'état d'App GN vivait en mémoire : un redémarrage perdait paiements, clés d'idempotence, cartes émises, codes de connexion et révocations. Le noyau doit rester exécutable dans le navigateur (démonstration, hors ligne), et ORCHEA, sur lequel App GN s'aligne, tourne sur PostgreSQL et teste sur PGlite.

## Décision

1. Port `AppStore` dans le noyau (paiements, idempotence, conversions, cartes émises), implémenté en mémoire dans le noyau et en PostgreSQL dans `apps/api/src/db`. Même idée pour la connexion (`AuthStore`) et le dédoublonnage des webhooks (`ProcessedEvents`), qu'un seul `PostgresStore` implémente.
2. Objets en JSONB, dans la forme du noyau ; en colonnes, ce qui sert à chercher ou à verrouiller. Pas d'ORM : une quinzaine de requêtes écrites à la main.
3. Chaque garantie tient en une instruction (réservation de clé, changement d'état conditionnel, consommation du code), sans transaction ouverte entre deux allers-retours. Le noyau les exprime comme des comparaisons-échanges ; la mémoire les respecte aussi.
4. `pg` contre un serveur (`DATABASE_URL`), PGlite dans un dossier (`APPGN_PGLITE_DIR`) pour travailler sur un poste sans PostgreSQL installé, mémoire sinon. Schéma rejouable appliqué au démarrage, versionné dans `schema_version`.
5. Tests du magasin sur PGlite par défaut, et contre un vrai serveur en CI (`TEST_DATABASE_URL`, service PostgreSQL 16).

## Conséquences

- Les identifiants de paiement, de conversion et de carte deviennent aléatoires (un compteur repartirait de zéro).
- `listPayments`, `rejectPayment`, `recordOutcome` deviennent asynchrones.
- Le référentiel (personnes, espaces, rattachements, comptes liés, documents) reste issu de la démonstration : il passera en base avec l'inscription et le rattachement de comptes.
- Les cartes sont relues au démarrage seulement : tant que ce n'est pas changé, une seule instance de l'API.
- Pas encore de migrations au-delà de la version 1 : la prochaine modification du schéma introduira des fichiers numérotés.
