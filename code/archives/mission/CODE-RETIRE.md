# Code retiré avec la Mission (2026-10-31)

Chaque morceau est donné avec son fichier et ses numéros de ligne **dans la version d'avant le retrait** (commit `51eee4a`). Voir `LISEZMOI.md`.

## state.js

### Lignes 30–32 — délais de la Mission

```js
const MISSION_TEAM_TIMEOUT_MS   = 120000;
const MISSION_CARD_TIMEOUT_MS   = 90000;
const MISSION_BONUS_TIMEOUT_MS  = 90000;
```

### Lignes 114–119 — état de la Mission dans une partie neuve

```js
    // Mission
    mission: {
      active: false, team: [], cards: {}, result: null, resultRevealed: false, bonusDone: false,
      teamTimeout: null, cardTimeout: null, bonusTimeout: null,
    },

```

### Lignes 243–246 — état de la Mission renvoyé à un téléphone reconnecté (buildFullState)

```js
    missionActive: state.mission.active,
    missionTeam:   state.mission.team,
    missionResult: state.mission.result,
    missionPhase:  (state.phase === "mission" || state.phase === "missionVote" || state.phase === "missionBonus") ? state.phase : null,
```

### Lignes 294 — reconnexion : l'équipe de mission

```js
  [state.lovers, state.deadPlayers, state.mission.team, state.tiebreakCandidates].forEach(liste => {
```

Remplacé par :

```js
  [state.lovers, state.deadPlayers, state.tiebreakCandidates].forEach(liste => {
```

### Lignes 304–305 — reconnexion : la carte de mission jouée

```js
  // Ses propres bulletins, et sa carte de mission
  [state.votesDay, state.votesWolf, state.mayorVote, state.councilVotes, state.mission.cards].forEach(urne => {
```

Remplacé par :

```js
  // Ses propres bulletins
  [state.votesDay, state.votesWolf, state.mayorVote, state.councilVotes].forEach(urne => {
```

### Lignes 325 — export des délais

```js
  MISSION_TEAM_TIMEOUT_MS, MISSION_CARD_TIMEOUT_MS, MISSION_BONUS_TIMEOUT_MS,
```

## snapshot.js

### Lignes 69–76 — sauvegarde de la Mission

```js
    mission: state.mission ? {
      active: state.mission.active,
      team: state.mission.team,
      cards: state.mission.cards,
      result: state.mission.result,
      resultRevealed: state.mission.resultRevealed,
      bonusDone: state.mission.bonusDone,
    } : null,
```

### Lignes 89 — relecture de la sauvegarde

```js
  if (snap.mission) Object.assign(state.mission, snap.mission);
```

## server.js

### Lignes 187–189 — état de la Mission envoyé à la tablette du MJ reconnectée

```js
      missionActive: state.mission.active,
      missionTeam:   state.mission.team,
      missionResult: state.mission.result,
```

### Lignes 388–392 — messages des téléphones

```js
  // ===== MISSION =====
  socket.on("missionTeamChoice",  teamIds      => roles.handleMissionTeamChoice(socket, actuel(teamIds)));
  socket.on("missionCard",        card         => roles.handleMissionCard(socket, card));
  socket.on("missionBonusChoice", bonusTeamIds => roles.handleMissionBonusChoice(socket, actuel(bonusTeamIds)));

```

### Lignes 547–548 — carte redemandée à un envoyé reconnecté

```js
  // Vote de mission : la demande de carte, si elle n'est pas encore jouée
  if (state.phase === "missionVote" && state.mission.team.includes(id) && !state.mission.cards[id]) roles.demanderCarteMission(id);
```

## votes.js

### Lignes 100–114 — après l'élection du maire : la Mission avant la première nuit

```js
      if (state.mission.active) {
        state.io.to(state.mayor).emit("missionSelectTeam", {
          mayorName: playerName(state.mayor),
          // Le maire ne peut pas s'envoyer en mission
          players: vivantsSauf(state.mayor).map(p => ({ id: p.id, name: p.name }))
        });
        state.io.emit("missionStarted", { mayorName: playerName(state.mayor) });
        versMJ("missionMJInfo", {
          step: "teamSelection",
          mayorName: playerName(state.mayor)
        });
        phases.setPhase("mission");
      } else {
        roles.ouvrirNuit(true);
      }
```

Remplacé par :

```js
      roles.ouvrirNuit(true);
```

## phases.js

### Lignes 10 — import des délais

```js
  MISSION_TEAM_TIMEOUT_MS, MISSION_CARD_TIMEOUT_MS, MISSION_BONUS_TIMEOUT_MS,
```

### Lignes 276–307 — minuteries des trois étapes

```js

  if (p === "mission") {
    state.mission.teamTimeout = setTimeout(() => {
      if (state.phase === "mission") {
        state.io.emit("autoResolve", "⏱️ Le Maire n'a pas sélectionné son équipe — mission annulée.");
        state.mission.active = false;
        roles.ouvrirNuit(true);
      }
    }, MISSION_TEAM_TIMEOUT_MS);
  }

  if (p === "missionVote") {
    state.mission.cardTimeout = setTimeout(() => {
      if (state.phase === "missionVote") {
        state.mission.team.forEach(id => {
          if (!state.mission.cards[id]) state.mission.cards[id] = "success";
        });
        state.io.emit("autoResolve", "⏱️ Temps écoulé — cartes manquantes comptées comme Réussite.");
        roles.resolveMissionCards();
      }
    }, MISSION_CARD_TIMEOUT_MS);
  }

  if (p === "missionBonus") {
    state.mission.bonusTimeout = setTimeout(() => {
      if (state.phase === "missionBonus") {
        state.io.emit("autoResolve", "⏱️ Le Maire n'a pas utilisé son bonus — passage au jour.");
        state.mission.bonusDone = true;
        setPhase("day");
      }
    }, MISSION_BONUS_TIMEOUT_MS);
  }
```

### Lignes 360 — arrêt des minuteries

```js
  roles.clearMissionTimeouts();
```

### Lignes 504–535 — robots : équipe, cartes, bonus

```js

  // Mission — sélection équipe
  if (p === "mission" && mayorBot()) {
    scheduleBot(() => {
      if (state.phase !== "mission") return;
      const candidates = vivantsSauf(state.mayor);
      if (candidates.length >= 3) roles.envoyerEnMission(fisherYates(candidates).slice(0, 3).map(pl => pl.id));
    });
  }

  // Mission — carte secrète de chaque robot de l'équipe : un loup sabote 7 fois sur 10,
  // un villageois réussit 8 fois sur 10
  if (p === "missionVote") {
    aliveBots.filter(b => state.mission.team.includes(b.id)).forEach(bot => {
      scheduleBot(() => {
        if (state.phase !== "missionVote" || state.mission.cards[bot.id]) return;
        const card = state.roles[bot.id] === "Loup"
          ? (Math.random() < 0.7 ? "fail" : "success")
          : (Math.random() < 0.8 ? "success" : "fail");
        roles.jouerCarteMission(bot.id, card);
      });
    });
  }

  // Mission — bonus du maire (il ne s'inspecte pas lui-même)
  if (p === "missionBonus" && mayorBot()) {
    scheduleBot(() => {
      if (state.phase !== "missionBonus") return;
      const candidates = vivantsSauf(state.mayor);
      if (candidates.length >= 3) roles.inspecterBonus(fisherYates(candidates).slice(0, 3).map(pl => pl.id));
    });
  }
```

### Lignes 538–543 — mayorBot (servait seulement à la Mission)

```js
// Le maire actuel est-il un robot ?
function mayorBot() {
  const maire = state.mayor && state.players.find(pl => pl.id === state.mayor);
  return !!(maire && maire.isBot);
}

```

## roles.js

### Lignes 3 — en-tête

```js
// initiale, mission. Inclut tous les handlers socket des rôles.
```

Remplacé par :

```js
// initiale. Inclut tous les handlers socket des rôles.
```

### Lignes 21–24 — phases de nuit

```js
// que la nuit se résout quand le MJ la rythme. Les phases de la mission sont rangées ici
// depuis toujours (elles précèdent la première nuit).
const PHASES_DE_NUIT = ["cupid", "amoureux", "sisters", "salvateur", "wolves", "seer", "petiteFille", "corbeau", "witch",
  "nightPause", "mission", "missionVote", "missionBonus"];
```

Remplacé par :

```js
// que la nuit se résout quand le MJ la rythme.
const PHASES_DE_NUIT = ["cupid", "amoureux", "sisters", "salvateur", "wolves", "seer", "petiteFille", "corbeau", "witch",
  "nightPause"];
```

### Lignes 32–61 — minuteries, bonus attendu, résolution des cartes

```js
// ===== MISSION — MINUTERIES =====
function clearMissionTimeouts() {
  ["teamTimeout", "cardTimeout", "bonusTimeout"].forEach(k => { clearTimeout(state.mission[k]); state.mission[k] = null; });
}

// Le bonus d'une mission réussie attend le maire (vivant) après la nuit
function bonusMissionAttendu() {
  return state.mission.active && state.mission.result === "success" && !state.mission.bonusDone
    && !!state.mayor && !state.deadPlayers.includes(state.mayor);
}

// ===== MISSION — RÉSOLUTION DES CARTES =====
function resolveMissionCards() {
  clearMissionTimeouts();
  const hasFail = Object.values(state.mission.cards).some(c => c === "fail");
  state.mission.result = hasFail ? "fail" : "success";

  // Informe le MJ discrètement du résultat brut
  versMJ("missionResultMJ", {
    result: state.mission.result,
    cards: state.mission.team.map(id => ({
      id, name: playerName(id), card: state.mission.cards[id]
    }))
  });

  // Enregistre le résultat mais ne le révèle PAS encore au broadcast.
  // → la révélation se fera dans doResolveNight() via missionReveal.
  ouvrirNuit(true);
}

```

### Lignes 70 — commentaire

```js
// l'élection du maire (ou la mission) : avec un MJ, phase « crepuscule » jusqu'à son
```

Remplacé par :

```js
// l'élection du maire : avec un MJ, phase « crepuscule » jusqu'à son
```

### Lignes 293–295 — aube : résultat à révéler, bonus attendu

```js
  const missionResultToReveal = (state.mission.active && !state.mission.resultRevealed) ? state.mission.result : null;
  if (missionResultToReveal !== null) state.mission.resultRevealed = true;
  const bonusMission = bonusMissionAttendu();
```

### Lignes 299 — aube : la carte attendait le bonus

```js
    : (state.actionMJ === "mayorTransfer" || require('./council').annonceMatinParMJ()) && !state.pendingEndGame && !bonusMission;
```

Remplacé par :

```js
    : (state.actionMJ === "mayorTransfer" || require('./council').annonceMatinParMJ()) && !state.pendingEndGame;
```

### Lignes 304 — aube : résultat envoyé aux téléphones

```js
    missionResult: missionResultToReveal,
```

### Lignes 307 — aube : lumières

```js
  lumieresAube(deaths.length, missionResultToReveal);
```

Remplacé par :

```js
  lumieresAube(deaths.length);
```

### Lignes 315–316 — aube : récap du MJ

```js
    savedBySalvateur: protectedBySalvateur,
    missionResult: missionResultToReveal
```

Remplacé par :

```js
    savedBySalvateur: protectedBySalvateur
```

### Lignes 348 — aube : passage au bonus

```js
  else phases.setPhase(bonusMission ? "missionBonus" : "day");
```

Remplacé par :

```js
  else phases.setPhase("day");
```

### Lignes 359–366 — lumières de l'aube (éclair vert « réussite » ou rouge après les morts)

```js
// Lumières de l'aube : un éclair par mort puis la couleur de la mission ; l'aube si personne n'est mort
function lumieresAube(nbMorts, mission) {
  const couleurMission = mission === "success" ? "flash.reussite" : "flash.death";
  if (nbMorts > 0) {
    lights.flashSequence("flash.death", nbMorts);
    if (mission !== null) setTimeout(() => lights.flash(couleurMission), nbMorts * 750 + 300);
  } else lights.flash(mission !== null ? couleurMission : "flash.dawn");
}
```

Remplacé par :

```js
// Lumières de l'aube : un éclair par mort ; l'aube si personne n'est mort
function lumieresAube(nbMorts) {
  if (nbMorts > 0) lights.flashSequence("flash.death", nbMorts);
  else lights.flash("flash.dawn");
}
```

### Lignes 546 — écharpe transmise la nuit : passage au bonus

```js
  else if (ctx === "night") phases.setPhase(bonusMissionAttendu() ? "missionBonus" : "day");
```

Remplacé par :

```js
  else if (ctx === "night") phases.setPhase("day");
```

### Lignes 628 — lancement : case Mission de la préparation

```js
  state.mission.active = !!config.mission;
```

### Lignes 859–927 — équipe, cartes, bonus, messages des téléphones

```js
// ===== MISSION =====
// 3 joueurs vivants distincts, autres que le maire (il ne s'envoie ni ne s'inspecte lui-même)
function equipeValide(ids) {
  const alive = alivePlayers().map(p => p.id);
  return ids.every(id => alive.includes(id) && id !== state.mayor) && new Set(ids).size === 3;
}

// Le maire (joueur ou robot) a choisi l'équipe : chacun de ses membres reçoit ses cartes
function envoyerEnMission(teamIds) {
  clearMissionTimeouts();
  state.mission.team = teamIds;
  const equipe = teamIds.map(id => ({ id, name: playerName(id) }));
  state.io.emit("missionTeamSelected", { team: equipe, mayorName: playerName(state.mayor) });
  teamIds.forEach(demanderCarteMission);
  versMJ("missionMJInfo", { step: "cardVote", team: equipe });
  phases.setPhase("missionVote");
}

// Un membre de l'équipe est invité à jouer sa carte secrète (envoi en mission, reconnexion)
function demanderCarteMission(id) {
  state.io.to(id).emit("missionCardChoice", { mayorName: playerName(state.mayor), teamNames: state.mission.team.map(playerName) });
}

// Carte jouée par un membre de l'équipe (joueur ou robot) ; la mission se résout à la dernière
function jouerCarteMission(id, card) {
  state.mission.cards[id] = card;
  state.io.to(id).emit("missionCardConfirm", { card });
  const recues = Object.keys(state.mission.cards).length, total = state.mission.team.length;
  versMJ("missionMJInfo", { step: "cardReceived", received: recues, total });
  state.io.emit("missionCardPlayed", { count: recues, total });
  if (recues === total) resolveMissionCards();
}

// Bonus d'une mission réussie : le maire apprend si un loup est parmi les 3 qu'il désigne
function inspecterBonus(teamIds) {
  clearMissionTimeouts();
  state.mission.bonusDone = true;
  const equipe = teamIds.map(id => ({ id, name: playerName(id) }));
  const loups = teamIds.filter(id => state.roles[id] === "Loup");
  state.io.to(state.mayor).emit("missionBonusResult", { team: equipe, hasWolf: loups.length > 0 });
  versMJ("missionMJBonusResult", {
    team: equipe, hasWolf: loups.length > 0, wolves: loups.map(id => playerName(id))
  });
  state.io.emit("missionBonusUsed", { mayorName: playerName(state.mayor), team: equipe });
  phases.setPhase("day");
}

function handleMissionTeamChoice(socket, teamIds) {
  if (state.phase !== "mission" || socket.id !== state.mayor) return;
  if (!Array.isArray(teamIds) || teamIds.length !== 3) return;
  if (!equipeValide(teamIds)) return socket.emit("missionError", "Sélection invalide — 3 joueurs vivants autres que toi.");
  envoyerEnMission(teamIds);
}

function handleMissionCard(socket, card) {
  if (state.phase !== "missionVote") return;
  if (!state.mission.team.includes(socket.id)) return;
  if (state.mission.cards[socket.id]) return;
  if (card !== "success" && card !== "fail") return;
  jouerCarteMission(socket.id, card);
}

function handleMissionBonusChoice(socket, bonusTeamIds) {
  if (state.phase !== "missionBonus" || socket.id !== state.mayor) return;
  if (!Array.isArray(bonusTeamIds) || bonusTeamIds.length !== 3) return;
  if (!equipeValide(bonusTeamIds)) return socket.emit("missionError", "Sélection bonus invalide — 3 joueurs vivants autres que toi.");
  inspecterBonus(bonusTeamIds);
}

```

### Lignes 932–933 — exports

```js
  // Mission
  clearMissionTimeouts, resolveMissionCards, envoyerEnMission, jouerCarteMission, inspecterBonus, demanderCarteMission,
```

### Lignes 948 — exports (messages)

```js
  handleMissionTeamChoice, handleMissionCard, handleMissionBonusChoice,
```

## narration.js

### Lignes 16–19 — narration : maire élu → Mission

```js
  "mayorVote_to_mission": [
    "Le Maire est élu. Une mission secrète l'attend : il doit choisir trois envoyés.",
    "Le village a son Maire. L'heure d'une mission délicate a sonné. Trois noms vont être désignés."
  ],
```

### Lignes 31–46 — narration : cartes jouées

```js
  // === Mission ===
  "mission_to_missionVote": [
    "L'équipe est désignée. Que les trois envoyés choisissent secrètement leur carte.",
    "Trois envoyés sont nommés. À eux de jouer leur carte dans l'ombre."
  ],
  "missionVote_to_cupid": [
    "Les cartes sont jouées. Le résultat sera révélé à l'aube. Cupidon, à toi maintenant.",
    "Les envoyés ont parlé. Leur secret se révélera demain. Cupidon, lève-toi."
  ],

  // Mission terminée, pas de Cupidon dans la partie : la nuit enchaîne sur les Loups.
  "missionVote_to_wolves": [
    "Les cartes sont jouées. Le résultat sera révélé à l'aube. La nuit tombe : Loups-Garous, réveillez-vous.",
    "Les envoyés ont parlé. Leur secret se révélera demain. Que la meute ouvre les yeux."
  ],

```

### Lignes 182–191 — narration : bonus du matin

```js
  "nightPause_to_missionBonus": ["Le jour se lève sur une mission réussie. Maire, l'information est à toi."],

  "witch_to_missionBonus": [
    "La Sorcière range ses fioles. Le jour se lève sur une mission réussie. Maire, l'information est à toi.",
    "La nuit s'achève. La mission a réussi. Maire, choisis trois personnes à inspecter."
  ],
  "missionBonus_to_day": [
    "L'inspection est faite. Le Maire garde son secret. Le village peut désormais débattre.",
    "Le Maire a inspecté. Place au débat."
  ],
```

### Lignes 228–232 — narration : écharpe transmise → bonus

```js
  ],
  "mayorTransfer_to_missionBonus": [
    "Le nouveau Maire prend ses fonctions et hérite de l'inspection. À toi de choisir trois cibles.",
    "L'écharpe a été transmise. Maire, lance ton inspection."
  ]
```

Remplacé par :

```js
  ]
```

## outils/banc-robots.js

### Lignes 1 — banc : en-tête

```js
// Banc d'essai : parties complètes jouées par des bots (6 à 15 joueurs, rôles, mission, mode
```

Remplacé par :

```js
// Banc d'essai : parties complètes jouées par des bots (6 à 15 joueurs, rôles, mode
```

### Lignes 51 — banc : Mission tirée au hasard

```js
  cfg.mission = alea() < 0.3;
```

### Lignes 58 — banc : description de la partie

```js
  const desc = `N=${N} ${modeMJ ? "MJ" : "auto"}${cfg.mjPilotedDay ? "+jourPiloté" : ""}${cfg.mission ? "+mission" : ""}${cfg.conseil ? "" : "+sansConseil"} rôles=` +
```

Remplacé par :

```js
  const desc = `N=${N} ${modeMJ ? "MJ" : "auto"}${cfg.mjPilotedDay ? "+jourPiloté" : ""}${cfg.conseil ? "" : "+sansConseil"} rôles=` +
```

## tests/navigateur.js

### Lignes 7 — test navigateur : commentaire

```js
 * Partie 1 — 2 loups, 4 villageois dont 2 Sœurs, MJ qui pilote le jour, sans Conseil ni mission.
```

Remplacé par :

```js
 * Partie 1 — 2 loups, 4 villageois dont 2 Sœurs, MJ qui pilote le jour, sans Conseil.
```

### Lignes 84 — test navigateur : cases décochées

```js
    for (const id of ["mission", "conseil", "autoMode"]) { const x = document.getElementById(id); if (x) x.checked = false; }
```

Remplacé par :

```js
    for (const id of ["conseil", "autoMode"]) { const x = document.getElementById(id); if (x) x.checked = false; }
```

## public/css/mj.css

### Lignes 28–32 — MJ : barre de la Mission

```css
/* Mission phase bar */
#missionPhaseBar { display:none; background:rgb(var(--lune-nuit)); border:1px solid rgb(var(--lune-sombre)); border-radius:10px; padding:12px 14px; margin-bottom:10px; }
#missionPhaseBar.active { display:block; }
#missionPhaseTitle { font-size:11px; color:rgb(var(--lune-base)); text-transform:uppercase; letter-spacing:1px; margin-bottom:8px; }

```

### Lignes 43–47 — MJ : panneau de la Mission

```css
/* Mission MJ panel */
#missionMJPanel { display:none; background:rgb(var(--lune-fond)); border:2px solid rgb(var(--lune-base)); border-radius:10px; padding:14px; margin-bottom:10px; }
#missionMJPanel.active { display:block; }
#missionBonusMJInfo { display:none; background:rgb(var(--vert-fond)); border:1px solid rgb(var(--vert-base)); border-radius:8px; padding:10px; margin-top:8px; font-size:13px; }

```

## public/css/player.css

### Lignes 17 — commentaire

```css
/* Encadré dans la page (identité, votes, chat et vision des morts, rôles de nuit, mission…) :
```

Remplacé par :

```css
/* Encadré dans la page (identité, votes, chat et vision des morts, rôles de nuit…) :
```

## public/css/communs.css

### Lignes 15 — commentaire de la palette

```css
  /* Voyante, Petite Fille, mission */ --voyance-nuit:8,5,12; --voyance-fond:16,11,24; --voyance-sombre:39,27,60; --voyance-base:91,59,145; --voyance-vif:142,98,218; --voyance-clair:195,170,238;
```

Remplacé par :

```css
  /* Voyante, Petite Fille */ --voyance-nuit:8,5,12; --voyance-fond:16,11,24; --voyance-sombre:39,27,60; --voyance-base:91,59,145; --voyance-vif:142,98,218; --voyance-clair:195,170,238;
```

## public/index.html

### Lignes 157–186 — carte « Mission Secrète » (règles, pour tous)

```html
<!-- Carte explicative au lancement de la mission (tous joueurs) -->
<div id="missionExplainCard" class="plein-ecran" style="display:none;z-index:9998;background:radial-gradient(ellipse at center,rgb(var(--lune-fond)) 0%,rgb(var(--lune-nuit)) 100%);">
  <div class="card-emoji">🕵️</div>
  <div class="card-title" style="color:rgb(var(--lune-clair));">Mission Secrète</div>
  <div style="max-width:380px;color:rgba(255,255,255,0.85);line-height:1.7;font-size:14px;animation:cardSlide 0.5s ease 0.3s both;">
    <div style="margin-bottom:14px;">
      Le <strong style="color:rgb(var(--or-vif));">Maire</strong> désigne <strong>3 joueurs</strong> pour partir en mission.
    </div>
    <div style="margin-bottom:14px;">
      Chaque joueur sélectionné choisit secrètement :
    </div>
    <div style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:10px 14px;margin-bottom:14px;text-align:left;">
      <div style="margin:4px 0;"><span style="color:rgb(var(--vert-vif));">✅ Réussite</span></div>
      <div style="margin:4px 0;"><span style="color:rgb(var(--sang-vif));">❌ Échec</span></div>
    </div>
    <div style="background:rgb(var(--braise-fond));border:1px solid rgb(var(--or-base));border-radius:8px;padding:8px 12px;margin-bottom:14px;color:rgb(var(--braise-vif));font-size:13px;">
      ⚠️ La mission échoue s'il y a au moins un Échec.
    </div>
    <div style="margin-bottom:14px;font-style:italic;color:rgba(255,255,255,0.6);">
      Le résultat sera révélé demain matin…
    </div>
    <div style="background:rgb(var(--vert-fond));border:1px solid rgb(var(--vert-base));border-radius:8px;padding:10px 14px;color:rgb(var(--vert-vif));font-size:13px;">
      🎁 Si la mission réussit, le Maire obtiendra une information secrète sur 3 joueurs de son choix.
    </div>
  </div>
  <button onclick="closeMissionExplainCard()" style="margin-top:22px;padding:12px 32px;border-radius:8px;border:1px solid rgba(var(--lune-clair),0.4);background:rgba(var(--lune-clair),0.1);color:rgb(var(--lune-clair));font-size:14px;cursor:pointer;animation:cardSlide 0.5s ease 0.6s both;">
    🕵️ J'ai compris
  </button>
</div>

```

### Lignes 348–411 — panneaux : statut, équipe du maire, carte secrète, bonus, résultat du bonus

```html
<!-- ===== MISSION ===== -->

<!-- Statut mission visible par tous (team sélectionnée, nb cartes jouées) -->
<div id="missionStatusPanel" class="panneau" style="display:none;background:rgb(var(--lune-nuit));border:1px solid rgb(var(--lune-sombre));text-align:center;">
  <div style="font-size:11px;color:rgb(var(--lune-base));text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">🎭 Mission secrète</div>
  <div id="missionStatusText" style="font-size:13px;color:rgb(var(--lune-clair));"></div>
  <div id="missionCardCounter" style="display:none;margin-top:8px;font-size:12px;color:rgb(var(--n5));"></div>
</div>

<!-- Maire : sélection des 3 joueurs pour la mission -->
<div id="missionPanel" class="panneau" style="display:none;background:rgb(var(--lune-fond));border:2px solid rgb(var(--lune-base));">
  <div style="font-size:24px;text-align:center;margin-bottom:8px;">🎭</div>
  <div style="font-weight:bold;color:rgb(var(--lune-vif));font-size:15px;text-align:center;margin-bottom:6px;">Tu es le Maire — choisis ton équipe</div>
  <div style="font-size:12px;color:rgb(var(--n5));margin-bottom:12px;text-align:center;">Sélectionne 3 joueurs (pas toi-même). Ils choisiront secrètement une carte.</div>
  <div id="missionTeamBtns" style="display:flex;flex-wrap:wrap;gap:6px;justify-content:center;"></div>
  <div id="missionSelectedNames" style="margin-top:10px;font-size:12px;color:rgb(var(--lune-vif));text-align:center;min-height:18px;"></div>
  <button id="missionConfirmBtn" onclick="confirmMissionTeam()" disabled
    style="width:100%;margin-top:12px;padding:12px;background:rgb(var(--lune-sombre));border:2px solid rgb(var(--lune-base));border-radius:8px;color:rgb(var(--lune-vif));font-size:14px;cursor:pointer;opacity:0.4;">
    ✅ Confirmer l'équipe
  </button>
</div>

<!-- Joueur sélectionné : choix de carte -->
<div id="missionVotePanel" class="panneau" style="display:none;background:rgb(var(--lune-fond));border:2px solid rgb(var(--lune-base));text-align:center;">
  <div style="font-size:24px;margin-bottom:8px;">🎭</div>
  <div style="font-weight:bold;color:rgb(var(--lune-vif));font-size:15px;margin-bottom:6px;">Mission — Choisis ta carte</div>
  <div style="font-size:12px;color:rgb(var(--n5));margin-bottom:14px;line-height:1.6;">
    Choisis <strong style="color:rgb(var(--n7));">secrètement</strong> une carte.<br>
    Ton choix n'est pas visible par les autres.
  </div>
  <div style="display:flex;gap:12px;justify-content:center;">
    <button onclick="playMissionCard('success')"
      style="flex:1;padding:18px 8px;background:rgb(var(--vert-sombre));border:2px solid rgb(var(--vert-base));border-radius:10px;color:rgb(var(--vert-vif));font-size:22px;cursor:pointer;">
      ✅<div style="font-size:11px;margin-top:4px;color:rgb(var(--vert-base));">Réussite</div>
    </button>
    <button onclick="playMissionCard('fail')"
      style="flex:1;padding:18px 8px;background:rgb(var(--sang-fond));border:2px solid rgb(var(--sang-base));border-radius:10px;color:rgb(var(--sang-vif));font-size:22px;cursor:pointer;">
      ❌<div style="font-size:11px;margin-top:4px;color:rgb(var(--sang-base));">Échec</div>
    </button>
  </div>
  <div id="missionCardDone" style="display:none;margin-top:12px;font-size:13px;color:rgb(var(--vert-vif));">✅ Carte jouée — en attente des autres joueurs…</div>
</div>

<!-- Maire : bonus (si mission réussie) -->
<div id="missionBonusPanel" class="panneau" style="display:none;background:rgb(var(--vert-fond));border:2px solid rgb(var(--vert-base));">
  <div style="font-size:24px;text-align:center;margin-bottom:8px;">🔍</div>
  <div style="font-weight:bold;color:rgb(var(--vert-vif));font-size:15px;text-align:center;margin-bottom:6px;">Mission réussie — Bonus d'information</div>
  <div style="font-size:12px;color:rgb(var(--n5));margin-bottom:12px;text-align:center;line-height:1.6;">
    Choisis 3 joueurs. Tu sauras en privé si au moins un d'eux est un Loup.
  </div>
  <div id="missionBonusBtns" style="display:flex;flex-wrap:wrap;gap:6px;justify-content:center;"></div>
  <div id="missionBonusSelectedNames" style="margin-top:10px;font-size:12px;color:rgb(var(--vert-vif));text-align:center;min-height:18px;"></div>
  <button id="missionBonusConfirmBtn" onclick="confirmMissionBonus()" disabled
    style="width:100%;margin-top:12px;padding:12px;background:rgb(var(--vert-sombre));border:2px solid rgb(var(--vert-base));border-radius:8px;color:rgb(var(--vert-vif));font-size:14px;cursor:pointer;opacity:0.4;">
    🔍 Révéler
  </button>
</div>

<!-- Résultat bonus (privé, visible uniquement par le maire) -->
<div id="missionBonusResult" class="panneau" style="display:none;background:rgb(var(--vert-fond));border:2px solid rgb(var(--vert-base));text-align:center;">
  <div id="missionBonusResultText" style="font-size:16px;font-weight:bold;margin-bottom:6px;"></div>
  <div id="missionBonusResultSub" style="font-size:12px;color:rgb(var(--n5));"></div>
</div>

```

### Lignes 585 — phases sans vibration

```html
  "mission","missionVote","missionBonus","chasseur"];
```

Remplacé par :

```html
  "chasseur"];
```

### Lignes 629–635 — variables

```html
// ===== MISSION =====
let missionActive = false;
let missionTeamSelected = [];   // ids des 3 joueurs sélectionnés (visible par tous)
let missionSelectedByMe = [];   // sélection en cours par le maire (côté client)
let missionBonusSelectedByMe = []; // sélection bonus en cours
let missionCardPlayed = false;  // ce joueur a-t-il joué sa carte ?

```

### Lignes 946 — fin de partie : panneaux cachés

```html
   "missionPanel","missionVotePanel","missionBonusPanel","missionStatusPanel","missionBonusResult",
```

### Lignes 1171 — commentaire

```html
// égalité, transmission, abdication, Voyante ; Petite Fille, mission et Cupidon via choisirDesJoueurs) : photo +
```

Remplacé par :

```html
// égalité, transmission, abdication, Voyante ; Petite Fille et Cupidon via choisirDesJoueurs) : photo +
```

### Lignes 1191 — commentaire

```html
// Choix de plusieurs joueurs (3 pour la Petite Fille et la mission, 2 pour Cupidon) : mêmes boutons,
```

Remplacé par :

```html
// Choix de plusieurs joueurs (3 pour la Petite Fille, 2 pour Cupidon) : mêmes boutons,
```

### Lignes 1423–1434 — reconnexion : état de la Mission

```html
  // Restaure état mission
  if(state.missionActive){
    missionActive=true;
    missionTeamSelected=state.missionTeam||[];
    const msp=document.getElementById("missionStatusPanel");
    if(msp&&state.missionPhase) msp.style.display="block";
    if(state.missionTeam&&state.missionTeam.length>0){
      const names=state.missionTeam.map(id=>{const p=players.find(x=>x.id===id);return p?p.name:id;}).join(", ");
      const st=document.getElementById("missionStatusText");
      if(st) st.innerText="Équipe de mission : "+names;
    }
  }
```

### Lignes 1518 — reconnexion : identifiants des sélections

```html
  missionTeamSelected = TL(missionTeamSelected); missionSelectedByMe = TL(missionSelectedByMe); missionBonusSelectedByMe = TL(missionBonusSelectedByMe);
```

### Lignes 1571 — cartes qui lèvent le voile de nuit

```html
  const ids = ['roleCard','dayDeathCard','nightFallCard','councilEventCard','missionExplainCard','mayorCard','sistersPanel','amoureuxPanel'];
```

Remplacé par :

```html
  const ids = ['roleCard','dayDeathCard','nightFallCard','councilEventCard','mayorCard','sistersPanel','amoureuxPanel'];
```

### Lignes 1577 — commentaire

```html
    // Cartes avec display:flex inline (councilEventCard, missionExplainCard)
```

Remplacé par :

```html
    // Cartes avec display:flex inline (councilEventCard)
```

### Lignes 1779 — phases « yeux ouverts »

```html
  const dayLike = ['day','crepuscule','mayorVote','mission','missionVote','missionBonus','mayorTransfer','chasseur','lobby'].includes(phase);
```

Remplacé par :

```html
  const dayLike = ['day','crepuscule','mayorVote','mayorTransfer','chasseur','lobby'].includes(phase);
```

### Lignes 1892–1925 — changement de phase : panneaux de la Mission

```html
  // ===== MISSION : gestion des panneaux selon phase =====
  // Règle : chaque panneau mission est ouvert/fermé par son event dédié, PAS par le handler phase.
  // Le handler phase se contente de gérer missionStatusPanel et de fermer les panneaux
  // qui ne correspondent plus à la phase courante.
  const isMissionPhase = ["mission","missionVote","missionBonus"].includes(p);

  // missionStatusPanel : visible pendant toute la durée de la mission
  const msp = document.getElementById("missionStatusPanel");
  if(msp) msp.style.display = isMissionPhase ? "block" : "none";

  // Ferme UNIQUEMENT les panneaux qui n'ont pas d'event dédié pour les ouvrir
  // — missionPanel    : ouvert par missionSelectTeam → ne fermer que hors phase mission
  // — missionVotePanel: ouvert par missionCardChoice → ne fermer que hors phase missionVote
  // — missionBonusPanel: ouvert par showMissionBonusPanel → ne fermer que hors phase missionBonus
  // — missionBonusResult: ouvert par missionBonusResult event → ne fermer que hors phase missionBonus
  if(p !== "mission")      { const e=document.getElementById("missionPanel");      if(e) e.style.display="none"; }
  if(p !== "missionVote")  { const e=document.getElementById("missionVotePanel");  if(e) e.style.display="none"; }
  if(p !== "missionBonus") { const e=document.getElementById("missionBonusPanel"); if(e) e.style.display="none"; }
  // missionBonusResult : reste visible pendant le jour pour que le maire puisse consulter le résultat
  // Disparaît seulement à la nuit suivante (phase wolves ou cupid)
  if(["wolves","cupid","lobby"].includes(p)) { const e=document.getElementById("missionBonusResult"); if(e) e.style.display="none"; }

  if(p==="mission"){
    document.getElementById("missionStatusText").innerText="Le Maire choisit son équipe…";
    document.getElementById("missionCardCounter").style.display="none";
  }
  if(p==="missionVote"){
    document.getElementById("missionCardCounter").style.display="block";
    document.getElementById("missionCardCounter").innerText="0 / 3 cartes jouées";
  }
  if(p==="missionBonus"){
    showMissionBonusPanel();
  }

```

### Lignes 2165–2169 — équipe refusée par le serveur

```html
// Sélection de mission refusée par le serveur (équipe invalide)
socket.on("missionError", msg => {
  document.getElementById("status").innerText = "⚠️ " + msg;
});

```

### Lignes 2429–2479 — équipe du maire, lancement, carte « Mission Secrète »

```html
// ===== MISSION — HANDLERS =====

// Reçu uniquement par le maire
socket.on("missionSelectTeam", data=>{
  missionActive = true;
  missionSelectedByMe = [];
  const panel = document.getElementById("missionPanel");
  panel.style.display = "block";
  choisirDesJoueurs(document.getElementById("missionTeamBtns"), data.players, "rgb(var(--lune-vif))",
    "missionSelectedNames", "missionConfirmBtn", () => missionSelectedByMe);
});

function confirmMissionTeam(){
  if(missionSelectedByMe.length !== 3) return;
  socket.emit("missionTeamChoice", missionSelectedByMe);
  document.getElementById("missionPanel").style.display = "none";
  document.getElementById("status").innerText = "🎭 Équipe envoyée — en attente des choix…";
}

// Reçu par tous : l'équipe est connue
socket.on("missionStarted", data=>{
  missionActive = true;
  document.getElementById("missionStatusPanel").style.display = "block";
  document.getElementById("missionStatusText").innerText = `🎭 Mission lancée par ${data.mayorName}`;
  // Affiche la carte explicative pour TOUS les joueurs (vivants comme spectateurs)
  showMissionExplainCard();
});

let _missionExplainAutoClose = null;
function showMissionExplainCard(){
  const card = document.getElementById("missionExplainCard");
  if(!card) return;
  card.style.display = "flex";
  card.style.animation = "fadeIn 0.5s ease forwards";
  updateNightCover();
  // Auto-close après 20 secondes — filet de sécurité, fermeture manuelle attendue
  if(_missionExplainAutoClose) clearTimeout(_missionExplainAutoClose);
  _missionExplainAutoClose = setTimeout(closeMissionExplainCard, 20000);
}
function closeMissionExplainCard(){
  if(_missionExplainAutoClose) { clearTimeout(_missionExplainAutoClose); _missionExplainAutoClose = null; }
  const card = document.getElementById("missionExplainCard");
  if(!card) return;
  card.style.animation = "fadeOut 0.6s ease forwards";
  setTimeout(()=>{
    card.style.display = "none"; card.style.animation = "";
    updateNightCover();
    updateDayDebateScreen();
  }, 600);
}

```

### Lignes 2592–2657 — équipe connue, carte secrète, cartes jouées, résultat du bonus (et un commentaire périmé)

```html
socket.on("missionTeamSelected", data=>{
  missionTeamSelected = data.team.map(p=>p.id);
  const names = data.team.map(p=>p.name).join(", ");
  document.getElementById("missionStatusPanel").style.display = "block";
  document.getElementById("missionStatusText").innerText =
    `🎭 Équipe de mission : ${names}`;
  document.getElementById("missionCardCounter").style.display = "block";
  document.getElementById("missionCardCounter").innerText = "En attente des votes…";
});

// Reçu par les 3 membres de l'équipe seulement
socket.on("missionCardChoice", data=>{
  missionCardPlayed = false;
  const panel = document.getElementById("missionVotePanel");
  panel.style.display = "block";
  document.getElementById("missionCardDone").style.display = "none";
  // Réactive les boutons
  panel.querySelectorAll("button").forEach(b=>{ b.disabled=false; b.style.opacity="1"; });
});

function playMissionCard(card){
  if(missionCardPlayed) return;
  missionCardPlayed = true;
  socket.emit("missionCard", card);
  // Cache les boutons, affiche confirmation
  document.getElementById("missionVotePanel").querySelectorAll("button[onclick]").forEach(b=>{
    b.disabled=true; b.style.opacity="0.3";
  });
  document.getElementById("missionCardDone").style.display = "block";
}

// Reçu par le joueur : confirmation de son choix
socket.on("missionCardConfirm", data=>{
  // Déjà géré dans playMissionCard côté UI
});

// Reçu par tous : quelqu'un a joué une carte (sans dire qui ni laquelle)
socket.on("missionCardPlayed", data=>{
  const counter = document.getElementById("missionCardCounter");
  if(counter) counter.innerText = `${data.count} / ${data.total} cartes jouées`;
});

// Reçu à l'aube via dawnResult — la révélation est dans le texte narratif (pas de nouvelle carte)
// Voir handler dawnResult modifié ci-dessous

// Reçu uniquement par le maire si mission réussie
socket.on("missionBonusResult", data=>{
  // Cache le panel de sélection
  document.getElementById("missionBonusPanel").style.display = "none";
  // Affiche le résultat
  const res = document.getElementById("missionBonusResult");
  res.style.display = "block";
  const names = data.team.map(p=>p.name).join(", ");
  const txt = document.getElementById("missionBonusResultText");
  const sub = document.getElementById("missionBonusResultSub");
  if(data.hasWolf){
    txt.style.color = "rgb(var(--sang-vif))";
    txt.innerText = "⚠️ OUI — au moins un Loup parmi eux !";
  } else {
    txt.style.color = "rgb(var(--vert-vif))";
    txt.innerText = "✅ NON — aucun Loup parmi eux.";
  }
  sub.innerText = `Joueurs inspectés : ${names}`;
});

// Reçu par le maire : activer le panneau bonus
```

### Lignes 2661 — aube : résultat de la Mission

```html
  const missionResult = !Array.isArray(data) ? data.missionResult : null;
```

### Lignes 2685–2687 — aube : texte du résultat

```html
  // Le résultat de mission n'est pas un rôle → on peut le montrer aux joueurs
  if (missionResult === "success")      text += "\n\n🎭 Mission réussie.";
  else if (missionResult === "fail")    text += "\n\n🎭 Mission échouée.";
```

### Lignes 2722–2747 — bonus utilisé, panneau du bonus

```html
// Reçu par tous : le maire a utilisé son bonus
socket.on("missionBonusUsed", data=>{
  const names = data.team ? data.team.map(p=>p.name).join(", ") : "…";
  document.getElementById("missionStatusText").innerText =
    `🔍 ${data.mayorName} a inspecté : ${names}`;
  document.getElementById("missionBonusPanel").style.display = "none";
});

function showMissionBonusPanel(){
  if(socket.id !== mayor) return;
  missionBonusSelectedByMe = [];
  const panel = document.getElementById("missionBonusPanel");
  panel.style.display = "block";
  // Le maire ne peut pas s'inspecter lui-même
  choisirDesJoueurs(document.getElementById("missionBonusBtns"), players.filter(p => !deadPlayers.includes(p.id) && p.id !== mayor),
    "rgb(var(--vert-base))", "missionBonusSelectedNames", "missionBonusConfirmBtn", () => missionBonusSelectedByMe);
}

function confirmMissionBonus(){
  if(missionBonusSelectedByMe.length !== 3) return;
  socket.emit("missionBonusChoice", missionBonusSelectedByMe);
  document.getElementById("missionBonusPanel").style.display = "none";
}

// ===== FIN MISSION HANDLERS =====

```

### Lignes 2955 — commentaire

```html
  // Vibration : début de vote du jour (mayorVote ou day) — pas en mission/nuit
```

Remplacé par :

```html
  // Vibration : début de vote du jour (mayorVote ou day) — pas la nuit
```

### Lignes 3020–3022 — nouvelle partie : remise à zéro

```html
  // Reset mission
  missionActive=false; missionTeamSelected=[]; missionSelectedByMe=[]; missionBonusSelectedByMe=[]; missionCardPlayed=false;
  ["missionPanel","missionVotePanel","missionBonusPanel","missionBonusResult","missionStatusPanel","missionExplainCard","councilPanel","councilEventCard"].forEach(id=>{
```

Remplacé par :

```html
  ["councilPanel","councilEventCard"].forEach(id=>{
```

### Lignes 3028 — nouvelle partie : minuterie de la carte

```html
  if(_missionExplainAutoClose) { clearTimeout(_missionExplainAutoClose); _missionExplainAutoClose=null; }
```

### Lignes 3247 — panneaux de choix

```html
const PANNEAUX_DE_CHOIX=["seerPanel","cupidPanel","salvateurPanel","corbeauPanel","petiteFillePanel","missionPanel","missionBonusPanel"];
```

Remplacé par :

```html
const PANNEAUX_DE_CHOIX=["seerPanel","cupidPanel","salvateurPanel","corbeauPanel","petiteFillePanel"];
```

## public/mj.html

### Lignes 178–190 — barre et panneau de la Mission

```html
<!-- INDICATEUR PHASE MISSION -->
<div id="missionPhaseBar">
  <div id="missionPhaseTitle">🎭 Phase Mission</div>
  <div id="missionMJPanel">
    <div id="missionMJStatus" style="font-size:13px;color:rgb(var(--lune-vif));margin-bottom:8px;"></div>
    <div id="missionMJCards" style="font-size:12px;color:rgb(var(--n5));"></div>
    <div id="missionBonusMJInfo">
      <div style="font-size:11px;color:rgb(var(--vert-vif));font-weight:bold;margin-bottom:4px;">🔍 Bonus utilisé :</div>
      <div id="missionBonusMJText" style="font-size:12px;color:rgb(var(--n7));"></div>
    </div>
  </div>
</div>

```

### Lignes 208 — « Relancer » : case Mission

```html
    <div class="config-item">🎭 <input id="rp_mission" type="checkbox"> Mission</div>
```

### Lignes 229 — préparation : case Mission

```html
    <div class="config-item">🎭<input id="mission" type="checkbox" title="Activer la phase de mission"> Mission</div>
```

### Lignes 694–698 — récap du matin : résultat

```html
  if (data.missionResult === "success") {
    nightHtml += `<div style="margin-top:6px;color:rgb(var(--vert-vif));font-size:12px;font-weight:bold;">🎭 Mission RÉUSSIE</div>`;
  } else if (data.missionResult === "fail") {
    nightHtml += `<div style="margin-top:6px;color:rgb(var(--sang-vif));font-size:12px;font-weight:bold;">🎭 Mission ÉCHOUÉE</div>`;
  }
```

### Lignes 1064–1076 — barre de nuit et barre de la Mission

```html
  const missionPhases = ['mission','missionVote','missionBonus'];
  const bar = document.getElementById("nightPhaseBar");
  const mBar = document.getElementById("missionPhaseBar");

  bar.classList.toggle("active", nightPhases.includes(currentPhase));
  mBar.classList.toggle("active", missionPhases.includes(currentPhase));

  if(missionPhases.includes(currentPhase)){
    const labels={mission:"🎭 Sélection équipe",missionVote:"🗳️ Vote secret",missionBonus:"🔍 Bonus maire"};
    document.getElementById("missionMJStatus").innerText = labels[currentPhase]||currentPhase;
    document.getElementById("missionMJPanel").style.display="block";
    return;
  }
```

Remplacé par :

```html
  const bar = document.getElementById("nightPhaseBar");

  bar.classList.toggle("active", nightPhases.includes(currentPhase));

```

### Lignes 1174–1220 — messages de la Mission

```html
// ===== MISSION — EVENTS MJ =====
socket.on("missionStarted", data=>{
  showAlert(`🎭 Mission lancée — ${data.mayorName} choisit son équipe`, "info");
  document.getElementById("missionPhaseBar").classList.add("active");
  document.getElementById("missionMJPanel").style.display="block";
  document.getElementById("missionMJStatus").innerText = `${data.mayorName} sélectionne son équipe…`;
  document.getElementById("missionBonusMJInfo").style.display="none";
});

socket.on("missionTeamSelected", data=>{
  const names = data.team.map(p=>p.name).join(", ");
  showAlert(`🎭 Équipe : ${names}`, "info");
});

socket.on("missionResultMJ", data=>{
  const emoji = data.result === "success" ? "✅" : "❌";
  const label = data.result === "success" ? "RÉUSSIE" : "ÉCHOUÉE";
  const cardsStr = data.cards.map(c => `${c.name}: ${c.card==="success"?"✅":"❌"}`).join(" | ");
  showAlert(`🎭 Mission ${label} — ${cardsStr}`, data.result==="success"?"success":"warn");
  document.getElementById("missionMJStatus").innerText = `Mission ${label}`;
  document.getElementById("missionMJCards").innerText = cardsStr;
});

socket.on("missionBonusUsed", data=>{
  const names = data.team ? data.team.map(p=>p.name).join(", ") : "…";
  showAlert(`🔍 ${data.mayorName} a inspecté : ${names}`, "info");
});

socket.on("missionMJBonusResult", data=>{
  const names = data.team.map(p=>p.name).join(", ");
  const hasWolf = data.hasWolf;
  const wolves  = data.wolves?.join(", ") || "aucun";
  const bonusDiv = document.getElementById("missionBonusMJInfo");
  const bonusTxt = document.getElementById("missionBonusMJText");
  bonusDiv.style.display="block";
  bonusTxt.innerText = hasWolf
    ? `⚠️ OUI — Loup(s) parmi [${names}] : ${wolves}`
    : `✅ NON — Aucun loup parmi [${names}]`;
});

socket.on("missionMJInfo", data=>{
  const st = document.getElementById("missionMJStatus");
  const cd = document.getElementById("missionMJCards");
  if(data.step==="cardVote"){ const names=data.team.map(p=>p.name).join(", "); st.innerText=`Vote en cours — équipe : ${names}`; cd.innerText="0 / 3 cartes jouées"; }
  if(data.step==="cardReceived") cd.innerText=`${data.received} / ${data.total} cartes jouées`;
});

```

### Lignes 1232 — aube : résultat

```html
  const mr = data.missionResult;
```

### Lignes 1234–1235 — aube : alerte

```html
  if(mr==="success") alertMsg += " | 🎭 Mission RÉUSSIE";
  else if(mr==="fail") alertMsg += " | 🎭 Mission ÉCHOUÉE";
```

### Lignes 1252 — fin de partie : barre

```html
  document.getElementById("missionPhaseBar").classList.remove("active");
```

### Lignes 1257–1260 — fin de partie : cases recopiées pour « Relancer »

```html
  ["mission","conseil"].forEach(k=>{
    const src=document.getElementById(k), dst=document.getElementById("rp_"+k);
    if(src&&dst) dst.checked=src.checked;
  });
```

Remplacé par :

```html
  document.getElementById("rp_conseil").checked = document.getElementById("conseil").checked;
```

### Lignes 1284–1295 — reconnexion : état de la Mission

```html
  // Restaure état mission
  if(state.missionActive){
    document.getElementById("missionPhaseBar").classList.add("active");
    document.getElementById("missionMJPanel").style.display="block";
    if(state.missionTeam?.length>0){
      const names = state.missionTeam.map(id=>{ const p=players.find(x=>x.id===id); return p?p.name:id; }).join(", ");
      document.getElementById("missionMJStatus").innerText = `Équipe : ${names}`;
    }
    if(state.missionResult){
      document.getElementById("missionMJStatus").innerText = `Mission : ${state.missionResult==="success"?"✅ RÉUSSIE":"❌ ÉCHOUÉE"}`;
    }
  }
```

### Lignes 1485 — remise à zéro : barre

```html
  document.getElementById("missionPhaseBar").classList.remove("active");
```

### Lignes 1487–1488 — remise à zéro : panneau

```html
  document.getElementById("missionMJPanel").style.display="none";
  document.getElementById("missionBonusMJInfo").style.display="none";
```

### Lignes 1559 — composition envoyée au serveur

```html
    mission: !!document.getElementById(prefixe + "mission")?.checked,
```

### Lignes 1758–1759 — noms des phases

```html
         chasseur:r("Chasseur"),day:"☀️ Jour",mayorTransfer:r("Maire", "Transfert Maire"),
         mission:"🎭 Mission — Équipe",missionVote:"🎭 Mission — Vote",missionBonus:"🔍 Mission — Bonus"}[p]||p;
```

Remplacé par :

```html
         chasseur:r("Chasseur"),day:"☀️ Jour",mayorTransfer:r("Maire", "Transfert Maire")}[p]||p;
```

### Lignes 1779–1781 — aide-mémoire du MJ

```html
  mission:      { title:"🎭 Mission — sélection",  lines:["Le Maire choisit 3 envoyés (il ne peut pas s'inclure)"] },
  missionVote:  { title:"🎭 Mission — vote",       lines:["Les 3 envoyés choisissent secrètement Réussite ou Échec"] },
  missionBonus: { title:"🔍 Inspection bonus",     lines:["Le Maire choisit 3 joueurs : il saura si un Loup se cache parmi eux"] },
```

## lights-scenes.json

Scènes lumineuses retirées (« flash.reussite » : l'éclair vert d'une mission réussie, à l'aube).

```json
{
  "mission": {
    "xy": [
      0.207,
      0.233
    ],
    "bri": 150,
    "transition": 1000
  },
  "missionVote": {
    "xy": [
      0.207,
      0.233
    ],
    "bri": 150,
    "transition": 1000
  },
  "missionBonus": {
    "xy": [
      0.249,
      0.493
    ],
    "bri": 200,
    "transition": 1000
  },
  "flash.reussite": {
    "xy": [
      0.2,
      0.622
    ],
    "bri": 254,
    "duration": 400,
    "repeat": 2
  }
}
```
