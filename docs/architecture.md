# App GN — architecture cible

Écrit le 12/10/2026 avec le socle (v0.1.0), complété le même jour (v0.2.0 : canaux par profil, hors ligne d'abord, coffre de documents, cartes virtuelles et conversions ; v0.3.0 : paiements de factures par ORCHEA, connexion par NIN et code SMS, PostgreSQL ; le 13/10, séparation des fonds par espace puis v0.4.0 : bureaux GAPP Entreprise et Administration). Ce document décrit la cible et dit, pour chaque brique, ce que le socle en contient déjà.

## 1. Ce qu'est App GN

Une seule application, trois profils, chacun sur ses canaux :

| Espace | Pour qui | Produit | Canaux |
|---|---|---|---|
| Citoyen | toute personne identifiée par son NIN | App GN | application mobile ou version web, sur tout appareil |
| Entreprise | micro-entrepreneur, PME, ETI | GAPP | tableau de bord web, sur ordinateur ou tablette uniquement |
| Administration | collectivité, EPA, agence, entreprise publique | GAPP Institutionnel | tableau de bord web, sur ordinateur ou tablette uniquement |

Une personne a **une seule identité** et un **espace personnel**. La plupart n'ont que celui-là. Celles qui gèrent aussi une entreprise ou une administration y ont un espace de plus, avec un rôle, **séparé du leur** : une session ne s'ouvre que dans un espace à la fois, et les fonds personnels ne s'affichent jamais à côté de ceux d'une organisation (§4).

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
              │ connecteurs simulés │   │ ORCHEA (factures) +     │
              │ (cible : API banques,│   │ orchestrateur simulé    │
              │ Mobile Money, crypto)│   │ (le reste)              │
              └─────────────────────┘   └─────────────────────────┘
                     AppStore (paiements, idempotence, conversions, cartes émises)
                     ├─ en mémoire (navigateur, démo)
                     └─ PostgreSQL (apps/api/src/db), ou PGlite sur un poste sans serveur
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
- entreprise : au-delà de 5 000 000 GNF, une seconde personne habilitée approuve, sauf si l'initiateur est lui-même habilité (le dirigeant), qui confirme alors par code SMS (ci-dessous) ;
- administration : toujours une seconde personne. L'ordonnateur mandate, le comptable public vise et paie. Celui qui initie ne peut jamais approuver.

**Séparation des fonds** (exigence du 13/10/2026). Chaque session est liée à un seul espace : l'espace personnel, ou une entreprise, ou une administration.
- Le noyau refuse toute lecture ou écriture hors de l'espace de la session (`not_a_member`, la même réponse qu'un espace inconnu) : depuis une session d'entreprise, ni soldes, ni mouvements, ni paiements, ni documents personnels ; et l'inverse. `me` ne rend que l'espace de la session, et nomme les autres (nom et nature, sans montant ni droit) pour pouvoir en changer.
- Qui n'a que son espace personnel y entre directement : rien ne lui parle d'entreprise. Qui a aussi une organisation choisit l'espace après le code.
- Changer d'espace ferme la session en cours, efface de l'appareil ce qui en était gardé pour le hors-ligne, et demande un nouveau code. Les paiements personnels en file restent sur l'appareil et ne partent qu'au retour dans l'espace personnel.
- Il n'existe aucun total qui additionne fonds personnels et fonds d'une organisation.

**Connexion** (`apps/api/src/auth.ts`) : NIN, puis code à 6 chiffres envoyé par SMS au numéro de la personne, puis session.
- `POST /v1/auth/codes {nin}` → `202 {challengeId, expiresAt}`, identique que le NIN soit connu ou non (ni l'existence de la personne ni son numéro ne se devinent) ; au plus 3 codes par NIN en 15 minutes (`429`).
- `POST /v1/auth/sessions {challengeId, code, spaceId?}` → `201 {token, expiresAt, me}` dans l'espace nommé, ou directement dans l'espace personnel pour qui n'a que lui ; sinon `200 {chooseSpace, selectionToken, spaces}`, puis `POST /v1/auth/sessions/space {selectionToken, spaceId}` (5 minutes, usage unique). Le code vit 5 minutes, se tente 5 fois, ne sert qu'une fois ; seule son empreinte est gardée.
- Jeton `ags1.<charge>.<HMAC-SHA256>` (clé `APPGN_SESSION_SECRET`) qui porte la personne et l'espace, valable 12 h, révocable par `DELETE /v1/auth/sessions/current`. L'application le garde sur l'appareil pour rester utilisable hors ligne.
- **Inscription** : `POST /v1/registrations {nin, name, phone}` → `202 {challengeId, expiresAt}` ; le code part au mobile saisi (`+224 6XX…`). `POST /v1/registrations/confirm {challengeId, code}` crée la personne (identité déclarée) et son espace personnel, puis ouvre la session. Un NIN déjà inscrit reçoit la même réponse, sans code, et le titulaire est prévenu par SMS.
- **Membres** : le dirigeant ou l'ordonnateur (`members:manage`) lit, ajoute (par NIN d'une personne inscrite) et retire les membres : `GET|POST /v1/spaces/:id/members`, `DELETE /v1/spaces/:id/members/:personId`. Les organisations s'ouvrent par l'outil de l'exploitant (`npm run admin -w @app-gn/api`).
- **Confirmation forte** (`packages/core/src/confirmation.ts`) : en entreprise, un paiement, un visa, un lot exécuté ou une TVA déclarée à partir de 5 M GNF (ou en devises) répond `428 confirmation_required` avec `{challengeId, expiresAt, sentTo}` ; le code part par SMS, lié à l'opération exacte, et la demande est renvoyée avec l'en-tête `AppGN-Confirmation: <challengeId>.<code>`. Un essai par code, 5 codes par 15 minutes. L'application web affiche la saisie du code et renvoie la même demande (même clé d'idempotence).
- **SMS** : `APPGN_SMS_PROVIDER=orange` (avec `ORANGE_SMS_CLIENT_ID`, `ORANGE_SMS_CLIENT_SECRET`, `ORANGE_SMS_SENDER`, `ORANGE_SMS_SENDER_NAME` en option) envoie par l'API SMS d'Orange ; sans fournisseur, les codes restent en mémoire. Une panne du fournisseur rend `503 unavailable`.
- En démonstration (`APPGN_DEMO_LOGIN`, ouverte par défaut), la réponse porte le code et l'accès rapide `Bearer demo:<personId>@<spaceId>` (lié à l'espace comme une vraie session ; `demo:<personId>` sans espace sert aux essais de l'API) reste ouvert ; `APPGN_DEMO_LOGIN=off` ferme les deux.
- Reste à faire : essai du SMS Orange sur un compte réel, appareil enregistré (qui fixera le format d'appareil au lieu de l'en-tête déclaré), raccordement à l'identité numérique nationale quand elle offrira une API.

## 5. Agrégation des comptes

- Un `AccountConnector` par fournisseur : `fetchBalance`, `fetchTransactions`. Le socle en a un simulé par fournisseur (Orange Money, MTN, Cellcom, Moov, Ecobank, UBA, Trésor public, carte virtuelle, wallet App GN, crypto).
- Tous les fournisseurs sont interrogés **en parallèle, chacun sous un délai** (3 s par défaut). Une panne ne bloque jamais la vue : on montre le dernier solde connu marqué « ancien », ou « indisponible » s'il n'y en a jamais eu, et la vue est marquée partielle.
- Le total est une **contre-valeur indicative en GNF** : devises et crypto sont converties à un taux daté ; aucun paiement n'est calculé sur ce montant. Les taux du socle sont fictifs.
- Montants : unités mineures entières en chaînes, même convention que le `Money` d'ORCHEA. Pas de flottant, pas d'arrondi implicite.

## 6. Paiements et ORCHEA

App GN ne déplace pas d'argent lui-même : il décide (droits, approbation, idempotence) puis remet l'ordre à l'orchestrateur par le port `PaymentOrchestrator`.

| App GN | ORCHEA |
|---|---|
| facture payée depuis Orange Money ou MTN MoMo | `POST /v1/payment-intents` avec `payer {msisdn, operator}` : le débit est poussé sur le téléphone |
| clé d'idempotence `appgn-<id du paiement>` | en-tête `Idempotency-Key` |
| id du paiement App GN | `externalReference`, rendu dans chaque webhook |
| facturier (`edg`, `seg`…) | `paymentDestinationId`, réglé par `ORCHEA_BILLER_DESTINATIONS` |
| statut `processing` | accusé `201 CREATED` (jamais un résultat) |
| `completed` / `failed` | webhook `TransactionConfirmed` / `TransactionRejected`, `TransactionFailed` |
| reste `processing` | `PaymentAttemptUnknown`, `PaymentAttemptActionRequired` |

L'adaptateur vit côté serveur (`apps/api/src/orchea.ts`) : la clé d'API et les numéros complets des wallets ne quittent jamais le serveur, et le noyau reste exécutable dans le navigateur. Sans variables `ORCHEA_*`, tout est simulé ; avec, les factures payées depuis Orange Money ou MTN MoMo passent par ORCHEA, et le reste par l'orchestrateur simulé (repli), jusqu'à ce que les routes correspondantes soient branchées : envoi vers un numéro (payouts, qui demandent un bénéficiaire et des fonds chez ORCHEA), virements entre comptes, conversions, Cellcom et Moov (qu'ORCHEA ne couvre pas encore).

Réception des webhooks (`POST /v1/webhooks/orchea`) : signature `X-Orchea-Signature` vérifiée sur le corps brut (HMAC-SHA256 de `t.corps`, 300 s de tolérance, plusieurs secrets pendant une rotation), dédoublonnage sur `eventId`, puis `AppGn.recordOutcome`, qui retrouve le paiement par la référence ORCHEA ou, si l'appel de création est resté sans réponse, par la référence externe. Un événement rejoué ou tardif est sans effet. Répondre `401` à une signature fausse, `400` à un corps illisible, `200` à tout le reste (y compris un type inconnu).

Si ORCHEA ne répond pas à la création (réseau, `5xx`, `409 payment_in_progress`), le paiement reste en cours : on ne sait pas s'il a été reçu, et le webhook le soldera. Un `4xx` le fait échouer tout de suite (`orchea_<code>`).

Vérifié de bout en bout le 12/10/2026 contre le simulateur local d'ORCHEA (`npm run dev` de son dépôt, mode `mobile-money`) : intention créée, webhook signé reçu, paiement passé à « Exécuté » dans l'interface. Ce qui manque : le rattrapage par le flux `GET /v1/events` quand un webhook se perd, le dédoublonnage persistant (avec la base), l'indication « confirmez sur votre téléphone » portée par `PaymentAttemptActionRequired`, et le solde du wallet, qui reste celui du connecteur simulé.

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
| Entreprise | trésorerie et projection, factures scellées, fournisseurs et lots, TVA, équipe et paie, score B2B, journal comptable, documents | financement adossé au score, déclarations sociales |
| Administration | situation, budget, chaîne de la dépense, paie des agents contrôlée, recettes, rapport Cour des comptes, documents | ordonnancement multi-niveaux, recettes encaissées par App GN |

### 10.1 Bureaux GAPP

Décision : [ADR-007](adr/adr-007-bureaux-gapp.md). Code : `packages/core/src/gapp/` (`business.ts`, `administration.ts`, `desk.ts`, `routes.ts`, `demo.ts`), écrans `apps/web/src/Business.tsx` et `Administration.tsx`.

**Entreprise (GAPP).** Rubriques et rôles qui les ouvrent :

| Rubrique | Ce qu'elle fait | Rôles |
|---|---|---|
| Trésorerie | disponible en GNF, devises à part, projection à 7 jours (factures à leur échéance, fournisseurs, paie, TVA avant le 15), point bas et tension, créances en retard, fournisseurs échus | dirigeant, DAF, comptable |
| Factures | émission `FAC-AAAA-NNNN` sans trou, scellée et chaînée, TVA 18 % ou exonérée ; encaissement, annulation motivée ; rapprochement des encaissements | dirigeant, DAF, comptable |
| Fournisseurs | factures reçues ; lot de paiement (50 lignes au plus) avec rail et frais estimés ; au-delà de 5 M GNF, un second habilité approuve ou refuse | DAF propose, dirigeant approuve |
| TVA | collectée moins déductible par mois ; déclaration et paiement à la DGI d'un seul geste ; crédit reporté ; période close | dirigeant et DAF déclarent, comptable consulte |
| Équipe et paie | embauche, fin de contrat, attestation de travail déposée dans le coffre du salarié, paie du mois en lot | dirigeant, RH |
| Score B2B | indicatif, cinq critères pondérés, détail par critère | dirigeant, DAF, comptable |
| Journal | piste d'audit chaînée, export du journal comptable SYSCOHADA | dirigeant, DAF, comptable |

**Administration (GAPP Institutionnel).**

| Rubrique | Ce qu'elle fait | Rôles |
|---|---|---|
| Budget | lignes (dotation, engagé, mandaté, payé, disponible), taux d'exécution | tous |
| Dépenses et mandats | engagement sur une ligne (crédit réservé), liquidation au service fait, mandat `MDT-AAAA-NNNN`, visa et paiement ou rejet motivé | ordonnateur engage et mandate ; comptable public vise |
| Paie des agents | contrôle de l'état de paie contre l'état civil, mandat de paie sur la ligne de paie, visa et paiement | ordonnateur prépare ; comptable public paie |
| Recettes | encaissements par nature | ordonnateur, comptable public, contrôle |
| Contrôle | piste d'audit chaînée, rapport Cour des comptes (CSV) | ordonnateur, comptable public, contrôle |

Un espace administration ne paie jamais en direct : le noyau refuse tout paiement qui ne vient pas d'un mandat.

## 11. Ce qui reste simulé ou absent

- Identité : NIN + code SMS, inscription et sessions signées (§4), défis en base. SMS Orange branché mais jamais essayé sans contrat ; identité déclarée, sans vérification nationale.
- Persistance : PostgreSQL pour l'état transactionnel et le référentiel (§12).
- Cartes et conversions : émetteur et cours simulés, frais fictifs.
- Documents : fictifs, aucun émetteur raccordé, pas encore de signature.
- Connecteurs : tous simulés. Chaque fournisseur réel demande un accord et une API (voir `positionnement/chiffres-a-sourcer.md` pour Ecobank, UBA, Cellcom, Moov).
- Orchestrateur : simulé par défaut ; ORCHEA pour les factures depuis Orange Money et MTN MoMo quand `ORCHEA_*` est réglé (§6).
- Piste d'audit : chaînée pour les bureaux GAPP (§10.1), pas encore pour l'espace citoyen. Notifications, rattachement d'un compte, bascule citoyen → pro : à construire.
- Bureaux GAPP : taux, frais, plan comptable et nomenclature budgétaire de démonstration ; DGI fictive ; état civil de démonstration pour le contrôle de paie.

## 12. Données

Le port `AppStore` (`packages/core/src/store.ts`) garde ce qui doit survivre à un redémarrage : paiements, clés d'idempotence, conversions, cartes émises et leur état. Côté serveur, `PostgresStore` (`apps/api/src/db/`) le met en base, avec aussi les défis de connexion, les demandes de code, les sessions révoquées et les webhooks ORCHEA déjà traités.

| Réglage | Base |
|---|---|
| `DATABASE_URL=postgres://…` | serveur PostgreSQL (cible en service ; `DATABASE_POOL_SIZE`, 10 par défaut) |
| `APPGN_PGLITE_DIR=./.data` | PostgreSQL embarqué (PGlite) dans ce dossier, pour un poste sans serveur |
| rien | mémoire, perdue à l'arrêt |

Les bureaux GAPP gardent leurs enregistrements (factures, lots, engagements, mandats, agents, journaux) dans `desk_records` : JSONB versionné, écrit par `UPDATE … WHERE version = …`, ce qui donne des numéros sans trou et des crédits engagés jamais dépassés, même à plusieurs instances.

Le schéma vient des migrations numérotées `db/migrations/NNN-*.sql` (socle, bureaux GAPP, limites de débit, référentiel, flux ORCHEA, cartes partagées), appliquées au démarrage dans l'ordre, chacune dans sa transaction, sous un verrou consultatif : deux instances qui démarrent ensemble n'appliquent rien deux fois. Les objets sont gardés en JSONB, dans la forme exacte du noyau, avec en colonnes ce qui sert à chercher et à verrouiller. Chaque garantie tient dans une seule instruction SQL, donc plusieurs instances peuvent partager la base :
- une clé d'idempotence se réserve par `INSERT … ON CONFLICT DO NOTHING` avant tout effet, et se libère si la demande est refusée ;
- un paiement ne change d'état que s'il est encore dans l'état attendu (`UPDATE … WHERE status = …`) : deux visas simultanés d'un même mandat n'en paient qu'un ;
- un code de connexion se consomme par `DELETE … RETURNING` : un seul essai simultané l'emporte ;
- un devis de conversion aussi : accepté au même moment sur deux instances, il ne sert qu'une fois ;
- une carte émise prend une place (1 à 3) de son espace et de son type sous un index unique : deux émissions simultanées ne dépassent pas le plafond.

Vérifié le 12/10/2026 sur PGlite et sur PostgreSQL 16 (mêmes tests, `TEST_DATABASE_URL`), et par redémarrage du serveur : session, paiement, rejeu par la même clé, carte émise et révocation retrouvés.

Le référentiel (personnes, espaces, rattachements, comptes liés, documents) est en base (`DirectoryStore`) : le noyau en garde une copie relue au démarrage, toutes les 30 s (`APPGN_DIRECTORY_REFRESH_MS`) et aussitôt pour un NIN ou un espace inconnu. Les limites de débit (`rate_limits`) et le curseur du flux ORCHEA (`feed_cursors`, sous bail) y sont aussi.

**Exploitation** :

| Réglage | Effet |
|---|---|
| `APPGN_ENV=production` | refuse de démarrer sans `APPGN_DEMO_LOGIN=off`, `APPGN_SESSION_SECRET`, `DATABASE_URL`, `APPGN_ALLOWED_ORIGINS`, `APPGN_SMS_PROVIDER` ; aucune donnée de démonstration |
| `APPGN_ALLOWED_ORIGINS` | origines web admises (CORS) ; une autre reçoit 403 |
| `APPGN_TRUST_PROXY` | mandataires de confiance (IP ou CIDR, ou `true`) |
| `APPGN_RATE_PER_IP`, `APPGN_RATE_PER_SESSION`, `APPGN_RATE_WRITES` | demandes par minute (600, 300, 60) |
| `ORCHEA_FEED_INTERVAL_MS` | rattrapage des événements ORCHEA (60 000) |

Les cartes d'un espace citoyen sont relues en base à chaque demande qui les touche (liste, vue consolidée, paiement, devis, conversion, blocage) : une carte émise ou bloquée sur une instance l'est aussitôt sur les autres. Les devis de conversion (60 s) sont en base (`exchange_quotes`). Plus rien n'impose une seule instance de l'API (vérifié le 16/10/2026 sur PostgreSQL 16 : deux instances sur la même base, émissions simultanées, blocage croisé, même devis accepté deux fois).

## 13. Stack

TypeScript partout, Node ≥ 22.18 (exécution directe des `.ts`), Fastify 5 pour l'API, React 19 + Vite pour le web (application installable), `node:test` pour les tests. Mêmes choix qu'ORCHEA pour que les deux dépôts se lisent de la même façon. PostgreSQL par `pg`, PGlite pour les tests et les postes sans serveur. Voir les ADR de `docs/adr/`.
