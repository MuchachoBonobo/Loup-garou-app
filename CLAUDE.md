# LoupGarouVoteApp — Instructions pour Claude

Bienvenue. Ce projet est une application web de Loup-Garou (party game) pensée pour le jeu en présentiel. Avant de répondre à une demande sur ce projet, **lis impérativement** :

1. **`CONTEXT.md`** — la vision produit, le public visé, les priorités de décision. C'est ce qui doit guider tes choix de design et de priorisation.
2. **`HANDOFF.md`** — l'état technique du code : architecture, rôles implémentés, modifications récentes, repères dans `server.js` et `mj.html`, bugs à surveiller.

## Conventions de travail

- **Langue** : tout est en français — code, commentaires, narrations, UI, ce document. Réponds en français.
- **Architecture serveur modulaire** : la logique est éclatée en 7 modules (`state.js`, `narration.js`, `council.js`, `roles.js`, `phases.js`, `votes.js`, `lights.js`) + un `server.js` bootstrap. Voir la "Carte du code" de `HANDOFF.md` pour savoir où vit chaque fonction.
- **Avant toute modification serveur** : repérer le module concerné via la Carte du code, puis `Grep` sur le nom de fonction pour confirmer la ligne. Les modules sont petits (200-900 lignes) donc une lecture ciblée suffit.
- **`public/index.html` (~2200 lignes) et `public/mj.html` (~1240 lignes)** : à lire par portions avec `offset`/`limit`, ou cibler via `Grep`.
- **Convention `state.js`** : ne JAMAIS faire `const { players } = state` au top d'un module — toujours accéder via `state.players` pour conserver la mutabilité partagée.
- **Après toute modification** : exécuter `node --check <fichier-modifié>.js` pour valider la syntaxe.
- **Ne jamais bloquer le moteur de jeu** sur des appels externes (cf. pattern fire-and-forget de `lights.js` : timeout court, pas d'`await`, pas de `throw`).

## Avant de proposer une fonctionnalité

Passe-la au filtre de `CONTEXT.md` :
1. Est-ce que ça aide les joueurs à passer un bon moment ?
2. Est-ce que ça renforce l'immersion ?
3. Est-ce que ça tient pour un public d'inconnus ?
4. Est-ce maintenable en temps libre ?

Si tu hésites sur une priorité ou une direction, **demande** plutôt que de partir tête baissée.

## Mise à jour de la documentation

Quand une modification significative est apportée au code, **mets à jour `HANDOFF.md`** (section "Modifications récentes") dans le même mouvement. Quand la vision ou le public évolue, mets à jour `CONTEXT.md`.
