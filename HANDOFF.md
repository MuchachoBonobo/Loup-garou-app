# Handoff — LoupGarouVoteApp

Document de reprise pour continuer ce projet dans une nouvelle conversation.

## Vue d'ensemble du projet

Application web de Loup-Garou (party game) avec :
- Serveur Node.js + Express + Socket.io, port 3000
- Architecture **modulaire** côté serveur : `server.js` n'est qu'un bootstrap (Express + Socket.io + câblage des handlers). Toute la logique métier vit dans 7 modules (voir Carte du code plus bas) : `state.js`, `narration.js`, `council.js`, `roles.js`, `phases.js`, `votes.js`, `lights.js`.
- Interface joueur : `public/index.html` (~2200 lignes)
- Interface Maître du Jeu (MJ) : `public/mj.html` (~1240 lignes)
- CSS extraits : `public/css/player.css` et `public/css/mj.css`
- Sons : `public/sounds/*.mp3`
- Localisation : `C:\Users\alexa\OneDrive\Documents\LoupGarouVoteApp`
- Démarrage : `node server.js` puis ouvrir `http://<ip>:3000/` (joueurs) et `http://<ip>:3000/mj` ou `http://<ip>:3000/mj.html` (MJ).

## Fonctionnalités majeures déjà implémentées

- Rôles : Loup, Villageois, Voyante, Sorcière, Cupidon, Chasseur, Petite Fille, Idiot, Corbeau, Salvateur, Sœurs jumelles.
- Vote du maire, élection avec arbitrage, transfert d'écharpe à la mort du maire.
- Phase Mission (3 envoyés choisis par le maire, cartes secrètes Réussite/Échec, bonus d'inspection si succès).
- Phases de nuit : Cupidon → Loups → Voyante → Corbeau → Sorcière, avec timeouts d'inactivité.
- Phases jour : 4 modes de vote (1=ouvert, 2=verrouillé, 4=10s, 5=anonyme) + tiebreak par le maire.
- Mode entraînement (bots niveau 2 : aléatoire cohérent).
- Mode autonome (la partie tourne seule après le start, sans MJ).
- Conseil des Morts : les morts votent un événement (19 disponibles : Émeute, Jugement, Panique, Paranoïa, Folie, Éclipse, Tempête, Brouillard, Incendie, Chuchotements, Tribunal, Mauvais Présage, Cloche, Dernières Volontés, Vent, Murmures, Vote Muet, Voix Étouffées, Abdication). Une seule séance par partie, à partir de ≤6 vivants. Effet appliqué le jour suivant.
- Narration vocale (TTS Web Speech) côté MJ avec dictionnaire de variantes par transition de phase.
- Bouton Pause MJ, Wake Lock écran, vibrations jour, PWA tags, plein écran.
- Gestion robuste : timeouts chasseur/transfert maire, validation config, anti double-clic "Terminer", rate-limit votes, registre de reconnexion.

## Modifications récentes (à connaître pour reprendre)

### UX vote du jour + battement de cœur (mai 2026) (`public/index.html`, `public/css/player.css`)

**Battement de cœur renforcé** : animation `heartbeatPulse` plus ample (scale 1.4 au lieu de 1.15, cycle 0.65s), `bgPulse` plus rouge (`#280404`). À l'entrée des 10 dernières secondes, une vibration unique `[120,80,120,80,200]` est déclenchée via `vibrateIfDay` (flag `_heartbeatVibrated` resetté à chaque `startCountdown`/`stopCountdown`).

**Checkmark de vote** : nouvelle variable `myDayVote` (id de la cible courante). Dans `render()`, si `myDayVote===p.id` → affiche `<span class="voted-check">✅</span>` ; sinon affiche le bouton Voter (ou rien si verrouillé). Changer de vote déplace le check automatiquement. Resets : `voteStarted`, `voteTimerEnd`, `gameReset`. Restauration depuis `votesDayDetail[socket.id]` au `votesDayPublic` (reconnexion mode 1). Mode 5 (anonyme) : `myDayVote` posé localement au moment du clic, non transmis aux autres.

### Bug fix — Cascade nuit, écran débat post-transfert jour, carte médailles personnelle (mai 2026) (`roles.js`, `public/mj.html`, `public/index.html`)

**Bug A — Nuit lancée automatiquement après cascade première nuit** (`roles.js`)
Scénario : Chasseur tue le Maire (Chasseur tirant en phase `chasseur`). Si la cible du Chasseur est un amant de Cupidon dont le partenaire est le Maire, le bloc amants `killPlayer` (ligne ~406) calculait `mayorTransferContext = "day"` au lieu de `"chasseur"` car la phase `"chasseur"` n'était pas dans la liste `nightP`.
**Fix 1** : ce bloc utilise désormais le même calcul que les autres blocs : `state.phase === "chasseur" ? (chasseurPostContext==="day" ? "chasseurFromDay" : "chasseur") : nightP.includes(state.phase) ? "night" : "day"`.
**Fix 2** : dans `performMayorTransfer()`, le `else` final (fallback pour ctx inconnus/vides) n'appelle plus `startNightSequence()` mais `phases.setPhase("day")`. Le `ctx === "day"` est rendu explicite (`else if`).

**Bug B — Écran de débat absent après transfert de maire en cours de journée** (`public/mj.html`)
Cause : `dayVoteResult` déclenche `showDeathCard()` côté joueur (5 s auto-close). Si le MJ cliquait "Lancer le vote" avant la fermeture de la carte (5,6 s), `currentVoteMode` passait à non-zéro et `updateDayDebateScreen()` ne s'affichait jamais.
**Fix** : dans le handler `dayVoteResult` du MJ, `_mjLaunchVoteUnlocksAt = Date.now() + 6500` est posé (5 s carte + 0,6 s fermeture + 0,9 s tampon).

**Feature — Carte médailles personnelle en fin de partie** (`public/index.html`)
L'ancienne `showChronique()` (Chronique du Village) est remplacée par `showPersonalBadgeCard()`. La carte affiche uniquement les médailles gagnées par le joueur courant (lookup dans `summary.badges[myName]`). Si aucune médaille → aucune carte affichée.

### Bug fix — Vote prématuré + tooltips médailles (mai 2026) (`public/mj.html`, `public/index.html`)

**Bug 3 — Écran de débat absent si le MJ lance le vote dans les 9 premières secondes après l'aube** (`public/mj.html`)
Cause : les joueurs voient la `dayDeathCard` pendant 7 s (auto-close). Si le MJ clique "Lancer le vote" pendant cette fenêtre, `voteStarted` arrive et pose `currentVoteMode !== 0`. Quand la `dayDeathCard` se ferme, `updateDayDebateScreen()` vérifie `!voteRunning` → false → écran de débat jamais affiché.
**Fix** : nouveau flag `_mjLaunchVoteUnlocksAt` posé à `Date.now() + 9000` dans le handler `dawnResult`. Dans `launchVote()`, si `Date.now() < _mjLaunchVoteUnlocksAt`, un message d'attente est affiché via `showAlert` et l'emit est bloqué (9 s = 7 s carte aube + 0,6 s fermeture + 1,4 s tampon).

**Feature — Médailles cliquables avec description** (`public/index.html`)
Au clic sur un badge dans `#endBadgesPanel`, un texte explicatif (champ `desc` de `badges.js`) apparaît/disparaît sous le chip. La description est rendue dans un `<span>` caché à l'intérieur du chip ; l'`onclick` bascule `display:none ↔ block`.

### Bug fix — Musique de nuit et voile Cupidon (mai 2026) (`public/mj.html`, `public/index.html`)

**Bug 1 — Musique de nuit pendant mayorTransfer en contexte jour** (`public/mj.html`)
Quand la sorcière-maire se sauve la nuit, tue le chasseur avec la potion de mort, et que le chasseur tire sur le maire à l'aube, les phases `chasseur` puis `mayorTransfer` déclenchaient `playAmbiance("night")` même si `dawnResult` venait de passer en musique de jour.
**Fix** : nouveau flag `_mjDawnContext` (false par défaut). Posé à `true` dans le handler `dawnResult` quand `playAmbiance("day")` est joué. Effacé à l'entrée des vraies phases de nuit (`cupid`, `wolves`, etc.). Pour `chasseur` et `mayorTransfer`, la musique de nuit n'est jouée que si `!_mjDawnContext`.

**Bug 2 — Voile « garde les yeux fermés » absent pendant la phase Cupidon** (`public/index.html`)
La 1ʳᵉ nuit, le voile n'apparaissait pas pendant la phase Cupidon. Cause double :
- `showNightFallCard()` n'était pas appelé à l'entrée de `cupid` (liste line 1673 excluait `cupid`).
- La callback de fermeture de la carte Maire (`showMayorCard`) ne rappelait pas `showNightFallCard()` pour `cupid` (liste line 728 excluait `cupid`).
**Fix** : `cupid` ajouté aux deux listes. Le guard `mayorCard.hasAttribute("data-open")` dans `showNightFallCard` gère proprement la séquence : appel immédiat retourné (carte encore ouverte) → la callback de fermeture de la carte Maire (~5 s après l'élection) appelle `showNightFallCard()` → le voile apparaît. Le serveur attendait déjà `nightCardShown` pendant la phase `cupid` (server.js ligne ~393).

### Lumières — refonte complète + UX + intro gothic (session mai 2026) (`lights.js`, `lights-scenes.json`, `roles.js`, `votes.js`, `council.js`, `phases.js`, `snapshot.js`, `public/index.html`, `public/css/player.css`)

**`flashSequence(key, count)`** — nouvelle fonction dans `lights.js` qui programme N flashes non-interférents avec un gap de 400 ms. Elle appelle `stopEffect()` une seule fois (évite l'annulation mutuelle quand N `flash()` seraient appelés successivement pour plusieurs morts). Exportée dans `module.exports`.

**Timing des flashs — morts de nuit** : `flash.death` retiré de `killPlayer` (exécuté pendant la nuit, invisible aux joueurs). Repositionné sur `dawnResult` (révélation à l'aube) : `flashSequence("flash.death", deaths.length)`. Si plusieurs morts + résultat de mission à révéler, le flash mission arrive après `deaths.length × 750 ms`. Si aucune mort → `flash.dawn` (aube tranquille).

**Timing des flashs — vote du jour** : `flash.death` ajouté au `setTimeout` t=2700ms dans les 4 chemins de résolution (`botMayorTiebreak`, `finishDayTiebreak`, `resolveDayVote`, `handleTiebreakChoice`) — synchronisé avec `soundPlay("death")` et `dayVoteResult`. Pas à t=8200ms (`killPlayer`), invisible car trop tard.

**Nouveaux flash / scènes** dans `lights-scenes.json` :
- `flash.wolves` : éclat rouge vif (xy 0.68/0.29, bri 254, 300ms) — loups verrouillent leur proie
- `flash.idiot` : double éclat jaune (bri 230, 300ms, repeat 2) — l'Idiot est révélé
- `flash.dawn` : lumière dorée douce (bri 200, 700ms) — aube sans mort
- `pause` : scène très sombre (bri 6, transition 800ms) — lumière atténuée pendant pause MJ
- `flash.death` : corrigé `duration 220 repeat 4` → `350 repeat 1` (un flash net au lieu de 4 micro-flashs qui s'annulent)

**Nouveaux points de déclenchement** :
- `votes.js performLockWolfVotes` → `flash.wolves`
- `votes.js performLockMayorVote` → `flash.bell` + délai 5s avant transition de phase (laisse le MJ annoncer le maire). Guard `if (state.phase !== "mayorVote") return` dans le `setTimeout`.
- `votes.js handleIdiotDayVoteSurvival` → `flash.idiot`
- `votes.js` résolution vote (4 chemins) → `flash.death` à t=2700ms
- `roles.js handleChasseurChoice` → `flash.death` (tir du chasseur)
- `roles.js performMayorTransfer` → `flash.bell`
- `roles.js dawnResult` → `flashSequence("flash.death", N)` ou `flash.dawn`
- `council.js applyAbdication` → `flash.bell`
- `phases.js pauseGame` → `applyScene("pause")`
- `phases.js resumeGame` → `applyScene(state.phase)` (retour à la scène de la phase courante)

**UX — surbrillance des lignes actionnables** (`public/index.html`, `public/css/player.css`) : `render()` pose un flag `hasActiveBtn` (vrai seulement si un bouton non-disabled existe pour ce joueur). Classe `.actionable-row` ajoutée à la `player-row` → bordure + fond or translucide. Les boutons disabled (mode 2 verrouillé, émeute verrouillée, idiot survivant) ne déclenchent pas la surbrillance.

**Écran d'intro gothic** (`public/index.html`) : `#introScreen` plein écran au premier chargement — lune animée, emoji loup, silhouette village (🌲🏚️🌲), titre « Loup-Garou », sous-titre « Le village dort… ». Disparaît au toucher, après 6 s, ou immédiatement si `localStorage.lgName` présent (reconnecteur). CSS dans `<style>`, HTML avant `#endCard`, JS en IIFE après `const socket = io()`. Appelé aussi dans le handler `reconnected` pour les reconnecteurs.

**Avatars joueurs** (`public/index.html`, `render()`) : fonction `playerAvatar(p, size)` — `<img>` ronde si photo disponible, sinon cercle initiale/couleur déterministe (palette `AVATAR_PALETTE` de 8 couleurs, hash sur `p.name`). Injecté en premier flex-child de chaque `player-row` dans `render()`.

**Nettoyage automatique des crash-snapshots** (`snapshot.js`) : `cleanOldCrashes(maxAgeDays=7)` parcourt `snapshots/crash-*.json` et supprime les fichiers dont le `mtime` dépasse le seuil. Appelé automatiquement dans `startPeriodicSave` (donc au boot). Exporté pour usage manuel si besoin.

**Git & GitHub** : dépôt initialisé dans `C:\LoupGarouVoteApp`, branch `master` poussée sur `https://github.com/MuchachoBonobo/Loup-garou-app`. `.gitignore` enrichi : `*.bak`, `.claude/`. Note : `day.mp3` (83 MB) et `night.mp3` (86 MB) dépassent la recommandation GitHub 50 MB mais sont sous la limite dure de 100 MB — push accepté avec avertissement.

### Robustesse + UX — Session mai 2026 (`server.js`, `council.js`, `state.js`, `snapshot.js`, `public/index.html`, `public/mj.html`)

**Reconnexion — IDs manquants** (`server.js`, handler `register`) : trois champs d'état n'étaient pas migrés lors du changement de socket ID : `state.protectedTarget`, `state.lastProtectedTarget`, `state.pendingChasseurAfterTransfer`. Un joueur qui reconnectait pendant la phase `salvateur` (ou juste après) pouvait ne plus être la cible protégée. `state.wolfConfirmed` (Set) était aussi ignoré. Les quatre migrations sont maintenant présentes dans le handler `register` après les migrations existantes.

**Reconnexion — Mission en cours** (`server.js`, handler `register`) : un joueur qui reconnectait pendant la phase `missionVote` ne recevait pas `missionCardChoice` — il voyait un écran vide et ne pouvait pas voter. Ajout d'un re-emit ciblé `missionCardChoice` si `state.phase === "missionVote" && state.mission.team.includes(socket.id) && !state.mission.cards[socket.id]`.

**Reconnexion MJ — Cible nuit** (`server.js`, `public/mj.html`) : si le MJ se déconnecte après la phase `wolves` (pendant `seer`, `corbeau` ou `witch`), il ne savait pas qui avait été ciblé. `nightTarget` est maintenant inclus dans le payload `mjReconnected`. La mj.html le lit et : affiche un bandeau d'alerte (`showAlert`) + injecte le nom dans `#wolfVotes` (visible dès que la section loups est réouverte).

**Conseil des Morts — 2ème cycle** (`council.js`) : quand tous les évènements du pool ont été proposés, `pickRandomCouncilOptions` réinitialisait silencieusement. Il logue maintenant un message et émet une notification MJ : « 👻 Le Conseil reprend — les esprits ont épuisé leurs requêtes ».

**Dead code `councilEverTriggered`** supprimé (`state.js`, `phases.js`, `snapshot.js`) : ce flag était initialisé à `false` mais jamais mis à `true` ni lu pour décision de jeu. Retiré des trois fichiers.

**Écran d'intro gothic** (`public/index.html`) : nouvel `#introScreen` plein écran affiché au premier chargement (lune animée, emoji loup, titre LOUP-GAROU). Disparaît au toucher, après 6 secondes, ou immédiatement pour les reconnecteurs (`localStorage.lgName` présent). CSS dans `<style>`, HTML avant `#endCard`, JS en IIFE au démarrage.

**Avatars dans la liste joueurs** (`public/index.html`, `render()`) : nouvelle fonction `playerAvatar(p, size)` — retourne une `<img>` ronde si le joueur a une photo, sinon un cercle initiale/couleur déterministe (palette de 8). Injecté en premier flex-child de chaque `player-row` dans `render()`.

### Bug fixes — Audit serveur (mai 2026) (`roles.js`, `phases.js`, `votes.js`, `state.js`)

Quatre corrections issues d'un audit complet des chemins d'état :

**Guard `doResolveNight`** (`roles.js`) : si deux handlers nuit (ex. `witchDone` + `resolveNight` MJ) arrivent dans le même tick Node.js, seul le premier s'exécute. Ajout de `if (state.inNightResolution) return;` au début de `doResolveNight` — `inNightResolution` étant déjà posé à `true` par la résolution en cours, le second appel est écarté sans effet de bord.

**`corbeauTarget` au skip de jour** (`votes.js`, `handleSkipDayVote`) : quand le MJ skippe le vote du jour, `state.corbeauTarget` n'était pas remis à `null`. Au jour suivant, `setPhase("day")` le réémet en `corbeauVotesPublic` et `resolveDayVote` injecte deux votes fantômes sur une cible obsolète. Ajout de `state.corbeauTarget = null` dans `handleSkipDayVote`.

**`tiebreakTimeout` invisible au reset** (`votes.js`, `phases.js`) : le timeout de 30 s du tiebreak était une variable locale au module `votes.js`, inatteignable de `resetGameState`. Si la partie était réinitialisée pendant un tiebreak en cours, le timeout pouvait se déclencher dans la nouvelle partie. Nouvelle fonction exportée `clearTiebreakTimeout()` dans `votes.js` ; appelée depuis `resetGameState` à la place des trois lignes d'état direct.

**Timeout de la Voyante** (`state.js`, `roles.js`, `phases.js`) : la phase `seer` était la seule phase de nuit sans timeout — si la Voyante se déconnectait, la partie restait bloquée. Ajout de `SEER_TIMEOUT_MS = 45000` (constante dans `state.js`), `seerTimeout: null` (champ d'état), et du bloc timeout dans `installPhaseTimeouts`. Le timeout auto-avance vers `corbeau`, `witch` ou `doResolveNight` selon `nextNightPhase`. `clearPhaseTimeouts` et `resetGameState` nettoient le timer. L'appel `clearTimeout(state.witchTimeout)` dans `handleSeerChoice` et le bot voyante était sémantiquement faux (witchTimeout est null pendant seer — fonctionnait par accident) ; corrigé en `state.seerTimeout`.

### Bug fix — Successeurs du maire : exclure les joueurs morts simultanément (mai 2026) (`roles.js`, `public/index.html`)

**Problème** : quand les loups tuaient le **maire** ET que la **sorcière** tuait un autre joueur la même nuit, la boucle `doResolveNight` se cassait dès que `killPlayer(maire)` passait la phase en `mayorTransfer`. La cible de la sorcière n'était donc jamais ajoutée à `state.deadPlayers`. Elle apparaissait à tort dans la liste des successeurs potentiels côté client (et le serveur l'acceptait comme successeur valide).

**Fix serveur** (`roles.js`, `doResolveNight`) : après la boucle principale des `deaths`, si `state.phase === "mayorTransfer"`, un second parcours traite les morts restantes non encore dans `deadPlayers`. Un mort ordinaire est passé à `killPlayer()`. Un chasseur est ajouté manuellement à `deadPlayers` (avec émission `deadPlayers` + `playerDied`) et mémorisé dans `state.pendingChasseurAfterTransfer` pour tirer après le transfert.

**Fix client** (`public/index.html`, handler `mayorMustTransfer`) : le code de construction des boutons est extrait dans une fonction `buildMayorTransferButtons()`. Elle est appelée à l'arrivée de `mayorMustTransfer` (best-effort) ET dans `openTransferPanel()` (juste avant l'ouverture réelle du panneau). Le panneau n'ouvre qu'après la carte d'aube (plusieurs secondes), ce qui laisse le temps au `deadPlayers` mis à jour d'arriver — au moment où le panneau s'ouvre, les boutons sont reconstruits avec la liste fraîche.

### Bug fix — Maire mourant + Chasseur amoureux (mai 2026) (`roles.js`, `state.js`, `phases.js`, `public/index.html`)

Deux bugs dans les scénarios impliquant mort du maire et/ou chasseur.

**Bug A (critique, serveur)** — `roles.js` `killPlayer`, bloc amoureux `else if (isMayorDying)` :
Quand le **maire** meurt et que son **amoureux est le chasseur** (deux personnes distinctes), le code appelait `setPhase("chasseur")` alors que `majorTransferPending = true`. `performMayorTransfer` refusait donc le transfert (`state.phase !== "mayorTransfer"`) et, côté client, `phase:"chasseur"` fermait le `tiebreakPanel` du maire mourant — qui restait bloqué sans pouvoir transférer l'écharpe.

Fix : le bloc `else if (isMayorDying)` pose maintenant `state.pendingChasseurAfterTransfer = partner` et appelle `setPhase("mayorTransfer")` (avec `return` pour ne pas tomber dans le bloc chasseur). Dans `performMayorTransfer`, après le transfert, si `pendingChasseurAfterTransfer` est non-null, on émet `chasseurMustShoot` et on passe en phase `chasseur`. Nouvelle variable `pendingChasseurAfterTransfer` initialisée à `null` dans `state.js` et réinitialisée dans `resetGameState` (`phases.js`).

**Bug B (client, visuel)** — `public/index.html` `dawnResult`, bloc `else if (mayorTransferPending)` :
`_dawnOnClose` rouvrait le `tiebreakPanel` (panneau de transfert du maire) pour **tous** les joueurs après la fermeture de la carte d'aube, pas seulement pour le maire mourant. Les autres voyaient un panneau "⚖️ Égalité — Le Maire doit trancher !" vide.

Fix : nouveau flag global `dyingMayorId` (posé dans `mayorMustTransfer`, remis à `null` dans `mayorTransferred` et `gameReset`). Le `_dawnOnClose` ne rouvre le panel que si `socket.id === dyingMayorId`.

**Suppression de la carte "village s'endort"** — `public/index.html` :
`showNightFallCard()` n'affiche plus la carte plein écran. Elle émet toujours `nightCardShown` (requis par le serveur) et appelle `updateNightCover()`, mais sans ouvrir la carte ni poser de timer de fermeture.

### Cloche au lancement du vote + vibrations des moments-clés du jour (mai 2026)
Renforcement du signal « c'est à toi de regarder l'écran » — sans temps d'écran inutile.

- **Son de cloche** (`public/mj.html`) : `launchVote()` joue désormais `playEffect("church_bell")`. Quand le MJ lance le vote du jour, la cloche du village sonne sur la tablette MJ (source sonore centrale de la table).
- **Vibrations de jour** (`public/index.html`) : le téléphone du joueur concerné vibre à chaque moment où il doit agir **de jour** — jamais la nuit (une vibration dans le silence donnerait une info aux voisins). Couvert :
  - Vote du jour / élection du Maire — déjà géré (`voteStarted`).
  - Le Maire doit trancher une égalité (`tiebreakMayor`).
  - Le Chasseur doit tirer (`chasseurMustShoot`) — uniquement si la mort survient de jour.
  - Le Maire mourant désigne son successeur (`mayorMustTransfer`) — uniquement de jour.
  - Le Maire abdique (évènement Conseil `mayorMustAbdicate`) — de jour.
- Nouvelles fonctions : `vibrateNow(pattern)` (vibration brute, sans garde de phase) et `isDayContext()`. Le Chasseur et le transfert d'écharpe ont leur propre phase (`chasseur`, `mayorTransfer`) qui n'est pas `day` ; `isDayContext()` s'appuie sur la nouvelle variable `_prevPhase` (phase précédente, mémorisée dans le handler `phase`) pour distinguer une mort de jour d'une mort de nuit. `vibrateIfDay()` reste la garde standard (refus si phase de nuit).

### Épuration du cockpit MJ — affichage contextuel à la phase (mai 2026)
Suite de la refonte « app au service du jeu », côté MJ (`public/mj.html`). Objectif : le MJ a l'information nécessaire en un coup d'œil, sans scroller ni chercher — moins il cherche, plus il porte l'immersion. Aucune logique de jeu touchée.

Nouvelle fonction **`updateMJLayout(phase)`** (près de `updateNightBar`) qui affiche/masque les grandes sections selon la phase. Appelée depuis le handler socket `phase`, `mjReconnected`, `gameReset`, et une fois à l'init (`updateMJLayout("lobby")` juste après sa définition).

- **Toujours visibles** : ③ Personnages (rôle + état vivant/mort), Sons & ambiance, Info live (Morts + Joueurs), cheat sheet, barres de phase nuit/mission.
- **Lobby uniquement** : `mjSectionStart` (config des rôles, mode autonome, pilotage MJ, bots), `mjSectionQR` (QR code de connexion).
- **En partie uniquement** (`phase !== "lobby"`) : `mjSectionUrgency` (contrôles manuels d'urgence), `mjSectionDeadChat` (chat des morts).
- **Strictement contextuel à la phase** : `mjSectionWolves` (phase `wolves`), `mjSectionMayor` (phase `mayorVote`), `mjSectionDay` (phase `day`).

**Restructuration HTML** : la section ③ « Rôles attribués » est sortie du `grid2` qu'elle partageait avec les votes loups — désormais pleine largeur (`id="mjSectionRoles"`), renommée « Personnages — rôle & état ». Les votes loups deviennent une section autonome `mjSectionWolves`. Les préfixes numériques ①–⑥ des titres de sections ont été retirés (ils impliquaient un ordre fixe que l'affichage contextuel ne respecte plus). Nouveaux id : `mjSectionStart`, `mjSectionUrgency`, `mjSectionRoles`, `mjSectionWolves`, `mjSectionMayor`, `mjSectionDay`, `mjSectionDeadChat`, `mjSectionQR`.

⚠ Validation : le mount Linux (OneDrive) servait encore une copie tronquée de `mj.html` — `node --check` direct y échoue à tort (cf. note plus bas). Le JS inline a été validé en reconstruisant le fichier complet hors OneDrive (syntaxe OK) ; fichier hôte vérifié intact (1681 lignes, ferme bien `</script></body></html>`).

### Épuration de l'UI joueur — bandeaux redondants retirés (mai 2026)
Suite de la refonte « app au service du jeu » : suppression, côté joueur (`public/index.html`, `public/css/player.css`), des éléments d'écran qui re-narrent ce que le MJ dit déjà à voix haute, ou qui font doublon. Aucune logique de jeu touchée.

- **`#narrativeBanner` + dico `PHASE_NARR` + fonction `setBanner`** supprimés. L'app ne re-narre plus par écrit chaque transition de phase (« ☀️ Le village se réveille », « 🌙 La nuit tombe »…). Tous les appels `setBanner()` retirés (handlers `phase`, `daySkipped`, carte d'aube `dawnResult`, `gameReset`).
- **`#phaseLabel`** supprimé : div + fonction `phaseLabel()` + les 2 assignations `innerText` (handlers `fullState` et `phase`). Le nom de la phase n'est plus affiché en permanence — le voile de nuit, l'écran de débat et la voix du MJ le portent déjà. L'attribut `body[data-phase]` (teinte ambiante `--phase-tint`) est **conservé**.
- **`#cycleCounter`** supprimé : div + handler socket `gameCycle` + les mises à `display:none`. Le décompte « Jour X · Nuit Y » est énoncé naturellement par le MJ. Le serveur émet toujours `gameCycle` — sans conséquence, plus aucun listener côté joueur.
- **`#deadBanner`** supprimé : son texte était devenu faux depuis l'étape 6 de la refonte (« vision spectateur complète » alors que `sendDeadVision` fait un `return` anticipé). Le `#deadFullScreen` épuré recouvre déjà l'écran du mort.
- **Pastille `(N✉️)`** retirée à côté des noms pendant le vote du jour dans `render()` — doublon exact du `#votesPanel`. La pastille équivalente du vote du Maire (visible des seuls morts) est **conservée** (hors périmètre).
- CSS orphelin retiré de `player.css` : `#deadBanner`, `#cycleCounter` (+ `.dp`/`.np`), `#narrativeBanner`.

Validation : `node --check` non applicable (HTML) ; le bloc `<script>` inline d'`index.html` a été extrait et vérifié syntaxiquement (OK). **Reste à faire** : même épuration côté MJ (`mj.html`).

### Ajustements post-playtest #3 (mai 2026)
Troisième lot après test.

**Voile « garde les yeux fermés » dès le début de la nuit** (`public/index.html`)
Le voile (`nightCoverScreen`) n'apparaissait qu'après le tour du Salvateur. Cause : `showNightFallCard` n'était appelé qu'en phase `cupid`/`wolves`, et le voile était bloqué tant que la `nightFallCard` était ouverte (pas d'auto-close). Corrections : `showNightFallCard()` est appelé à l'entrée de TOUTE phase de nuit (le garde `nightCardShownThisNight` la limite à 1×/nuit) ; la `nightFallCard` a maintenant une fermeture auto à 3,5 s ; `updateNightCover()` est ré-appelé à chaque `render()`.

**Les morts ne voient plus la carte « la nuit tombe »** : `showNightFallCard` fait un `return` anticipé si `iAmDead`.

**Carte évènement Conseil — règle explicite côté MJ** (`public/mj.html`)
La carte `councilEventCard` du MJ a un nouvel encadré « 📋 Règle à appliquer » rempli depuis le dictionnaire `MJ_EVENT_RULES` (19 évènements, règle explicite chacun). Fonction `showMjCouncilEventCard(data)`. `councilResolvedMJ` l'utilise aussi.

**Séquencement des cartes de début de jour** (`public/index.html`, `public/mj.html`)
Au début du jour : carte récap de nuit d'abord, carte évènement ENSUITE. Côté joueur : `councilEventActive` met l'évènement en file (`_pendingCouncilEventData`) si la `dayDeathCard` est ouverte ; `closeDawnCard` l'affiche via `showCouncilEventCardNow`. Côté MJ : idem avec `_mjPendingCouncilEvent` / `closeDayRecapCard`. La carte `mjDayRecap` ne contient plus le bloc « Hier, le village… » (déjà narré via `mjVoteDeathCard` au moment du vote).

**Mort du Chasseur visible par le MJ** (`roles.js`, `public/mj.html`)
`performChasseurShot` émet `mjChasseurShot` (`shooterName`, `targetName`, `targetRole`). Côté MJ, la carte `mjVoteDeathCard` est devenue générique (`showMjDeathCard(emoji, subtitle, name, role, narrative)`) — utilisée pour le vote du jour ET le tir du Chasseur, avec emoji/sous-titre adaptés.

### Ajustements post-playtest #2 (mai 2026)
Second lot après test.

**Écran de mort rendu INCONDITIONNEL** (`public/index.html`)
Le joueur mort signalait voir encore la liste des joueurs + les boutons voter pendant le jour. `updateDeadFullScreen` ne dépend plus du flag `mjPilotedDay` (`show = iAmDead && !gameIsOver`) — idem `updateDeadVoteView`. Surtout, `updateDeadFullScreen()` et `updateDayDebateScreen()` sont désormais appelés **à la fin de `render()`** (donc à chaque changement d'état) en plus des hooks d'events : garantit qu'un mort ne voit jamais l'UI de jeu, de jour comme de nuit, même si un event a été manqué. La vue du vote (`deadVoteView`) reste affichée dans l'écran de mort pendant un vote. Le chat des morts reste toujours accessible (déplacé dans `deadFullScreen`).

**Carte évènement Conseil — joueurs : icône + titre seulement** (`public/index.html`)
La carte `councilEventCard` côté joueur masque le narratif (`councilEventNarrative` en `display:none`) — les joueurs voient l'icône 🪦 + le titre + « Le Maître du Jeu vous en expliquera la règle ». Le MJ garde le narratif complet (sa propre `councilEventCard` dans `mj.html`, inchangée).

**Écran de débat fiabilisé** : `updateDayDebateScreen()` appelé aussi depuis `render()` (l'écran ne s'affichait pas toujours les premiers jours).

### Ajustements post-playtest (mai 2026)
Lot d'ajustements après un premier test de la refonte épuration jour.

**Cartes de mort côté joueur → photos uniquement** (`public/index.html`, `public/mj.html`)
Les joueurs ne voient plus le rôle ni le récit des morts. `showDeathCard` (vote du jour) et le handler `dawnResult` (morts de la nuit) affichent désormais seulement les **photos** des défunts (via `renderDeathPhotos`, role retiré aussi de l'infobulle `title`) + un titre neutre. Les joueurs savent QUI est mort, pas son rôle. La liste des joueurs ne montre plus le rôle des morts (juste un ☠️ ; `deathInfo` épuré dans `render()`). Côté MJ : nouvelle carte plein écran `#mjVoteDeathCard` (nom + rôle + récit + TTS) affichée sur `dayVoteResult` pour que le MJ puisse narrer ; la nuit était déjà couverte par `mjDayRecap`.

**Carte « Découvre ton rôle » à retourner** (`public/index.html`)
Au lancement, le rôle n'apparaît plus directement. Nouvel overlay `#roleRevealCover` (z-index 10000) : une carte face cachée « Découvre ton rôle ». Le joueur la touche → flip 3D (`rotateY 180`, `transform-style:preserve-3d`) → révèle emoji + nom du rôle → bouton « Voir les détails » → ouvre la `roleCard` détaillée habituelle. Fonctions `showRoleReveal(r)` / `closeRoleReveal()`. Le handler `yourRole` appelle `showRoleReveal` au lieu de `showRoleCard`. Masqué à `gameReset`.

**Vibration au lancement** (`public/index.html`)
Le handler `yourRole` déclenche `navigator.vibrate([450,160,450,160,250])` pour alerter les joueurs distraits. Vibration courte additionnelle au retournement de la carte.

**Vue QR code plein écran MJ** (`public/mj.html`)
Bouton « 📺 Afficher le QR en grand » + overlay `#qrFullscreen` (z-index 10000) : uniquement un grand QR (300px) + URL + rappel « 🔇 mettez vos téléphones en silencieux ». Fonctions `showQRFullscreen()` / `closeQRFullscreen()`. L'URL est mémorisée dans `_gameJoinUrl` au boot (`initQR`).

**Conseil des Morts — condition de déclenchement** (`phases.js`)
Le Conseil se déclenche chaque début de journée dès qu'au moins 2 joueurs sont morts (`state.deadPlayers.length >= 2`), quelle que soit la taille initiale de la partie. `COUNCIL_TRIGGER_THRESHOLD = 6` est défini dans `council.js` comme constante sémantique mais n'est pas utilisé comme condition de déclenchement dans `phases.js`. Les options déjà proposées (choisies ou non) ne réapparaissent pas grâce à `councilUsedEvents`.

**Bug corrigé — Idiot du village & arbitrage d'égalité** (`votes.js`)
L'Idiot survit au vote du village mais doit mourir de toute autre cause. La survie n'était gérée que dans le chemin de résolution normal (`resolveDayVote`) ; les deux chemins de tiebreak (`handleTiebreakChoice` arbitrage maire, `maybeRunBotForTiebreak` arbitrage maire-bot) tuaient l'Idiot directement. Extraction d'un helper `handleIdiotDayVoteSurvival(victimId)` appelé par les 3 chemins → l'Idiot survit à TOUT vote du village (égalité comprise). Loups / sorcière / chasseur / chagrin d'amour passent par `killPlayer` sans exception → l'Idiot meurt normalement.

**⚠ Note importante sur le test** : si après une mise à jour le vote redémarre tout seul et/ou les morts revoient la vision complète, c'est que le processus `node server.js` n'a pas été relancé — Node garde les anciens modules en mémoire. **Toujours arrêter (Ctrl+C) et relancer `node server.js`** après modification du code serveur, et rafraîchir les navigateurs (cache).

### Refonte épuration jour — étapes 1 à 4 (mai 2026) — EN COURS
**Contexte** : prise de conscience produit qu'aujourd'hui les joueurs passent ~80 % du temps de la phase jour à regarder leur écran (vote auto-démarré, timer visible, panneau de votes live). Cela casse l'expérience sociale en présentiel : les joueurs fuient le contact visuel dans leur téléphone, ce qui se propage par mimétisme à toute la table. Objectif : recentrer le jour autour de la narration du MJ, l'app n'étant qu'un outil de service (carte d'aube + écran de débat épuré + vote rapide quand le MJ le lance). La nuit reste inchangée. Plan en 8 étapes ; les étapes 1 à 4 ci-dessous sont implémentées, les étapes 5 à 8 (écran de débat dédié, refonte vue des morts, cockpit MJ enrichi, playtest, nettoyage) restent à faire.

**Étape 1 — Marquage de la frontière nuit/jour** (`phases.js`)
Ajout de commentaires-blocs visuels `⚠ ZONE NUIT — NE PAS TOUCHER` au-dessus de `installPhaseTimeouts` et `runBotsForPhase` pour signaler les zones gelées pendant la refonte jour. Aucun changement de logique.

**Étape 2 — Flag `state.mjPilotedDay` + toggle MJ** (`state.js`, `roles.js`, `public/mj.html`)
Nouveau champ `state.mjPilotedDay: true` (default ON) dans `state.js`. **Non reset par `resetGameState`** — c'est une préférence persistante entre parties. `roles.js assignAndStart` lit `config.mjPilotedDay` quand fourni (sinon conserve la valeur existante). Côté `mj.html` : nouveau toggle ambre dans la config initiale ① (sous le bloc Mode autonome), texte explicite « les joueurs voient seulement une carte de jour puis un écran de débat épuré ». Propagation dans `startGame()` et `replayGame()`. Décocher → comportement classique (auto-vote 2 s, durée 200 s).

**Étape 3 — Désactivation de l'auto-démarrage du vote en mode piloté** (`phases.js`, `public/index.html`)
Le bloc `state.dayAutoStartTimer` dans `setPhase("day")` est désormais conditionné : `if (p === "day" && (state.autoMode || !state.mjPilotedDay))`. En mode piloté, seul le bouton MJ « 🚀 Lancer le vote » déclenche `votes.startDayVote(1)` via le handler `handleStartVote` existant. Côté joueur : le handler `socket.on("phase", "day")` n'ouvre plus `voteWaitBox` à l'aube — le `voteWaitBox` et le `voteTimerBox` restent cachés jusqu'à la réception de `voteStarted`. Cohérence avec la voie autonome préservée : si `autoMode=true`, l'auto-vote continue (la phase autonome vise par définition une partie sans MJ).

**Étape 4 — Durée mode 1 = 60 s + désactivation du sprint final en mode piloté** (`votes.js`, `phases.js`, `public/mj.html`)
`votes.js startDayVote` : `durations[1]` passe de 200 000 → 60 000 ms. Les modes 2 (Jugement, 200 s), 4 (Panique, 30 s), 5 (Émeute, 60 s) sont inchangés. L'effet battement de cœur des 10 dernières secondes (`startCountdown` côté joueur via la classe CSS `heartbeat` quand `rem<=10`) fonctionne tel quel — pas de modification nécessaire.
Sprint final (raccourcissement à 30 s quand tous ont voté) : désactivé en mode piloté MJ via `&& !state.mjPilotedDay` ajouté dans `votes.js handleVoteDay` et `phases.js runBotsForPhase` (le bloc bot du jour a son propre sprint dupliqué). En mode autonome il garde son comportement historique.
Labels MJ mis à jour dans `mj.html` : `voteModeLabel`, le label du mode 1 (60s au lieu de 200s), bouton « 🚀 Lancer le vote (60s) ».

**Étape 5 — Écran de débat épuré côté joueur** (`public/index.html`)
Nouveau div plein écran `#dayDebateScreen` (z-index 9000, fond doré chaud, soleil animé `ddSunBreathe`). Affiché aux joueurs **vivants** pendant la phase day quand aucune carte narrative n'est ouverte et qu'aucun vote n'est en cours. Contient : message « 👀 Regardez-vous, débattez ensemble », carte d'identité du joueur (photo + nom), bouton hold-to-reveal du rôle dédié (`#ddRoleRevealBtn` → `bindDayDebateRoleReveal()`, l'écran couvrant l'UI normale il faut son propre bouton), rappel « 📵 Posez le téléphone ».
Fonction centrale `updateDayDebateScreen()` : ouvre/ferme selon `phase==="day" && !iAmDead && !gameIsOver && currentVoteMode===0 && !isAnyNarrativeCardOpen()`. Branchée sur : handler `phase`, `closeDawnCard`, `closeCouncilEventCard`, `closeMissionExplainCard`, `voteStarted` (ferme), `deadPlayers`, `reconnected`, `gameReset` (ferme). Le handler `phase=day` n'ouvre plus `voteWaitBox`. `phaseLabel("day")` → « ☀️ Le jour — débat ». Reconnexion : `voteWaitBox` n'est plus forcé, `currentVoteMode` restauré depuis le snapshot, durées corrigées (`{1:60000,2:200000,4:30000,5:60000}`).

**Étape 6 — Refonte vue des morts épurée** (`roles.js`, `state.js`, `public/index.html`)
Les morts ne voient plus la vision spectateur complète pendant la partie, seulement un écran épuré « Vous êtes mort » + leur rôle en grand.
- `roles.js` : `yourRole` transmet désormais `mjPilotedDay` au client. `sendDeadVision()` fait un `return` anticipé si `state.mjPilotedDay` (plus d'émission `deadVision` en cours de partie). La révélation complète reste émise en fin de partie par `phases.js endGame` (emit `deadVision` direct — chemin distinct, inchangé).
- `state.js` : `buildFullState` ajoute `mjPilotedDay` au snapshot et n'inclut le bloc `deadVision` que si `!state.mjPilotedDay` (un mort qui reconnecte ne récupère plus la vision complète en mode piloté).
- `public/index.html` : nouveau `#deadFullScreen` plein écran (z-index 9100, sous les cartes narratives 9998 pour que la chronique d'aube reste visible). Header immersif (☠️ + « Vous êtes mort » + rôle en grand + photo). Au 1er appel de `updateDeadFullScreen()`, les panneaux `councilPanel` et `deadChatPanel` sont **déplacés** (`appendChild`) dans `#deadFullScreenSlot` — ils restent ainsi accessibles en scrollant, sans dupliquer de code (les handlers socket les ciblent par id, inchangés). Variable globale client `mjPilotedDay` (reçue via `yourRole`/`reconnected`). `updateDeadFullScreen()` branché sur `deadPlayers`, `reconnected`, `gameEnd` (masque), `gameReset` (masque). Le `deadVisionPanel` n'est plus ouvert en cours de partie ; à `endGame` il s'ouvre brièvement puis `gameEnd` le masque au profit de l'`endScreen`.

**Étape 7 — Cockpit MJ enrichi** (`public/mj.html`)
- Cheatsheet `MJ_CHEATSHEET.day` réécrite en 5 étapes claires (annoncer les morts → ouvrir le débat → laisser discuter → lancer le vote → la nuit revient seule). L'ancien texte « le vote démarre auto après 2 s » était devenu faux.
- Nouvel indicateur d'état `#dayStateBanner` dans la section ⑤ : bascule visuellement entre **🗣️ DÉBAT EN COURS** (ambre) et **🗳️ VOTE EN COURS** (rouge) via `refreshDayStateBanner()` + flag `mjVoteRunning`. Branché sur `phase`, `voteStarted`, `voteStartedMJ`, `voteTimerEnd`.
- Section ⑤ renommée « ⑤ Le Jour — Débat & Vote », bouton « 🚀 Lancer le vote (60s) », labels de durée corrigés (mode 1 = 60 s).

**Étape 8 — restante** : playtest IRL, mesure du temps écran joueur en journée, suppression du toggle + du flag si validé.

**À garder en tête** :
- La nuit (Sœurs, Salvateur, Loups, Voyante, Corbeau, Sorcière, Cupidon, Chasseur, Conseil des Morts) reste intouchée, conformément aux commentaires-blocs ajoutés.
- Le toggle MJ par défaut ON ; pour comparer avec l'ancien comportement, décocher avant de lancer la partie. En mode legacy (`mjPilotedDay=false`), `sendDeadVision` réémet la vision complète et l'ancien `deadVisionPanel` s'affiche normalement.
- Mode 2 (Jugement) volontairement conservé à 200 s : c'est un événement spécial du Conseil des Morts où chaque vote est verrouillé, la durée longue est intentionnelle pour permettre la délibération.
- Le `deadFullScreen` déplace `councilPanel` + `deadChatPanel` par `appendChild` au runtime : si on touche à ces panneaux, se souvenir qu'ils vivent désormais dans `#deadFullScreenSlot`.
- ⚠ Validation : le sandbox Linux (OneDrive) a servi des copies tronquées de `state.js`, `roles.js`, `public/index.html` pendant le développement — `node --check` y échouait à tort. Les fichiers Windows étaient corrects (vérifiés). **Toujours valider `node --check` côté Windows après modification.**

### Bug fix #1 — Voile de nuit n'écrase plus les cartes narratives (`public/index.html`)
**Symptôme** : pendant les phases de nuit, les joueurs non-actifs ne voyaient que le voile « Garde les yeux fermés » et jamais les cartes narratives (nightFallCard, dayDeathCard, councilEventCard, missionExplainCard). Cause : z-index du voile (99990) supérieur à celui des cartes (9998-9999).
**Fix** : `updateNightCover()` consulte désormais `isAnyNarrativeCardOpen()` qui vérifie l'état des cartes `roleCard`, `dayDeathCard`, `nightFallCard`, `councilEventCard`, `missionExplainCard`, `mayorCard`. Si une carte est affichée, le voile reste caché. À chaque ouverture/fermeture de carte, `updateNightCover()` est rappelé.

### Bug fix #2 — Carte chronique (dayDeathCard) ne s'affichait pas au début du jour (`public/index.html`)
**Symptôme** : à l'aube, la dayDeathCard s'ouvrait via `dawnResult` puis se fermait instantanément. `clearNightSecrets()` (appelé sur `socket.on("phase", "day")`) contenait un `closeDawnCard()` qui se déclenchait juste après l'ouverture (dawnResult est émis avant `setPhase("day")`).
**Fix** : retrait du `closeDawnCard()` de `clearNightSecrets()`. La carte a son propre timer d'auto-fermeture (7 s).

### Bug fix #3 — Victoire vérifiée avant la narration de la nuit (`votes.js`, `narration.js`)
**Symptôme** : la narration TTS « le village s'endort, les loups se réveillent » jouait sur le MJ avant l'annonce de la victoire quand le vote du jour scellait la fin de partie via un chemin tiebreak.
**Fix** : ajout d'un `if (phases.checkVictory()) return;` dans les deux chemins tiebreak (`resolveVoteWithTiebreak` callback + `handleTiebreakChoice`) avant `phases.setPhase("wolves")`. Garde supplémentaire dans `narration.narrate` : l'émission TTS dans le `setTimeout(900ms)` ne se déclenche plus si `state.phase` a changé entre-temps (cas où setPhase wolves est appelé puis setPhase lobby).

### Bug fix #4 — Le maire peut s'envoyer en mission (`roles.js`, `votes.js`)
**Symptôme** : le maire ne pouvait pas s'inclure parmi les 3 envoyés de la mission — utile pourtant pour qu'il vérifie s'il est loup en cas de réussite.
**Fix** : suppression du filtre `id !== state.mayor` côté validation serveur (`handleMissionTeamChoice` dans `roles.js`). La liste envoyée au maire au lancement de mission (`votes.js` autour de la ligne 67) inclut désormais le maire lui-même.

### Bug fix #5 — Carte chronique de nuit s'affiche AVANT l'écran de fin de partie (`state.js`, `phases.js`, `roles.js`)
**Symptôme** : quand une victoire se déclenchait après une nuit (loups éliminés / loups majoritaires), l'écran de fin de partie apparaissait avant que les joueurs aient pu voir la carte chronique expliquant ce qu'il s'était passé pendant la nuit.
**Fix** : nouveau flag `state.inNightResolution` posé à `true` au début de `doResolveNight` et à `false` à la fin. Quand `endGame()` est appelé pendant cette fenêtre, il diffère ses émissions (`gameSummary`, `gameEnd`, `setPhase("lobby")`) en stockant la fonction dans `state.pendingEndGame`. Une fois `doResolveNight` ayant émis `dawnResult` + posé `pendingDayRecap`, il déclenche `pendingEndGame` après un `setTimeout(7000ms)`, après avoir envoyé le récap MJ. Reset propre dans `resetGameState`.

### Amélioration #1 — Auto-close du vote du maire (`votes.js`)
`checkMayorAutoLock()` n'est plus conditionné au mode autonome — dès que tous les joueurs vivants ont voté, le vote du maire se verrouille automatiquement, en mode MJ comme en mode autonome. Le MJ n'a plus besoin de cliquer.

### Amélioration #2 — Bouton « Valider ma proie » côté loups (`votes.js`, `server.js`, `phases.js`, `state.js`, `public/index.html`)
Chaque loup voit désormais un bouton « 🐺 Valider ma proie » sous son interface de vote. État côté serveur : `state.wolfConfirmed` (Set d'ids). Nouveau handler `wolfConfirm` (server.js ligne 226). Quand tous les loups vivants ont validé ET votent la même cible → `performLockWolfVotes()` automatique. En cas de désaccord à la validation, toutes les validations sont annulées et un `wolfConfirmReject` est envoyé. Changer de cible (`voteWolf`) supprime sa validation. Émission d'un statut `wolfConfirmStatus` (confirmed: ids, total: nb) à l'entrée de phase wolves et à chaque vote/validation. Combiné à l'amélioration #1, le MJ n'a plus rien à faire pendant la nuit.

### Amélioration #3 — Carte narrative complète à la résolution du Conseil des Morts (`council.js`, `public/mj.html`)
Quand le Conseil vote un événement pour demain, le MJ reçoit désormais le narratif complet (pas juste le titre). `councilResolvedMJ` inclut `narrative`. Côté `mj.html`, le handler affiche la carte plein écran `#councilEventCard` (avec titre + narratif) et lance la narration TTS complète, en plus de l'alerte. Le MJ a ainsi toute l'explication pour raconter aux joueurs ce qui les attend.

### Amélioration #4 — Saut de la phase Sorcière si plus de potions (`roles.js`, `phases.js`)
`nextNightPhase()` ne retourne plus `"witch"` quand la sorcière a déjà utilisé `witchSaveUsed && witchKillUsed`. Le `handleSetPhase` côté MJ couvre aussi ce cas — si on force la phase witch sans potions, on bascule directement sur `doResolveNight()`. Plus de temps mort de 45 s sur la sorcière inactive.

### Bug fix — Dépendance circulaire des modules (CRITIQUE) (`phases.js`, `roles.js`, `votes.js`)
**Symptôme observé** : au lancement de la partie (clic sur Start côté MJ), tous les joueurs sur leur portable se faisaient « déconnecter », et le bouton Pause ne répondait plus.

**Cause** : `phases.js`, `roles.js` et `votes.js` se requièrent en cycle (`require('./roles')`, `require('./phases')`, `require('./votes')` au top de chaque fichier). Pendant le chargement circulaire, certains modules captent une référence à l'objet `module.exports` AVANT que le module n'ait fini son chargement. Quand le fichier se terminait par `module.exports = { ... }` (réassignation), cela **détachait** l'objet capturé : les autres modules continuaient à pointer sur le `{}` initial vide. Conséquence : `phases.js` voyait `roles` comme un objet vide → `roles.clearMissionTimeouts is not a function` → `TypeError` non catchée → process Node tué → tous les sockets ferment.

Reproduction confirmée en isolant les modules :
```
TypeError: roles.clearMissionTimeouts is not a function
    at clearPhaseTimeouts (phases.js:286:9)
    at Object.setPhase (phases.js:112:3)
```

**Correction** : remplacement de `module.exports = { ... };` par `Object.assign(module.exports, { ... });` à la fin de `phases.js`, `roles.js` et `votes.js`. `Object.assign` **mute** l'objet exports d'origine au lieu de le remplacer ; toutes les références capturées pendant le chargement voient alors apparaître les fonctions.

Le commentaire du haut de chaque fichier (« Dépendances circulaires (...) résolues via `require('./module').fn()` à l'usage ») était l'intention initiale (lazy require dans chaque fonction) mais n'avait jamais été appliquée — `Object.assign` est plus simple et n'oblige pas à réécrire les call-sites.

Tous les scénarios qui plantaient passent maintenant : `setPhase("mayorVote")`, `pauseGame()`, `resumeGame()`, `resetGameState`, `checkVictory()`, `assignAndStart`. `node server.js` boote sans erreur.

### Bug fix — `server.js` tronqué sur disque
Le fichier était physiquement tronqué à 12958 octets, finissant en plein milieu de `socket.on("d` — il manquait tout le handler `disconnect`, la fermeture de `io.on("connection")`, et l'appel `http.listen(PORT, ...)`. `node --check server.js` échouait avec un `SyntaxError`. Probablement une sauvegarde interrompue ou un raté de sync OneDrive. Le fichier a été restauré dans sa version complète (298 lignes, ~13.5 ko).

### Bug fix — Route `/api/ip` rétablie (`server.js`)
Le QR code du panneau MJ (`public/mj.html` ligne ~1228, fonction `initQR`) appelle `/api/ip` pour récupérer l'IP locale et générer l'URL de connexion joueur. Cette route avait disparu lors de la refonte modulaire et le QR code affichait "Erreur IP". Ajout dans `server.js` : `require("os")`, helper `getLocalIPv4()` qui parcourt `os.networkInterfaces()` et renvoie la première IPv4 non-loopback (fallback `127.0.0.1`), et route `app.get("/api/ip", ...)` qui renvoie `{ ip, port: PORT }`. Le QR code refonctionne après simple redémarrage du serveur.

### Petit confort — Alias d'URL `/mj` (`server.js`)
Ajout d'une route Express `app.get("/mj", ...)` qui renvoie `public/mj.html`. L'URL longue `/mj.html` continue de fonctionner (servie par `express.static`), mais `/mj` (sans extension) marche aussi maintenant — pratique pour taper l'URL de mémoire sur la tablette MJ. Aucune autre URL n'est affectée.

### Bug fix — Check victoire avant la phase de nuit (`server.js`, dans `resolveDayVote`)
Avant `setPhase("wolves")` après une mort de jour, `checkVictory()` est appelé explicitement. Évite que la nuit ne démarre brièvement quand la victoire est scellée par le vote du jour.

```js
if (phase !== "lobby" && phase !== "chasseur" && phase !== "mayorTransfer") {
  if (checkVictory()) return;
  setPhase("wolves");
}
```

### Bug fix — Sprint final 30s, fonctionnel tous les jours (`server.js`)
- `FAST_RESOLVE_MS` : `10000` → `30000` (constante en haut du fichier).
- Dans le handler `voteDay` (vote réel des joueurs), ajout de la garde `voteTimer != null` (comme dans la version bot) pour éviter de déclencher le sprint avant que le MJ n'ait lancé le vote.
- `fastResolveTriggered = true` est désormais posé **uniquement** si `remainingMs > FAST_RESOLVE_MS` (sinon le flag bloquait à tort le sprint quand les votes arrivaient tard).
- Messages "vote rapide 10s" → "vote rapide 30s".

### Amélioration — Carte narrative côté MJ (`mj.html`)
Ajout du div plein écran `#councilEventCard` (mêmes couleurs/structure que côté joueur).
- Handler `councilEventActive` affiche maintenant la carte en plus du bandeau et de la narration TTS.
- Fonction `closeCouncilEventCard()` + timeout 20s de sécurité.
- Handler `councilEventEnd` ferme la carte si encore ouverte.

### Anti-triche — Jeu en présentiel sur canapé (`public/index.html`)
- **Voile de nuit** : nouvel overlay `#nightCoverScreen` plein écran avec fond noir étoilé et message « 🌙 Garde les yeux fermés. Ce n'est pas ton tour de jeu — la nuit veille pour toi. ». Activé pour tout joueur vivant qui n'est PAS le rôle actif de la phase courante. Logique centralisée dans `isActiveDuringPhase(phase, role)` + `updateNightCover()`. Le rôle actif voit son interface normalement. Les morts ne voient jamais le voile (ils ont le Conseil des Morts / chat).
- **Bouton « Maintenir pour voir mon rôle »** pendant le jour : la zone `#infoPanelContent` (rôle, alliés Loups, amoureux, potions Sorcière) est masquée par défaut pendant `day`/`mayorVote`/`mission*`/`mayorTransfer`/`chasseur`/`lobby`. Bouton `#infoRevealBtn` au-dessus, hold-to-reveal via `mousedown`/`touchstart` + `mouseup`/`touchend`/`mouseleave`. Anti-context menu pour bloquer le long-press iOS. Pendant les phases de nuit, le panneau est visible directement (l'écran est de toute façon masqué pour les non-concernés).
- **Effacement des secrets à l'aube** : `clearNightSecrets()` appelé sur `phase === "day"` — efface `#status` (« 🛡 Vous protégez X », « 🧪 Potion utilisée », résultat Voyante, confirmation Corbeau), ferme les panneaux d'action de nuit. Le joueur doit mémoriser ce qu'il a vu pendant la nuit.
- **Plus de vibrations pendant la nuit** : `salvateur` ajouté à `NO_VIBRATE_PHASES` (les autres phases nocturnes y étaient déjà). Aucune vibration ne peut trahir un rôle par un voisin attentif.
- Hooks de mise à jour du voile et du bouton : `socket.on("phase")`, `socket.on("yourRole")`, `socket.on("deadPlayers")`.
- Tests : `node --check server.js` OK, JS player OK, serveur boote proprement.

### Nouveau rôle — Les Sœurs jumelles (`state.js`, `phases.js`, `roles.js`, `narration.js`, `lights-scenes.json`, `public/index.html`, `public/mj.html`)
- **Rôle Villageois pur** (clé interne `"Sœurs"`, avec œ ligaturé) : 2 joueuses qui se réveillent ensemble chaque nuit pour 20 secondes silencieuses. Elles peuvent se regarder et se faire signe IRL — aucune communication via l'app. **Compte comme villageois** pour `checkVictory` (toute valeur ≠ "Loup" → villageois).
- **Nouvelle phase `sisters`** insérée entre `cupid` et `salvateur`. `startNightAfterCupid()` route vers sisters si ≥2 sœurs vivantes, sinon vers le nouveau helper `startNightAfterSisters()` qui contient l'ancienne logique cupid→salvateur/wolves. Toutes les transitions cupid→nuit passent désormais par ces deux helpers.
- **Timer 20s déclenché PAR LE MJ** (pas auto-démarré à l'entrée de phase) : à l'entrée en phase `sisters`, `installPhaseTimeouts` pose un fail-safe 5 min (filet anti-blocage si le MJ se déconnecte). Le vrai timer 20s est posé par le nouveau handler `handleMJStartSistersTimer(socket)` (dans `roles.js`) déclenché par le socket event `mjStartSistersTimer` (câblé dans `server.js`). À l'expiration → `startNightAfterSisters()`. Reset dans `clearPhaseTimeouts` (`state.sistersTimeout`) et `resetGameState`.
- **Carte narrative MJ `#sistersLauncherCard`** : plein écran rose poudré, apparaît à l'entrée en phase sisters, contient un bouton « ▶ Lancer le timer des Sœurs (20s) ». Au clic → `socket.emit("mjStartSistersTimer")` + ferme la carte. Disparaît aussi automatiquement au prochain changement de phase. Permet au MJ d'attendre que tous les joueurs aient fermé les yeux et que les sœurs aient ouvert les leurs.
- **Côté joueur** : `sistersTurn` ouvre le panneau et **fige** le timer à `00:20`. Nouvel event `sistersTimerStart` (payload `{durationMs, startedAt}`) démarre le vrai compte à rebours, calculé sur `Date.now() - startedAt` toutes les 250 ms pour rester précis même en cas de drift.
- **Émissions socket** : `sistersTurn` (à chaque sœur vivante, payload `{count}` — **Option B** : pas de nom révélé, elles se reconnaissent IRL) ; `sistersInfoMJ` (au MJ, payload `{sisters: [{id,name},...]}` pour rappel si besoin).
- **Config MJ** : input `👯‍♀️ sisters` (0 ou 2 seulement — toute autre valeur est ramenée à 0 dans `assignAndStart` via `numSisters = (+config.sisters === 2) ? 2 : 0`). Ajout dans panneau ① et Replay. `startGame()` et `replayGame()` envoient la valeur. Boucle de copie ① → Replay incluse.
- **Player UI** : panneau plein écran `#sistersPanel` (rose poudré `#3a1428` → `#1a0814`, emoji 👯‍♀️ 72px, message « Réveille-toi, cherche ta sœur du regard » + compteur 20s + « X sœurs en vie »). Handler `sistersTurn` lance le countdown via `setInterval` 1s. Auto-fermeture quand `phase !== "sisters"` (handler `socket.on("phase")` DÉDIÉ, ajouté en plus du gros handler `phase` existant — socket.io gère les listeners multiples, c'est volontaire). Ajout aux dictionnaires : `ROLE_EXPLAIN`, `ROLE_DISPLAY`, `PHASE_NARR`, `DEATH_ROLE_EMOJI`, `phaseLabel`, `NO_VIBRATE_PHASES`, `NIGHT_PHASES_FOR_COVER`, `isActiveDuringPhase` (`sisters` + `Sœurs` → true), `clearNightSecrets` (ferme `sistersPanel`).
- **MJ UI** : phase `sisters` ajoutée à `nightPhases`, aux `steps` de la barre nuit (condition `needed: filter(r=>r==='Sœurs').length >= 2`), à `phaseLabel`, à `roleEmoji`. Pas d'ambiance modifiée — sister.mp3 se joue par-dessus via `playEffectWithFade`.
- **Sons** : fichier `public/sounds/sisters.mp3` joué **en boucle** par-dessus l'ambiance `night.mp3` pendant TOUTE la phase sisters (canal audio dédié `_sistersLoopAudio`). Fonctions `playSistersLoop()` / `stopSistersLoop()` dans `mj.html` ; déclenchement direct depuis le handler de phase MJ (pas via `soundPlay` serveur). Fondu de sortie 1s au changement de phase.
- **Musique de nuit étendue** : `playAmbiance("night")` est désormais déclenché dès la PREMIÈRE phase de nuit (`cupid` la 1ʳᵉ nuit, `sisters` ou `salvateur` ou `wolves` les suivantes) — liste élargie : `["cupid","sisters","salvateur","wolves","corbeau","seer","petiteFille","witch","chasseur","mayorTransfer"]`. Le guard `if(ambianceName===k...)` dans `playAmbiance` évite les redémarrages inutiles entre phases.
- **Lumière** : scène `sisters` dans `lights-scenes.json` (xy 0.40/0.25 = magenta tendre, bri 180, slow_pulse).
- **Narration TTS** : 3 entrées ajoutées dans `NARRATIONS` (`*_to_sisters`, `sisters_to_salvateur`, `sisters_to_wolves`).
- **Cas limites** : si 0 ou 1 sœur en vie, la phase saute (skip via `startNightAfterCupid → startNightAfterSisters` direct). Pas de bot pour la phase sisters (rien à faire — le timer suffit). Si Cupidon lie une sœur à un loup, comportement standard amoureux (rien de spécial).

### Immersion — Quick wins CSS (`public/css/player.css`, `public/index.html`)
- **Voile de nuit qui respire** : animation `coverBreathe` 5s (brightness 1 ↔ 1.18), couche d'étoiles `starsTwinkle` 4s décalée, et `moonPulse` 6s sur l'emoji 🌙 (scale + drop-shadow doré). Statique avant, vivant maintenant.
- **Animation de révélation du rôle** : nouvelle keyframe `cardReveal` (cubic-bezier overshoot) qui fait apparaître l'emoji avec un flip 3D `rotateY(180→0)` + scale 0.2→1.15→1 + désaturation `blur(8px)→0`. Halo lumineux `::after` derrière l'emoji avec `haloPulse`. L'emoji flotte ensuite doucement (`emojiHover` 3s).
- **Teinte ambiante de l'écran par phase** : `body[data-phase]` posé par le handler `socket.on("phase")` côté joueur. Variables CSS `--phase-tint` et `--phase-tint-edge` définies par phase (cupid rose, sisters magenta tendre, salvateur cyan, wolves rouge, seer violet, witch vert, day doré, etc.). Overlay `body::after` en `radial-gradient` qui transitionne sur 1.2s. Subtle mais ça vit.

### Immersion — Cheat sheet MJ contextuelle (`public/mj.html`)
Dictionnaire `MJ_CHEATSHEET` (15 phases couvertes). Petit panneau vert sous le pause banner avec un titre dynamique « 📜 Pense à dire » + 2-4 lignes guides selon la phase. Mis à jour automatiquement à chaque `socket.on("phase")` via `updateCheatSheet(p)`. Bouton ✕ pour le fermer manuellement. Aide énormément quand on est MJ pour la 1ʳᵉ fois (ou quand on a oublié la formule rituelle).

### Immersion — Récits de mort différenciés (`death-narratives.js`, `roles.js`, `votes.js`, `public/index.html`)
Nouveau module **`death-narratives.js`** avec 5 causes (loups, sorcière, vote, amour, chasseur) × variantes default + overrides par rôle (Loup, Voyante, Sorcière, Chasseur, Cupidon, Salvateur, Corbeau, Sœurs, PetiteFille, Idiot). Templates avec placeholders `{name}` et `{role}` rendus côté serveur. `buildDeath(id, cause)` dans `roles.js` enrichit chaque entry avec un champ `narrative`. Idem `buildVoteNarrative` dans `votes.js`. Côté player UI, `showDeathCard(name, role, narrative)` et le handler `dawnResult` priorisent le récit serveur quand disponible — fallback historique préservé. Multi-death : concaténation des récits si tous ont une narrative. Conséquence : au lieu de « Marie est éliminée. Son rôle était Voyante », on lit « À l'aube, les villageois découvrent le corps de Marie. Ses visions s'éteignent pour toujours. La meute a trouvé la Voyante. »

### Immersion — Badges post-victoire (`badges.js`, hook dans `phases.js checkVictory`)
Nouveau module **`badges.js`** : `buildBadges({players, roles, deadPlayers, lovers, gameStats, winner})` détecte 14 médailles automatiques (⚰️ Première victime, 🏆 Survivant, 🐺 Chef de meute, 🤡 Roi du Bluff, 💔 Cœur brisé, 💘 Couple éternel, 🔮 Devineresse, 🛡 Bouclier inébranlable, 🧪 Apothicaire émérite, 🔫 Tireur d'élite, 👯‍♀️ Sœurs inséparables, 🏛️ Étoile du village, 🤡 Bouffon impardonnable, 🪶 Plume noire). Renvoie `{playerName: [{emoji,label,desc}]}`. Ajouté au payload `gameSummary`. Côté player UI, nouveau panneau `#endBadgesPanel` sur l'écran de fin avec une chip par badge sous le nom du joueur.

### Immersion — Selfie au lobby + carte d'identité (`server.js`, `public/index.html`)
- **Capture côté joueur** : `<input type="file" accept="image/*" capture="user">` qui ouvre la caméra frontale sur mobile. `handlePhotoSelected` redimensionne à 200×200 carré centré via `canvas.drawImage`, encode en JPEG quality 0.72, donne un aperçu rond, et émet `setPhoto`. Cappé à ~35 KB côté serveur (validation `data:image/` + taille).
- **Stockage serveur** : `players[i].photo` (base64) + `playerRegistry[name.toLowerCase()].photo` (persiste à la reconnexion / restore après crash). Diffusé via `io.emit("players")`.
- **Mémorisation locale** : `localStorage.lgPhoto` côté client → re-emit automatique `setPhoto` à chaque reconnect (utile après crash serveur).
- **Affichage** : avatar rond 80px sur la **carte de rôle** (au-dessus de l'emoji), 32px dans la **liste des rôles de l'écran de fin** (remplace l'emoji du rôle si photo disponible). Sur la **dayDeathCard**, helper `renderDeathPhotos(victims)` qui rend une rangée flex adaptative : 100px solo, 80px pour 2-3 morts, 60px pour 4+. Si une victime n'a pas de photo → placeholder rond avec initiale du prénom sur fond gris foncé. Toutes les morts d'une nuit (loups + sorcière + amour) sont représentées visuellement.
- **Lobby visible jusqu'à `yourRole`** : avant, le lobby était caché dès `join()`. Maintenant la section selfie reste visible après l'inscription, et le lobby ne se cache qu'au démarrage effectif (réception de `yourRole`). Le joueur a donc le temps de prendre une photo entre son inscription et le clic « Lancer la partie » du MJ.

### Robustesse — Logger structuré (`logger.js`)
Nouveau module sans dépendance externe. Niveaux `info` / `warn` / `error` / `debug` (debug uniquement si `LOG_DEBUG=1`). Sortie : console + fichier journalier `logs/YYYY-MM-DD.log` (créé auto, append). Format : `[YYYY-MM-DD HH:mm:ss] [LEVEL] msg`. Branché dans : `server.js` (boot, connect/disconnect, register, MJ), `phases.js` (setPhase, checkVictory si proche victoire), `roles.js` (killPlayer, assignAndStart, handleMJStartSistersTimer), `votes.js` (startDayVote, resolveDayVote), `council.js` (applyCouncilEvent).

### Robustesse — Persistance d'état + reprise après crash (`snapshot.js`, hooks `server.js`)
**Objectif** : ne plus perdre une partie en cours si le serveur crash ou si Windows redémarre.
- **`snapshot.js`** : `serializeState(state)` extrait les champs métier (omet `state.io`, timers, Sets → Arrays). Sauvegarde toutes les 5 s dans `snapshots/state-snapshot.json` (écriture atomique via `.tmp` + `rename`). Pas de snapshot en phase `lobby` (et purge tout snapshot zombie). `applySnapshot(state, snap)` repose les champs (Sets reconstitués).
- **Crash handlers dans `server.js`** : `process.on('uncaughtException')` et `process.on('unhandledRejection')` appellent `snapshot.dumpCrash(state, err)` qui écrit `snapshots/crash-{timestamp}.json` avec stack + état complet, log l'erreur, puis exit (uncaughtException) ou continue (unhandledRejection).
- **Au boot** : `snapshot.loadSnapshot()` détecte la sauvegarde. Si phase ≠ "lobby" → `state.pendingRestore = snap` et log warn.
- **Côté MJ** : quand le MJ s'enregistre, si `state.pendingRestore` est posé, le serveur émet `crashRecoveryAvailable` avec un résumé (savedAt, phase, players, maire, jours/nuits). Carte plein écran ambre `#crashRecoveryCard` apparaît côté MJ avec 2 boutons : « ✅ Reprendre la partie » → emit `acceptCrashRecovery` ; « 🗑 Ignorer » → emit `discardCrashRecovery` (confirm).
- **Accepter la reprise** (`server.js handler`) : `snapshot.applySnapshot(state, snap)` + emit `gameRestored` à tous + `phases.setPhase(state.phase)` pour réinstaller les timers proprement. Les joueurs reçoivent `gameRestored` côté `index.html` → re-emit `register` automatique avec le prénom mémorisé en `localStorage`. La logique de reconnexion existante (`playerRegistry` keyed by name) remappe les anciens IDs vers les nouveaux sockets.
- **Refuser** : clear le snapshot + reset `pendingRestore`. Le serveur reste en lobby.

### Robustesse — Reconnexion en plein milieu d'une phase Sœurs ou Salvateur (`state.js buildFullState`, `public/index.html`)
**Symptôme** : si une Sœur ou le Salvateur perdait sa connexion (4G qui coupe, etc.) pendant SA phase, à la reconnexion le snapshot envoyé par `buildFullState` ne ré-ouvrait pas son panneau plein écran — elle se retrouvait avec un écran vide alors que sa phase tournait.
**Fix** : `buildFullState` ajoute désormais `pendingSistersTurn` (si phase=sisters + role=Sœurs + vivant) avec `{count, timerEndsAt}` et `pendingSalvateurTurn` (si phase=salvateur + role=Salvateur + vivant) avec `{lastProtectedId, lastProtectedName}`. Côté `index.html`, le handler `reconnected` détecte ces flags et ré-ouvre les panneaux : pour Sœurs, le countdown reprend exactement sur le temps restant si le MJ a déjà lancé le timer (via `state.sistersTimerEnd`), sinon figé à `00:20`. Nouveau champ `state.sistersTimerEnd` posé/cleared dans `handleMJStartSistersTimer` et `clearPhaseTimeouts`/`resetGameState`.

### Robustesse — ESLint minimal (`package.json`, `eslint.config.js`)
Config plate ESLint 9 dans `eslint.config.js`. Règles informationnelles uniquement : `no-unused-vars: warn` (avec ignore pattern `^_` pour les variables marquées intentionnellement), `no-undef: error` côté serveur, `eqeqeq: warn` partout. Pour le front (`public/**`), `no-unused-vars` et `no-undef` désactivés (faux positifs car les `<script>` partagent un namespace global). Script `npm run lint`. Devdep `eslint: ^9.0.0`. Installation à faire côté Windows (`npm install`) car le sandbox Linux ne voit pas le `package.json` à jour à cause de OneDrive.

### Bug fix CRITIQUE — Sœurs & Salvateur ne jouaient pas après la nuit 1 (`roles.js`, `phases.js`, `votes.js`)
**Symptôme** : seules la 1ʳᵉ nuit déclenchait Cupidon → Sœurs → Salvateur → Loups. Toutes les nuits suivantes (après chaque vote du jour) sautaient directement aux Loups, bypassant Sœurs et Salvateur. Bug latent depuis l'ajout du Salvateur (pas remarqué), aggravé par l'ajout des Sœurs.
**Cause** : `startNightAfterCupid()` n'était appelée que depuis le handler Cupidon (handler humain, bot, timeout). Toutes les transitions day→night appelaient `phases.setPhase("wolves")` directement dans 5 endroits : `votes.js resolveDayVote`, `votes.js handleTiebreakChoice`, `votes.js handleSkipDayVote`, `votes.js maybeRunBotForTiebreak`, `roles.js performChasseurShot` (postCtx day), `roles.js performMayorTransfer` (else final), `phases.js chasseurTimeout fallback`. Chacun shuntait la séquence Sœurs/Salvateur.
**Fix** : renommage de `startNightAfterCupid` → `startNightSequence` dans `roles.js` (alias historique gardé pour compat). Tous les chemins day→night listés ci-dessus pointent maintenant vers `roles.startNightSequence()` au lieu de `phases.setPhase("wolves")`. La séquence vérifie : ≥2 Sœurs vivantes → phase `sisters` ; sinon Salvateur vivant → phase `salvateur` ; sinon `wolves`.

### Bug fix — Son loups joué pendant la phase Sœurs (`roles.js handleCupidChoice`, `phases.js` bot Cupidon)
**Symptôme** : après la sélection des amoureux par Cupidon, le son `wolves_attack.mp3` retentissait 4 s plus tard — c'est-à-dire en plein pendant le tour des Sœurs (phase `sisters`), gâchant l'ambiance.
**Cause** : `handleCupidChoice` programmait un `setTimeout(4000ms)` qui jouait `wolves` après la fin de `cupid.mp3` (4 s). Avant l'ajout des Sœurs/Salvateur, le flux était cupid → wolves direct, donc ce timer fire au bon moment. Avec sisters qui dure ≥20 s entre les deux, le timer fire au mauvais moment.
**Fix** : le `setTimeout` ne joue le son loups QUE si `state.phase === "wolves"` au moment où il fire (cas cupid→wolves direct, sans intermédiaire). Sinon il ne fait que reset `state.skipWolvesSoundOnce = false`, ce qui permet à `setPhase("wolves")` de jouer le son naturellement quand on y arrivera (plus tard via sisters/salvateur).

### Narration TTS — ajouts pour la séquence complète (`narration.js`)
Ajout de `*_to_salvateur` (avant : transition silencieuse les nuits 2+) et `salvateur_to_wolves` (avant : silence après protection). Reformulation de `*_to_sisters` pour ne plus mentionner « vingt secondes » (le MJ peut prendre son temps avant de lancer le timer).

### Nettoyage post-audit Sœurs (`public/index.html`, `public/mj.html`)
- Fusion du listener `socket.on("phase")` dupliqué pour les Sœurs : la fermeture du `sistersPanel` est désormais intégrée dans le gros handler `socket.on("phase", ...)` existant (`if (p !== "sisters") closeSistersPanel();`).
- Ajout de `'sistersPanel'` à la liste de `isAnyNarrativeCardOpen` (cohérence avec les autres cartes plein écran qui font reculer le voile de nuit).
- Barre de phases nocturne MJ : le step `Sœurs` est désormais filtré sur les sœurs **vivantes** (`Object.entries(roles).filter(([id,r])=>r==='Sœurs' && !deadIds.includes(id)).length >= 2`), pour ne plus afficher l'étape une fois les deux sœurs mortes.
- Toast MJ branché sur `sistersInfoMJ` (avant : émission morte sans handler) → « 👯‍♀️ Sœurs jumelles à réveiller : Marie & Sophie ».

### Amélioration — Son `shield.mp3` sur confirmation Salvateur (`roles.js`, `phases.js`, `public/mj.html`)
- À la confirmation de cible par le Salvateur (handler `handleSalvateurAction` ET bot dans `runBotsForPhase("salvateur")`), émission `soundPlay: "shield"` au MJ juste après `salvateurConfirm`. Côté MJ, `shield` ajouté à l'allowlist du handler `soundPlay` et à `SOUNDS` (`sounds/shield.mp3`). Nouveau fichier `public/sounds/shield.mp3` à fournir.

### Nouveau rôle — Le Salvateur (`server.js`, `public/index.html`, `public/mj.html`, `lights-scenes.json`)
- **Rôle Villageois** : chaque nuit, avant les Loups, choisit un joueur à protéger. Si les Loups attaquent cette personne, elle survit. Peut se cibler lui-même. **Interdiction de protéger la même personne deux nuits de suite.**
- **Nouvelle phase `salvateur`** insérée entre `cupid` et `wolves`. Helper `startNightAfterCupid()` centralise la transition : si un Salvateur est vivant → `setPhase("salvateur")`, sinon → `setPhase("wolves")`. Tous les chemins cupid→wolves (handler, timeout, bot) ont été redirigés via ce helper.
- État serveur : `protectedTarget` (cible courante), `lastProtectedTarget` (cible de la nuit précédente, interdite). Cycle dans `doResolveNight` : `lastProtectedTarget = protectedTarget; protectedTarget = null;`. Reset propre dans `resetGameState` et `clearPhaseTimeouts`.
- Logique de protection : dans `doResolveNight`, calcule `protectedBySalvateur = (nightTarget === protectedTarget)`. La mort par les loups n'est ajoutée à `deaths` que si `!protectedByWitch && !protectedBySalvateur`. Le récap MJ reçoit désormais `savedByWitch` et `savedBySalvateur` séparément pour différencier la narration.
- Socket handler `salvateurAction(targetId)` : valide la phase, refuse `targetId === lastProtectedTarget` (émet `salvateurReject`), émet `salvateurConfirm` puis `setPhase("wolves")`. Timeout 45 s avec auto-passage (aucune protection cette nuit).
- Bot Salvateur : choisit aléatoirement parmi les vivants ≠ `lastProtectedTarget`.
- **Player UI** : nouveau panneau `#salvateurPanel`, handler `salvateurTurn` qui affiche les boutons cibles (cible précédente grisée avec libellé "(hier)"), `salvateurConfirm` → status, `salvateurReject` → alert. Ajout au `ROLE_EXPLAIN`, `PHASE_NARR`, `DEATH_ROLE_EMOJI`, `phaseLabel`.
- **MJ UI** : input `🛡 salvateur` ajouté dans ① Démarrage et dans le panneau Replay. Phase `salvateur` ajoutée à `nightPhases` et aux `steps` de la barre nuit. `startGame()` et `replayGame()` envoient la valeur. Carte récap MJ adaptée pour afficher "🛡 Le Salvateur a protégé la victime des loups" quand pertinent.
- Lumière : scène `salvateur` ajoutée dans `lights-scenes.json` (bleu turquoise xy 0.17/0.40, bri 130) — appliquée automatiquement par le hook `setPhase` existant.
- Tests : `node --check` OK sur server.js + lights.js, blocs JS OK pour mj.html + index.html, JSON 31 scènes, serveur boot propre.

### Amélioration — Lumières connectées Philips Hue (`lights.js`, `lights-scenes.json`, `.env.example`, hooks dans `server.js`)
- Nouveau module **`lights.js`** : pilote Hue via l'API CLIP v2 (HTTPS LAN, certif autosigné), pattern fire-and-forget (`timeout 1.5s`, jamais d'`await`, jamais de throw → ne bloque/ne casse jamais le moteur de jeu). Throttle 100 ms entre commandes pour respecter le rate-limit Hue. Effets supportés : `lightning`, `fire_flicker`, `slow_pulse`, `fast_pulse`. Helpers : `applyScene(key)`, `flash(key)`, `reset()`, `status()`.
- Nouveau **`lights-scenes.json`** : 30 scènes (phases + 15 évènements `council.*` + 2 flashs `flash.death`/`flash.victory`). Valeurs xy CIE 1931, `bri` 0–254, `transition` ms, `effect` optionnel.
- **`.env.example`** documente les 5 variables : `LIGHTS_ENABLED` (défaut `false` → totalement dormant), `HUE_BRIDGE_IP`, `HUE_API_KEY`, `HUE_GROUP_ID`, `LIGHTS_DEBUG`. Tant que `LIGHTS_ENABLED!="true"`, aucun appel réseau, aucun warning.
- **4 hooks dans `server.js`** (purement additifs, le moteur de jeu reste inchangé) :
  1. Fin de `setPhase(p)` → `lights.applyScene(p)` (clé = nom de phase brut)
  2. Début de `applyCouncilEvent(ev)` → `lights.applyScene("council." + ev.id)` (superpose à `day`)
  3. Après `io.emit("playerDied", …)` dans `killPlayer` → `lights.flash("flash.death")` (sauvegarde + restaure la scène courante)
  4. Avant `setPhase("lobby")` à la fin de partie → `lights.flash("flash.victory")` ; dans `resetGameState` → `lights.reset()`
- Tests effectués : `node --check server.js` ✓, `node --check lights.js` ✓, JSON valide (30 scènes), serveur démarre proprement avec module dormant. Pour activer : copier `.env.example` → `.env`, remplir Bridge IP / clé / group UUID, mettre `LIGHTS_ENABLED=true`, redémarrer.

### Amélioration — Modes de vote pilotés par le Conseil des Morts + nouveaux évènements (`server.js`, `mj.html`)
- Le mode 1 (vote libre) est le seul lançable « par défaut ». Les modes 2/4/5 ne sont déclenchés que via un évènement du Conseil des Morts. Le handler socket `startVote` ignore son paramètre et appelle toujours `startDayVote(1)` ; `startDayVote` applique ensuite l'override selon `activeCouncilEvent`.
- Mapping évènement → mode forcé : `riot` → mode 5 (Émeute, vote anonyme, 60 s) ; `judgment` → mode 2 (Le Jugement, verrouillé, 200 s) ; `panic` → mode 4 (La Panique, express, 30 s).
- Deux nouveaux évènements ajoutés à `COUNCIL_EVENTS` : `judgment` (« ⚖ Le Jugement », narratif « Une fois prononcé, un vote ne peut plus être changé. ») et `panic` (« ⚡ La Panique », narratif « Le village sombre dans la précipitation. »).
- Durées de vote remises à jour dans `startDayVote` : `{ 1: 200000, 2: 200000, 4: 30000, 5: 60000 }`.
- Côté MJ (`mj.html`) : retrait des boutons de sélection de mode dans la section ⑤. Bouton « Relancer le vote (mode 1) » + bouton « Terminer ». Labels mis à jour dans le handler `voteStarted` (« ⚖ Le Jugement — verrouillé (200s) », « ⚡ La Panique — express (30s) », « 🖤 Émeute — vote anonyme (60s) »). `selectMode` conservé en no-op défensif.

### Amélioration — Carte narrative MJ « fin de nuit / début de jour » (`server.js`, `mj.html`)
- Nouvel évènement socket `mjDayRecap` émis uniquement au MJ à l'entrée de la phase `day`. Payload : `{ dayNum, nightNum, previousDayDeath, nightDeaths[], saved, missionResult }`.
- Côté serveur : nouvelles variables `lastDayVoteDeath` (mémorisée dans `resolveDayVote`) et `pendingDayRecap` (préparée dans `doResolveNight` — y compris le chemin chasseur — et émise dans `setPhase("day")` pour couvrir tous les chemins de retour à day). Toutes les deux remises à `null` dans `resetGameState`.
- Côté MJ (`mj.html`) : carte plein écran `#dayRecapCard` (jaune/bleu) avec deux blocs (« Hier, le village… » et « Cette nuit… »), bouton « Continuer », auto-fermeture 25 s. Fermée aussi au `gameReset`. Narration TTS automatique de synthèse via `speakNarration(...)` pour aider le MJ à raconter le tour.

### Amélioration — Auto-démarrage du vote jour mode 1 / durée 200 s (`server.js`)
- Lorsque la phase `day` commence, le vote est désormais lancé automatiquement (timer `dayAutoStartTimer`, délai `DAY_AUTO_START_DELAY_MS = 2000`). En mode autonome on respecte `autoVoteMode`, sinon on lance le mode 1 (vote ouvert).
- Bloc de démarrage déplacé hors du `if (autoMode)` dans `setPhase`. Garde `voteTimer == null` ajoutée pour ne pas écraser un vote déjà initié par le MJ.
- Durée du mode 1 dans `startDayVote` portée de **90 s → 200 s** (`durations[1]` et fallback). Les modes 2/4/5 et le sprint final `FAST_RESOLVE_MS = 30000` restent inchangés (le sprint ne raccourcit que si le temps restant > 30 s, sinon on garde la valeur courante).

### Amélioration — Toggle narration vocale visible (`mj.html`)
- Bouton `#narrationOnOffBtn` dans le panneau `#narrationPanel` (vert "🔊 ON" / rouge "🔇 OFF").
- Fonction `setNarrationEnabled(enabled)` : met à jour `narrationOn`, envoie `socket.emit('setNarration', ...)`, stoppe `speechSynthesis.cancel()` si on coupe, met à jour l'opacité du bouton micro header et le statut. Côté serveur, le handler `setNarration` existe déjà à la ligne ~1923.
- Le clic droit sur le bouton micro header reste disponible comme raccourci.

### Nouveaux évènements Conseil des Morts — 🤐 Le Vote Muet + 💬 Les Voix Étouffées + 👑 L'Abdication (`council.js`, `votes.js`, `state.js`, `phases.js`, `server.js`, `public/index.html`, `public/mj.html`)

**Contexte** : les évènements existants étaient majoritairement des contraintes verbales/sociales et 4 vote modes. Les nouveaux events visent des mécaniques de jeu jusqu'ici inexploitées par le Conseil (vote sans débat, débat écrit, écharpe). Une première version proposait 🎲 Le Tirage (tiebreak hasard, 90 s) — retiré au profit du Vote Muet, plus cohérent avec l'esprit "contrainte de parole" du Conseil.

**🤐 Le Vote Muet** : 90 s pour voter, silence total — pas de débat, pas de plaidoyer. Contrainte sociale appliquée par les joueurs eux-mêmes (comme `paranoia`/`whispers`/`madness`/`tribunal`). L'arbitrage maire reste actif en cas d'égalité (comportement par défaut).
- `council.js` : entrée `voteMute` dans `COUNCIL_EVENTS` (technical `{ voteDurationMs: 90000 }`).
- `votes.js` : `startDayVote` override `duration = 90000` quand `activeCouncilEvent === "voteMute"`. La branche `tirage` dans `resolveVoteWithTiebreak` a été retirée.
- `public/mj.html` : label vote "🤐 Le Vote Muet — silence total (90s)" via la variable `_mjActiveCouncilEvent`.

**💬 Les Voix Étouffées** : un chat écrit s'ouvre pour la journée. Visible par tous (vivants + morts + MJ en lecture seule). Seuls les vivants peuvent écrire. Les joueurs débattent à l'écrit — utile en cas de partie où on veut un débat plus posé ou plus égalitaire.
- `council.js` : entrée `silencedVoices` (technical `{ dayChat: true }`). Dans `applyCouncilEvent`, le hook `dayChat` réinitialise `state.silentDayChatHistory = []` et émet `silentDayChatStart` à tous. Nouveaux handlers : `handleSilentDayChat(socket, payload)` valide (phase=day, event=actif, !mort, !MJ, texte 200 char max, strip `<>`), pousse dans `state.silentDayChatHistory` (cap 200 msgs) et émet `silentDayChatMsg` à `io.emit`. `handleSilentDayChatHistory(socket)` renvoie l'historique pour reconnexion.
- `state.js` : nouveau `state.silentDayChatHistory: []`.
- `phases.js` : `resetGameState` purge l'historique entre parties.
- `server.js` : sockets `silentDayChat` (envoi de message) et `silentDayChatHistory` (re-sync) câblés vers les handlers `council.*`.
- `public/index.html` : nouveau panneau `#silentDayChatPanel` (fond violet, max-width 520px) avec zone messages scrollable + input + bouton "Inscrire". Helper `refreshSilentDayChatVisibility()` consulte `silentDayChatActive` + `deadPlayers` pour afficher/masquer le panneau et basculer input/lecture seule selon vivant/mort. Handlers `silentDayChatStart` (efface + demande historique), `silentDayChatMsg` (append), `silentDayChatHistory` (re-pop). `councilEventEnd` ferme le panneau. `deadPlayers` re-évalue l'état write/read si event actif.
- `public/mj.html` : miroir lecture seule `#mjSilentDayChatPanel` (max-height 240px scrollable) affiché à `silentDayChatStart`, masqué à `councilEventEnd`. Les messages sont rendus en violet stylé identique côté joueur.

**👑 L'Abdication** : le maire désigne lui-même son successeur — pas de vote du village (par analogie à `performMayorTransfer` côté mort du maire, mais déclenché sur un maire vivant).
- `council.js` : entrée `abdication` (technical `{ abdication: true }`). Nouveau bloc « ===== ABDICATION ===== » : `triggerAbdicationPrompt()` envoie `mayorMustAbdicate` au maire avec la liste des candidats vivants (excluant lui-même), pose un timeout `ABDICATION_TIMEOUT_MS = 60000` pour filet aléatoire si pas de pick. `applyAbdication(newMayorId, forced)` met à jour `state.mayor`, émet `newMayor` + `mayorAbdicated`. Handler `handleAbdicationChoice(socket, targetId)` câblé au socket `mayorAbdicationChoice`. Nettoyage du timeout dans `clearCouncilEffects`.
- `server.js` : nouveau handler socket `mayorAbdicationChoice` câblé vers `council.handleAbdicationChoice`.
- `public/index.html` : nouveau handler `mayorMustAbdicate` qui réutilise `tiebreakPanel` (couleurs jaune/orange pour distinguer du `mayorMustTransfer` qui est bleu), bouton par candidat émettant `mayorAbdicationChoice`. Handler `mayorAbdicated` ferme le panneau et affiche le message public dans le `#status`.
- `public/mj.html` : handler `mayorAbdicated` (toast info + narration TTS).

**Garde-fous notables** :
- `applyAbdication` vérifie que le maire est encore vivant (sinon ignore).
- Si `mayorMustAbdicate` ne reçoit pas de pick en 60 s, fallback aléatoire avec flag `forced=true` (le message distingue ce cas).
- L'event `abdication` reste `state.activeCouncilEvent` toute la journée pour la cohérence visuelle, mais le prompt n'est envoyé qu'une fois (le timeout est cleared dès la première application).

**Bug fix concomitant — `server.js` retronqué par OneDrive** : le fichier était à nouveau tronqué (295 lignes, fin à `state.mjSocke`) lors de la prise en charge des nouveaux events. Réécriture intégrale via Write pour restaurer le handler `disconnect` complet, la fermeture de `io.on("connection")` et l'appel `http.listen` final (avec logs IP locale + URL MJ). Fichier de 305 lignes après remise à neuf.

## État du serveur après modifications

- `node --check server.js` : OK (vérifié).
- HTML mj.html : balises et JS équilibrés (vérifié).

## Carte du code — modules serveur

Le serveur est éclaté en 7 modules (+ `server.js` bootstrap). Tailles indicatives :

| Module | Lignes | Rôle |
|--------|--------|------|
| `server.js` | ~285 | Bootstrap pur : Express, route `/mj`, Socket.io, middleware pause, câblage de tous les handlers vers les modules. Ne contient AUCUNE logique métier. |
| `state.js` | ~242 | État mutable partagé (`state.players`, `state.phase`, `state.mission`, `state.gameStats`, etc.), toutes les constantes de timeout, helpers (`alivePlayers`, `computeCounts`, `playerName`, `fisherYates`, `buildFullState`). **Convention** : ne jamais déstructurer (`const { players } = state` est interdit) — toujours `state.players` pour conserver la réactivité. |
| `narration.js` | ~176 | Dictionnaire `NARRATIONS` (variantes TTS par transition de phase, ex. `"wolves_to_seer"`), `narrate(from, to)`, `setNarrationEnabled(bool)`. |
| `council.js` | ~360 | Conseil des Morts : `COUNCIL_EVENTS` (19 events — dont `voteMute`, `silencedVoices`, `abdication`), `COUNCIL_TRIGGER_THRESHOLD = 6`, `startCouncil`, `resolveCouncil`, `applyCouncilEvent` (effets : tonnerre, cloche, murmures, présage, abdication, dayChat), `clearCouncilEffects`, bloc « ABDICATION » (`triggerAbdicationPrompt`/`applyAbdication`/`handleAbdicationChoice`), bloc « LES VOIX ÉTOUFFÉES » (`handleSilentDayChat`/`handleSilentDayChatHistory`), handlers `handleCouncilVote`/`handlePlayPresage`. |
| `roles.js` | ~671 | Logique métier des rôles + mission + mort. Sections : `clearMissionTimeouts`/`resetMissionState`/`resolveMissionCards`, `startNightAfterCupid`/`nextNightPhase`/`doResolveNight`, `killPlayer`/`sendDeadVision`, `performChasseurShot`, `performMayorTransfer`, `assignAndStart` (attribution des rôles + start partie), handlers Cupidon/Salvateur/Voyante/Corbeau/Sorcière/Mission. |
| `phases.js` | ~873 | Orchestration. Sections : `startStuckTimer`, `scheduleBot`, **`setPhase`** (le cœur — applique lumières, narration, démarre auto-vote, etc.), `installPhaseTimeouts`/`clearPhaseTimeouts`, `runBotsForPhase` (logique des bots niveau 2), `checkVictory`, `pauseGame`/`resumeGame`, `resetGameState`, handlers `setPhase`/`pauseGame`/`resumeGame`/`reset`/`replayGame`. |
| `votes.js` | ~439 | Tous les votes. Sections : `clearVoteTimer`, `resolveVoteWithTiebreak` (égalités → arbitrage maire), `performLockMayorVote`/`performLockWolfVotes`, `checkMayorAutoLock`/`checkWolfConsensus` (mode autonome), `maybeRunBotForTiebreak`, `resolveDayVote`/`startDayVote`, handlers `voteMayor`/`startVote`/`voteDay`/`voteWolf`/`lockDayVotes`/`skipDayVote`/`tiebreakChoice`. |
| `lights.js` | ~290 | Pilote Philips Hue (CLIP v2, HTTPS LAN, certif autosigné). Pattern fire-and-forget. Export : `applyScene(key)`, `flash(key)`, `flashSequence(key, count)`, `reset()`, `status()`, `SCENES`. Flash types : `flash.death`, `flash.victory`, `flash.wolves`, `flash.idiot`, `flash.dawn`, `flash.bell`, `flash.lightning`. Scène `pause` pour la pause MJ. Scènes dans `lights-scenes.json` (33 entrées). |

**Comment trouver une fonction** : la grande majorité des fonctions sont en haut de leur module et exportées via `module.exports = {...}` en fin de fichier. Un `Grep` sur le nom dans le dossier racine pointe directement vers le bon module.

**Dépendances entre modules** (cycles évités via `require` paresseux quand nécessaire) :
- `state.js` → ne dépend de rien (sauf require paresseux de `council` dans `buildFullState`)
- `narration.js` → `state`
- `council.js` → `state`, `lights`
- `lights.js` → autonome (lit `lights-scenes.json`)
- `roles.js` → `state`, `lights`, `phases`
- `votes.js` → `state`, `phases`, `roles`
- `phases.js` → `state`, `lights`, `narration`, `council`, `roles`, `votes`
- `server.js` → tous les modules ci-dessus (câblage uniquement)

## Carte du code — `public/mj.html`

⚠ Les repères ci-dessous datent d'avant la refonte modulaire serveur. La structure du HTML/JS MJ n'a pas été re-vérifiée depuis — utiliser à titre indicatif et confirmer par `Grep` avant édition.

| Zone | Lignes approximatives |
|------|----------------------|
| Header (boutons connexion, pause, narration, plein écran) | 15-26 |
| Panneau narration (toggle ON/OFF, voix, vitesse, test) | 28-41 |
| Bandeau Conseil actif + bouton Présage | 48-52 |
| Carte plein écran `councilEventCard` (nouveau) | ~54-62 |
| TTS : `frenchVoices`, `speakNarration`, `toggleNarration`, `setNarrationEnabled` | ~330-430 |
| Handlers Conseil des Morts MJ | ~407-485 |
| Pause / Reprise | ~487-525 |

## Tâches en attente (à faire au bon moment)

- **Re-vérifier la carte du code de `public/mj.html`** : les plages de lignes datent d'avant la refonte modulaire serveur et n'ont pas été re-validées. À mettre à jour la prochaine fois qu'on travaille substantiellement sur `mj.html` — pas la peine de le faire à blanc.

## Idées / améliorations potentielles (non implémentées)

- Bouton MJ explicite pour activer la mission avant le start.
- Mode "Spectateur" pour rejoindre sans jouer.
- Persistance des parties (replay JSON sauvegardé).
- Nouveau rôle : Ancien (survit au 1er coup des loups) ou Bouc émissaire.
- Compteur visuel "joueurs ayant voté / total" plus prominent.
- Statistiques globales multi-parties (taux de victoire par rôle).
- Tests unitaires pour `checkVictory`, `resolveVoteWithTiebreak`, `doResolveNight`.
- Internationalisation (anglais).

## Bugs potentiels à surveiller

- Le flag `fastResolveTriggered` est réinitialisé dans `startDayVote` et `resetGameState` — vérifier qu'aucun autre chemin ne le laisse à `true` entre deux jours.
- `killPlayer` a plusieurs chemins de sortie anticipée (chasseur, mayorTransfer, lovers) — le filet `checkVictory()` dans `resolveDayVote` est défensif, mais les chemins `doResolveNight` → `killPlayer` ne sont pas tous protégés de la même façon. Audit possible.
- En mode autonome + bots, vérifier que les sons ne se chevauchent pas si les phases enchaînent vite.
- Quand un joueur reconnecte pendant la phase Mission, `buildFullState` envoie l'état mission mais l'UI peut nécessiter un test.

## Comment reprendre

1. Ouvrir une nouvelle conversation Cowork sur le dossier `LoupGarouVoteApp`.
2. Coller (ou pointer vers) ce document `HANDOFF.md`.
3. Indiquer la prochaine demande (correction, ajout, refonte).
4. L'agent peut alors lire les 3 fichiers principaux à la demande (server.js, public/index.html, public/mj.html) — `server.js` fait ~46k tokens, le lire par portions (`offset`/`limit`).

## Commandes utiles

```bash
# Vérif syntaxe serveur
node --check server.js

# Démarrer
node server.js

# Lancer en mode rapide pour tests
# (le bouton "Mode entraînement" dans l'UI MJ ajoute des bots)
```
