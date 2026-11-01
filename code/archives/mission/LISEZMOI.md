# La Mission — retirée le 2026-10-31

Alexandre l'a retirée du jeu : elle ne sera pas utilisée en prestation. Ce dossier garde ce
qu'elle était et tout son code, pour pouvoir la retrouver un jour.

## Ce que c'était

Une option de la préparation (case « 🎭 Mission » de la page du MJ, décochée par défaut).

1. Juste après l'élection du Maire, une carte « Mission Secrète » expliquait la règle à tous.
2. Le Maire désignait 3 envoyés (jamais lui-même).
3. Chaque envoyé jouait en secret une carte **Réussite** ou **Échec** (robots : un loup sabote
   7 fois sur 10, un villageois réussit 8 fois sur 10). Un seul Échec faisait échouer la mission.
   Le MJ voyait les cartes de chacun.
4. La première nuit suivait ; le résultat était révélé à l'aube (carte de l'aube, récap du MJ,
   éclair vert « réussite » ou rouge après les morts).
5. Mission réussie : au matin, avant le jour, le Maire désignait 3 joueurs et apprenait en privé
   si un Loup se cachait parmi eux. Si le Maire mourait la nuit, son successeur en héritait.

Délais : 2 min pour choisir l'équipe (sinon mission annulée), 90 s pour les cartes (manquantes
= Réussite), 90 s pour le bonus.

## Où est le code

- `CODE-RETIRE.md` : chaque morceau retiré, avec son fichier et ses numéros de ligne d'origine
  (serveur, page joueur, page du MJ, styles, narration, scènes lumineuses, banc d'essai).
- La dernière version complète du jeu avec la Mission est le commit **51eee4a** du dépôt
  (par exemple `git show 51eee4a:code/roles.js`).

## Pour la remettre

Annuler le commit qui l'a retirée (`git revert`), puis relancer `npm test`. Si le code a beaucoup
changé depuis, des conflits sont probables : repartir alors de `CODE-RETIRE.md`. Deux défauts
connus à corriger en la remettant : le Maire qui recharge sa page pendant la mission ne retrouvait
ni le choix de l'équipe ni le bonus (le serveur ne renvoyait pas `missionSelectTeam`, la page ne
rouvrait pas le bonus).
