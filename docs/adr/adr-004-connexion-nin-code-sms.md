# ADR-004 — Connexion par NIN et code SMS, sessions signées

Date : 12/10/2026. Statut : accepté.

## Contexte

La démonstration choisissait la personne (`Bearer demo:<personId>`). App GN vise le citoyen guinéen sur téléphone, souvent sans adresse e-mail ; le NIN identifie chacun, et le numéro de téléphone est le canal le plus sûr d'atteindre la personne. L'identité numérique nationale n'offre pas encore d'API.

## Décision

1. Connexion en deux temps : NIN, puis code à 6 chiffres par SMS au numéro enregistré. Réponse identique pour un NIN inconnu, limite par NIN (connu ou non), 5 minutes, 5 essais, usage unique, empreinte seulement.
2. Session : jeton signé HMAC-SHA256 (`ags1.…`), sans état côté serveur hormis la liste des révocations, valable 12 h. Il reste lisible hors ligne par l'application, qui le garde sur l'appareil.
3. Le port `SmsSender` isole l'envoi. Faute de fournisseur, la démonstration rend le code dans la réponse ; un seul réglage (`APPGN_DEMO_LOGIN=off`) ferme ce raccourci et la connexion de démo.
4. Les règles d'accès ne changent pas : la connexion établit la personne, `@app-gn/core` décide du reste.

## Conséquences

- Défis et révocations en mémoire : un redémarrage les perd (les jetons restent valides jusqu'à leur échéance). Ils passeront en base avec PostgreSQL.
- Le format d'appareil reste déclaré par le client ; l'appareil enregistré viendra plus tard.
- La confirmation forte par code des paiements d'entreprise au-delà du seuil peut maintenant réutiliser le même mécanisme.
