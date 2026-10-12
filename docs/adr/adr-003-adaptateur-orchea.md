# ADR-003 — Brancher les paiements sur ORCHEA par son API, côté serveur

Date : 12/10/2026. Statut : accepté.

## Contexte

App GN remet chaque paiement à un orchestrateur par le port `PaymentOrchestrator` (ADR-001). ORCHEA, le moteur de paiement, expose une API publique (intentions de paiement, payouts, webhooks signés) et un SDK TypeScript qui vit dans son propre dépôt, sans paquet publié.

## Décision

1. L'adaptateur `OrcheaOrchestrator` vit dans `apps/api`, pas dans le noyau : la clé d'API et les numéros complets des wallets restent sur le serveur, et le noyau reste exécutable dans le navigateur (démo, hors ligne).
2. App GN reprend le contrat d'ORCHEA, pas son code : appel `fetch` et vérification de signature réécrite (une vingtaine de lignes, même schéma qu'ADR-032 d'ORCHEA), testée contre de faux appels et vérifiée de bout en bout contre son simulateur. Quand le SDK sera publié comme paquet, on pourra le prendre à la place.
3. Première route : facture payée depuis Orange Money ou MTN MoMo, en intention de paiement avec le payeur. Le reste passe par un orchestrateur de repli (simulé aujourd'hui), choisi ordre par ordre.
4. Clé d'idempotence `appgn-<id>` et référence externe = id du paiement App GN, qui devient aléatoire (un compteur repartant de zéro au redémarrage ferait rejouer d'anciens paiements chez ORCHEA).
5. Création sans réponse, `5xx` ou `409` : le paiement reste en cours et le webhook le solde, retrouvé par la référence externe. `4xx` : échec immédiat.

## Conséquences

- Les paiements par ORCHEA restent « en cours » jusqu'au webhook ; l'interface relit la liste toutes les 3 s tant qu'un paiement est en cours.
- Le dédoublonnage des événements est en mémoire : il deviendra persistant avec PostgreSQL, et le rattrapage par `GET /v1/events` viendra avec.
- Routes encore à brancher : payouts (bénéficiaires, fonds chez ORCHEA), virements, conversions ; Cellcom et Moov attendent leurs connecteurs côté ORCHEA.
