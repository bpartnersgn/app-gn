# ADR-001 — Socle d'App GN : dépôt, stack, découpage

Date : 12/10/2026. Statut : accepté, par délégation (choix par défaut, à revoir sur demande).

## Contexte
App GN sert trois profils (citoyen, entreprise, administration) avec un agrégateur de comptes et un orchestrateur de paiements. L'orchestrateur existe déjà : ORCHEA (`orcheagn/-orchea-payment`), qui pose que ses consommateurs vivent dans leur propre dépôt et l'appellent par son contrat d'API.

## Décisions
1. **Dépôt séparé d'ORCHEA.** App GN est un consommateur d'ORCHEA, comme Facture.gn. Aucun code commun ; le point de contact est l'API et le SDK d'ORCHEA.
2. **Monorepo npm workspaces** : `packages/core` (règles), `apps/api` (HTTP), `apps/web` (interface).
3. **Toutes les règles dans `packages/core`**, y compris les contrôles d'accès. L'API et le web transportent. Conséquence : le web peut embarquer le noyau pour une démo autonome, avec les mêmes règles.
4. **Stack alignée sur ORCHEA** : TypeScript, Node ≥ 22.18 sans étape de build côté serveur, Fastify 5, `node:test`. Web : React 19 + Vite, conçu d'abord pour le téléphone. Une application mobile native (React Native) pourra réutiliser `packages/core` sans changement.
5. **Une identité, plusieurs espaces** : la personne (NIN) est membre d'espaces avec un rôle par espace, plutôt que trois types de comptes utilisateur.
6. **Ports simulés** pour les fournisseurs (`AccountConnector`) et l'orchestrateur (`PaymentOrchestrator`) : le socle tourne sans aucun accord externe.

## Conséquences
- Brancher un fournisseur réel = écrire un connecteur ; brancher ORCHEA = écrire un adaptateur du port, sans toucher aux écrans ni aux règles.
- La persistance est en mémoire : à remplacer par PostgreSQL avant tout usage réel.
