# ADR-002 — Canaux par profil, hors ligne d'abord, coffre de documents, cartes et conversions

Date : 12/10/2026. Statut : accepté. Exigences posées par le porteur du projet le 12/10/2026 ; leur mise en œuvre est décidée par délégation.

## Contexte
- Citoyen : application mobile ou version web. Entreprise et administration : tableau de bord web ou tablette uniquement.
- Contraintes locales : réseau intermittent, d'où le hors ligne d'abord avec synchronisation.
- Dématérialiser les supports (assurance, cartes, abonnements, permis…).
- S'inspirer de Keecash pour les paiements.

## Décisions
1. **Le canal est une donnée de chaque appel** (`Actor = personne + format d'appareil`). Le noyau refuse un espace pro sur téléphone ; l'interface choisit sa mise en page d'après l'espace et l'appareil. Ce n'est pas une frontière de sécurité tant que le format n'est pas lié à un appareil enregistré.
2. **Application mobile = application web installable d'abord**, application native (Expo) ensuite, sur le même noyau. Raison : une seule base de code pour la démo et les pilotes ; la native se justifiera par la biométrie, le NFC et la distribution en store.
3. **Hors ligne d'abord** : lectures gardées sur l'appareil et datées ; seuls les paiements du citoyen se mettent en file, avec leur clé d'idempotence, et expirent après 24 h. Tout ce qui dépend d'un état frais (approbation, cours, carte) exige le réseau.
4. **Coffre de documents** dans le noyau : document émis (code de vérification) ou déclaratif ; vérification publique minimale par code. Signature ECDSA et QR hors ligne en cible.
5. **Cartes et conversions façon Keecash**, limitées à l'espace citoyen : plusieurs cartes, blocage instantané, devis de 60 s affichant frais et cours avant confirmation. Émetteur derrière le port `CardIssuer`, conversion derrière `PaymentOrchestrator.convert`.

## Conséquences
- Toute nouvelle route prend un `Actor`, pas un identifiant de personne seul.
- Les frais, plafonds et taux du socle sont fictifs ; les vrais demandent la grille tarifaire, un émetteur de cartes et le cadre BCRG (monnaie électronique, crypto).
