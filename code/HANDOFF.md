# Handoff — LoupGarouVoteApp

Document de reprise pour continuer ce projet dans une nouvelle conversation. Il décrit **l'état réel du code** (section « État actuel », revérifiée sur le code le 2026-10-16) puis garde l'historique de ce qui a été construit (section « Journal »).

> **Règle de lecture** : si une entrée ancienne du Journal contredit la section « État actuel », c'est l'État actuel qui fait foi — le Journal raconte l'histoire, pas forcément le présent (ex. : le vote du jour a duré 90 s, puis 200 s, puis 60 s).

## Organisation du dossier (depuis le 2026-10-16)

```
C:\LoupGarouVoteApp\
├─ CLAUDE.md          instructions pour Claude (reste à la racine pour être lu automatiquement)
├─ LISEZMOI.md        page d'accueil : explique les deux dossiers
├─ code\              LE CODE — zone de Claude (Alexandre n'y va pas)
│  ├─ server.js + modules *.js, lights-scenes.json
│  ├─ public\         interfaces joueur (index.html) et MJ (mj.html), css\, sounds\
│  ├─ tests\          scenarios.js (intégration), ui-headless.js (UI via Chrome)
│  ├─ outils\         test-hue.js (diagnostic lumières)
│  ├─ docs\           archives techniques (ANALYSE-2026-05-07.md)
│  ├─ HANDOFF.md, CONTEXT.md
│  ├─ start.ps1, .env (secrets Hue, non versionné), .env.example
│  └─ logs\, snapshots\, node_modules\  (générés, non versionnés)
└─ gestion\           LA PARTIE D'ALEXANDRE — pitch, mise en place, lumières, prospection
   ├─ Lancer le jeu.bat        double-clic = démarre le serveur (appelle code\start.ps1)
   └─ Tester les lumieres.bat  double-clic = code\outils\test-hue.js
```

- Tous les chemins du serveur sont relatifs à `__dirname` (y compris `express.static`, corrigé le 2026-10-16) : `node code/server.js` marche depuis n'importe quel dossier.
- **`gestion\` appartient à Alexandre.** Claude n'y touche que sur demande — mais si une modification du code change la mise en place (nouvelle variable `.env`, nouveau port, nouvelle étape de lancement, nouveau rôle…), Claude met à jour la fiche concernée de `gestion\` dans le même mouvement et le signale.
- Le dépôt Git est à la racine (`C:\LoupGarouVoteApp`, branche `master`, remote `https://github.com/MuchachoBonobo/Loup-garou-app`). Il n'est plus dans OneDrive : les problèmes de fichiers tronqués décrits dans le Journal concernaient l'ancien emplacement `OneDrive\Documents\LoupGarouVoteApp`.

## État actuel (vérifié sur le code le 2026-10-16)

### Vue d'ensemble

Application web de Loup-Garou pour jouer **en présentiel** : chaque joueur sur son téléphone, le Maître du Jeu (MJ) sur une tablette ou un PC, tout le monde sur le même Wi-Fi que l'ordinateur qui fait tourner le serveur.

- Serveur Node.js + Express 5 + Socket.io 4, port **3000** (variable `PORT` pour changer).
- Joueurs : `http://<ip>:3000/` — MJ : `http://<ip>:3000/mj` (ou `/mj.html`). Le panneau MJ affiche un QR code de connexion, dessiné par le serveur (`/api/qr.svg`, bibliothèque npm `qrcode`) à partir de `/api/ip` (première IPv4 non interne de la machine). **Le jeu ne fait plus aucune requête vers Internet** : il fonctionne sur un routeur sans connexion.
- Lancement : `gestion\Lancer le jeu.bat` (double-clic), ou `code\start.ps1`, ou `npm start` dans `code\`. `server.js` lit lui-même `code\.env` au démarrage.
- Lumières Philips Hue optionnelles (`LIGHTS_ENABLED=true` dans `.env` — **actuellement activé** sur le PC d'Alexandre).
- **Réseau de jeu** (depuis le 2026-10-22) : routeur de voyage **GL.iNet Opal (GL-SFT1200)**, Wi-Fi « La nuit du village », réseau `192.168.8.0/24`, réglages en `192.168.8.1`. Adresses réservées dans le routeur : **PC du jeu `192.168.8.231`** (MAC `D0:39:57:A7:B5:61`) → jeu toujours en `http://192.168.8.231:3000` ; **Bridge Hue `192.168.8.147`** (MAC `C4:29:96:62:40:E2`, branché sur une prise LAN de l'Opal) → `HUE_BRIDGE_IP=192.168.8.147`. À la maison, câble box SFR → prise WAN de l'Opal (Internet) ; en prestation, pas de WAN, jeu hors ligne. Le PC doit être sur « La nuit du village » pour voir le Bridge.

### Rôles (12)
Loup, Villageois, Voyante, Sorcière, Cupidon, Chasseur, Petite Fille, Idiot du village, Ange, Corbeau, Salvateur, Sœurs jumelles (0 ou 2). Configuration au lobby côté MJ (`mjSectionStart`) + case « Mission ».
- La Petite Fille (règle d'Alexandre, 2026-10-23) : chaque nuit, **après la Voyante**, elle désigne sur son téléphone **3 joueurs vivants, jamais elle-même**, et apprend seulement s'il y a **au moins un loup** parmi eux ou **aucun** (ni lequel, ni combien). La nuit attend son « OK, j'ai vu » (filet 30 s ; 45 s pour choisir). Son tour est sauté s'il reste moins de 3 autres joueurs vivants. Pendant les Loups, elle garde les yeux fermés (même voile que tout le monde). Le MJ voit ses 3 joueurs, la réponse et le nom des loups trouvés. `roles.petiteFilleReveal`, évènements `petiteFilleChoice` / `petiteFilleResult` / `petiteFilleDone`, journal `gameStats.petiteFilleLog` (écran de fin).
- L'Idiot survit à tout vote du village (égalité comprise), meurt de toute autre cause.
- L'Ange (depuis le 2026-10-23) gagne **seul** s'il est désigné au **premier** vote du village (lendemain de la 1ʳᵉ nuit), égalité tranchée comprise (maire ou hasard). Pas s'il est tiré au sort faute de votes, pas si le MJ a passé ce 1er vote, pas s'il meurt la nuit : il est alors un simple villageois. `votes.handleAngeVictoire`, compteur `state.nbVotesJour`.

### Déroulé d'une partie
1. **Lobby** : les joueurs scannent le QR, saisissent leur prénom, prennent un selfie (optionnel). Le MJ règle les rôles, ajoute des bots s'il veut tester, lance.
2. **Révélation du rôle** : carte face cachée à retourner + vibration.
3. **Élection du Maire** : le MJ valide (« ✅ Valider le Maire »), même quand tout le monde a voté — il est alors prévenu par une alerte. Verrouillage automatique seulement en mode autonome.
4. **Mission** (si activée) : le maire choisit 3 envoyés (**il ne peut pas s'inclure** — règle confirmée par Alexandre le 2026-10-22), cartes secrètes Réussite/Échec, bonus d'inspection si réussite.
5. **Crépuscule** (depuis le 2026-10-26, hors mode autonome) : après l'élection du maire (ou la mission) et après chaque fin de jour (vote, vote passé, Idiot, tir du Chasseur, transmission d'écharpe), phase `crepuscule` : les téléphones gardent la carte du maire élu ou du mort, le MJ voit la grande carte « 🌙 Lancer la nuit » (filet 3 min). La nuit ne commence qu'à ce clic (`roles.ouvrirNuit` / `handleMJLancerNuit`). **Nuit rythmée par le MJ** (hors mode autonome) : entre deux étapes, phase `nightPause` (tous les écrans voilés, la voix endort le rôle précédent) et grande carte MJ « ▶ Passer à l'étape suivante » ; le rôle suivant ne se réveille qu'au clic (filet 3 min). Ordre : Cupidon (1ʳᵉ nuit, seulement s'il y a un Cupidon : `roles.startFirstNight`) → Amoureux (1ʳᵉ nuit : chacun voit l'autre, 15 s qui démarrent seules) → Sœurs (si 2 vivantes ; leurs 20 s démarrent seules au réveil) → Salvateur → Loups (ils désignent leur proie d'un toucher, le MJ valide l'attaque ; verrouillage auto au consensus en mode autonome seulement) → Voyante (la nuit attend son « OK, j'ai vu », filet 30 s) → Petite Fille (3 joueurs, « au moins un loup » ou « aucun », attend aussi son « OK ») → Corbeau → Sorcière (sautée si plus de potions ; une question à la fois : « Sauver X ? » avec sa photo, puis « Potion de mort ? », puis la liste avec « Passer ») → résolution. Les phases des rôles morts sont sautées. Voile « garde les yeux fermés » pour tous ceux qui ne jouent pas.
6. **Aube** : carte des morts (photos seulement ; le MJ a le récit complet + rôle). Dans la liste des joueurs, chaque mort affiche ensuite son rôle à droite (évènement `playerDied`).
7. **Jour piloté par le MJ** (`mjPilotedDay`, défaut ON) : **réveil mené par le MJ** (depuis le 2026-10-26) : la carte des morts reste sur les téléphones jusqu'à son « ▶ Lancer le débat » ; s'il y a un évènement du Conseil, il l'annonce d'abord (« 📜 Annoncer l'évènement : … »), puis « Lancer le débat » referme les deux cartes. « Lancer le vote » est grisé pendant le réveil. Puis écran « Parlez entre vous. » côté joueurs, le MJ lance le vote quand il veut. Exception : si un Chasseur, un maire mourant, le bonus de mission ou une fin de partie suit l'aube, la carte se ferme seule (7 s) comme avant. Égalité → le maire tranche. Chasseur, transfert d'écharpe et cascades d'amoureux gérés partout.
8. **Conseil des Morts** : chaque début de journée dès qu'**au moins 1 joueur est mort** (`council.COUNCIL_TRIGGER_THRESHOLD`), les morts votent un évènement appliqué le jour suivant, au moment où le MJ l'annonce (mode autonome : 3 s après l'aube). Les évènements déjà proposés ne reviennent pas tant que la réserve n'est pas épuisée (puis nouveau cycle, notifié au MJ).
9. **Fin** : écran de victoire (Village, Loups, Amoureux ou Ange), rôles révélés, une médaille au plus par joueur (17 médailles, `badges.js`) et classement de la soirée (`soiree.js`).

### Votes du jour (`votes.js startDayVote`)
| Mode | Déclenché par | Durée |
|------|---------------|-------|
| 1 — libre | défaut (bouton MJ) | 60 s |
| 2 — Jugement (vote définitif) | évènement `judgment` | 60 s |
| 4 — Panique (express) | évènement `panic` | 30 s |
| 5 — Émeute (anonyme) | évènement `riot` | 60 s |
| (mode 1) Vote Muet | évènement `voteMute` | 90 s |

Le « sprint final » (raccourci à 30 s quand tout le monde a voté) n'existe qu'en jour non piloté / mode autonome. Battement de cœur + vibration sur les 10 dernières secondes. La cloche sonne côté MJ au lancement du vote.

### Conseil des Morts — 18 évènements (`council.js COUNCIL_EVENTS`)
Émeute, Le Jugement, La Panique, La Paranoïa, La Folie, L'Éclipse, Tempête (tonnerre toutes les 30 s), La Paralysie (ex-Brouillard, id `fog`), Incendie, Les Chuchotements, Le Tribunal, La Cloche du Village, Les Dernières Volontés, Le Vent, Les Morts Murmurent, Le Vote Muet, Les Voix Étouffées (chat écrit pour la journée), L'Abdication (le maire désigne son successeur). La plupart sont des contraintes sociales que le MJ fait respecter ; la règle exacte s'affiche sur la carte MJ (`MJ_EVENT_RULES` dans `mj.html`).

### Modes particuliers
- **Mode autonome** : la partie tourne sans clic MJ (votes auto-démarrés, verrouillages auto). ⚠ Les libellés du menu « mode du vote » dans `mj.html` (90 s / 10 s) ne correspondent plus aux durées réelles du serveur (60 s / 30 s) — à corriger.
- **Mode entraînement** : bots niveau 2 (choix aléatoires cohérents), ajoutés au lobby.
- **Jour non piloté** (case décochée) : ancien comportement, vote lancé automatiquement 2 s après l'aube et vision spectateur complète pour les morts.

### Mise en scène
Narration vocale (synthèse vocale du navigateur, côté MJ, variantes par transition de phase dans `narration.js`), musique d'ambiance jour/nuit + effets sonores (`public/sounds/`, joués sur l'appareil MJ), lumières Hue (scènes par phase, 18 scènes d'évènements, flashs mort/aube/loups/cloche/victoire, scène « pause »), cartes narratives plein écran, cheat sheet MJ contextuelle, écran d'intro, teinte d'écran par phase, vibrations **uniquement de jour**.

### Robustesse
Reconnexion par prénom (registre `playerRegistry`, toutes les phases couvertes), sauvegarde de l'état toutes les 5 s (`snapshots/`) et proposition de reprise au MJ après un crash, timeouts sur chaque phase de nuit, bouton Pause, journaux quotidiens dans `logs/`, nettoyage des crash-snapshots de plus de 7 jours.

## Carte du code — serveur (`code/`)

| Fichier | Lignes | Rôle |
|---------|--------|------|
| `server.js` | ~450 | Bootstrap : lecture `.env`, Express (static, `/mj`, `/api/ip`), Socket.io, middleware pause, câblage des ~47 évènements socket vers les modules, handlers crash / reprise, `http.listen`. Aucune logique de jeu. |
| `state.js` | ~300 | État partagé + toutes les constantes de timeout + helpers (`alivePlayers`, `computeCounts`, `playerName`, `fisherYates`, `buildFullState`, `idActuel`). **Ne jamais déstructurer** (`state.players`, jamais `const { players } = state`). |
| `phases.js` | ~980 | Orchestration : `setPhase` (le cœur : lumières, narration, Conseil, auto-vote), `installPhaseTimeouts`/`clearPhaseTimeouts`, `runBotsForPhase`, `checkVictory`, pause/reprise, `resetGameState`, replay. |
| `roles.js` | ~980 | Rôles, mission, mort : `startNightSequence` (alias `startNightAfterCupid`), `nextNightPhase`, `doResolveNight`, `killPlayer`, `sendDeadVision`, `performChasseurShot`, `performMayorTransfer`, `assignAndStart`, handlers de chaque rôle. `PHASES_DE_NUIT` : liste unique des phases où une mort compte « de nuit » (contexte de transmission d'écharpe). |
| `votes.js` | ~640 | Tous les votes : maire, loups (`wolfConfirm`), jour (`startDayVote`, `resolveDayVote`), égalités (`resolveVoteWithTiebreak`, arbitrage maire / bot), survie de l'Idiot, victoire de l'Ange, skip. |
| `council.js` | ~370 | Conseil des Morts : 18 évènements, tirage, vote, application des effets, Abdication, Voix Étouffées. |
| `narration.js` | ~210 | Dictionnaire des narrations TTS par transition (`"wolves_to_seer"`…). |
| `lights.js` | ~295 | Pilote Hue CLIP v2, fire-and-forget (timeout 1,5 s, jamais d'`await`, jamais de `throw`). `applyScene`, `flash`, `flashSequence`, `reset`, `status`. |
| `lights-scenes.json` | 43 entrées | 16 scènes de phase (dont `petiteFille`, rose pêche), 18 `council.*`, 8 `flash.*` (dont `flash.ange`, blanc doré), `pause`. |
| `badges.js` | ~250 | 17 médailles de fin de partie, **une seule par joueur** (la plus prestigieuse, `RANGS`). |
| `soiree.js` | ~90 | Classement de la soirée (1 point par victoire), fichier `soiree.json` dans le dossier des sauvegardes (non versionné), remis à zéro par le bouton MJ « Nouvelle soirée ». |
| `death-narratives.js` | ~120 | Récits de mort par cause × rôle. |
| `snapshot.js` | ~240 | Sauvegarde périodique, dump de crash, reprise. |
| `logger.js` | ~55 | Journal console + `logs/AAAA-MM-JJ.log`. |

Dépendances : `state` (feuille) ← `narration`, `council` (+`lights`) ← `roles` ← `votes` ← `phases` ← `server`. **`phases`, `roles` et `votes` se requièrent en cycle** : ils doivent finir par `Object.assign(module.exports, {...})`, jamais `module.exports = {...}` (sinon crash au lancement de partie — voir Journal).

## Carte du code — front (`code/public/`)

| Fichier | Lignes | Repères |
|---------|--------|---------|
| `index.html` (joueur) | ~3270 | `render()` (liste des joueurs, avatars, boutons), `updateNightCover()`/`isAnyNarrativeCardOpen()`, `updateDayDebateScreen()`, `updateDeadFullScreen()`, cartes (`showRoleReveal`, `showDeathCard`, `dawnResult`…), `#introScreen`. JS inline — à lire par `Grep` + `offset`/`limit`. |
| `mj.html` (MJ) | ~1700 | Sections `mjSectionStart` (lobby), `mjSectionUrgency`, `mjSectionRoles`, `mjSectionWolves`, `mjSectionMayor`, `mjSectionDay`, `mjSectionDeadChat`, `mjSectionQR` ; `updateMJLayout(phase)` les affiche selon la phase. TTS (`speakNarration`), sons (`playAmbiance`, `playEffect`), `MJ_CHEATSHEET`, `MJ_EVENT_RULES`, cartes MJ (`showMjDeathCard`, `#dayRecapCard`, `#councilEventCard`, `#sistersLauncherCard`, `#crashRecoveryCard`, `#qrFullscreen`). |
| `css/player.css`, `css/mj.css` | 262 / 100 | Styles extraits (une partie des styles reste inline dans les HTML). |
| `test-ui.js` | — | Audit UI exécuté dans la page par `tests/ui-headless.js`. |
| `sounds/` | 22 mp3 | `day.mp3` et `night.mp3` pèsent ~85 Mo chacun (sous la limite GitHub de 100 Mo). `endgame_ange.mp3` (victoire de l'Ange, 3 min 21) : « Alléluia » du Messie de Haendel, London Symphony Orchestra et London Philharmonic Choir dir. Hermann Scherchen (1953), domaine public, version MP3 de Wikimedia Commons (`File:Handel - Messiah, Part 2 (Scherchen) - 45. Hallelujah.ogg`). S'il venait à manquer, `playAmbiance` joue `endgame_village` à la place. |

## Tests et commandes (depuis `code/`)

```bash
node --check server.js          # syntaxe (à faire sur chaque .js modifié)
npm start                       # démarrer le serveur
npm test                        # 11 scénarios d'intégration (Ange ×2, Petite Fille, clics en trop du MJ ×2, pastilles de connexion), ~8 min, port 3099, lumières coupées
npm run test:banc               # banc d'essai : 3 parties complètes jouées par des bots, règles contrôlées à chaque évènement (~10 min ; voir outils/banc-robots.js pour lancer plusieurs bancs en parallèle)
npm run test:hue                # diagnostic de la connexion Hue (lit .env)
npm run test:ui                 # audit UI dans Chrome headless (serveur lancé ; nécessite puppeteer-core, non installé par défaut)
npm run lint                    # ESLint (informationnel)
```

Après toute modification serveur : **arrêter et relancer** le serveur (Node garde les anciens modules en mémoire) et rafraîchir les navigateurs.

## Tâches en attente

- **Étape 8 de la refonte du jour** : playtest réel, mesurer le temps d'écran des joueurs en journée, puis supprimer le toggle `mjPilotedDay` et le mode legacy si validé.
- `server.js.bak` (ancien serveur monolithique, non versionné) traîne dans `code/` : peut être supprimé.
- Ajouter `puppeteer-core` en devDependency si on veut garder `npm run test:ui` (absent : le test d'interface ne peut pas tourner).
- Doublons structurels laissés en l'état (risque de divergence) : les bots recopient la logique des humains au lieu de l'appeler (vote du jour et son « sprint final » dans `phases.runBotsForPhase` vs `votes.handleVoteDay`, Salvateur, Sorcière). À factoriser un jour, avec les tests d'intégration comme filet.

## Idées / améliorations potentielles (non implémentées)

Rappel du principe d'Alexandre (voir `CLAUDE.md`) : l'application s'efface derrière le jeu ; un écran n'apparaît que pour une grosse plus-value.

- **Plus tard (Alexandre aime l'idée)** : écran public sur télé / vidéoprojecteur (ambiance de nuit, morts de l'aube avec photos, votes en direct, évènement du Conseil, victoire) — surtout pour les séminaires avec spectateurs.
- **Écartées par Alexandre (2026-10-23), ne pas reproposer** : liste de vérification avant prestation ; chronique de fin de partie « Ce qu'il s'est vraiment passé » (trop d'écran) ; « dernières paroles » chronométrées. Compositions de rôles : c'est le rôle du MJ (pas de bouton « composition conseillée »).
- Bouton MJ explicite pour activer la mission avant le start.
- Mode « Spectateur » pour rejoindre sans jouer.
- Historique des parties (replay JSON sauvegardé), statistiques multi-parties (taux de victoire par rôle).
- Nouveaux rôles : Ancien (survit au 1er coup des loups), Bouc émissaire.
- Compteur « joueurs ayant voté / total » plus visible.
- Tests unitaires pour `checkVictory`, `resolveVoteWithTiebreak`, `doResolveNight`.
- Outil d'appairage Hue en un script (générer la clé + lister les groupes) pour éviter les commandes `curl` à la main.
- Internationalisation (anglais) — hors-scope tant que le concept n'est pas validé (cf. `CONTEXT.md`).

## Bugs potentiels à surveiller

- `fastResolveTriggered` : réinitialisé dans `startDayVote` et `resetGameState` — vérifier qu'aucun autre chemin ne le laisse à `true` entre deux jours.
- `killPlayer` a plusieurs sorties anticipées (chasseur, mayorTransfer, amoureux) ; les chemins `doResolveNight` → `killPlayer` ne sont pas tous protégés de la même façon par `checkVictory()`.
- Mode autonome + bots : chevauchement possible des sons si les phases s'enchaînent vite.
- Reconnexion pendant la Mission : le re-emit `missionCardChoice` existe, l'UI complète reste à tester en vrai.
- `getLocalIPv4()` prend la **première** IPv4 trouvée : sur un PC avec VPN, Hyper-V/VirtualBox ou Ethernet + Wi-Fi, le QR code peut afficher la mauvaise adresse.

## Comment reprendre

1. Ouvrir Claude Code sur `C:\LoupGarouVoteApp` (le `CLAUDE.md` racine est lu automatiquement).
2. `git pull` avant de commencer.
3. Lire ce document, puis cibler les fichiers via la Carte du code + `Grep`.
4. Après une modification significative : ajouter une entrée en tête du Journal ci-dessous, et mettre à jour l'État actuel si le comportement change.

---

## Journal (du plus récent au plus ancien)

### 2026-10-26 — Le MJ donne le rythme : crépuscule, réveil, évènement ; Sorcière, amoureux, Voyante, lumières
Demandes d'Alexandre après la partie test (« les joueurs iraient tous au même rythme »).
- **Crépuscule — « 🌙 Lancer la nuit »** : la nuit ne démarre plus seule. Après l'élection du maire (ou la mission) et après chaque fin de jour, nouvelle phase `crepuscule` : les téléphones gardent la carte d'avant (maire élu, ou « Le village a tranché ») ; un joueur qui la ferme lui-même voit 🌆 « La nuit approche. ». Le MJ a une grande carte « 🌙 Lancer la nuit » (même modèle que « Passer à l'étape suivante », filet 3 min). Serveur : `roles.ouvrirNuit(premiere)` remplace les appels directs à `startFirstNight` / `startNightSequence` en fin de jour, `handleMJLancerNuit`, `state.nuitEnAttente` (sauvegardé). Téléphones : `fermerCarteAuRythme(fermer, délai, phasesRetenues)` — la carte attend la première phase hors de la liste (5 s au minimum). Mode autonome : inchangé (`nuitParMJ` faux).
- **Réveil mené par le MJ** (choix d'Alexandre : « Le MJ déclenche l'annonce ») : la carte des morts reste jusqu'au MJ (`dawnResult.annonceParMJ`), qui voit « 🌅 RÉVEIL » puis, s'il y a un évènement du Conseil, « 📜 Annoncer l'évènement : … » (l'évènement n'est plus appliqué 3 s après l'aube : `council.annoncerEvenement`), puis « ▶ Lancer le débat » (`finAnnonceMatin` referme les cartes). « Lancer le vote » est grisé pendant le réveil ; lancé quand même (filet), il annonce l'évènement et ferme la carte des morts. Un joueur qui se reconnecte ne découvre l'évènement qu'une fois annoncé. Exceptions où la carte se ferme seule comme avant : Chasseur, maire mourant, bonus de mission, fin de partie à l'aube.
- **Sorcière, une question à la fois** : « Sauver X ? » (photo, Oui/Non) → « Utiliser la potion de mort ? » (Oui/Non) → liste des joueurs avec « Passer » (même vue que le vote). Les boutons de la Sorcière ont quitté la liste des joueurs. `etatPotions` est envoyé avant `nightVictim` (aussi à la reconnexion).
- **Cupidon puis les amoureux** : après le choix de Cupidon, étape `amoureux` (1ʳᵉ nuit) : Cupidon se rendort (voile), les deux amoureux voient chacun la photo et le prénom de l'autre, 15 s qui démarrent seules (`AMOUREUX_TIMEOUT_MS`), puis la nuit continue. Étape visible dans la barre de nuit du MJ ; un amoureux reconnecté retrouve son écran avec le temps restant.
- **Voyante** : la vision se ferme seule au bout de 10 s ; son bouton la ferme tout de suite.
- **Le maire chez le MJ** : toujours affiché dans l'en-tête (🏛️ Prénom) et sur sa ligne dans « Personnages ».
- **Lumières** : le Chasseur et la transmission d'écharpe ont désormais une lumière de jour (avant : encore la nuit au réveil) ; nouvelles scènes `crepuscule` (orangée, transition 3 s) et `amoureux` (rose, pulsation). 46 entrées dans `lights-scenes.json`.
- **Bug corrigé — carte du maire transparente** : la remise à zéro effaçait le fond de `#mayorCard` (inscrit dans son HTML) ; depuis la correction du 2026-10-25 (remise à zéro à chaque lancement), la carte était transparente dans toutes les parties. Au passage : l'initiale d'un avatar sans photo ne donne plus « � » quand le prénom commence par un emoji.
- **Vérifié** : `npm test` 42/42 (le MJ de test clique « Lancer la nuit ») ; banc de robots (le MJ automatique lance la nuit, annonce ou non l'évènement ; contrôles « amoureux sans Cupidon » et « crépuscule en pleine nuit ») ; navigateur, partie réelle avec robots : carte du maire retenue au crépuscule puis voile à « Lancer la nuit », carte du matin toujours là après 12 s puis fermée par « Lancer le débat », carte du vote retenue 25 s au crépuscule, « La nuit approche. », évènement annoncé au clic (Le Tribunal) puis refermé par « Lancer le débat », tablette du MJ rechargée en plein réveil ; écrans de la Sorcière et des amoureux affichés sur le téléphone d'essai.
- **Encore à décider avec Alexandre** : quelles familles d'évènements garder (certains ne « prennent » pas, comme Le Vent) et comment l'évènement s'affiche sur les téléphones.

### 2026-10-25 — Retours de partie test : nouvelle partie, retrait d'un joueur, écrans allégés, photos, rechargement
- **Bug corrigé — « 🚀 Lancer la partie » après une partie terminée** : seul « Relancer » remettait l'état à zéro. Lancée depuis la préparation (visible au salon après la fin), la nouvelle partie gardait les morts, les amoureux, le maire, les statistiques de la précédente, et les téléphones (jamais prévenus) réaffichaient l'ancien écran de victoire après la révélation du rôle ; seul un redémarrage du serveur réparait. `assignRoles` appelle désormais `resetGameState(true)` + `gameReset`, comme `replayGame`. Le registre des joueurs garde aussi la photo à la remise à zéro. Au passage : la carte « Ta médaille » (6 s après la fin) ne surgit plus si la partie a été relancée entre-temps. Reproduit puis vérifié par script ; scénario S12.
- **Retirer un joueur** : au salon, une croix ✕ à côté de chaque nom dans « Joueurs connectés » (écran MJ, avec confirmation). Serveur `retirerJoueur` (MJ, salon seulement) ; le téléphone reçoit `retireParMJ`, oublie son prénom (sessionStorage) et revient à l'écran pour rejoindre (prénom prérempli s'il veut revenir).
- **Écrans allégés** (le texte fait regarder l'écran au lieu de parler) : voile de nuit = 🌙 « Yeux fermés. » ; écran du jour avant le vote = ☀️ « Parlez entre vous. » + petit bouton « 🎴 Mon rôle » (plus de sous-titre, de paragraphe, de photo/nom/statut, ni de « Posez le téléphone ») ; Vote Muet = 🤐 « Silence. ».
- **Photos en grand** : un toucher sur la photo d'un joueur (liste, carte des morts, écran de fin) l'ouvre en plein écran avec son prénom ; un toucher la referme (`ouvrirPhotoZoom`, `#photoZoom`).
- **Bouton ⟳** (coin haut-droit, au-dessus de tous les écrans) : deux touchers (« Recharger ? ») rechargent la page. Une page rechargée se reconnecte désormais toute seule avec le prénom de l'onglet (avant : il fallait retaper « Rejoindre ») et le plein écran revient au premier toucher.
- **« Valider ma proie » retiré** des téléphones des loups : en partie avec MJ, c'est le MJ qui valide (« Valider l'attaque »). Le mécanisme serveur `wolfConfirm` reste (utilisé par les tests) ; le verrouillage automatique au consensus ne joue qu'en mode autonome. Aide-mémoire MJ mis à jour.
- **Vérifié** : navigateur (photo en grand, voile et écran du jour, ⟳ par vrais touchers puis retour automatique dans la partie, croix du MJ et retrait d'un joueur) ; S12 (nouvelle partie + retrait).
- **À repenser avec Alexandre** : les évènements du Conseil des Morts (certains ne « prennent » pas, comme Le Vent ; pas assez clairs ; annonce de l'évènement qui tombe pendant l'annonce des morts — ce dernier point est réglé le 2026-10-26 : c'est le MJ qui annonce).

### 2026-10-23 (suite 5) — Boutons du MJ grisés, médailles plus rares, classement de la soirée
- **Décisions d'Alexandre** sur les propositions de la vérification : boutons grisés oui ; liste de vérification non ; chronique de fin non (« le plaisir n'est pas sur le téléphone ») ; dernières paroles non ; médailles oui mais pas trop ; classement de la soirée oui ; composition conseillée = rôle du MJ ; écran public plus tard. Principe ajouté à `CLAUDE.md`.
- **Boutons grisés** (`mj.html`) : étape du jour `mjEtatVote` = débat / vote / résultat. Débat : « ⏹ Terminer » grisé (il n'y a rien à clore), « 🚀 Lancer le vote » grisé avec compte à rebours « (dans 6 s) » tant que les joueurs voient la carte de l'aube. Vote : « 🗳️ Vote en cours… » grisé. Résultat : tout grisé (« ⏳ Résultat en cours… »), y compris « Passer vote » des contrôles d'urgence, bandeau « ⚖️ VOTE CLOS ». Le serveur envoie `voteClosMJ` au début du dépouillement et l'état du vote dans `mjReconnected` (tablette rechargée). Style `.btn:disabled` dans `mj.css`.
- **Médailles** (`badges.js`) : une seule par joueur et par partie, la plus prestigieuse (ordre `RANGS`). « 🏆 Survivant » (donnée à tous les vivants) supprimée. Nouvelles : 😇 Ange gardien (l'Ange qui gagne), 👧 Fine limière (la Petite Fille qui a repéré la meute), 🎯 Flair (un non-loup qui n'a voté que contre des loups, au moins 2 votes), 🦊 Insoupçonnable (un loup sans aucune voix sur au moins 2 votes). « Roi du Bluff » passe en 🎭 (doublon de 🤡). Les bulletins de chaque vote sont gardés par prénom dans `gameStats.voteLog` (`votes.resolveDayVote`). Carte personnelle : « Ta médaille ».
- **Classement de la soirée** (`soiree.js`) : 1 point par victoire pour chaque joueur du camp gagnant, mort ou vivant (loups ; tous les non-loups ; les deux amoureux ; l'Ange seul) ; bots non classés, partie entre bots non comptée. Enregistré une fois par partie dans `buildSummary` (champ `classement` de `gameSummary`), stocké dans `soiree.json` (survit à un redémarrage). Affiché sur l'écran de fin des téléphones (🥇🥈🥉, ex æquo au même rang, sa propre ligne surlignée) et chez le MJ (panneau « Relancer ») ; bouton « 🔄 Nouvelle soirée » (avec confirmation) dans la préparation de partie, avec le nombre de parties jouées (`soireeMJ`).
- **Vérifié** : navigateur (boutons dans les 3 états, écran de fin avec classement et médaille, bouton Nouvelle soirée) ; médailles sur des fins simulées (max 1 par joueur) ; S6 complété (une médaille au plus, Ange gardien, 1 point pour l'Ange seul, remise à zéro) ; `npm test` 36/36.

### 2026-10-23 (suite 4) — Pastilles de connexion chez le MJ
- `server.js` : `etatConnexions()` / `envoyerConnexionsMJ()` → évènement `connexionsMJ` (id → ok | veille | perdu) ; `players[].connecte` / `ecranVisible` ; évènement `visibilite` envoyé par la page joueur (`visibilitychange`) ; alerte `joueurPerdu` après 5 s de coupure (`DELAI_ALERTE_DECONNEXION_MS`), `joueurRevenu` au retour ; reprise après crash → tous rouges jusqu’à reconnexion.
- `mj.html` : pastille 🟢/🟠/🔴 devant chaque personnage, résumé « 📶 4/6 · 🔴 1 déconnecté · 🟠 1 écran éteint » dans le titre de la section, alertes. Vérifié dans le navigateur.
- **Défaut corrigé au passage** : une tablette MJ rechargée en pleine partie affichait « En attente… » à la place des personnages (le handler `rolesMJ` ignorait la liste des joueurs).
- Nouveau scénario S11 dans `npm test` (états des pastilles, alerte après 5 s, alerte de retour, rien pour un rechargement rapide) : suite complète 32/32. Limite : un téléphone qui se met en veille sans prévenir le jeu peut rester 🟢 jusqu’à ~1 min 30 (délai de détection de Socket.io : 25 s + 60 s) avant de passer 🔴.

### 2026-10-23 (suite 3) — Vérification générale : banc de parties de robots, 6 défauts corrigés
- **Méthode** : relecture des modifications récentes, puis un **banc d'essai** (`outils/banc-robots.js`, `npm run test:banc`) qui fait jouer des parties complètes à des bots — 6 à 15 joueurs, rôles, mission, mode autonome ou nuit rythmée par le MJ, jour piloté ou non, pauses du MJ, tout au hasard — en contrôlant à chaque évènement : ordre de la nuit, aucun rôle mort ou absent réveillé, Petite Fille seulement avec 3 autres vivants, Cupidon seulement la 1ʳᵉ nuit, un jour après chaque nuit et une nuit après chaque jour, règle de l'Ange, justesse du vainqueur, joueur mort deux fois, erreurs du serveur. Le MJ simulé reclique comme un humain si rien ne bouge. 1er banc : 15 parties → 2 anomalies ; reproduction ciblée : 9 parties ; 2e banc après corrections : **15 parties, 0 anomalie, 0 erreur**.
- **Corrigé 1 (grave) — boutons du MJ pendant le suspense d'un vote** : « ⏹ Terminer » appuyé deux fois, ou « Lancer le vote » / « Passer vote » pendant les 8 s de suspense → vote dépouillé deux fois, même éliminé annoncé deux fois, nouveau vote lancé, plusieurs nuits enchaînées. `state.resolutionJourEnCours` (posé par `resolveDayVote`, remis à false par chaque `setPhase` et par `resetGameState`) : les boutons sont ignorés et le MJ est prévenu (« ⏳ Le vote est déjà clos »), les votes des joueurs et des bots refusés ; « Lancer le vote » déjà lancé ne relance plus le compte à rebours. Les minuteries de révélation (2,7 s) et de mort (8,2 s) des 4 chemins s'arrêtent si le jour a été quitté entre-temps : un « Reset » pendant le suspense n'élimine plus personne dans la partie relancée (l'ancien point « à surveiller »).
- **Corrigé 2 — clics tardifs pendant une fin de partie à l'aube** : la partie gagnée reste 7 s dans la dernière phase de nuit avant l'écran de fin ; un « Valider l'attaque », un « J'ai terminé » de la Sorcière, un « Résoudre la nuit » ou un bot y relançaient une **deuxième aube « nuit calme »**. `allerEtapeNuit`/`lancerEtapeNuit` ne font plus rien tant que `state.pendingEndGameTimer` court. Trouvé par le banc, reproduit à coup sûr, test S10.
- **Corrigé 3 — fin de partie périmée** : une victoire constatée pendant une nuit où le Chasseur meurt était mise en attente puis oubliée ; si le tir du Chasseur changeait la donne, elle ressurgissait à l'aube suivante avec un mauvais vainqueur. Le Chasseur tire d'abord, la victoire est réévaluée après son tir (`state.pendingEndGame = null` dans la branche Chasseur de `resoudreNuit`).
- **Corrigé 4 — mode autonome après une pause** : la pause effaçait les filets automatiques (verrouillage des loups, du maire, lancement du vote du jour) sans les réarmer → partie figée (vue par le banc : jour bloqué 12 min). `phases.armerMinuteriesAutomatiques` est appelée à l'entrée de phase et à la reprise.
- **Corrigé 5 — immersion de l'Ange** : pendant le roulement de tambour, les téléphones repassaient sur « Discutez, cherchez les loups », puis encore une demi-seconde avant l'écran de fin. Le vote n'est clos côté écrans qu'à 8,2 s (comme une élimination), la carte de révélation reste jusqu'à l'écran de fin, qui referme désormais toute carte encore ouverte.
- **Tests** : `npm test` 23/23 (S9 boutons du MJ pendant le suspense, S10 clics tardifs pendant une fin à l'aube) ; scripts séparés (double appui, reset pendant le suspense, deux aubes avant/après correction).
- **Limite** : ce sont des bots et un MJ simulé ; une vraie partie avec des téléphones (veille, Wi-Fi, navigateurs) reste indispensable avant une prestation.

### 2026-10-23 (suite 2) — Musique de victoire de l'Ange ; lumière de la Petite Fille
- **Musique** : parmi trois propositions libres de droits (Alléluia de Haendel, « In Paradisum » de Fauré, un chœur moderne de Pixabay), Alexandre a choisi l'**Alléluia** de Haendel, dirigé par Scherchen (1953). Domaine public selon Wikimedia Commons (en Europe, les enregistrements publiés avant 1963 ne sont plus protégés) : utilisable en prestation payante, sans mention obligatoire. Téléchargé dans sa version MP3 (stéréo, 3,3 Mo, lisible aussi sur les tablettes Apple) et installé en `public/sounds/endgame_ange.mp3` ; aucun code à changer. Vérifié dans le navigateur : à la victoire de l'Ange, l'écran du MJ joue bien ce fichier (« 😇 Victoire de l'Ange »), pas la musique de secours.
- Remarque utile pour la suite : sur Pixabay, presque tous les « chœurs angéliques » sont générés par IA ; « Triumph and Choir Revelation » (DPatterson_Composer) est l'une des rares exceptions.
- **Lumière de la Petite Fille** : rose pêche (`xy 0.5/0.35`, `bri 110`) au lieu du lilas, trop proche du violet de la Voyante qui la précède. Fiche Lumières mise à jour. Pas encore vue sur les vraies ampoules.

### 2026-10-23 (suite) — La Petite Fille enquête ; deux défauts de fin de nuit corrigés
- **Recherche d'abord** : aucune trace, ni dans le code (même la première version de mai), ni dans l'historique git, ni dans les conversations Claude enregistrées sur ce PC, d'une Petite Fille « 3 joueurs ». Elle a toujours été « elle entrouvre les yeux pendant les Loups ». La règle a donc été créée. (Le bonus de mission du maire — 3 joueurs, « au moins un loup » — est le mécanisme le plus proche ; il n'a pas changé.)
- **Règle** (Alexandre) : chaque nuit après la Voyante, 3 joueurs vivants désignés (jamais elle-même) → « au moins un loup » ou « aucun ». Choix d'ordre : Loups → Voyante → Petite Fille → Corbeau → Sorcière. Décidé de mon côté : tour sauté s'il reste moins de 3 autres vivants ; mêmes délais que la Voyante (45 s pour choisir, 30 s pour le « OK ») ; le MJ voit tout.
- **Serveur** : `roles.petiteFillePeutJouer`, `nextNightPhase` (étape `petiteFille`), `petiteFilleReveal` (validation : 3 vivants distincts, pas elle), `advanceAfterPetiteFille`, `handlePetiteFilleChoice`/`handlePetiteFilleDone` ; minuteries dans `phases.installPhaseTimeouts`/`clearPhaseTimeouts`/`resetGameState` ; bot Petite Fille dans `runBotsForPhase` ; reconnexion : réponse renvoyée si elle n'a pas encore confirmé (`server.js register`), choix envoyés traduits par `actuel()` ; narration (`*_to_petiteFille`, `petiteFille_to_*`) ; scène Hue `petiteFille` ; son `petite_fille.mp3` (déjà présent, jamais utilisé) joué chez le MJ à la réponse ; récits de mort réécrits (ils parlaient d'yeux entrouverts) ; `gameStats.petiteFilleLog` (+ reprise d'anciennes sauvegardes dans `snapshot.applySnapshot`).
- **Écrans** : joueuse — carte de rôle réécrite, panneau `#petiteFillePanel` (3 choix, désélection possible, bouton « Découvrir » actif à 3), reconstruit avec les bons identifiants si un joueur se reconnecte pendant son choix, réponse sur la carte de nuit avec « OK, j'ai vu ✓ » ; le « OK » est désormais commun à la Voyante et à la Petite Fille (`_confirmationNuitEnAttente` remplace `_visionVoyanteEnAttente`). Voile et absence de vibration pendant son tour pour les autres. Écran de fin : ligne « La Petite Fille a enquêté ». MJ — étape « 👧 Petite Fille » dans la barre de nuit (le libellé « Loups · 👧 » de l'ancienne mécanique est retiré), aide-mémoire, alerte avec la réponse et le nom des loups, libellés de phase et de pause.
- **Défaut corrigé (existant, trouvé en relisant)** : un maire tué **la nuit** transmettait l'écharpe… puis la partie repartait sur une **nouvelle nuit** au lieu du jour. Cause : depuis la nuit rythmée par le MJ, la nuit se résout pendant la pause `nightPause`, absente des listes de phases de nuit recopiées dans `killPlayer` (contexte « day » au lieu de « night »). Les trois listes sont remplacées par `PHASES_DE_NUIT`. Reproduit puis vérifié par script.
- **Défaut corrigé (existant, Voyante comprise)** : une pause du MJ pendant qu'une réponse de nuit est affichée l'effaçait (`clearPhaseTimeouts`) et le « OK » tapé pendant la pause était ignoré → la nuit restait bloquée jusqu'à 45 s après la reprise. `pauseGame` conserve désormais `seerPendingResult`/`petiteFillePendingResult`, `resumeGame` renvoie la réponse au joueur. Vérifié par script (5/5).
- **Défaut corrigé (existant, révélé par les tests)** : une fin de partie à l'aube s'affiche 7 s plus tard ; ce minuteur n'était pas annulé par un reset et pouvait déclarer « fin de partie » au milieu de la partie suivante. Mémorisé dans `state.pendingEndGameTimer`, annulé par `resetGameState`.
- **Au passage** : aide-mémoire MJ de la mission corrigé (« peut s'inclure » → « ne peut pas s'inclure », règle confirmée le 2026-10-22) ; libellé de phase et d'inactivité du Corbeau ajoutés chez le MJ ; fiche Lumières (gestion) : ligne « Petite Fille — Rose pêche » (d'abord lilas, changé à la demande d'Alexandre : trop proche du violet de la Voyante, qui la précède).
- **Vérifié** : `npm test` 18/18 (nouveau S8 : 2 nuits, choix refusé si elle se désigne, « au moins un loup » puis « aucun », la nuit attend son « OK », le MJ voit le loup ; S5 joue désormais avec une Petite Fille bot) ; scripts : reconnexions pendant son tour et tour sauté (6/6), maire tué la nuit (2/2), Petite Fille bot en mode autonome, anciens scripts reconnexions 9/9, loups 5/5, Ange 3/3 ; navigateur : carte de rôle, panneau (exclusion d'elle-même et des morts, 4ᵉ choix refusé, reconnexion d'un joueur choisi), réponse dans les deux cas, « OK » qui prévient le serveur, Voyante toujours fonctionnelle, voile d'un villageois, écran MJ, aucune erreur console.

### 2026-10-23 — Nouveau rôle : l'Ange
- **Règle (choisie par Alexandre)** : l'Ange est un villageois qui gagne **seul** s'il est désigné au **premier** vote du village, celui du lendemain de la 1ʳᵉ nuit. Égalité tranchée en sa défaveur (maire, maire-bot, hasard) : il gagne aussi. Premier vote passé par le MJ : chance perdue. Tué la nuit, ou désigné à un vote suivant : simple villageois (récit « son heure était passée »). Seule exception ajoutée de mon côté : tiré au sort parce que **personne** n'a voté, il ne gagne pas (le village ne l'a pas désigné).
- **Serveur** : `votes.handleAngeVictoire(id)`, appelé par les 4 chemins de résolution du vote du jour (comme l'Idiot) : normal, arbitrage du maire, maire-bot, garde-fou au hasard. Même suspense qu'une élimination, puis évènement `angeRevele` (+ `flash.ange`), puis `checkVictory` termine sur `endGame("ange", …)` grâce à `state.angeVainqueur`. L'Ange n'est pas tué (pas de cascade Chasseur / écharpe / amoureux : la partie s'arrête). `state.nbVotesJour` est incrémenté par `resolveDayVote` et `handleSkipDayVote`, remis à zéro par `resetGameState`, sauvegardé par `snapshot`. Attribution : `config.ange` dans `roles.assignAndStart`.
- **Écrans** : case 😇 dans les réglages du MJ et du « Relancer » ; carte de rôle ; carte de révélation dorée chez les joueurs ; écran de fin « 😇 L'Ange a gagné ! » où lui seul est mis en avant ; alerte MJ ; musique `endgame_ange` avec repli sur `endgame_village` tant que le fichier manque.
- **Vérifié** : `npm test` 11/11 (nouveaux S6 : Ange désigné au 1er vote → victoire ; S7 : 1er vote passé puis Ange désigné au 2e → éliminé comme un villageois) ; script séparé pour l'égalité tranchée par le maire (3/3) ; carte de rôle, révélation, écran de fin et repli musical vérifiés dans le navigateur.
- **Documents mis en cohérence (sans mettre l'Ange en avant, demande d'Alexandre)** : pitch (« 12 rôles », liste), fiche Lumières (flash « l'Ange révélé »), plaquette « Avis à la population » (« Douze rôles », liste, pied « 12 rôles » ; PDF refait avec `plaquettes/rendre-pdf.sh`). Le site, la fiche activité, la plaquette nocturne et la fiche de mise en place ne listent pas les rôles : rien à changer.

### 2026-10-22 (suite 3) — Reconnexions : deux protections générales
- **Pourquoi** : à la reconnexion, un joueur change d'identifiant de connexion ; tout écran ou tout choix qui gardait l'ancien pointait vers un joueur « fantôme ». Le correctif « loups et amoureux » ne traitait que deux cas : celui-ci couvre tout le reste.
- **Protection 1, serveur** : `state.aliasIds` (ancien → nouvel identifiant, rempli dans `register`, remis à zéro par `resetGameState`, sauvegardé par `snapshot`) et `idActuel()` dans `state.js`. Tous les handlers de choix de `server.js` passent la cible par `actuel(...)` : maire, mission, égalité, transmission d'écharpe, Cupidon, Salvateur, loups, Voyante, Corbeau, Sorcière, Chasseur, vote du jour, abdication.
- **Protection 2, écrans** : `traduireIdsApresReconnexion` (`index.html`) et `traduireIdsMJ` (`mj.html`) traduisent par prénom tous les identifiants gardés en mémoire à chaque évènement `players` (votes, compteurs, loups, amoureux, morts, maire, victime de la nuit, cible du Corbeau, rôles…). Côté serveur, `resynchroniserApresReconnexion(socket)` renvoie au joueur revenu les panneaux ouverts : votes en cours (maire, loups, jour), Corbeau, égalité à trancher, transmission d'écharpe, victime pour la Sorcière, Conseil des morts.
- **Bug trouvé par le test** : les votes émis CONTRE un joueur qui se reconnectait restaient sur son ancien identifiant (son propre vote suivait, pas ceux des autres) : il pouvait perdre des voix et une égalité passer inaperçue. Corrigé dans `register` : les cibles de `votesDay`, `votesWolf` et `mayorVote` sont remappées.
- Vérifié par script (9/9 : votes contre et du joueur reconnecté, vote envoyé avec un ancien identifiant, égalité tranchée et tir du Chasseur avec un ancien identifiant, transmission d'écharpe) ; script loups 5/5 ; traduction des deux pages vérifiée dans le navigateur ; `npm test` 7/7.

### 2026-10-22 (suite 2) — Loups et amoureux reconnectés
- **Bug** : après la reconnexion d'un loup, son coéquipier ne le voyait plus dans « Votre identité » et voyait un bouton « Attaquer » sur lui (le serveur refusait déjà ce vote, `votes.handleVoteWolf`). Cause : chaque téléphone de loup garde la liste des loups par identifiant de connexion, qui change à la reconnexion. Même défaut pour les amoureux et Cupidon.
- **Correctif** (`server.js register`) : après le remappage, nouvel évènement `loupsMisAJour` (liste à jour) vers les autres loups, et `loversInfo` vers l'autre amoureux et Cupidon. `index.html` écoute `loupsMisAJour`.
- Vérifié par script (5/5 : avant/après reconnexion, chaque loup reconnaît l'autre) ; `npm test` 7/7.

### 2026-10-22 (suite) — Plein écran moins insistant ; règle de la mission confirmée
- **Plein écran** (`index.html`) : demandé au clic « Rejoindre », puis une seule fois au premier toucher après une reconnexion (`_pleinEcranADemander`, réarmé dans le handler `connect` quand `_wasConnected` et dans `reconnected`). Un joueur qui quitte le plein écran n'est plus forcé d'y revenir à chaque toucher. Vérifié dans le navigateur en comptant les demandes : 1 au clic « Rejoindre », 0 sur deux touchers suivants, 1 de plus après une reconnexion.
- **Mission** : Alexandre confirme que le maire **ne peut pas** s'inclure dans sa mission. C'est ce que fait le code ; l'entrée « Bug fix #4 » du Journal de mai, qui disait l'inverse, est marquée comme annulée.

### 2026-10-22 — Mise en place du routeur « La nuit du village »
- Routeur GL.iNet Opal reçu et configuré avec Alexandre. Premier essai : câbles inversés (box sur une prise LAN, Bridge sur la prise WAN) → le PC recevait une adresse de la box et le Bridge restait invisible. Corrigé : box → WAN, Bridge → LAN.
- Bridge retrouvé en `192.168.8.147` ; `.env` mis à jour (`HUE_BRIDGE_IP`), la clé Hue reste valable ; test des lumières OK. Réservations d'adresses faites par Alexandre dans l'Opal (PC `192.168.8.231`, Bridge `192.168.8.147`).
- `outils/test-hue.js` : messages à jour (« Lancer le jeu.bat », Wi-Fi « La nuit du village »).
- Fiches `gestion/2 - Mise en place` (partie « Le réseau du jeu » : branchements, adresses fixes, partage du Wi-Fi par QR Android) et `gestion/3 - Lumières` (Bridge sur le routeur, condition Wi-Fi) mises à jour.

### 2026-10-21 (suite 8) — Contrôle général du code
- Méthode : scripts d'audit (fonctions jamais appelées hors définition/export, évènements socket envoyés sans écouteur et inversement, champs de `state` jamais lus, `getElementById` sans élément, sélecteurs CSS sans usage, scènes Hue sans usage), puis vérification manuelle de chaque candidat. Résultat : les 81 champs de `state`, toutes les fonctions serveur, les 41 scènes et tous les éléments recherchés sont utilisés.
- **Corrigé** : `gameCycle` émis sans écouteur (supprimé) ; `missionError` jamais affiché (écouteur ajouté côté joueur) ; `corbeauConfirm` écouté mais jamais envoyé (le serveur l'envoie au Corbeau) ; phase fantôme `petiteFille` retirée de 7 listes (+ garde de `handleSetPhase`) ; listes de phases de nuit recopiées → `NIGHT_PHASES_FOR_COVER` (joueur) et `MJ_PHASES_NUIT` (MJ) — la barre de nuit du MJ disparaissait pendant le Corbeau, la carte du maire oubliait Sœurs/Salvateur/Corbeau ; écran de fin : table de rôles locale incomplète (Corbeau, Salvateur, Sœurs) remplacée par `ROLE_DISPLAY` ; `ROLE_LABEL` des récits de mort dédoublonné (`death-narratives.js`) ; libellés du mode autonome alignés sur les vraies durées (60/60/30/60 s) et texte « durée 200 s » corrigé ; morts : `playApplause`, `DEATH_ROLE_EMOJI`, `selectMode`/`selectedMode` ; CSS orphelins (`#petiteFillePanel`, `.btn.purple`, `.grid3`, `.mode-grid`, `.mode-btn`, `.sfx-grid`) ; commentaire « 19 events » ; `public/test-ui.js` adapté (Petite Fille sans panneau).
- **Conservé volontairement** : transitions de narration directes (`wolves_to_seer`…) — utilisées en mode autonome, sans pause ; `fullReset` (tests) ; les trois fonctions auto-exécutées (`initIntro`, `initQR`, `bootRestore`).
- Vérifié : audits relancés (plus aucun candidat), `npm test` 7/7, scripts nuit MJ 10/10, Sœurs 7/7, Conseil 11/11, pages MJ et joueur sans erreur.

### 2026-10-21 (suite 7) — QR code sans Internet
- L'écran MJ chargeait `qrcode.min.js` depuis cdnjs : sans Internet (routeur de voyage), le QR code ne s'affichait pas. Désormais le serveur le dessine : route `GET /api/qr.svg` (`?theme=sombre` pour le petit QR du panneau, noir sur blanc sinon), dépendance npm `qrcode` (^1.5.4). Plus aucune ressource externe dans `public/`.
- Vérifié : les deux QR s'affichent, toutes les requêtes restent locales, le SVG servi est identique à celui de l'adresse attendue ; `npm test` 7/7.
- **À savoir** : Alexandre n'utilise pas la narration vocale pour l'instant (la dépendance de certaines voix à Internet n'est donc pas un problème aujourd'hui).
- Préparation du kit de prestation (discussion) : enceinte, lampes pour les ampoules Hue, câble réseau, multiprise et rallonge, chargeurs, batteries externes, téléphones de prêt, support de tablette, QR imprimés (Wi-Fi + jeu), cartes de rôles papier en secours, RC Pro. À faire à réception du routeur : **réservation d'adresse** pour le PC et le Bridge Hue (QR imprimé stable, lumières sans reconfiguration).

### 2026-10-21 (suite 6) — Conseil des Morts dès le premier mort
- Demande d'Alexandre : le Conseil se réunit dès qu'il y a **au moins 1 mort** (avant : 2). Le seuil vit désormais dans `council.COUNCIL_TRIGGER_THRESHOLD` (= 1), lu par `phases.setPhase("day")` ; la constante, auparavant à 6 et inutilisée, est enfin branchée.

### 2026-10-21 (suite 5) — Conseil des Morts : La Paralysie, Tempête plus fréquente
- « 🌫 Le Brouillard » (interdit de pointer du doigt) devient **« 🧊 La Paralysie »** : interdit de bouger les bras pour s'exprimer. Identifiant interne `fog` conservé (scène Hue `council.fog`, sauvegardes) ; récit, titre et règle MJ (`MJ_EVENT_RULES.fog`) réécrits ; scène lumineuse passée du gris de brume à un bleu glacé.
- **Tempête** : tonnerre (et éclair Hue) toutes les **30 s** au lieu de 40.

### 2026-10-21 (suite 4) — Sœurs : décompte automatique au réveil
- Les 20 s des Sœurs démarrent dès l'entrée en phase `sisters` (`phases.installPhaseTimeouts` → `roles.demarrerTimerSoeurs`), donc au clic MJ « Passer à l'étape suivante ». Supprimés : carte MJ `#sistersLauncherCard`, `mjLaunchSistersTimer`, évènement `mjStartSistersTimer`, `handleMJStartSistersTimer`, filet de 5 min (le décompte se termine toujours), et deux branches mortes du handler `phase` de `mj.html` (« mission » / « lobby », rattachées à l'ancienne carte et jamais exécutées). Le MJ reçoit une alerte « Les Sœurs jumelles ont 20 secondes… ».
- Plus aucun cas particulier : chaque rôle de nuit est réveillé par le même clic MJ et suivi de la même pause.
- Vérifié par script (pause avant les Sœurs, décompte de 20 s reçu au réveil sans autre clic, pause commune après, loups au clic) ; `npm test` 7/7.

### 2026-10-21 (suite 3) — Sœurs alignées sur la règle commune
- Demande d'Alexandre : « pas de cas particulier ». Le bouton « Passer à la suite » propre aux Sœurs (`sistersTimeUp`, `mjSistersNext`, `handleMJSistersNext`, écran « Ferme les yeux. ») est supprimé. À la fin des 20 s, `startNightAfterSisters()` passe par la pause commune (`nightPause` + « Passer à l'étape suivante »). Il reste aux Sœurs, et à elles seules, le bouton MJ « Lancer le timer des Sœurs (20s) » au début de leur tour.
- Le 1er rôle de la nuit passe aussi par la pause (Cupidon la 1ʳᵉ nuit, sinon Sœurs / Salvateur / Loups). Vérifié par script : pause avant les Sœurs, Sœurs réveillées au clic seulement, pause après les 20 s, loups au clic ; pause avant Cupidon la 1ʳᵉ nuit. `npm test` 7/7.

### 2026-10-21 (suite 2) — Nuit rythmée par le MJ
- **Demande d'Alexandre** (option 3 parmi celles proposées) : un joueur qui tarde à fermer les yeux ne doit pas voir l'écran du rôle suivant s'allumer. À chaque fin d'étape de nuit, la nuit s'arrête et le MJ clique « Passer à l'étape suivante ».
- **Mécanisme** (`roles.js`) : point de passage unique `allerEtapeNuit(etape, { sansPause })` → phase `nightPause` (`state.etapeNuitSuivante`) + évènement MJ `etapeNuitEnAttente` ; clic `mjEtapeSuivante` → `handleMJEtapeSuivante` → `lancerEtapeNuit`, qui regroupe les messages propres à chaque rôle (`sistersTurn`, `salvateurTurn`, `corbeauTurn`, `nightVictim`) puis `setPhase`. Étapes : cupid, sisters, salvateur, wolves, seer, corbeau, witch, `aube` (= `resoudreNuit`, ex-corps de `doResolveNight` ; `doResolveNight()` passe désormais par la pause). `etapeApres(phase)` traduit `nextNightPhase`.
- **Tous les chemins y passent** : humains, bots (`phases.runBotsForPhase`), délais de secours (Corbeau, Salvateur, Sorcière, Voyante, Cupidon), fin des loups (`votes.performLockWolfVotes`), début de nuit (`startNightSequence`, `startFirstNight`, mission annulée). **Sans pause** : mode autonome, actions forcées par le MJ (`handleResolveNight`, `handleSetPhase`), sortie des Sœurs après « Passer à la suite » (le MJ vient déjà de cliquer). Filet `NIGHT_PAUSE_TIMEOUT_MS` = 3 min.
- **Côté joueurs** : `nightPause` ajoutée aux phases de nuit (voile pour tous, pas de vibration, carte « la nuit tombe »). **Côté MJ** : carte `#etapeSuivanteCard` (libellé du rôle suivant), restaurée à la reconnexion (`mjReconnected.etapeNuitSuivante`), musique de nuit, aide-mémoire. Narration : `*_to_nightPause`, `<rôle>_to_nightPause` (« … ferme les yeux »), `nightPause_to_<rôle>` (« … ouvre les yeux »), `nightPause_to_day`. Scène Hue `nightPause` (bleu nuit très sombre). Sauvegarde : `etapeNuitSuivante` dans les snapshots.
- `tests/scenarios.js` : le MJ de test clique automatiquement 0,5 s après chaque `etapeNuitEnAttente`.
- Vérifié : script `socket.io-client` (10/10 : pause en début de nuit, aucune avance sans clic, loups → Voyante → Sorcière → jour à chaque clic, la Sorcière ne reçoit la victime qu'après le clic) ; navigateur (carte MJ « Étape suivante : 🐺 Les Loups-Garous », voile « Garde les yeux fermés » côté joueur) ; `npm test` 7/7.
- Fiche `gestion/2 - Mise en place et lancement.docx` : « La nuit avance à ton rythme ».

### 2026-10-21 (suite) — Sœurs : le MJ passe à la suite ; minuteurs indépendants de l'horloge du téléphone
- **Fin des 20 s des Sœurs** : la nuit ne continue plus toute seule. `roles.handleMJStartSistersTimer` pose `state.sistersTimeUp` et émet `sistersTimeUp` (carte MJ « Le temps des Sœurs est écoulé » + bouton « ▶ Passer à la suite » → `mjSistersNext` → `roles.handleMJSistersNext` → `startNightAfterSisters`). Côté Sœurs : 00:00 + « Ferme les yeux. ». Filet de 5 min inchangé. Reconnexion MJ (`mjReconnected.sistersTimeUp / sistersTimerRunning`) et Sœur (`pendingSistersTurn.timeUp`) gérées.
- **Bug « 30 s affichées au lieu de 20 »** : le compte à rebours des Sœurs utilisait l'heure du **serveur** (`startedAt`) comparée à l'heure du **téléphone** ; un téléphone en retard de 10 s affichait 30 s (le serveur, lui, coupait bien à 20 s). Le décompte part désormais de l'heure de réception. Même défaut corrigé pour le vote du jour **après une reconnexion** (`buildFullState.serverNow` + `pendingSistersTurn.timerRemainingMs`) ; `voteStarted` / `voteResumed` compensaient déjà l'écart.
- Aide-mémoire MJ des Sœurs et fiche `gestion/2 - Mise en place et lancement.docx` mis à jour.
- Vérifié : script `socket.io-client` (phase reste `sisters` après 21 s et 3 s de plus, MJ et Sœurs prévenus, `wolves` après le clic) ; navigateur (compteur à 00:20 avec une horloge simulée en retard de 10 s, écran de fin des Sœurs, carte MJ) ; `npm test` 7/7.
- **Question ouverte** (posée par Alexandre) : éviter qu'un joueur qui vient de finir son rôle de nuit, encore les yeux ouverts, voie l'écran du joueur suivant s'allumer. Pistes proposées, non construites : pause de transition entre deux rôles de nuit, écrans identiques jusqu'au toucher, nuit rythmée par le MJ.

### 2026-10-21 — Retours de partie test : plein écran, identité, MJ, maire, Petite Fille, Voyante, rôle des morts, évènement du jour
- **Plein écran** (`index.html` `entrerPleinEcran`) : demandé au clic « Rejoindre », puis au premier clic chaque fois qu'il a été perdu (geste utilisateur obligatoire). Sans effet sur iPhone (Safari ne le permet pas). Non vérifiable dans le navigateur intégré de Claude (il n'accorde pas le plein écran) : à confirmer sur Android.
- **Identité affichée en continu le jour** : le handler `reconnected` n'appelait pas `updateRoleRevealBtn()` → après une reconnexion (fréquente), le bloc « Votre identité » restait visible. Corrigé (+ `updateNightCover()`).
- **MJ : « ? » à la place du rôle d'un joueur reconnecté** : le MJ indexe les rôles par identifiant de connexion. `server.js register` émet désormais `rolesMJUpdate` + `loversInfo` au MJ après le remappage, et met aussi à jour les identifiants de `gameStats.deathLog`.
- **Sécurité** : `rolesMJ` (tous les rôles) était diffusé à **tous les téléphones** au lancement (`io.emit`). Désormais envoyé au seul MJ.
- **Vote du maire** : `checkMayorAutoLock` ne verrouille plus qu'en mode autonome ; sinon alerte MJ unique (`mayorAllVotedNotified`). Aide-mémoire MJ mis à jour.
- **Petite Fille** : panneau `#petiteFillePanel` et son code supprimés ; elle n'est plus « active » pendant les Loups (`isActiveDuringPhase`) → même voile que tout le monde.
- **Voyante** : `roles.seerReveal` / `advanceAfterSeer` / `handleSeerDone` (nouvel évènement `seerDone`). La nuit attend « OK, j'ai vu » (`state.seerPendingResult`, filet `SEER_ACK_TIMEOUT_MS` = 30 s). Le bot Voyante passe par les mêmes fonctions et confirme après un délai. Vision renvoyée si la Voyante se reconnecte avant de confirmer.
- **Rôle des morts dans la liste** : remplace la tête de mort à droite (`.role-mort`), alimenté par `playerDied` (déjà diffusé avec le rôle) + `deathLog`. Choix d'Alexandre, qui revient sur la décision de mai (« les joueurs ne voient plus le rôle des morts »).
- **MJ : évènement du jour** : bandeau `#councilActiveBanner` avec titre + règle (`MJ_EVENT_RULES`) + bouton « 📖 Revoir la carte » ; restauré à la reconnexion du MJ (`mjReconnected.activeCouncilEvent`).
- **Bug corrigé au passage — première nuit sans Cupidon** : la nuit 1 passait toujours par la phase `cupid` et attendait 60 s (`CUPID_TIMEOUT_MS`) quand il n'y avait pas de Cupidon. `roles.startFirstNight()` saute l'étape. Narration `missionVote_to_wolves` ajoutée.
- Vérifié : navigateur (MJ + joueuse + bots) pour maire, nuit sans Cupidon, Voyante bot, identité après coupure, rôles MJ sans « ? », rôle des morts, bandeau MJ, carte Voyante (« OK » obligatoire), voile de la Petite Fille (simulé) ; script `socket.io-client` pour la Voyante humaine (la nuit reste en `seer` sans « OK », passe au jour après) ; `npm test` 7/7.

### 2026-10-18 — Écran de débat adapté au Vote Muet et aux Voix Étouffées
- **Décision d'Alexandre** : le MJ lance le vote à chaque fois, y compris pour les évènements qui modifient le vote (aucun ne le démarre automatiquement) ; le Vote Muet garde 90 s.
- `public/index.html` : variable `evenementDuJour` (posée par `councilEventActive` et à la reconnexion, remise à `null` par `councilEventEnd` et `gameReset`). `updateDayDebateScreen()` lit `DD_TEXTES` : pendant le **Vote Muet**, l'écran annonce seulement « Silence. Le vote va bientôt commencer. » (🤐) au lieu de « Discutez ». Pendant **Les Voix Étouffées**, l'écran de débat reste fermé : il recouvrait le chat écrit `#silentDayChatPanel`, ce qui rendait l'évènement injouable (bug antérieur). C'est sans risque depuis que les boutons « Voter » n'existent qu'une fois le vote lancé.
- Vérifié dans le navigateur (évènements simulés côté joueur) : écran « Silence » pour le Vote Muet ; chat « La Place du Parchemin » visible et 0 bouton « Voter » pour Les Voix Étouffées ; retour à l'écran normal sans évènement.

### 2026-10-18 — Jour piloté : plus de vote possible avant le lancement par le MJ
- **Bug** : pendant la journée, avant « Lancer le vote », les joueurs voyaient la liste avec des boutons « Voter » et les votes des bots. Trois causes cumulées :
  1. `phases.js runBotsForPhase("day")` : les bots votaient dès l'aube, sans le garde `voteTimer` que `handleVoteDay` applique aux humains → leurs votes s'affichaient chez tous ;
  2. `index.html render()` créait les boutons « Voter » dès que `voteActive` (mis à `true` à l'aube), en comptant sur l'écran de débat pour les masquer ;
  3. `closeRoleCard()` ne redessinait pas la page : après fermeture de la carte de rôle, l'écran de débat restait caché jusqu'au prochain évènement.
- **Correctifs** : garde `mjPilotedDay && voteTimer == null` dans le vote des bots, et `startDayVote` relance `phases.runBotsForPhase("day")` en mode piloté ; boutons et `voteDay()` conditionnés à `!mjPilotedDay || currentVoteMode !== 0` ; `scheduleRender()` à la fermeture de la carte de rôle.
- Vérifié dans le navigateur (MJ + 1 joueur + 5 bots) : avant le lancement, écran de débat affiché, 0 bouton, 0 vote ; après « Lancer le vote », 5 boutons et 5 votes de bots. `npm test` 7/7.
- **À vérifier** : la 1ʳᵉ nuit est restée >30 s en phase `cupid` dans une partie **sans Cupidon** (le joueur humain n'avait pas encore retourné sa carte de rôle). Probablement l'attente de `nightCardShown` puis le timeout de 60 s, mais à confirmer.

### 2026-10-18 — Reconnexions : identité par onglet, délai de détection allongé
- **Bug** : en testant avec un onglet par joueur, tous les onglets se reconnectaient sous le **dernier prénom saisi** (le prénom de reconnexion vivait dans `localStorage`, partagé par tous les onglets) ; les autres joueurs perdaient leur place. Visible dans les journaux : chaque onglet déconnecté ~75 s après l'ouverture du suivant (onglets en arrière-plan mis en veille par Chrome), puis un seul prénom revenait.
- **Correctif** (`public/index.html`) : prénom et photo de reconnexion dans `sessionStorage` (propre à l'onglet, survit au rechargement) via `lireIdentite` / `ecrireIdentite` ; `localStorage` ne sert plus qu'à pré-remplir le champ et à sauter l'intro. Pas de `register` automatique si l'onglet n'a pas d'identité. Reconnexion immédiate sur `visibilitychange` / `pageshow` (joueur et MJ).
- `server.js` : Socket.io `pingInterval 25 s / pingTimeout 60 s` (au lieu de 25 / 20) : un verrouillage d'écran bref ne déclenche plus de déconnexion.
- Vérifié : 3 onglets (Alice, Bruno, Chloé) coupés puis reconnectés reviennent chacun sous leur prénom ; `npm test` 7/7. Une déconnexion pendant que le téléphone est verrouillé reste normale (le navigateur met la page en pause) — l'important est le retour sous le bon prénom.
- Fiche `gestion/2 - Mise en place et lancement.docx` : dépannage « site inaccessible » (Wi-Fi SFR FON, redémarrage, Node.js Privé + Public), téléphone verrouillé, essai la veille d'une prestation, test à plusieurs onglets.

### 2026-10-17 (suite) — Documents de gestion passés en Word, grille de prix
- Tous les documents de `gestion/` (y compris `Prise de contact/` et `prive/`) sont désormais des **.docx** en Calibri, fabriqués via Word (COM) à partir des anciens .md, qui ont été supprimés. Word est maintenant la source : ne pas recréer de .md.
- Nouveaux : `gestion/6 - Prix.docx` (300 € la 1ʳᵉ heure, 150 € l'heure suivante, jusqu'à 15 personnes ; ×2 avec 2 MJ ; déplacement compris jusqu'à 30 km de Lyon puis 0,50 €/km) et `gestion/Prise de contact/Guide d'appel - seminaire 90 personnes.docx`.
- **À construire si une prestation à 2 MJ se concrétise** : faire tourner deux parties simultanées (deux serveurs sur deux ports, `PORT` et `SNAPSHOT_DIR` distincts, deux groupes Hue).

### 2026-10-17 — Prospection, site internet, dossier privé
- **Le dépôt GitHub est PUBLIC** : les coordonnées de prospects vont dans `gestion/prive/` (ignoré par Git, ajouté au `.gitignore`), jamais dans les fiches versionnées. `4 - Prospection` ne garde qu'un résumé anonyme des demandes.
- Deux demandes d'entreprises reçues via le site (30 et 90 personnes) : le marché semble venir des entreprises plus que des particuliers, avec des groupes plus grands qu'une partie (8 à 15 joueurs) → piste « plusieurs parties à tour de rôle / plusieurs tables ».
- **Site internet** : dossier `C:\Users\alexa\Desktop\site-loupgarou` (hors dépôt), hébergé sur **Netlify** (mise à jour par glisser-déposer du dossier dans l'onglet Deploys), domaine `lanuitduvillage.fr`, formulaire via Formspree. Textes alignés sur le jeu réel (couleurs des lumières, 8 à 15 joueurs, ~30 min par partie), chevauchement « Découvrir » / bouton corrigé. Le guide de déploiement, qui était publié par erreur, est rangé dans `gestion/5 - Site internet (deploiement)`. Les avis du site sont de vrais retours de parties tests.

### 2026-10-16 — Réorganisation du dossier en `code/` + `gestion/`, documentation remise à jour
- Tout le technique est déplacé dans `code/` ; nouveau dossier `gestion/` (pitch, mise en place Wi-Fi, lumières, prospection) pour Alexandre, avec `Lancer le jeu.bat`. Nouveau `LISEZMOI.md` à la racine.
- Renommages : `_run_scenarios.js` → `tests/scenarios.js`, `_run_tests.js` → `tests/ui-headless.js`, `test-hue.js` → `outils/test-hue.js`, `ANALYSE_RAPPORT.md` → `docs/ANALYSE-2026-05-07.md`. Chemins internes corrigés (`cwd` du runner, `.env` lu par test-hue).
- `server.js` : `express.static("public")` → `express.static(path.join(__dirname, "public"))`, sinon le jeu ne trouvait plus ses pages s'il était lancé depuis un autre dossier.
- `package.json` : scripts `test`, `test:ui`, `test:hue` ; `eslint.config.js` couvre `tests/` et `outils/`.
- `.claude/launch.json` (qui pointait par erreur vers un autre projet) → configuration `loupgarou` (port 3000). ⚠ L'outil de preview lit le `launch.json` du projet ouvert dans la session : depuis une session ouverte sur un autre projet, tester plutôt avec `PORT=3098 LIGHTS_ENABLED=false node code/server.js` + `curl`.
- **Bug corrigé — les tests laissaient une fausse partie « à reprendre »** : `npm test` écrivait `snapshots/state-snapshot.json` (partie de bots en phase `seer`), que le vrai jeu proposait ensuite en reprise après crash au MJ. `snapshot.js` accepte désormais `SNAPSHOT_DIR` (dossier de sauvegarde), et `tests/scenarios.js` utilise un dossier temporaire qu'il supprime à la fin.
- `gestion/Tester les lumieres.bat` : double-clic qui lance `outils/test-hue.js`.
- HANDOFF : nouvelle section « État actuel » revérifiée sur le code. Corrections : 18 évènements du Conseil (pas 19), mode 2 Jugement = 60 s (pas 200 s), Conseil dès 2 morts et à chaque jour (pas « une séance par partie à ≤ 6 vivants »), 41 scènes de lumière, tailles de fichiers réelles.

### Mai 2026 — construction initiale (entrées historiques, non datées au jour près)

> Ces entrées décrivent le projet au moment où elles ont été écrites, quand le dossier vivait encore dans OneDrive. Les noms de fichiers cités sont relatifs à `code/` aujourd'hui ; `_run_scenarios.js` est devenu `tests/scenarios.js`.

#### Correctifs audit bugs (mai 2026) (`roles.js`, `server.js`, `phases.js`, `public/index.html`)

Quatre bugs corrigés suite à un audit complet :

**BUG 1 — Morts perdues si chasseur tué la nuit et sorcière a aussi agi** (`roles.js`)  
Si `doResolveNight()` s'interrompait pour passer en phase `chasseur`, les morts restantes dans `deaths` (ex: cible de la Sorcière) n'étaient jamais ajoutées à `state.deadPlayers`. Ces joueurs restaient « vivants » côté client. Fix : bloc catch-up symétrique au bloc `mayorTransfer` déjà existant — manipulation directe de `state.deadPlayers` sans appel à `killPlayer` pour ne pas provoquer de changements de phase intempestifs.

**BUG 2 — Reconnexion pendant phase Corbeau/Sorcière/Chasseur bloquait l'UI 45-90s** (`server.js`)  
Le handler de reconnexion ne ré-émettait pas `corbeauTurn`, `nightVictim`, ni `chasseurMustShoot`. Ajout de 3 blocs conditionnels après le bloc existant `wolfVotesUpdate`.

**BUG 3 — Barre de progression erronée après reconnexion en mode 2** (`public/index.html`)  
`modeDurations[2]` valait 200000 ms au lieu de 60000 ms → barre trop longue. Corrigé.

**BUG 4 — Message `autoResolve` visible par tous les joueurs pour les timeouts nocturnes** (`phases.js`)  
Les timeouts Sorcière, Voyante, Corbeau, Cupidon, Salvateur, Sœurs émettaient en broadcast. Changé en `if (state.mjSocketId) state.io.to(state.mjSocketId).emit(...)` pour envoyer uniquement au MJ.

#### Bannière « action en cours » — Chasseur et transfert de maire (mai 2026) (`public/index.html`, `public/css/player.css`)

Quand le Chasseur ou le Maire mourant choisit sa cible/successeur, les autres joueurs voient maintenant un bandeau fixe en bas d'écran : `#actionPendingBanner` (z-index 9150, animation `actionPulse` douce). Il s'affiche par-dessus l'UI normale mais n'écrase pas les cartes narratives (z-index 9998+).

- **Chasseur** : `updateActionPendingBanner()` appelé dans `chasseurMustShoot` — condition `phase === "chasseur" && !isChasseurDead` (le Chasseur lui-même a `isChasseurDead=true` et voit son panel de tir plein écran z-index 9500).
- **Transfert maire** : appelé dans `mayorMustTransfer` avant le `return` anticipé — condition `phase === "mayorTransfer" && socket.id !== dyingMayorId` (le Maire mourant gère son propre tiebreakPanel z-index 10000).
- **Nettoyage** : masqué dans le handler `phase` (sortie de phase), `mayorTransferred`, `gameEnd` et `gameReset`.

#### UX vote du jour + battement de cœur (mai 2026) (`public/index.html`, `public/css/player.css`)

**Battement de cœur renforcé** : animation `heartbeatPulse` plus ample (scale 1.4 au lieu de 1.15, cycle 0.65s), `bgPulse` plus rouge (`#280404`). À l'entrée des 10 dernières secondes, une vibration unique `[120,80,120,80,200]` est déclenchée via `vibrateIfDay` (flag `_heartbeatVibrated` resetté à chaque `startCountdown`/`stopCountdown`).

**Checkmark de vote** : nouvelle variable `myDayVote` (id de la cible courante). Dans `render()`, si `myDayVote===p.id` → affiche `<span class="voted-check">✅</span>` ; sinon affiche le bouton Voter (ou rien si verrouillé). Changer de vote déplace le check automatiquement. Resets : `voteStarted`, `voteTimerEnd`, `gameReset`. Restauration depuis `votesDayDetail[socket.id]` au `votesDayPublic` (reconnexion mode 1). Mode 5 (anonyme) : `myDayVote` posé localement au moment du clic, non transmis aux autres.

#### Bug fix — Cascade nuit, écran débat post-transfert jour, carte médailles personnelle (mai 2026) (`roles.js`, `public/mj.html`, `public/index.html`)

**Bug A — Nuit lancée automatiquement après cascade première nuit** (`roles.js`)
Scénario : Chasseur tue le Maire (Chasseur tirant en phase `chasseur`). Si la cible du Chasseur est un amant de Cupidon dont le partenaire est le Maire, le bloc amants `killPlayer` (ligne ~406) calculait `mayorTransferContext = "day"` au lieu de `"chasseur"` car la phase `"chasseur"` n'était pas dans la liste `nightP`.
**Fix 1** : ce bloc utilise désormais le même calcul que les autres blocs : `state.phase === "chasseur" ? (chasseurPostContext==="day" ? "chasseurFromDay" : "chasseur") : nightP.includes(state.phase) ? "night" : "day"`.
**Fix 2** : dans `performMayorTransfer()`, le `else` final (fallback pour ctx inconnus/vides) n'appelle plus `startNightSequence()` mais `phases.setPhase("day")`. Le `ctx === "day"` est rendu explicite (`else if`).

**Bug B — Écran de débat absent après transfert de maire en cours de journée** (`public/mj.html`)
Cause : `dayVoteResult` déclenche `showDeathCard()` côté joueur (5 s auto-close). Si le MJ cliquait "Lancer le vote" avant la fermeture de la carte (5,6 s), `currentVoteMode` passait à non-zéro et `updateDayDebateScreen()` ne s'affichait jamais.
**Fix** : dans le handler `dayVoteResult` du MJ, `_mjLaunchVoteUnlocksAt = Date.now() + 6500` est posé (5 s carte + 0,6 s fermeture + 0,9 s tampon).

**Feature — Carte médailles personnelle en fin de partie** (`public/index.html`)
L'ancienne `showChronique()` (Chronique du Village) est remplacée par `showPersonalBadgeCard()`. La carte affiche uniquement les médailles gagnées par le joueur courant (lookup dans `summary.badges[myName]`). Si aucune médaille → aucune carte affichée.

#### Bug fix — Vote prématuré + tooltips médailles (mai 2026) (`public/mj.html`, `public/index.html`)

**Bug 3 — Écran de débat absent si le MJ lance le vote dans les 9 premières secondes après l'aube** (`public/mj.html`)
Cause : les joueurs voient la `dayDeathCard` pendant 7 s (auto-close). Si le MJ clique "Lancer le vote" pendant cette fenêtre, `voteStarted` arrive et pose `currentVoteMode !== 0`. Quand la `dayDeathCard` se ferme, `updateDayDebateScreen()` vérifie `!voteRunning` → false → écran de débat jamais affiché.
**Fix** : nouveau flag `_mjLaunchVoteUnlocksAt` posé à `Date.now() + 9000` dans le handler `dawnResult`. Dans `launchVote()`, si `Date.now() < _mjLaunchVoteUnlocksAt`, un message d'attente est affiché via `showAlert` et l'emit est bloqué (9 s = 7 s carte aube + 0,6 s fermeture + 1,4 s tampon).

**Feature — Médailles cliquables avec description** (`public/index.html`)
Au clic sur un badge dans `#endBadgesPanel`, un texte explicatif (champ `desc` de `badges.js`) apparaît/disparaît sous le chip. La description est rendue dans un `<span>` caché à l'intérieur du chip ; l'`onclick` bascule `display:none ↔ block`.

#### Bug fix — Musique de nuit et voile Cupidon (mai 2026) (`public/mj.html`, `public/index.html`)

**Bug 1 — Musique de nuit pendant mayorTransfer en contexte jour** (`public/mj.html`)
Quand la sorcière-maire se sauve la nuit, tue le chasseur avec la potion de mort, et que le chasseur tire sur le maire à l'aube, les phases `chasseur` puis `mayorTransfer` déclenchaient `playAmbiance("night")` même si `dawnResult` venait de passer en musique de jour.
**Fix** : nouveau flag `_mjDawnContext` (false par défaut). Posé à `true` dans le handler `dawnResult` quand `playAmbiance("day")` est joué. Effacé à l'entrée des vraies phases de nuit (`cupid`, `wolves`, etc.). Pour `chasseur` et `mayorTransfer`, la musique de nuit n'est jouée que si `!_mjDawnContext`.

**Bug 2 — Voile « garde les yeux fermés » absent pendant la phase Cupidon** (`public/index.html`)
La 1ʳᵉ nuit, le voile n'apparaissait pas pendant la phase Cupidon. Cause double :
- `showNightFallCard()` n'était pas appelé à l'entrée de `cupid` (liste line 1673 excluait `cupid`).
- La callback de fermeture de la carte Maire (`showMayorCard`) ne rappelait pas `showNightFallCard()` pour `cupid` (liste line 728 excluait `cupid`).
**Fix** : `cupid` ajouté aux deux listes. Le guard `mayorCard.hasAttribute("data-open")` dans `showNightFallCard` gère proprement la séquence : appel immédiat retourné (carte encore ouverte) → la callback de fermeture de la carte Maire (~5 s après l'élection) appelle `showNightFallCard()` → le voile apparaît. Le serveur attendait déjà `nightCardShown` pendant la phase `cupid` (server.js ligne ~393).

#### Lumières — refonte complète + UX + intro gothic (session mai 2026) (`lights.js`, `lights-scenes.json`, `roles.js`, `votes.js`, `council.js`, `phases.js`, `snapshot.js`, `public/index.html`, `public/css/player.css`)

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

#### Robustesse + UX — Session mai 2026 (`server.js`, `council.js`, `state.js`, `snapshot.js`, `public/index.html`, `public/mj.html`)

**Reconnexion — IDs manquants** (`server.js`, handler `register`) : trois champs d'état n'étaient pas migrés lors du changement de socket ID : `state.protectedTarget`, `state.lastProtectedTarget`, `state.pendingChasseurAfterTransfer`. Un joueur qui reconnectait pendant la phase `salvateur` (ou juste après) pouvait ne plus être la cible protégée. `state.wolfConfirmed` (Set) était aussi ignoré. Les quatre migrations sont maintenant présentes dans le handler `register` après les migrations existantes.

**Reconnexion — Mission en cours** (`server.js`, handler `register`) : un joueur qui reconnectait pendant la phase `missionVote` ne recevait pas `missionCardChoice` — il voyait un écran vide et ne pouvait pas voter. Ajout d'un re-emit ciblé `missionCardChoice` si `state.phase === "missionVote" && state.mission.team.includes(socket.id) && !state.mission.cards[socket.id]`.

**Reconnexion MJ — Cible nuit** (`server.js`, `public/mj.html`) : si le MJ se déconnecte après la phase `wolves` (pendant `seer`, `corbeau` ou `witch`), il ne savait pas qui avait été ciblé. `nightTarget` est maintenant inclus dans le payload `mjReconnected`. La mj.html le lit et : affiche un bandeau d'alerte (`showAlert`) + injecte le nom dans `#wolfVotes` (visible dès que la section loups est réouverte).

**Conseil des Morts — 2ème cycle** (`council.js`) : quand tous les évènements du pool ont été proposés, `pickRandomCouncilOptions` réinitialisait silencieusement. Il logue maintenant un message et émet une notification MJ : « 👻 Le Conseil reprend — les esprits ont épuisé leurs requêtes ».

**Dead code `councilEverTriggered`** supprimé (`state.js`, `phases.js`, `snapshot.js`) : ce flag était initialisé à `false` mais jamais mis à `true` ni lu pour décision de jeu. Retiré des trois fichiers.

**Écran d'intro gothic** (`public/index.html`) : nouvel `#introScreen` plein écran affiché au premier chargement (lune animée, emoji loup, titre LOUP-GAROU). Disparaît au toucher, après 6 secondes, ou immédiatement pour les reconnecteurs (`localStorage.lgName` présent). CSS dans `<style>`, HTML avant `#endCard`, JS en IIFE au démarrage.

**Avatars dans la liste joueurs** (`public/index.html`, `render()`) : nouvelle fonction `playerAvatar(p, size)` — retourne une `<img>` ronde si le joueur a une photo, sinon un cercle initiale/couleur déterministe (palette de 8). Injecté en premier flex-child de chaque `player-row` dans `render()`.

#### Runner de tests d'intégration (mai 2026) (`_run_scenarios.js`, `server.js`)

**Fichier** : `_run_scenarios.js` — runner autonome, `node _run_scenarios.js`. Lance un serveur sur le port 3099, connecte de vrais sockets socket.io-client, et vérifie 5 scénarios bout-en-bout. Tous les scénarios passent (7/7 assertions). Durée : ~160s (S5 autoMode est le plus long).

**Événement `fullReset`** (`server.js`) : nouvel événement MJ qui appelle `resetGameState(false)` (vide `state.players`) pour isoler chaque scénario. Sans ça, les sockets du scénario N resteraient dans `state.players` et l'attribution de rôles du scénario N+1 serait faussée.

**Scénarios** :
- **S1** — Chasseur tué la nuit + Sorcière empoisonne : vérifie que les deux morts sont dans `deadPlayers` après `dawnResult` (régression bug 1).
- **S2** — Reconnexion Corbeau pendant sa phase : vérifie la réception de `corbeauTurn` après reconnexion (régression bug 2).
- **S3** — Reconnexion Sorcière pendant sa phase : vérifie la réception de `nightVictim` après reconnexion (régression bug 2).
- **S4** — Chasseur lynché au vote du jour : vérifie que `chasseurMustShoot` est reçu après `lockDayVotes`. Note de timing : `lockDayVotes → 800ms → resolveDayVote → 8200ms → killPlayer(chasseur) → chasseurMustShoot` = ~9s ; timeout du test = 13s.
- **S5** — Smoke test autoMode bots : partie complète sans intervention humaine, `gameEnd` dans les 245s. Config : 5 bots, 1 loup, 1 voyante (1 seul loup garantit le consensus et évite le timeout loups 120s).

**Pièges à retenir** :
- Les listeners (`deadPlayers`, `phase`) doivent être posés AVANT l'action qui déclenche l'événement (race condition socket.io-client).
- `dawnResult` et `phase:"day"` sont émis dans la même boucle synchrone ; les deux promesses peuvent être créées en parallèle avant le déclenchement.
- Le vote du jour avec `mjPilotedDay:true` requiert `mj.emit("startVote")` d'abord ; les votes arrivant avant le démarrage officiel sont rejetés.
- Ne pas tuer le maire (players[0]) avec les loups — déclencherait `mayorTransfer` avant `phase:day`.

#### Bug fixes — Audit serveur (mai 2026) (`roles.js`, `phases.js`, `votes.js`, `state.js`)

Quatre corrections issues d'un audit complet des chemins d'état :

**Guard `doResolveNight`** (`roles.js`) : si deux handlers nuit (ex. `witchDone` + `resolveNight` MJ) arrivent dans le même tick Node.js, seul le premier s'exécute. Ajout de `if (state.inNightResolution) return;` au début de `doResolveNight` — `inNightResolution` étant déjà posé à `true` par la résolution en cours, le second appel est écarté sans effet de bord.

**`corbeauTarget` au skip de jour** (`votes.js`, `handleSkipDayVote`) : quand le MJ skippe le vote du jour, `state.corbeauTarget` n'était pas remis à `null`. Au jour suivant, `setPhase("day")` le réémet en `corbeauVotesPublic` et `resolveDayVote` injecte deux votes fantômes sur une cible obsolète. Ajout de `state.corbeauTarget = null` dans `handleSkipDayVote`.

**`tiebreakTimeout` invisible au reset** (`votes.js`, `phases.js`) : le timeout de 30 s du tiebreak était une variable locale au module `votes.js`, inatteignable de `resetGameState`. Si la partie était réinitialisée pendant un tiebreak en cours, le timeout pouvait se déclencher dans la nouvelle partie. Nouvelle fonction exportée `clearTiebreakTimeout()` dans `votes.js` ; appelée depuis `resetGameState` à la place des trois lignes d'état direct.

**Timeout de la Voyante** (`state.js`, `roles.js`, `phases.js`) : la phase `seer` était la seule phase de nuit sans timeout — si la Voyante se déconnectait, la partie restait bloquée. Ajout de `SEER_TIMEOUT_MS = 45000` (constante dans `state.js`), `seerTimeout: null` (champ d'état), et du bloc timeout dans `installPhaseTimeouts`. Le timeout auto-avance vers `corbeau`, `witch` ou `doResolveNight` selon `nextNightPhase`. `clearPhaseTimeouts` et `resetGameState` nettoient le timer. L'appel `clearTimeout(state.witchTimeout)` dans `handleSeerChoice` et le bot voyante était sémantiquement faux (witchTimeout est null pendant seer — fonctionnait par accident) ; corrigé en `state.seerTimeout`.

#### Bug fix — Successeurs du maire : exclure les joueurs morts simultanément (mai 2026) (`roles.js`, `public/index.html`)

**Problème** : quand les loups tuaient le **maire** ET que la **sorcière** tuait un autre joueur la même nuit, la boucle `doResolveNight` se cassait dès que `killPlayer(maire)` passait la phase en `mayorTransfer`. La cible de la sorcière n'était donc jamais ajoutée à `state.deadPlayers`. Elle apparaissait à tort dans la liste des successeurs potentiels côté client (et le serveur l'acceptait comme successeur valide).

**Fix serveur** (`roles.js`, `doResolveNight`) : après la boucle principale des `deaths`, si `state.phase === "mayorTransfer"`, un second parcours traite les morts restantes non encore dans `deadPlayers`. Un mort ordinaire est passé à `killPlayer()`. Un chasseur est ajouté manuellement à `deadPlayers` (avec émission `deadPlayers` + `playerDied`) et mémorisé dans `state.pendingChasseurAfterTransfer` pour tirer après le transfert.

**Fix client** (`public/index.html`, handler `mayorMustTransfer`) : le code de construction des boutons est extrait dans une fonction `buildMayorTransferButtons()`. Elle est appelée à l'arrivée de `mayorMustTransfer` (best-effort) ET dans `openTransferPanel()` (juste avant l'ouverture réelle du panneau). Le panneau n'ouvre qu'après la carte d'aube (plusieurs secondes), ce qui laisse le temps au `deadPlayers` mis à jour d'arriver — au moment où le panneau s'ouvre, les boutons sont reconstruits avec la liste fraîche.

#### Bug fix — Maire mourant + Chasseur amoureux (mai 2026) (`roles.js`, `state.js`, `phases.js`, `public/index.html`)

Deux bugs dans les scénarios impliquant mort du maire et/ou chasseur.

**Bug A (critique, serveur)** — `roles.js` `killPlayer`, bloc amoureux `else if (isMayorDying)` :
Quand le **maire** meurt et que son **amoureux est le chasseur** (deux personnes distinctes), le code appelait `setPhase("chasseur")` alors que `majorTransferPending = true`. `performMayorTransfer` refusait donc le transfert (`state.phase !== "mayorTransfer"`) et, côté client, `phase:"chasseur"` fermait le `tiebreakPanel` du maire mourant — qui restait bloqué sans pouvoir transférer l'écharpe.

Fix : le bloc `else if (isMayorDying)` pose maintenant `state.pendingChasseurAfterTransfer = partner` et appelle `setPhase("mayorTransfer")` (avec `return` pour ne pas tomber dans le bloc chasseur). Dans `performMayorTransfer`, après le transfert, si `pendingChasseurAfterTransfer` est non-null, on émet `chasseurMustShoot` et on passe en phase `chasseur`. Nouvelle variable `pendingChasseurAfterTransfer` initialisée à `null` dans `state.js` et réinitialisée dans `resetGameState` (`phases.js`).

**Bug B (client, visuel)** — `public/index.html` `dawnResult`, bloc `else if (mayorTransferPending)` :
`_dawnOnClose` rouvrait le `tiebreakPanel` (panneau de transfert du maire) pour **tous** les joueurs après la fermeture de la carte d'aube, pas seulement pour le maire mourant. Les autres voyaient un panneau "⚖️ Égalité — Le Maire doit trancher !" vide.

Fix : nouveau flag global `dyingMayorId` (posé dans `mayorMustTransfer`, remis à `null` dans `mayorTransferred` et `gameReset`). Le `_dawnOnClose` ne rouvre le panel que si `socket.id === dyingMayorId`.

**Suppression de la carte "village s'endort"** — `public/index.html` :
`showNightFallCard()` n'affiche plus la carte plein écran. Elle émet toujours `nightCardShown` (requis par le serveur) et appelle `updateNightCover()`, mais sans ouvrir la carte ni poser de timer de fermeture.

#### Cloche au lancement du vote + vibrations des moments-clés du jour (mai 2026)
Renforcement du signal « c'est à toi de regarder l'écran » — sans temps d'écran inutile.

- **Son de cloche** (`public/mj.html`) : `launchVote()` joue désormais `playEffect("church_bell")`. Quand le MJ lance le vote du jour, la cloche du village sonne sur la tablette MJ (source sonore centrale de la table).
- **Vibrations de jour** (`public/index.html`) : le téléphone du joueur concerné vibre à chaque moment où il doit agir **de jour** — jamais la nuit (une vibration dans le silence donnerait une info aux voisins). Couvert :
  - Vote du jour / élection du Maire — déjà géré (`voteStarted`).
  - Le Maire doit trancher une égalité (`tiebreakMayor`).
  - Le Chasseur doit tirer (`chasseurMustShoot`) — uniquement si la mort survient de jour.
  - Le Maire mourant désigne son successeur (`mayorMustTransfer`) — uniquement de jour.
  - Le Maire abdique (évènement Conseil `mayorMustAbdicate`) — de jour.
- Nouvelles fonctions : `vibrateNow(pattern)` (vibration brute, sans garde de phase) et `isDayContext()`. Le Chasseur et le transfert d'écharpe ont leur propre phase (`chasseur`, `mayorTransfer`) qui n'est pas `day` ; `isDayContext()` s'appuie sur la nouvelle variable `_prevPhase` (phase précédente, mémorisée dans le handler `phase`) pour distinguer une mort de jour d'une mort de nuit. `vibrateIfDay()` reste la garde standard (refus si phase de nuit).

#### Épuration du cockpit MJ — affichage contextuel à la phase (mai 2026)
Suite de la refonte « app au service du jeu », côté MJ (`public/mj.html`). Objectif : le MJ a l'information nécessaire en un coup d'œil, sans scroller ni chercher — moins il cherche, plus il porte l'immersion. Aucune logique de jeu touchée.

Nouvelle fonction **`updateMJLayout(phase)`** (près de `updateNightBar`) qui affiche/masque les grandes sections selon la phase. Appelée depuis le handler socket `phase`, `mjReconnected`, `gameReset`, et une fois à l'init (`updateMJLayout("lobby")` juste après sa définition).

- **Toujours visibles** : ③ Personnages (rôle + état vivant/mort), Sons & ambiance, Info live (Morts + Joueurs), cheat sheet, barres de phase nuit/mission.
- **Lobby uniquement** : `mjSectionStart` (config des rôles, mode autonome, pilotage MJ, bots), `mjSectionQR` (QR code de connexion).
- **En partie uniquement** (`phase !== "lobby"`) : `mjSectionUrgency` (contrôles manuels d'urgence), `mjSectionDeadChat` (chat des morts).
- **Strictement contextuel à la phase** : `mjSectionWolves` (phase `wolves`), `mjSectionMayor` (phase `mayorVote`), `mjSectionDay` (phase `day`).

**Restructuration HTML** : la section ③ « Rôles attribués » est sortie du `grid2` qu'elle partageait avec les votes loups — désormais pleine largeur (`id="mjSectionRoles"`), renommée « Personnages — rôle & état ». Les votes loups deviennent une section autonome `mjSectionWolves`. Les préfixes numériques ①–⑥ des titres de sections ont été retirés (ils impliquaient un ordre fixe que l'affichage contextuel ne respecte plus). Nouveaux id : `mjSectionStart`, `mjSectionUrgency`, `mjSectionRoles`, `mjSectionWolves`, `mjSectionMayor`, `mjSectionDay`, `mjSectionDeadChat`, `mjSectionQR`.

⚠ Validation : le mount Linux (OneDrive) servait encore une copie tronquée de `mj.html` — `node --check` direct y échoue à tort (cf. note plus bas). Le JS inline a été validé en reconstruisant le fichier complet hors OneDrive (syntaxe OK) ; fichier hôte vérifié intact (1681 lignes, ferme bien `</script></body></html>`).

#### Épuration de l'UI joueur — bandeaux redondants retirés (mai 2026)
Suite de la refonte « app au service du jeu » : suppression, côté joueur (`public/index.html`, `public/css/player.css`), des éléments d'écran qui re-narrent ce que le MJ dit déjà à voix haute, ou qui font doublon. Aucune logique de jeu touchée.

- **`#narrativeBanner` + dico `PHASE_NARR` + fonction `setBanner`** supprimés. L'app ne re-narre plus par écrit chaque transition de phase (« ☀️ Le village se réveille », « 🌙 La nuit tombe »…). Tous les appels `setBanner()` retirés (handlers `phase`, `daySkipped`, carte d'aube `dawnResult`, `gameReset`).
- **`#phaseLabel`** supprimé : div + fonction `phaseLabel()` + les 2 assignations `innerText` (handlers `fullState` et `phase`). Le nom de la phase n'est plus affiché en permanence — le voile de nuit, l'écran de débat et la voix du MJ le portent déjà. L'attribut `body[data-phase]` (teinte ambiante `--phase-tint`) est **conservé**.
- **`#cycleCounter`** supprimé : div + handler socket `gameCycle` + les mises à `display:none`. Le décompte « Jour X · Nuit Y » est énoncé naturellement par le MJ. Le serveur émet toujours `gameCycle` — sans conséquence, plus aucun listener côté joueur.
- **`#deadBanner`** supprimé : son texte était devenu faux depuis l'étape 6 de la refonte (« vision spectateur complète » alors que `sendDeadVision` fait un `return` anticipé). Le `#deadFullScreen` épuré recouvre déjà l'écran du mort.
- **Pastille `(N✉️)`** retirée à côté des noms pendant le vote du jour dans `render()` — doublon exact du `#votesPanel`. La pastille équivalente du vote du Maire (visible des seuls morts) est **conservée** (hors périmètre).
- CSS orphelin retiré de `player.css` : `#deadBanner`, `#cycleCounter` (+ `.dp`/`.np`), `#narrativeBanner`.

Validation : `node --check` non applicable (HTML) ; le bloc `<script>` inline d'`index.html` a été extrait et vérifié syntaxiquement (OK). **Reste à faire** : même épuration côté MJ (`mj.html`).

#### Ajustements post-playtest #3 (mai 2026)
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

#### Ajustements post-playtest #2 (mai 2026)
Second lot après test.

**Écran de mort rendu INCONDITIONNEL** (`public/index.html`)
Le joueur mort signalait voir encore la liste des joueurs + les boutons voter pendant le jour. `updateDeadFullScreen` ne dépend plus du flag `mjPilotedDay` (`show = iAmDead && !gameIsOver`) — idem `updateDeadVoteView`. Surtout, `updateDeadFullScreen()` et `updateDayDebateScreen()` sont désormais appelés **à la fin de `render()`** (donc à chaque changement d'état) en plus des hooks d'events : garantit qu'un mort ne voit jamais l'UI de jeu, de jour comme de nuit, même si un event a été manqué. La vue du vote (`deadVoteView`) reste affichée dans l'écran de mort pendant un vote. Le chat des morts reste toujours accessible (déplacé dans `deadFullScreen`).

**Carte évènement Conseil — joueurs : icône + titre seulement** (`public/index.html`)
La carte `councilEventCard` côté joueur masque le narratif (`councilEventNarrative` en `display:none`) — les joueurs voient l'icône 🪦 + le titre + « Le Maître du Jeu vous en expliquera la règle ». Le MJ garde le narratif complet (sa propre `councilEventCard` dans `mj.html`, inchangée).

**Écran de débat fiabilisé** : `updateDayDebateScreen()` appelé aussi depuis `render()` (l'écran ne s'affichait pas toujours les premiers jours).

#### Ajustements post-playtest (mai 2026)
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

#### Refonte épuration jour — étapes 1 à 4 (mai 2026) — EN COURS
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

#### Bug fix #1 — Voile de nuit n'écrase plus les cartes narratives (`public/index.html`)
**Symptôme** : pendant les phases de nuit, les joueurs non-actifs ne voyaient que le voile « Garde les yeux fermés » et jamais les cartes narratives (nightFallCard, dayDeathCard, councilEventCard, missionExplainCard). Cause : z-index du voile (99990) supérieur à celui des cartes (9998-9999).
**Fix** : `updateNightCover()` consulte désormais `isAnyNarrativeCardOpen()` qui vérifie l'état des cartes `roleCard`, `dayDeathCard`, `nightFallCard`, `councilEventCard`, `missionExplainCard`, `mayorCard`. Si une carte est affichée, le voile reste caché. À chaque ouverture/fermeture de carte, `updateNightCover()` est rappelé.

#### Bug fix #2 — Carte chronique (dayDeathCard) ne s'affichait pas au début du jour (`public/index.html`)
**Symptôme** : à l'aube, la dayDeathCard s'ouvrait via `dawnResult` puis se fermait instantanément. `clearNightSecrets()` (appelé sur `socket.on("phase", "day")`) contenait un `closeDawnCard()` qui se déclenchait juste après l'ouverture (dawnResult est émis avant `setPhase("day")`).
**Fix** : retrait du `closeDawnCard()` de `clearNightSecrets()`. La carte a son propre timer d'auto-fermeture (7 s).

#### Bug fix #3 — Victoire vérifiée avant la narration de la nuit (`votes.js`, `narration.js`)
**Symptôme** : la narration TTS « le village s'endort, les loups se réveillent » jouait sur le MJ avant l'annonce de la victoire quand le vote du jour scellait la fin de partie via un chemin tiebreak.
**Fix** : ajout d'un `if (phases.checkVictory()) return;` dans les deux chemins tiebreak (`resolveVoteWithTiebreak` callback + `handleTiebreakChoice`) avant `phases.setPhase("wolves")`. Garde supplémentaire dans `narration.narrate` : l'émission TTS dans le `setTimeout(900ms)` ne se déclenche plus si `state.phase` a changé entre-temps (cas où setPhase wolves est appelé puis setPhase lobby).

#### Bug fix #4 — Le maire peut s'envoyer en mission (`roles.js`, `votes.js`) — ⚠ ANNULÉ : le code refuse que le maire s'inclue, et c'est la règle voulue (Alexandre, 2026-10-22)
**Symptôme** : le maire ne pouvait pas s'inclure parmi les 3 envoyés de la mission — utile pourtant pour qu'il vérifie s'il est loup en cas de réussite.
**Fix** : suppression du filtre `id !== state.mayor` côté validation serveur (`handleMissionTeamChoice` dans `roles.js`). La liste envoyée au maire au lancement de mission (`votes.js` autour de la ligne 67) inclut désormais le maire lui-même.

#### Bug fix #5 — Carte chronique de nuit s'affiche AVANT l'écran de fin de partie (`state.js`, `phases.js`, `roles.js`)
**Symptôme** : quand une victoire se déclenchait après une nuit (loups éliminés / loups majoritaires), l'écran de fin de partie apparaissait avant que les joueurs aient pu voir la carte chronique expliquant ce qu'il s'était passé pendant la nuit.
**Fix** : nouveau flag `state.inNightResolution` posé à `true` au début de `doResolveNight` et à `false` à la fin. Quand `endGame()` est appelé pendant cette fenêtre, il diffère ses émissions (`gameSummary`, `gameEnd`, `setPhase("lobby")`) en stockant la fonction dans `state.pendingEndGame`. Une fois `doResolveNight` ayant émis `dawnResult` + posé `pendingDayRecap`, il déclenche `pendingEndGame` après un `setTimeout(7000ms)`, après avoir envoyé le récap MJ. Reset propre dans `resetGameState`.

#### Amélioration #1 — Auto-close du vote du maire (`votes.js`)
`checkMayorAutoLock()` n'est plus conditionné au mode autonome — dès que tous les joueurs vivants ont voté, le vote du maire se verrouille automatiquement, en mode MJ comme en mode autonome. Le MJ n'a plus besoin de cliquer.

#### Amélioration #2 — Bouton « Valider ma proie » côté loups (`votes.js`, `server.js`, `phases.js`, `state.js`, `public/index.html`)
Chaque loup voit désormais un bouton « 🐺 Valider ma proie » sous son interface de vote. État côté serveur : `state.wolfConfirmed` (Set d'ids). Nouveau handler `wolfConfirm` (server.js ligne 226). Quand tous les loups vivants ont validé ET votent la même cible → `performLockWolfVotes()` automatique. En cas de désaccord à la validation, toutes les validations sont annulées et un `wolfConfirmReject` est envoyé. Changer de cible (`voteWolf`) supprime sa validation. Émission d'un statut `wolfConfirmStatus` (confirmed: ids, total: nb) à l'entrée de phase wolves et à chaque vote/validation. Combiné à l'amélioration #1, le MJ n'a plus rien à faire pendant la nuit.

#### Amélioration #3 — Carte narrative complète à la résolution du Conseil des Morts (`council.js`, `public/mj.html`)
Quand le Conseil vote un événement pour demain, le MJ reçoit désormais le narratif complet (pas juste le titre). `councilResolvedMJ` inclut `narrative`. Côté `mj.html`, le handler affiche la carte plein écran `#councilEventCard` (avec titre + narratif) et lance la narration TTS complète, en plus de l'alerte. Le MJ a ainsi toute l'explication pour raconter aux joueurs ce qui les attend.

#### Amélioration #4 — Saut de la phase Sorcière si plus de potions (`roles.js`, `phases.js`)
`nextNightPhase()` ne retourne plus `"witch"` quand la sorcière a déjà utilisé `witchSaveUsed && witchKillUsed`. Le `handleSetPhase` côté MJ couvre aussi ce cas — si on force la phase witch sans potions, on bascule directement sur `doResolveNight()`. Plus de temps mort de 45 s sur la sorcière inactive.

#### Bug fix — Dépendance circulaire des modules (CRITIQUE) (`phases.js`, `roles.js`, `votes.js`)
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

#### Bug fix — `server.js` tronqué sur disque
Le fichier était physiquement tronqué à 12958 octets, finissant en plein milieu de `socket.on("d` — il manquait tout le handler `disconnect`, la fermeture de `io.on("connection")`, et l'appel `http.listen(PORT, ...)`. `node --check server.js` échouait avec un `SyntaxError`. Probablement une sauvegarde interrompue ou un raté de sync OneDrive. Le fichier a été restauré dans sa version complète (298 lignes, ~13.5 ko).

#### Bug fix — Route `/api/ip` rétablie (`server.js`)
Le QR code du panneau MJ (`public/mj.html` ligne ~1228, fonction `initQR`) appelle `/api/ip` pour récupérer l'IP locale et générer l'URL de connexion joueur. Cette route avait disparu lors de la refonte modulaire et le QR code affichait "Erreur IP". Ajout dans `server.js` : `require("os")`, helper `getLocalIPv4()` qui parcourt `os.networkInterfaces()` et renvoie la première IPv4 non-loopback (fallback `127.0.0.1`), et route `app.get("/api/ip", ...)` qui renvoie `{ ip, port: PORT }`. Le QR code refonctionne après simple redémarrage du serveur.

#### Petit confort — Alias d'URL `/mj` (`server.js`)
Ajout d'une route Express `app.get("/mj", ...)` qui renvoie `public/mj.html`. L'URL longue `/mj.html` continue de fonctionner (servie par `express.static`), mais `/mj` (sans extension) marche aussi maintenant — pratique pour taper l'URL de mémoire sur la tablette MJ. Aucune autre URL n'est affectée.

#### Bug fix — Check victoire avant la phase de nuit (`server.js`, dans `resolveDayVote`)
Avant `setPhase("wolves")` après une mort de jour, `checkVictory()` est appelé explicitement. Évite que la nuit ne démarre brièvement quand la victoire est scellée par le vote du jour.

```js
if (phase !== "lobby" && phase !== "chasseur" && phase !== "mayorTransfer") {
  if (checkVictory()) return;
  setPhase("wolves");
}
```

#### Bug fix — Sprint final 30s, fonctionnel tous les jours (`server.js`)
- `FAST_RESOLVE_MS` : `10000` → `30000` (constante en haut du fichier).
- Dans le handler `voteDay` (vote réel des joueurs), ajout de la garde `voteTimer != null` (comme dans la version bot) pour éviter de déclencher le sprint avant que le MJ n'ait lancé le vote.
- `fastResolveTriggered = true` est désormais posé **uniquement** si `remainingMs > FAST_RESOLVE_MS` (sinon le flag bloquait à tort le sprint quand les votes arrivaient tard).
- Messages "vote rapide 10s" → "vote rapide 30s".

#### Amélioration — Carte narrative côté MJ (`mj.html`)
Ajout du div plein écran `#councilEventCard` (mêmes couleurs/structure que côté joueur).
- Handler `councilEventActive` affiche maintenant la carte en plus du bandeau et de la narration TTS.
- Fonction `closeCouncilEventCard()` + timeout 20s de sécurité.
- Handler `councilEventEnd` ferme la carte si encore ouverte.

#### Anti-triche — Jeu en présentiel sur canapé (`public/index.html`)
- **Voile de nuit** : nouvel overlay `#nightCoverScreen` plein écran avec fond noir étoilé et message « 🌙 Garde les yeux fermés. Ce n'est pas ton tour de jeu — la nuit veille pour toi. ». Activé pour tout joueur vivant qui n'est PAS le rôle actif de la phase courante. Logique centralisée dans `isActiveDuringPhase(phase, role)` + `updateNightCover()`. Le rôle actif voit son interface normalement. Les morts ne voient jamais le voile (ils ont le Conseil des Morts / chat).
- **Bouton « Maintenir pour voir mon rôle »** pendant le jour : la zone `#infoPanelContent` (rôle, alliés Loups, amoureux, potions Sorcière) est masquée par défaut pendant `day`/`mayorVote`/`mission*`/`mayorTransfer`/`chasseur`/`lobby`. Bouton `#infoRevealBtn` au-dessus, hold-to-reveal via `mousedown`/`touchstart` + `mouseup`/`touchend`/`mouseleave`. Anti-context menu pour bloquer le long-press iOS. Pendant les phases de nuit, le panneau est visible directement (l'écran est de toute façon masqué pour les non-concernés).
- **Effacement des secrets à l'aube** : `clearNightSecrets()` appelé sur `phase === "day"` — efface `#status` (« 🛡 Vous protégez X », « 🧪 Potion utilisée », résultat Voyante, confirmation Corbeau), ferme les panneaux d'action de nuit. Le joueur doit mémoriser ce qu'il a vu pendant la nuit.
- **Plus de vibrations pendant la nuit** : `salvateur` ajouté à `NO_VIBRATE_PHASES` (les autres phases nocturnes y étaient déjà). Aucune vibration ne peut trahir un rôle par un voisin attentif.
- Hooks de mise à jour du voile et du bouton : `socket.on("phase")`, `socket.on("yourRole")`, `socket.on("deadPlayers")`.
- Tests : `node --check server.js` OK, JS player OK, serveur boote proprement.

#### Nouveau rôle — Les Sœurs jumelles (`state.js`, `phases.js`, `roles.js`, `narration.js`, `lights-scenes.json`, `public/index.html`, `public/mj.html`)
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

#### Immersion — Quick wins CSS (`public/css/player.css`, `public/index.html`)
- **Voile de nuit qui respire** : animation `coverBreathe` 5s (brightness 1 ↔ 1.18), couche d'étoiles `starsTwinkle` 4s décalée, et `moonPulse` 6s sur l'emoji 🌙 (scale + drop-shadow doré). Statique avant, vivant maintenant.
- **Animation de révélation du rôle** : nouvelle keyframe `cardReveal` (cubic-bezier overshoot) qui fait apparaître l'emoji avec un flip 3D `rotateY(180→0)` + scale 0.2→1.15→1 + désaturation `blur(8px)→0`. Halo lumineux `::after` derrière l'emoji avec `haloPulse`. L'emoji flotte ensuite doucement (`emojiHover` 3s).
- **Teinte ambiante de l'écran par phase** : `body[data-phase]` posé par le handler `socket.on("phase")` côté joueur. Variables CSS `--phase-tint` et `--phase-tint-edge` définies par phase (cupid rose, sisters magenta tendre, salvateur cyan, wolves rouge, seer violet, witch vert, day doré, etc.). Overlay `body::after` en `radial-gradient` qui transitionne sur 1.2s. Subtle mais ça vit.

#### Immersion — Cheat sheet MJ contextuelle (`public/mj.html`)
Dictionnaire `MJ_CHEATSHEET` (15 phases couvertes). Petit panneau vert sous le pause banner avec un titre dynamique « 📜 Pense à dire » + 2-4 lignes guides selon la phase. Mis à jour automatiquement à chaque `socket.on("phase")` via `updateCheatSheet(p)`. Bouton ✕ pour le fermer manuellement. Aide énormément quand on est MJ pour la 1ʳᵉ fois (ou quand on a oublié la formule rituelle).

#### Immersion — Récits de mort différenciés (`death-narratives.js`, `roles.js`, `votes.js`, `public/index.html`)
Nouveau module **`death-narratives.js`** avec 5 causes (loups, sorcière, vote, amour, chasseur) × variantes default + overrides par rôle (Loup, Voyante, Sorcière, Chasseur, Cupidon, Salvateur, Corbeau, Sœurs, PetiteFille, Idiot). Templates avec placeholders `{name}` et `{role}` rendus côté serveur. `buildDeath(id, cause)` dans `roles.js` enrichit chaque entry avec un champ `narrative`. Idem `buildVoteNarrative` dans `votes.js`. Côté player UI, `showDeathCard(name, role, narrative)` et le handler `dawnResult` priorisent le récit serveur quand disponible — fallback historique préservé. Multi-death : concaténation des récits si tous ont une narrative. Conséquence : au lieu de « Marie est éliminée. Son rôle était Voyante », on lit « À l'aube, les villageois découvrent le corps de Marie. Ses visions s'éteignent pour toujours. La meute a trouvé la Voyante. »

#### Immersion — Badges post-victoire (`badges.js`, hook dans `phases.js checkVictory`)
Nouveau module **`badges.js`** : `buildBadges({players, roles, deadPlayers, lovers, gameStats, winner})` détecte 14 médailles automatiques (⚰️ Première victime, 🏆 Survivant, 🐺 Chef de meute, 🤡 Roi du Bluff, 💔 Cœur brisé, 💘 Couple éternel, 🔮 Devineresse, 🛡 Bouclier inébranlable, 🧪 Apothicaire émérite, 🔫 Tireur d'élite, 👯‍♀️ Sœurs inséparables, 🏛️ Étoile du village, 🤡 Bouffon impardonnable, 🪶 Plume noire). Renvoie `{playerName: [{emoji,label,desc}]}`. Ajouté au payload `gameSummary`. Côté player UI, nouveau panneau `#endBadgesPanel` sur l'écran de fin avec une chip par badge sous le nom du joueur.

#### Immersion — Selfie au lobby + carte d'identité (`server.js`, `public/index.html`)
- **Capture côté joueur** : `<input type="file" accept="image/*" capture="user">` qui ouvre la caméra frontale sur mobile. `handlePhotoSelected` redimensionne à 200×200 carré centré via `canvas.drawImage`, encode en JPEG quality 0.72, donne un aperçu rond, et émet `setPhoto`. Cappé à ~35 KB côté serveur (validation `data:image/` + taille).
- **Stockage serveur** : `players[i].photo` (base64) + `playerRegistry[name.toLowerCase()].photo` (persiste à la reconnexion / restore après crash). Diffusé via `io.emit("players")`.
- **Mémorisation locale** : `localStorage.lgPhoto` côté client → re-emit automatique `setPhoto` à chaque reconnect (utile après crash serveur).
- **Affichage** : avatar rond 80px sur la **carte de rôle** (au-dessus de l'emoji), 32px dans la **liste des rôles de l'écran de fin** (remplace l'emoji du rôle si photo disponible). Sur la **dayDeathCard**, helper `renderDeathPhotos(victims)` qui rend une rangée flex adaptative : 100px solo, 80px pour 2-3 morts, 60px pour 4+. Si une victime n'a pas de photo → placeholder rond avec initiale du prénom sur fond gris foncé. Toutes les morts d'une nuit (loups + sorcière + amour) sont représentées visuellement.
- **Lobby visible jusqu'à `yourRole`** : avant, le lobby était caché dès `join()`. Maintenant la section selfie reste visible après l'inscription, et le lobby ne se cache qu'au démarrage effectif (réception de `yourRole`). Le joueur a donc le temps de prendre une photo entre son inscription et le clic « Lancer la partie » du MJ.

#### Robustesse — Logger structuré (`logger.js`)
Nouveau module sans dépendance externe. Niveaux `info` / `warn` / `error` / `debug` (debug uniquement si `LOG_DEBUG=1`). Sortie : console + fichier journalier `logs/YYYY-MM-DD.log` (créé auto, append). Format : `[YYYY-MM-DD HH:mm:ss] [LEVEL] msg`. Branché dans : `server.js` (boot, connect/disconnect, register, MJ), `phases.js` (setPhase, checkVictory si proche victoire), `roles.js` (killPlayer, assignAndStart, handleMJStartSistersTimer), `votes.js` (startDayVote, resolveDayVote), `council.js` (applyCouncilEvent).

#### Robustesse — Persistance d'état + reprise après crash (`snapshot.js`, hooks `server.js`)
**Objectif** : ne plus perdre une partie en cours si le serveur crash ou si Windows redémarre.
- **`snapshot.js`** : `serializeState(state)` extrait les champs métier (omet `state.io`, timers, Sets → Arrays). Sauvegarde toutes les 5 s dans `snapshots/state-snapshot.json` (écriture atomique via `.tmp` + `rename`). Pas de snapshot en phase `lobby` (et purge tout snapshot zombie). `applySnapshot(state, snap)` repose les champs (Sets reconstitués).
- **Crash handlers dans `server.js`** : `process.on('uncaughtException')` et `process.on('unhandledRejection')` appellent `snapshot.dumpCrash(state, err)` qui écrit `snapshots/crash-{timestamp}.json` avec stack + état complet, log l'erreur, puis exit (uncaughtException) ou continue (unhandledRejection).
- **Au boot** : `snapshot.loadSnapshot()` détecte la sauvegarde. Si phase ≠ "lobby" → `state.pendingRestore = snap` et log warn.
- **Côté MJ** : quand le MJ s'enregistre, si `state.pendingRestore` est posé, le serveur émet `crashRecoveryAvailable` avec un résumé (savedAt, phase, players, maire, jours/nuits). Carte plein écran ambre `#crashRecoveryCard` apparaît côté MJ avec 2 boutons : « ✅ Reprendre la partie » → emit `acceptCrashRecovery` ; « 🗑 Ignorer » → emit `discardCrashRecovery` (confirm).
- **Accepter la reprise** (`server.js handler`) : `snapshot.applySnapshot(state, snap)` + emit `gameRestored` à tous + `phases.setPhase(state.phase)` pour réinstaller les timers proprement. Les joueurs reçoivent `gameRestored` côté `index.html` → re-emit `register` automatique avec le prénom mémorisé en `localStorage`. La logique de reconnexion existante (`playerRegistry` keyed by name) remappe les anciens IDs vers les nouveaux sockets.
- **Refuser** : clear le snapshot + reset `pendingRestore`. Le serveur reste en lobby.

#### Robustesse — Reconnexion en plein milieu d'une phase Sœurs ou Salvateur (`state.js buildFullState`, `public/index.html`)
**Symptôme** : si une Sœur ou le Salvateur perdait sa connexion (4G qui coupe, etc.) pendant SA phase, à la reconnexion le snapshot envoyé par `buildFullState` ne ré-ouvrait pas son panneau plein écran — elle se retrouvait avec un écran vide alors que sa phase tournait.
**Fix** : `buildFullState` ajoute désormais `pendingSistersTurn` (si phase=sisters + role=Sœurs + vivant) avec `{count, timerEndsAt}` et `pendingSalvateurTurn` (si phase=salvateur + role=Salvateur + vivant) avec `{lastProtectedId, lastProtectedName}`. Côté `index.html`, le handler `reconnected` détecte ces flags et ré-ouvre les panneaux : pour Sœurs, le countdown reprend exactement sur le temps restant si le MJ a déjà lancé le timer (via `state.sistersTimerEnd`), sinon figé à `00:20`. Nouveau champ `state.sistersTimerEnd` posé/cleared dans `handleMJStartSistersTimer` et `clearPhaseTimeouts`/`resetGameState`.

#### Robustesse — ESLint minimal (`package.json`, `eslint.config.js`)
Config plate ESLint 9 dans `eslint.config.js`. Règles informationnelles uniquement : `no-unused-vars: warn` (avec ignore pattern `^_` pour les variables marquées intentionnellement), `no-undef: error` côté serveur, `eqeqeq: warn` partout. Pour le front (`public/**`), `no-unused-vars` et `no-undef` désactivés (faux positifs car les `<script>` partagent un namespace global). Script `npm run lint`. Devdep `eslint: ^9.0.0`. Installation à faire côté Windows (`npm install`) car le sandbox Linux ne voit pas le `package.json` à jour à cause de OneDrive.

#### Bug fix CRITIQUE — Sœurs & Salvateur ne jouaient pas après la nuit 1 (`roles.js`, `phases.js`, `votes.js`)
**Symptôme** : seules la 1ʳᵉ nuit déclenchait Cupidon → Sœurs → Salvateur → Loups. Toutes les nuits suivantes (après chaque vote du jour) sautaient directement aux Loups, bypassant Sœurs et Salvateur. Bug latent depuis l'ajout du Salvateur (pas remarqué), aggravé par l'ajout des Sœurs.
**Cause** : `startNightAfterCupid()` n'était appelée que depuis le handler Cupidon (handler humain, bot, timeout). Toutes les transitions day→night appelaient `phases.setPhase("wolves")` directement dans 5 endroits : `votes.js resolveDayVote`, `votes.js handleTiebreakChoice`, `votes.js handleSkipDayVote`, `votes.js maybeRunBotForTiebreak`, `roles.js performChasseurShot` (postCtx day), `roles.js performMayorTransfer` (else final), `phases.js chasseurTimeout fallback`. Chacun shuntait la séquence Sœurs/Salvateur.
**Fix** : renommage de `startNightAfterCupid` → `startNightSequence` dans `roles.js` (alias historique gardé pour compat). Tous les chemins day→night listés ci-dessus pointent maintenant vers `roles.startNightSequence()` au lieu de `phases.setPhase("wolves")`. La séquence vérifie : ≥2 Sœurs vivantes → phase `sisters` ; sinon Salvateur vivant → phase `salvateur` ; sinon `wolves`.

#### Bug fix — Son loups joué pendant la phase Sœurs (`roles.js handleCupidChoice`, `phases.js` bot Cupidon)
**Symptôme** : après la sélection des amoureux par Cupidon, le son `wolves_attack.mp3` retentissait 4 s plus tard — c'est-à-dire en plein pendant le tour des Sœurs (phase `sisters`), gâchant l'ambiance.
**Cause** : `handleCupidChoice` programmait un `setTimeout(4000ms)` qui jouait `wolves` après la fin de `cupid.mp3` (4 s). Avant l'ajout des Sœurs/Salvateur, le flux était cupid → wolves direct, donc ce timer fire au bon moment. Avec sisters qui dure ≥20 s entre les deux, le timer fire au mauvais moment.
**Fix** : le `setTimeout` ne joue le son loups QUE si `state.phase === "wolves"` au moment où il fire (cas cupid→wolves direct, sans intermédiaire). Sinon il ne fait que reset `state.skipWolvesSoundOnce = false`, ce qui permet à `setPhase("wolves")` de jouer le son naturellement quand on y arrivera (plus tard via sisters/salvateur).

#### Narration TTS — ajouts pour la séquence complète (`narration.js`)
Ajout de `*_to_salvateur` (avant : transition silencieuse les nuits 2+) et `salvateur_to_wolves` (avant : silence après protection). Reformulation de `*_to_sisters` pour ne plus mentionner « vingt secondes » (le MJ peut prendre son temps avant de lancer le timer).

#### Nettoyage post-audit Sœurs (`public/index.html`, `public/mj.html`)
- Fusion du listener `socket.on("phase")` dupliqué pour les Sœurs : la fermeture du `sistersPanel` est désormais intégrée dans le gros handler `socket.on("phase", ...)` existant (`if (p !== "sisters") closeSistersPanel();`).
- Ajout de `'sistersPanel'` à la liste de `isAnyNarrativeCardOpen` (cohérence avec les autres cartes plein écran qui font reculer le voile de nuit).
- Barre de phases nocturne MJ : le step `Sœurs` est désormais filtré sur les sœurs **vivantes** (`Object.entries(roles).filter(([id,r])=>r==='Sœurs' && !deadIds.includes(id)).length >= 2`), pour ne plus afficher l'étape une fois les deux sœurs mortes.
- Toast MJ branché sur `sistersInfoMJ` (avant : émission morte sans handler) → « 👯‍♀️ Sœurs jumelles à réveiller : Marie & Sophie ».

#### Amélioration — Son `shield.mp3` sur confirmation Salvateur (`roles.js`, `phases.js`, `public/mj.html`)
- À la confirmation de cible par le Salvateur (handler `handleSalvateurAction` ET bot dans `runBotsForPhase("salvateur")`), émission `soundPlay: "shield"` au MJ juste après `salvateurConfirm`. Côté MJ, `shield` ajouté à l'allowlist du handler `soundPlay` et à `SOUNDS` (`sounds/shield.mp3`). Nouveau fichier `public/sounds/shield.mp3` à fournir.

#### Nouveau rôle — Le Salvateur (`server.js`, `public/index.html`, `public/mj.html`, `lights-scenes.json`)
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

#### Amélioration — Lumières connectées Philips Hue (`lights.js`, `lights-scenes.json`, `.env.example`, hooks dans `server.js`)
- Nouveau module **`lights.js`** : pilote Hue via l'API CLIP v2 (HTTPS LAN, certif autosigné), pattern fire-and-forget (`timeout 1.5s`, jamais d'`await`, jamais de throw → ne bloque/ne casse jamais le moteur de jeu). Throttle 100 ms entre commandes pour respecter le rate-limit Hue. Effets supportés : `lightning`, `fire_flicker`, `slow_pulse`, `fast_pulse`. Helpers : `applyScene(key)`, `flash(key)`, `reset()`, `status()`.
- Nouveau **`lights-scenes.json`** : 30 scènes (phases + 15 évènements `council.*` + 2 flashs `flash.death`/`flash.victory`). Valeurs xy CIE 1931, `bri` 0–254, `transition` ms, `effect` optionnel.
- **`.env.example`** documente les 5 variables : `LIGHTS_ENABLED` (défaut `false` → totalement dormant), `HUE_BRIDGE_IP`, `HUE_API_KEY`, `HUE_GROUP_ID`, `LIGHTS_DEBUG`. Tant que `LIGHTS_ENABLED!="true"`, aucun appel réseau, aucun warning.
- **4 hooks dans `server.js`** (purement additifs, le moteur de jeu reste inchangé) :
  1. Fin de `setPhase(p)` → `lights.applyScene(p)` (clé = nom de phase brut)
  2. Début de `applyCouncilEvent(ev)` → `lights.applyScene("council." + ev.id)` (superpose à `day`)
  3. Après `io.emit("playerDied", …)` dans `killPlayer` → `lights.flash("flash.death")` (sauvegarde + restaure la scène courante)
  4. Avant `setPhase("lobby")` à la fin de partie → `lights.flash("flash.victory")` ; dans `resetGameState` → `lights.reset()`
- Tests effectués : `node --check server.js` ✓, `node --check lights.js` ✓, JSON valide (30 scènes), serveur démarre proprement avec module dormant. Pour activer : copier `.env.example` → `.env`, remplir Bridge IP / clé / group UUID, mettre `LIGHTS_ENABLED=true`, redémarrer.

#### Amélioration — Modes de vote pilotés par le Conseil des Morts + nouveaux évènements (`server.js`, `mj.html`)
- Le mode 1 (vote libre) est le seul lançable « par défaut ». Les modes 2/4/5 ne sont déclenchés que via un évènement du Conseil des Morts. Le handler socket `startVote` ignore son paramètre et appelle toujours `startDayVote(1)` ; `startDayVote` applique ensuite l'override selon `activeCouncilEvent`.
- Mapping évènement → mode forcé : `riot` → mode 5 (Émeute, vote anonyme, 60 s) ; `judgment` → mode 2 (Le Jugement, verrouillé, 200 s) ; `panic` → mode 4 (La Panique, express, 30 s).
- Deux nouveaux évènements ajoutés à `COUNCIL_EVENTS` : `judgment` (« ⚖ Le Jugement », narratif « Une fois prononcé, un vote ne peut plus être changé. ») et `panic` (« ⚡ La Panique », narratif « Le village sombre dans la précipitation. »).
- Durées de vote remises à jour dans `startDayVote` : `{ 1: 200000, 2: 200000, 4: 30000, 5: 60000 }`.
- Côté MJ (`mj.html`) : retrait des boutons de sélection de mode dans la section ⑤. Bouton « Relancer le vote (mode 1) » + bouton « Terminer ». Labels mis à jour dans le handler `voteStarted` (« ⚖ Le Jugement — verrouillé (200s) », « ⚡ La Panique — express (30s) », « 🖤 Émeute — vote anonyme (60s) »). `selectMode` conservé en no-op défensif.

#### Amélioration — Carte narrative MJ « fin de nuit / début de jour » (`server.js`, `mj.html`)
- Nouvel évènement socket `mjDayRecap` émis uniquement au MJ à l'entrée de la phase `day`. Payload : `{ dayNum, nightNum, previousDayDeath, nightDeaths[], saved, missionResult }`.
- Côté serveur : nouvelles variables `lastDayVoteDeath` (mémorisée dans `resolveDayVote`) et `pendingDayRecap` (préparée dans `doResolveNight` — y compris le chemin chasseur — et émise dans `setPhase("day")` pour couvrir tous les chemins de retour à day). Toutes les deux remises à `null` dans `resetGameState`.
- Côté MJ (`mj.html`) : carte plein écran `#dayRecapCard` (jaune/bleu) avec deux blocs (« Hier, le village… » et « Cette nuit… »), bouton « Continuer », auto-fermeture 25 s. Fermée aussi au `gameReset`. Narration TTS automatique de synthèse via `speakNarration(...)` pour aider le MJ à raconter le tour.

#### Amélioration — Auto-démarrage du vote jour mode 1 / durée 200 s (`server.js`)
- Lorsque la phase `day` commence, le vote est désormais lancé automatiquement (timer `dayAutoStartTimer`, délai `DAY_AUTO_START_DELAY_MS = 2000`). En mode autonome on respecte `autoVoteMode`, sinon on lance le mode 1 (vote ouvert).
- Bloc de démarrage déplacé hors du `if (autoMode)` dans `setPhase`. Garde `voteTimer == null` ajoutée pour ne pas écraser un vote déjà initié par le MJ.
- Durée du mode 1 dans `startDayVote` portée de **90 s → 200 s** (`durations[1]` et fallback). Les modes 2/4/5 et le sprint final `FAST_RESOLVE_MS = 30000` restent inchangés (le sprint ne raccourcit que si le temps restant > 30 s, sinon on garde la valeur courante).

#### Amélioration — Toggle narration vocale visible (`mj.html`)
- Bouton `#narrationOnOffBtn` dans le panneau `#narrationPanel` (vert "🔊 ON" / rouge "🔇 OFF").
- Fonction `setNarrationEnabled(enabled)` : met à jour `narrationOn`, envoie `socket.emit('setNarration', ...)`, stoppe `speechSynthesis.cancel()` si on coupe, met à jour l'opacité du bouton micro header et le statut. Côté serveur, le handler `setNarration` existe déjà à la ligne ~1923.
- Le clic droit sur le bouton micro header reste disponible comme raccourci.

#### Nouveaux évènements Conseil des Morts — 🤐 Le Vote Muet + 💬 Les Voix Étouffées + 👑 L'Abdication (`council.js`, `votes.js`, `state.js`, `phases.js`, `server.js`, `public/index.html`, `public/mj.html`)

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
