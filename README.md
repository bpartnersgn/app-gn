# App GN

Une seule application pour le **citoyen**, l'**entreprise** (GAPP) et l'**administration** (GAPP Institutionnel). Elle agrège tous les moyens de paiement d'une personne ou d'une organisation (comptes bancaires, wallets Mobile Money, carte virtuelle, wallet App GN, crypto) dans une vue consolidée, et les relie à des services. Chaque profil a son accès et sa logique métier.

Les paiements passent par l'orchestrateur [ORCHEA](https://github.com/orcheagn/-orchea-payment) (XeyLink Router), dans son propre dépôt.

**État : socle v0.1.0.** Données fictives et connecteurs simulés : aucun fournisseur réel n'est appelé, aucun argent ne bouge.

## Ce que fait le socle
- Trois espaces dans la même application, un sélecteur pour passer de l'un à l'autre, un rôle par espace.
- Vue consolidée de tous les comptes en GNF (contre-valeur indicative), résistante à la panne d'un fournisseur.
- Paiements (facture, Mobile Money, entre comptes) avec idempotence et règles d'approbation par profil : seuil de 5 M GNF côté entreprise, séparation ordonnateur / comptable public côté administration.
- Catalogue de services filtré par rôle (branchés et prévus).

Architecture : [docs/architecture.md](docs/architecture.md). Décision de socle : [docs/adr/adr-001-socle.md](docs/adr/adr-001-socle.md).

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

Utilisateurs de démo : Mariama Camara (citoyenne, dirigeante de Couture Mariama), Alpha Diallo (directeur financier de Boké Logistique), Sékou Condé (dirigeant de Boké Logistique), Fatoumata Bah (ordonnatrice, Commune de Kaloum), Ibrahima Sylla (comptable public, Commune de Kaloum).

## API (v1)
Authentification de démo : `Authorization: Bearer demo:<personId>`.

| Méthode | Chemin | |
|---|---|---|
| GET | `/v1/me` | la personne et ses espaces (rôle, permissions) |
| GET | `/v1/spaces/:spaceId/overview` | vue consolidée |
| GET | `/v1/spaces/:spaceId/accounts/:accountId/transactions` | mouvements d'un compte |
| GET | `/v1/spaces/:spaceId/services` | services accessibles au rôle |
| GET/POST | `/v1/spaces/:spaceId/payments` | lister / initier (`Idempotency-Key` requise) |
| POST | `/v1/spaces/:spaceId/payments/:id/approve` · `/reject` | décider d'un paiement en attente |

## Structure
- `packages/core` — règles : profils et droits, agrégation, paiements, catalogue, montants
- `apps/api` — API HTTP (Fastify)
- `apps/web` — interface (React + Vite)
- `docs/` — architecture et décisions
