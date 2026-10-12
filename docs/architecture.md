# App GN — architecture cible

Écrit le 12/10/2026 avec le socle (v0.1.0), complété le même jour (v0.2.0 : canaux par profil, hors ligne d'abord, coffre de documents, cartes virtuelles et conversions). Ce document décrit la cible et dit, pour chaque brique, ce que le socle en contient déjà.

## 1. Ce qu'est App GN

Une seule application, trois profils, chacun sur ses canaux :

| Espace | Pour qui | Produit | Canaux |
|---|---|---|---|
| Citoyen | toute personne identifiée par son NIN | App GN | application mobile ou version web, sur tout appareil |
| Entreprise | micro-entrepreneur, PME, ETI | GAPP | tableau de bord web, sur ordinateur ou tablette uniquement |
| Administration | collectivité, EPA, agence, entreprise publique | GAPP Institutionnel | tableau de bord web, sur ordinateur ou tablette uniquement |

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

## 3. Canaux

Chaque cas d'usage reçoit un `Actor` : la personne et le format de son appareil (`phone`, `tablet`, `desktop`). Un espace entreprise ou administration demandé depuis un téléphone répond `channel_not_allowed` ; `me` dit pour chaque espace s'il s'ouvre sur l'appareil, et l'interface grise les autres (`channels.ts`).

- Côté client, le format vient de la largeur de l'écran (la démo permet de le forcer). Côté API, de l'en-tête `AppGN-Channel`, `phone` par défaut.
- C'est une règle produit, pas une frontière de sécurité : un navigateur peut mentir sur sa largeur. La cible lie le format à l'appareil enregistré à la connexion.
- Trois mises en page : application (barre d'onglets en bas) pour le citoyen sur téléphone, web (onglets en haut) pour le citoyen sur grand écran, tableau de bord (barre latérale) pour l'entreprise et l'administration.
- Application mobile : aujourd'hui une application web installable (manifeste + service worker qui ouvre la coquille sans réseau). Une application native (React Native / Expo) réutilisera `packages/core` sans changement quand les stores et l'accès matériel (biométrie, NFC) le demanderont.

## 4. Profils et accès

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

## 5. Agrégation des comptes

- Un `AccountConnector` par fournisseur : `fetchBalance`, `fetchTransactions`. Le socle en a un simulé par fournisseur (Orange Money, MTN, Cellcom, Moov, Ecobank, UBA, Trésor public, carte virtuelle, wallet App GN, crypto).
- Tous les fournisseurs sont interrogés **en parallèle, chacun sous un délai** (3 s par défaut). Une panne ne bloque jamais la vue : on montre le dernier solde connu marqué « ancien », ou « indisponible » s'il n'y en a jamais eu, et la vue est marquée partielle.
- Le total est une **contre-valeur indicative en GNF** : devises et crypto sont converties à un taux daté ; aucun paiement n'est calculé sur ce montant. Les taux du socle sont fictifs.
- Montants : unités mineures entières en chaînes, même convention que le `Money` d'ORCHEA. Pas de flottant, pas d'arrondi implicite.

## 6. Paiements et ORCHEA

App GN ne déplace pas d'argent lui-même : il décide (droits, approbation, idempotence) puis remet l'ordre à l'orchestrateur par le port `PaymentOrchestrator`.

| App GN | ORCHEA (cible) |
|---|---|
| paiement d'une facture, envoi Mobile Money | `POST /v1/payment-intents` ou `POST /v1/payouts` |
| clé d'idempotence = id du paiement App GN | en-tête `Idempotency-Key` |
| statut `processing` puis issue | accusé `CREATED` puis webhook signé, lu par `readWebhook` du SDK |
| `AppGn.recordOutcome(reference, issue)` | réception du webhook |

Le socle branche un orchestrateur simulé qui débite et crédite le réseau simulé tout de suite. L'adaptateur ORCHEA réel est le prochain lot côté paiements ; ORCHEA lui-même n'appelle encore aucun Provider réel.

Les comptes crypto ne servent pas à payer directement : ils se convertissent (§8). L'achat de crypto n'est pas ouvert tant qu'aucun cadre (BCRG, dépositaire) n'est posé.

## 7. Hors ligne d'abord

Le réseau est souvent absent ou cher : l'application doit rester utile sans lui (`sync.ts`, `apps/web/src/offline.ts`).

- **Lectures** : réseau d'abord, puis gardées sur l'appareil, datées. Sans réseau, l'écran montre la dernière version gardée et le dit (« données du 12 oct., 05:28 »). Les documents sont gardés dès qu'ils ont été affichés une fois.
- **Paiements du citoyen** : sans réseau, le paiement est mis en file sur l'appareil avec sa clé d'idempotence, puis rejoué dans l'ordre au retour du réseau. Une coupure au mauvais moment (paiement reçu, réponse perdue) ne débite jamais deux fois : le rejeu porte la même clé. Un paiement resté plus de 24 h sans réseau expire au lieu de partir des jours plus tard sur un solde changé.
- **Ce qui exige le réseau** : approuver, rejeter, convertir (le cours change), émettre ou bloquer une carte, et tout paiement d'un espace entreprise ou administration (il peut attendre une approbation).
- **Stockage** : `localStorage` dans le socle ; cible : IndexedDB dans le navigateur, SQLite chiffré dans l'application native. Les données gardées sont celles que la personne peut déjà voir, rien de plus.
- **À venir** : synchronisation différentielle (ne rapatrier que ce qui a changé), purge à la déconnexion, chiffrement du cache par une clé tirée du code PIN.

## 8. Cartes virtuelles et conversions (sur le modèle de Keecash)

Inspiré de Keecash : plusieurs cartes Visa ou Mastercard par personne, rechargées depuis le Mobile Money ou la crypto, bloquées en un geste, frais affichés avant de confirmer (`cards.ts`).

- **Cartes** : au plus 3 par type (Standard, Gold). Bloquer une carte refuse aussitôt tout débit. L'émission passe par le port `CardIssuer` ; la cible est un émetteur de cartes partenaire (BIN sponsor), à choisir.
- **Conversion** en deux temps : un devis (débité, frais, cours, reçu) valable 60 s, puis l'exécution, idempotente. Le montant crédité est arrondi vers le bas, le frais vers le haut : ce qui est affiché est ce qui est fait.
- **Frais du socle** (fictifs, à fixer par la grille tarifaire) : recharge d'une carte Gold gratuite, d'une carte Standard 2 %, depuis la crypto 1 %, sinon 1,5 %.
- **Réservé à l'espace citoyen** pour l'instant. Les cartes de dépense d'entreprise viendront avec les règles d'approbation.
- **À trancher avant le réel** : cadre BCRG pour la crypto et pour la monnaie électronique, émetteur des cartes, source des cours, plafonds KYC par palier.

## 9. Coffre de documents

Dématérialiser les supports : carte d'identité, permis, carte grise, attestations d'assurance, carte d'assurance maladie, abonnements, cartes de fidélité ; côté entreprise, extrait RCCM, attestation fiscale, assurance flotte (`documents.ts`).

- Un document est soit **émis par l'organisme** (il porte un code de vérification), soit **ajouté par la personne** (déclaratif, sans valeur probante). L'interface affiche toujours la différence.
- **Présenter sans réseau** : le document et son code sont gardés sur l'appareil.
- **Vérifier** : un contrôleur saisit le code (`GET /v1/document-checks/:code`, sans compte) et ne voit que le titre, l'émetteur, le titulaire et la validité.
- **Alertes** : un document expiré ou qui expire sous 30 jours remonte en tête, avec un rappel.
- **Cible** : documents signés par l'émetteur (ECDSA), vérifiables hors ligne par QR code contre la clé publique de l'émetteur ; raccordement des émetteurs un par un (aucun ne l'est aujourd'hui, tous les documents du socle sont fictifs).

## 10. Catalogue de services

`services.ts` liste les services par espace, chacun avec la permission qu'il exige et son état (`available` dans le socle, `planned` sinon). L'écran n'affiche que ce que le rôle permet.

| Espace | Branché dans le socle | Prévu |
|---|---|---|
| Citoyen | vue consolidée, envoi, paiement de facture (hors ligne compris), cartes virtuelles, conversions, documents | rattacher un compte, passer en pro |
| Entreprise | trésorerie consolidée, paiement fournisseur avec approbation, documents | facturation, TVA, paie, score B2B |
| Administration | situation des comptes, mandat, visa et paiement, documents | paie des agents, exécution budgétaire, reporting Cour des Comptes |

## 11. Ce qui reste simulé ou absent

- Identité : connexion de démo (`Bearer demo:<personId>`). Cible : NIN + OTP / identité numérique.
- Persistance : mémoire. Cible : PostgreSQL, comme ORCHEA.
- Cartes et conversions : émetteur et cours simulés, frais fictifs.
- Documents : fictifs, aucun émetteur raccordé, pas encore de signature.
- Connecteurs : tous simulés. Chaque fournisseur réel demande un accord et une API (voir `positionnement/chiffres-a-sourcer.md` pour Ecobank, UBA, Cellcom, Moov).
- Orchestrateur : simulé. Cible : ORCHEA par son SDK.
- Piste d'audit, notifications, rattachement d'un compte, bascule citoyen → pro : à construire.

## 12. Stack

TypeScript partout, Node ≥ 22.18 (exécution directe des `.ts`), Fastify 5 pour l'API, React 19 + Vite pour le web (application installable), `node:test` pour les tests. Mêmes choix qu'ORCHEA pour que les deux dépôts se lisent de la même façon. Voir `docs/adr/adr-001-socle.md` et `docs/adr/adr-002-canaux-hors-ligne-documents-cartes.md`.
