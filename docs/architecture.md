# App GN — architecture cible

Écrit le 12/10/2026, avec le socle (v0.1.0). Ce document décrit la cible et dit, pour chaque brique, ce que le socle en contient déjà.

## 1. Ce qu'est App GN

Une seule application, trois profils :

| Espace | Pour qui | Produit |
|---|---|---|
| Citoyen | toute personne identifiée par son NIN | App GN |
| Entreprise | micro-entrepreneur, PME, ETI | GAPP |
| Administration | collectivité, EPA, agence, entreprise publique | GAPP Institutionnel |

Une personne a **une seule identité** et agit dans **plusieurs espaces** : son espace citoyen, et ceux des entreprises ou administrations dont elle est membre, avec un rôle dans chacun. Passer de citoyen à pro, c'est ouvrir un espace de plus, pas créer un autre compte.

Le cœur commun est un **agrégateur** (lire tous les comptes : banques, Mobile Money, carte virtuelle, wallet App GN, crypto) branché à un **orchestrateur de paiements** (ORCHEA / XeyLink Router, dépôt `orcheagn/-orchea-payment`), et des **services** qui s'en servent.

## 2. Vue d'ensemble

```
            ┌──────────── apps/web (React, mobile d'abord) ────────────┐
            │  sélecteur d'espace · vue consolidée · paiements · services │
            └───────────────┬─────────────────────────────┬─────────────┘
                     HTTP /v1 (apps/api, Fastify)   ou   noyau embarqué (démo)
                            └──────────────┬──────────────┘
                              packages/core  (@app-gn/core)
     ┌───────────────┬───────────────┬──────────────┬───────────────┬───────────────┐
     │ Identité &    │ Agrégation    │ Paiements     │ Catalogue de  │ Montants      │
     │ accès (RBAC)  │ des comptes   │ (règles +     │ services      │ (Money, FX    │
     │ rbac.ts       │ aggregation.ts│ port ORCHEA)  │ services.ts   │ indicatif)    │
     └───────────────┴──────┬────────┴──────┬────────┴───────────────┴───────────────┘
                            │ AccountConnector │ PaymentOrchestrator
              ┌─────────────┴───────┐   ┌──────┴──────────────────┐
              │ connecteurs simulés │   │ orchestrateur simulé    │
              │ (cible : API banques,│   │ (cible : ORCHEA, API    │
              │ Mobile Money, crypto)│   │ payment-intents/payouts)│
              └─────────────────────┘   └─────────────────────────┘
```

Règle de construction : **toute règle d'accès et toute règle métier vivent dans `packages/core`**. L'API et le web ne font que transporter. C'est ce qui permet au web de tourner seul en démo avec exactement les mêmes règles que l'API.

## 3. Profils et accès

Modèle : `Person` (NIN) → `Membership` (personne, espace, rôle) → `Space` (citoyen | entreprise | administration).

| Rôle | Espace | Peut |
|---|---|---|
| Titulaire | citoyen | tout sur ses propres comptes |
| Dirigeant | entreprise | tout, dont approuver et gérer les membres |
| Directeur financier | entreprise | lire, rattacher, initier des paiements, facturer, déclarer — pas approuver |
| Comptable | entreprise | lire, facturer, rapports |
| Ressources humaines | entreprise | lire, soumettre la paie |
| Ordonnateur | administration | lire, mandater (initier), soumettre la paie, budget |
| Comptable public | administration | lire, viser et payer (approuver), budget |
| Contrôle | administration | lecture seule |

Matrice complète : `packages/core/src/rbac.ts`. Un espace dont on n'est pas membre répond comme un espace inexistant (on ne révèle pas son existence).

**Règles d'approbation** (`payments.ts`) :
- citoyen : aucune ;
- entreprise : au-delà de 5 000 000 GNF, une seconde personne habilitée approuve, sauf si l'initiateur est lui-même habilité (le dirigeant ; une confirmation forte par OTP viendra avec l'authentification réelle) ;
- administration : toujours une seconde personne. L'ordonnateur mandate, le comptable public vise et paie. Celui qui initie ne peut jamais approuver.

## 4. Agrégation des comptes

- Un `AccountConnector` par fournisseur : `fetchBalance`, `fetchTransactions`. Le socle en a un simulé par fournisseur (Orange Money, MTN, Cellcom, Moov, Ecobank, UBA, Trésor public, carte virtuelle, wallet App GN, crypto).
- Tous les fournisseurs sont interrogés **en parallèle, chacun sous un délai** (3 s par défaut). Une panne ne bloque jamais la vue : on montre le dernier solde connu marqué « ancien », ou « indisponible » s'il n'y en a jamais eu, et la vue est marquée partielle.
- Le total est une **contre-valeur indicative en GNF** : devises et crypto sont converties à un taux daté ; aucun paiement n'est calculé sur ce montant. Les taux du socle sont fictifs.
- Montants : unités mineures entières en chaînes, même convention que le `Money` d'ORCHEA. Pas de flottant, pas d'arrondi implicite.

## 5. Paiements et ORCHEA

App GN ne déplace pas d'argent lui-même : il décide (droits, approbation, idempotence) puis remet l'ordre à l'orchestrateur par le port `PaymentOrchestrator`.

| App GN | ORCHEA (cible) |
|---|---|
| paiement d'une facture, envoi Mobile Money | `POST /v1/payment-intents` ou `POST /v1/payouts` |
| clé d'idempotence = id du paiement App GN | en-tête `Idempotency-Key` |
| statut `processing` puis issue | accusé `CREATED` puis webhook signé, lu par `readWebhook` du SDK |
| `AppGn.recordOutcome(reference, issue)` | réception du webhook |

Le socle branche un orchestrateur simulé qui débite et crédite le réseau simulé tout de suite. L'adaptateur ORCHEA réel est le prochain lot côté paiements ; ORCHEA lui-même n'appelle encore aucun Provider réel.

Les comptes crypto sont lisibles mais pas débitables depuis App GN tant qu'aucun cadre (BCRG, dépositaire) n'est posé.

## 6. Catalogue de services

`services.ts` liste les services par espace, chacun avec la permission qu'il exige et son état (`available` dans le socle, `planned` sinon). L'écran n'affiche que ce que le rôle permet.

| Espace | Branché dans le socle | Prévu |
|---|---|---|
| Citoyen | vue consolidée, envoi, paiement de facture | rattacher un compte, mes documents, passer en pro |
| Entreprise | trésorerie consolidée, paiement fournisseur avec approbation | facturation, TVA, paie, score B2B |
| Administration | situation des comptes, mandat, visa et paiement | paie des agents, exécution budgétaire, reporting Cour des Comptes |

## 7. Ce qui reste simulé ou absent

- Identité : connexion de démo (`Bearer demo:<personId>`). Cible : NIN + OTP / identité numérique.
- Persistance : mémoire. Cible : PostgreSQL, comme ORCHEA.
- Connecteurs : tous simulés. Chaque fournisseur réel demande un accord et une API (voir `positionnement/chiffres-a-sourcer.md` pour Ecobank, UBA, Cellcom, Moov).
- Orchestrateur : simulé. Cible : ORCHEA par son SDK.
- Piste d'audit, notifications, rattachement d'un compte, bascule citoyen → pro : à construire.

## 8. Stack

TypeScript partout, Node ≥ 22.18 (exécution directe des `.ts`), Fastify 5 pour l'API, React 19 + Vite pour le web, `node:test` pour les tests. Mêmes choix qu'ORCHEA pour que les deux dépôts se lisent de la même façon. Voir `docs/adr/adr-001-socle.md`.
