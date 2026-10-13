# ADR-007 — Les bureaux GAPP : logique métier de l'entreprise et de l'administration

Date : 13/10/2026. Statut : accepté.

## Contexte

Demande du 13/10/2026 : construire GAPP Entreprise et GAPP Institutionnel, chacun avec la logique métier de son tableau de bord. Jusqu'ici les deux espaces n'avaient qu'une situation des comptes et un paiement avec approbation. Point de départ : `positionnement/cas-usage-par-profil.md` et ses remarques.

Une PME et une administration ne dépensent pas de la même façon. La PME encaisse et décaisse librement, sous un seuil d'approbation. L'administration exécute un budget voté : une dépense n'existe que par une chaîne engagement → liquidation → mandat → visa, avec deux personnes distinctes (ordonnateur, comptable public).

## Décision

1. **Deux bureaux dans le noyau**, `BusinessDesk` et `AdministrationDesk` (`packages/core/src/gapp/`). Chaque cas d'usage commence par `AppGn.guard(actor, espace, permissions, nature)` : espace de la session (ADR-006), bonne nature d'espace, permission du rôle. Un bureau appelé sur un espace de l'autre nature répond comme un espace inconnu.
2. **Un magasin versionné**, `DeskStore` (collections d'enregistrements JSON avec version et écriture conditionnelle). Les compteurs sans trou (factures `FAC-AAAA-NNNN`, mandats `MDT-AAAA-NNNN`) et les crédits engagés d'une ligne budgétaire avancent par comparaison-échange : deux écritures simultanées ne peuvent pas prendre le même numéro ni dépasser une ligne. En mémoire pour la démo, en PostgreSQL (`desk_records`, schéma v2) côté serveur.
3. **Ce qui ne doit pas se réécrire est chaîné** : factures scellées (empreinte SHA-256 de la précédente, pas d'antidate), et journal d'audit de chaque bureau en ajout seul, chaîné et vérifiable.
4. **En administration, une dépense passe par le bureau.** `initiatePayment`, `approvePayment` et `rejectPayment` refusent un paiement direct d'un espace administration ; seul le bureau (origine `desk`) en crée, au mandat, et le comptable public le vise et le paie ou le rejette avec un motif.
5. **Une seule table de routes** (`GAPP_ROUTES`) dans le noyau : l'API la déclare telle quelle à Fastify, et l'application sans serveur l'appelle par le même aiguillage. Les deux ne peuvent pas diverger.
6. **L'interface suit les permissions** : chaque rubrique déclare les permissions qui l'ouvrent ; un rôle ne voit que les siennes (les RH ne voient que l'équipe et les documents ; le contrôle ne voit ni dépenses ni paie).

## Règles retenues

- Entreprise : seuil d'approbation de 5 M GNF ; lots fournisseurs de 50 lignes au plus, une clé d'idempotence par ligne ; frais estimés par rail (même opérateur 0,5 %, autre opérateur 1,5 %, banque 1 %, wallet 1,2 %, valeurs de démonstration) ; TVA 18 %, déclaration et paiement à la DGI d'un seul geste, crédit reporté, période close ensuite ; journal comptable SYSCOHADA en CSV ; score B2B indicatif sur cinq critères.
- Administration : lignes budgétaires avec dotation et engagé ; liquidation au service fait, au plus le reste de l'engagement ; mandat puis visa ; contrôle de la paie contre l'état civil (NIN invalide ou inconnu, identité discordante, doublon, wallet partagé, agent suspendu) avant tout mandat de paie, imputée sur la ligne de paie ; recettes ; rapport Cour des comptes en CSV.

## Conséquences

- Tous les montants, taux et frais sont des valeurs de démonstration : à confirmer avec un expert-comptable (TVA, SYSCOHADA) et un comptable public (nomenclature budgétaire, pièces du mandat).
- Les paiements partent encore par l'orchestrateur simulé ; la DGI est un facturier fictif.
- Le registre d'état civil est une liste de démonstration ; le contrôle de paie se branchera sur le vrai registre quand une API existera.
