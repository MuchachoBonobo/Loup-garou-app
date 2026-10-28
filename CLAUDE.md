# LoupGarouVoteApp — Instructions pour Claude

Application web de Loup-Garou (party game) pensée pour le jeu en présentiel : téléphones des joueurs + tablette du Maître du Jeu, sur le Wi-Fi d'un PC qui fait tourner le serveur, avec lumières Philips Hue optionnelles.

## Le dossier a deux parties

| Dossier | À qui | Contenu |
|---------|-------|---------|
| `code/` | **Claude** — Alexandre n'y va pas | Serveur, interfaces, sons, tests, outils, doc technique. Tu l'organises et le modifies librement (en gardant les conventions ci-dessous). |
| `gestion/` | **Alexandre** | Documents **Word** (.docx, police Calibri) : pitch, mise en place (Wi-Fi, lancement), lumières, prospection, site internet, prix, prise de contact ; lanceurs `Lancer le jeu.bat` et `Tester les lumieres.bat`. |

- Dans `gestion/`, tu ne modifies **que sur demande**, avec deux exceptions : (1) si une modification du code change la mise en place (variable `.env`, port, étape de lancement, rôle, durée affichée aux joueurs…), mets à jour la fiche concernée dans le même mouvement et dis-le ; (2) ne jamais y mettre de jargon technique — ces fiches s'adressent à quelqu'un qui ne code pas.
- **Format** : tous les documents de `gestion/` sont des fichiers Word (.docx) qu'Alexandre édite lui-même dans Word. Pour en modifier un : décompresser le .docx et éditer `word/document.xml` (skill docx), ou le régénérer via Word (COM PowerShell) en gardant la police Calibri ; ne jamais le remplacer par du Markdown. Vérifier qu'il n'est pas ouvert dans Word (fichier `~$…` présent = verrouillé).
- **Données personnelles** : le dépôt GitHub est **public** — coordonnées de prospects uniquement dans `gestion/prive/` (ignoré par Git).
- Ne casse jamais `gestion/Lancer le jeu.bat` : il appelle `code/start.ps1`. Si tu déplaces `start.ps1`, mets à jour le `.bat`.

## Avant de répondre à une demande

Lis impérativement :
1. **`code/CONTEXT.md`** — vision produit, public, priorités de décision.
2. **`code/HANDOFF.md`** — section « État actuel » (vérité du code) + Carte du code + Journal.

## Conventions de travail

- **Langue** : tout en français — code, commentaires, narrations, UI, documents. Réponds en français, simplement : Alexandre n'est pas développeur.
- **Git** : dépôt à la racine, branche `master`. `git pull` en début de session.
- **Architecture** : `code/server.js` ne fait que le câblage ; repérer le module dans la **Carte du code** de `code/HANDOFF.md`, puis `Grep` pour la ligne. `public/index.html` et `public/mj.html` font plusieurs milliers de lignes : les lire par portions (`offset`/`limit`) ou via `Grep`.
- **Un besoin, une fonction** (revues du 2026-10-27) : avant d'écrire, chercher si l'outil existe déjà — `public/js/communs.js` et `public/css/communs.css` (partagés par les deux écrans), `state.js` (`versMJ`, `vivantsAvecRole`…), `roles.js` (`ETAPES_NUIT`, `marquerMort`), `snapshot.js` (`CHAMPS`), `tests/outils.js`. Ne pas recopier : appeler.
- **Convention `state.js`** : ne JAMAIS faire `const { players } = state` — toujours `state.players`.
- **Cycle `phases` ↔ `roles` ↔ `votes`** : terminer ces modules par `Object.assign(module.exports, {...})`, jamais `module.exports = {...}`.
- **Chemins** : toujours relatifs à `__dirname` (le serveur peut être lancé depuis n'importe quel dossier).
- **Après toute modification** : `node --check <fichier>.js`, puis les filets décrits dans « Tests et commandes » de `code/HANDOFF.md` (`npm test` et `npm run test:rythme` pour le serveur, `npm run test:navigateur` pour les écrans). Relancer le serveur pour tester (Node garde les anciens modules en mémoire).
- **Modification visible** : la vérifier dans le navigateur avant de considérer la tâche terminée — `npm run test:navigateur`, ou un serveur d'essai sans lumières (`PORT=3097 LIGHTS_ENABLED=false node server.js`). Le preview `loupgarou` (`.claude/launch.json`, port 3000) allume les **vraies** lumières Hue.
- **Ne jamais bloquer le moteur de jeu** sur des appels externes (pattern fire-and-forget de `lights.js` : timeout court, pas d'`await`, pas de `throw`).
- **Secrets** : `code/.env` contient la clé Hue — jamais versionné, jamais affiché.

## Avant de proposer une fonctionnalité

Passe-la au filtre de `code/CONTEXT.md` :
1. Est-ce que ça aide les joueurs à passer un bon moment ?
2. Est-ce que ça renforce l'immersion (et ça ne ramène pas les yeux vers l'écran sans nécessité) ?
3. Est-ce que ça tient pour un public d'inconnus ?
4. Est-ce maintenable en temps libre ?

**Principe d'Alexandre (2026-10-23)** : le plaisir n'est pas sur le téléphone. L'application s'efface derrière le jeu : elle le rend plus dynamique et plus fluide, ajoute le Conseil des Morts et de petites fonctionnalités, mais chaque fois qu'elle fait regarder un écran, ce doit être pour une **grosse plus-value** — sinon c'est juste trop d'écran. Les idées déjà écartées sont listées dans `code/HANDOFF.md` (section « Idées ») : ne pas les reproposer.

Si tu hésites sur une priorité ou une direction, **demande** plutôt que de partir tête baissée.

## Mise à jour de la documentation

Après une modification significative : entrée datée en tête du **Journal** de `code/HANDOFF.md`, et mise à jour de sa section « État actuel » si le comportement change. Vision ou public qui évolue → `code/CONTEXT.md`. Mise en place qui change → fiche de `gestion/`.
