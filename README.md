# App GN

Une seule application pour le **citoyen** (application mobile ou web), l'**entreprise** (GAPP) et l'**administration** (GAPP Institutionnel), ces deux dernières en tableau de bord sur ordinateur ou tablette. Elle agrège tous les moyens de paiement (comptes bancaires, wallets Mobile Money, cartes virtuelles, wallet App GN, crypto) dans une vue consolidée, garde les documents dématérialisés, et reste utilisable sans réseau. Chaque profil a son accès et sa logique métier.

Les paiements passent par l'orchestrateur [ORCHEA](https://github.com/orcheagn/-orchea-payment) (XeyLink Router), dans son propre dépôt.

**État : socle v0.2.0.** Données fictives et connecteurs simulés : aucun fournisseur réel n'est appelé, aucun argent ne bouge.

## Ce que fait le socle
- Trois espaces dans la même application, un sélecteur pour passer de l'un à l'autre, un rôle par espace.
- Vue consolidée de tous les comptes en GNF (contre-valeur indicative), résistante à la panne d'un fournisseur.
- Paiements (facture, Mobile Money, entre comptes) avec idempotence et règles d'approbation par profil : seuil de 5 M GNF côté entreprise, séparation ordonnateur / comptable public côté administration.
- Catalogue de services filtré par rôle (branchés et prévus).
- Canaux : espace citoyen sur tout appareil (mise en page application sur téléphone), espaces pro en tableau de bord sur tablette ou ordinateur seulement.
- Hors ligne d'abord : écrans servis depuis l'appareil, paiements du citoyen mis en file et rejoués sans double débit, expiration après 24 h ; application installable.
- Coffre de documents : identité, permis, carte grise, assurances, abonnements, attestations d'entreprise ; alerte avant expiration ; vérification par code.
- Cartes virtuelles et conversions sur le modèle de Keecash : plusieurs cartes, blocage instantané, recharge depuis Mobile Money ou crypto avec devis (frais et cours) avant confirmation.

Architecture : [docs/architecture.md](docs/architecture.md). Décisions : [ADR-001](docs/adr/adr-001-socle.md), [ADR-002](docs/adr/adr-002-canaux-hors-ligne-documents-cartes.md).

## Démarrer
Node ≥ 22.18.

```bash
npm install
npm test            # noyau + API
npm run typecheck

# Interface seule, noyau embarqué (aucune API nécessaire)
npm run dev:web

# Ou l'API + l'interface branchée dessus
npm run dev:api
VITE_API_URL=/ npm run dev:web
```

Avec une base (sinon tout est en mémoire et perdu à l'arrêt) :

```bash
APPGN_PGLITE_DIR=./.data npm run dev:api                       # PostgreSQL embarqué, sans serveur à installer
DATABASE_URL=postgres://appgn:appgn@localhost:5432/appgn npm run dev:api   # serveur PostgreSQL
TEST_DATABASE_URL=postgres://… node --test apps/api/test/postgres.test.ts  # tests du magasin contre un vrai serveur (base jetable)
```

Avec ORCHEA (simulateur local, depuis le dépôt d'ORCHEA) :

```bash
# Dans le dépôt ORCHEA
ORCHEA_API_KEY=cle_locale_de_demo_123456 ORCHEA_SIMULATOR_MODE=mobile-money \
ORCHEA_WEBHOOK_URL=http://127.0.0.1:3100/v1/webhooks/orchea ORCHEA_WEBHOOK_SECRET=secret_local_de_demo_0123 \
ORCHEA_WEBHOOK_ORGANIZATION_ID=org-local npm run dev

# Ici
ORCHEA_BASE_URL=http://127.0.0.1:3000 ORCHEA_API_KEY=cle_locale_de_demo_123456 \
ORCHEA_WEBHOOK_SECRET=secret_local_de_demo_0123 ORCHEA_BILLER_DESTINATIONS=edg=dest-edg,seg=dest-seg \
npm run dev:api
```

Contre un ORCHEA partagé, ajouter `ORCHEA_MODE=test` avec une clé de test : rien ne bouge. Détails : `docs/architecture.md` §6.

Utilisateurs de démo : Kadiatou Sow (citoyenne, sans entreprise), Mariama Camara (citoyenne, dirigeante de Couture Mariama), Alpha Diallo (directeur financier de Boké Logistique), Sékou Condé (dirigeant de Boké Logistique), Fatoumata Bah (ordonnatrice, Commune de Kaloum), Ibrahima Sylla (comptable public, Commune de Kaloum).

## API (v1)
Connexion : `POST /v1/auth/codes {nin}` puis `POST /v1/auth/sessions {challengeId, code, spaceId?}` (et, pour qui a plusieurs espaces sans en nommer un, `POST /v1/auth/sessions/space {selectionToken, spaceId}`) → `Authorization: Bearer <jeton>`. Une session vaut pour un seul espace : fonds personnels et fonds d'une organisation ne se lisent jamais ensemble. En démonstration, la réponse porte le code (aucun SMS n'est envoyé) et `Bearer demo:<personId>@<spaceId>` reste accepté ; `APPGN_DEMO_LOGIN=off` ferme les deux. `APPGN_SESSION_SECRET` (32 caractères au moins) garde les sessions d'un redémarrage à l'autre. Format d'appareil : `AppGN-Channel: phone | tablet | desktop` (`phone` par défaut).

| Méthode | Chemin | |
|---|---|---|
| GET | `/v1/me` | la personne et ses espaces (rôle, permissions) |
| GET | `/v1/spaces/:spaceId/overview` | vue consolidée |
| GET | `/v1/spaces/:spaceId/accounts/:accountId/transactions` | mouvements d'un compte |
| GET | `/v1/spaces/:spaceId/services` | services accessibles au rôle |
| GET/POST | `/v1/spaces/:spaceId/payments` | lister / initier (`Idempotency-Key` requise) |
| POST | `/v1/spaces/:spaceId/payments/:id/approve` · `/reject` | décider d'un paiement en attente |
| GET | `/v1/spaces/:spaceId/documents` | coffre de documents |
| GET | `/v1/document-checks/:code` | vérification publique d'un document |
| GET/POST | `/v1/spaces/:spaceId/cards` | lister / émettre une carte virtuelle |
| POST | `/v1/spaces/:spaceId/cards/:accountId/freeze` · `/unfreeze` | bloquer / débloquer |
| POST | `/v1/spaces/:spaceId/exchange-quotes` puis `/exchanges` | devis puis conversion |
| POST | `/v1/webhooks/orchea` | issues de paiement envoyées par ORCHEA (signées ; seulement si `ORCHEA_*` est réglé) |

## Structure
- `packages/core` — règles : profils et droits, agrégation, paiements, catalogue, montants
- `apps/api` — API HTTP (Fastify), connexion (`auth.ts`), adaptateur ORCHEA (`orchea.ts`), base (`db/`)
- `apps/web` — interface (React + Vite)
- `docs/` — architecture et décisions
