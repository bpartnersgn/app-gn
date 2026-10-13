# ADR-006 — Une session, un espace : fonds personnels et fonds d'organisation séparés

Date : 13/10/2026. Statut : accepté. Remplace, sur ce point, l'idée d'ADR-001 d'une personne qui passe d'un espace à l'autre par des onglets.

## Contexte

Exigence posée le 13/10/2026 : une personne qui a App GN n'a pas forcément d'entreprise à gérer, et ses fonds personnels ne doivent pas être exposés à côté de ceux d'une PME ou d'une administration. Jusqu'ici, une personne connectée voyait tous ses espaces en onglets, dans la même session, et le tableau de bord d'entreprise s'ouvrait par défaut sur ordinateur.

## Décision

1. L'`Actor` porte l'espace de sa session ; le noyau refuse tout cas d'usage sur un autre espace, avec la réponse d'un espace inconnu. La règle vit dans `@app-gn/core`, donc l'API et la démo embarquée l'appliquent pareil.
2. Le jeton de session porte l'espace (`spc`). Qui n'a qu'un espace y entre directement ; sinon on choisit après le code, ou on nomme l'espace dès la demande.
3. Changer d'espace, c'est quitter la session (révoquée), effacer de l'appareil les lectures gardées pour cet espace, puis entrer dans l'autre avec un nouveau code. Raison : sur une tablette de bureau partagée, une session d'entreprise ne doit pas mener aux comptes personnels de la dirigeante, ni l'inverse.
4. `me` nomme les autres espaces (nom et nature) pour permettre de changer, sans montant, rôle ni droit.
5. Les paiements personnels en file hors ligne ne partent que depuis une session personnelle.

## Conséquences

- L'interface n'a plus d'onglets d'espaces : un bandeau dit dans quel espace on est, et « Changer d'espace » n'apparaît que pour qui a une organisation.
- Passer d'un espace à l'autre coûte un SMS. C'est voulu ; à revoir si l'usage montre une gêne (par exemple : appareil enregistré et code PIN local pour revenir à l'espace personnel).
- `demo:<personId>` sans espace reste pour les essais de l'API ; il disparaît avec `APPGN_DEMO_LOGIN=off`.
