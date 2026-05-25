// roles.js — Logique de tous les rôles : Salvateur, Voyante, Sorcière, Cupidon, Corbeau,
// Chasseur, Idiot ; mécanique mort, transfert maire, résolution de nuit, attribution
// initiale, mission. Inclut tous les handlers socket des rôles.
//
// Dépendances circulaires (phases, votes) résolues via require('./module').fn() à l'usage.

const {
  state, alivePlayers, playerName, hasRole, isMJ, fisherYates, resetActivity,
  CUPID_SOUND_MS, SISTERS_TIMEOUT_MS,
} = require('./state');

const lights = require('./lights');
const phases = require('./phases');
const log    = require('./logger');
const deathNarratives = require('./death-narratives');

// Libellés français des rôles (pour les récits de mort + révélation)
const ROLE_LABEL = {
  Loup: "Loup-Garou", Voyante: "Voyante", Sorcière: "Sorcière",
  Chasseur: "Chasseur", Cupidon: "Cupidon", Villageois: "Villageois",
  PetiteFille: "Petite Fille", Idiot: "l'Idiot du village",
  Corbeau: "Corbeau", Salvateur: "Salvateur", Sœurs: "une des Sœurs jumelles",
};

function buildDeath(id, cause) {
  const role = state.roles[id];
  const name = playerName(id);
  const narrative = deathNarratives.buildDeathNarrative({
    role, cause, name, roleLabel: ROLE_LABEL[role] || role
  });
  return { id, name, role, cause, narrative };
}

// ===== MISSION — RESET / TIMEOUTS =====
function clearMissionTimeouts() {
  if (state.mission.teamTimeout)  { clearTimeout(state.mission.teamTimeout);  state.mission.teamTimeout  = null; }
  if (state.mission.cardTimeout)  { clearTimeout(state.mission.cardTimeout);  state.mission.cardTimeout  = null; }
  if (state.mission.bonusTimeout) { clearTimeout(state.mission.bonusTimeout); state.mission.bonusTimeout = null; }
}

function resetMissionState() {
  clearMissionTimeouts();
  state.mission = {
    active: false, team: [], cards: {}, result: null,
    resultRevealed: false, bonusDone: false,
    teamTimeout: null, cardTimeout: null, bonusTimeout: null
  };
}

// ===== MISSION — RÉSOLUTION DES CARTES =====
function resolveMissionCards() {
  clearMissionTimeouts();
  const hasFail = Object.values(state.mission.cards).some(c => c === "fail");
  state.mission.result = hasFail ? "fail" : "success";

  // Informe le MJ discrètement du résultat brut
  if (state.mjSocketId) {
    state.io.to(state.mjSocketId).emit("missionResultMJ", {
      result: state.mission.result,
      cards: state.mission.team.map(id => ({
        id, name: playerName(id), card: state.mission.cards[id]
      }))
    });
  }

  // Enregistre le résultat mais ne le révèle PAS encore au broadcast.
  // → la révélation se fera dans doResolveNight() via missionReveal.
  phases.setPhase("cupid");
}

// ===== NUIT =====
// Entrée standard d'une nuit : appelée après Cupidon (nuit 1) ET après chaque
// vote du jour (nuits suivantes). Route séquentiellement :
//   Sœurs (si ≥2 vivantes) → Salvateur (s'il existe) → Loups
// Anciennement nommée startNightAfterCupid — renommée pour mieux refléter qu'elle
// gère TOUTES les nuits (pas seulement la 1ʳᵉ). Avant ce fix, Sœurs et Salvateur
// ne jouaient qu'à la nuit 1 parce que les transitions day→night appelaient
// setPhase("wolves") directement, contournant ce helper.
function startNightSequence() {
  const aliveSisters = Object.keys(state.roles).filter(id => state.roles[id] === "Sœurs" && !state.deadPlayers.includes(id));
  if (aliveSisters.length >= 2) {
    const sistersInfo = aliveSisters.map(id => ({ id, name: playerName(id) }));
    aliveSisters.forEach(sid => {
      state.io.to(sid).emit("sistersTurn", {
        count: aliveSisters.length,
        // Option B : on n'envoie PAS les noms aux sœurs — elles se reconnaissent IRL.
        // (les noms restent dispos côté serveur si on veut changer plus tard)
      });
    });
    // Le MJ reçoit l'info détaillée pour pouvoir rappeler qui doit se réveiller.
    if (state.mjSocketId) state.io.to(state.mjSocketId).emit("sistersInfoMJ", { sisters: sistersInfo });
    phases.setPhase("sisters");
  } else {
    startNightAfterSisters();
  }
}

// Continuation de la nuit une fois la phase Sœurs terminée (timeout 20s).
function startNightAfterSisters() {
  const salvateurId = Object.keys(state.roles).find(id => state.roles[id] === "Salvateur" && !state.deadPlayers.includes(id));
  if (salvateurId) {
    state.io.to(salvateurId).emit("salvateurTurn", {
      lastProtectedId:   state.lastProtectedTarget || null,
      lastProtectedName: state.lastProtectedTarget ? playerName(state.lastProtectedTarget) : null
    });
    phases.setPhase("salvateur");
  } else {
    phases.setPhase("wolves");
  }
}

function nextNightPhase(after) {
  const seerAlive    = Object.keys(state.roles).some(id => state.roles[id] === "Voyante"  && !state.deadPlayers.includes(id));
  const corbeauAlive = Object.keys(state.roles).some(id => state.roles[id] === "Corbeau"  && !state.deadPlayers.includes(id));
  // AMÉLIORATION 4 : la phase sorcière n'a de sens que si elle est vivante ET qu'il
  // lui reste au moins une potion. Sinon on saute directement à la résolution.
  const witchAlive   = Object.keys(state.roles).some(id => state.roles[id] === "Sorcière" && !state.deadPlayers.includes(id));
  const witchHasPotions = witchAlive && !(state.witchSaveUsed && state.witchKillUsed);
  if (after === "wolves") {
    if (seerAlive)        return "seer";
    if (corbeauAlive)     return "corbeau";
    if (witchHasPotions)  return "witch";
    return "resolveAuto";
  }
  if (after === "seer") {
    if (corbeauAlive)     return "corbeau";
    if (witchHasPotions)  return "witch";
    return "resolveAuto";
  }
  if (after === "corbeau") {
    if (witchHasPotions)  return "witch";
    return "resolveAuto";
  }
  return "resolveAuto";
}

function doResolveNight() {
  // Guard : si deux handlers (ex. witchDone + resolveNight MJ) arrivent dans le même
  // tick, le second est ignoré. inNightResolution est remis à false à la fin.
  if (state.inNightResolution) return;
  // BUG 5 : marqueur — toute victoire qui déclenche durant cette résolution sera
  // retardée par endGame() pour laisser la carte chronique de nuit s'afficher d'abord.
  state.inNightResolution = true;
  state.gameStats.nightCount++;
  const protectedBySalvateur = !!(state.nightTarget && state.protectedTarget && state.nightTarget === state.protectedTarget);
  const protectedByWitch     = !!(state.nightTarget && state.witchSaveActive);
  const savedThisNight       = !!(state.nightTarget && (protectedBySalvateur || protectedByWitch));
  const witchKillThisNight   = !!state.witchKillTarget;
  if (witchKillThisNight) state.gameStats.witchKilled = true;
  if (protectedByWitch)   state.gameStats.witchSaved  = true;

  const deaths = [];
  if (state.nightTarget && !protectedByWitch && !protectedBySalvateur) {
    deaths.push(buildDeath(state.nightTarget, "loups"));
  }
  if (state.witchKillTarget) {
    deaths.push(buildDeath(state.witchKillTarget, "sorcière"));
  }

  // Cycle Salvateur : la protection courante devient "celle de la nuit précédente"
  state.lastProtectedTarget = state.protectedTarget;
  state.protectedTarget     = null;

  const deadBeforeNight = new Set(state.deadPlayers);

  // Si killPlayer déclenche un changement de phase (chasseur/mayorTransfer),
  // on doit interrompre la boucle pour ne pas exécuter la 2e mort hors contexte.
  for (const d of deaths) {
    if (!state.gameStats.firstDead) state.gameStats.firstDead = { name: d.name, role: d.role };
    state.gameStats.deathLog.push(d);
    killPlayer(d.id);
    if (state.phase === "chasseur" || state.phase === "mayorTransfer") break;
  }

  // deathLog et firstDead pour les morts d'amour sont déjà écrits par killPlayer
  // (via la mécanique amoureux). On ne fait qu'alimenter le tableau `deaths` pour
  // qu'il soit complet dans l'émission dawnResult.
  state.deadPlayers.filter(id => !deadBeforeNight.has(id) && !deaths.find(d => d.id === id)).forEach(id => {
    deaths.push(buildDeath(id, "amour"));
  });

  // BUG FIX (mai 2026) : si la boucle a été interrompue par `mayorTransfer`, les
  // morts restantes dans `deaths` (ex : cible de la Sorcière) n'ont pas été ajoutées
  // à state.deadPlayers → elles apparaissent à tort comme successeurs potentiels dans
  // le panneau de transfert de maire.
  // On les traite ici, APRÈS la boucle, pour que le prochain emit `deadPlayers`
  // arrive au client avant que le panneau s'ouvre (le panneau s'ouvre après la carte
  // d'aube, soit plusieurs secondes plus tard).
  if (state.phase === "mayorTransfer") {
    for (const d of deaths) {
      if (state.deadPlayers.includes(d.id)) continue; // déjà mort (cascade amour ou 1ère itération)
      if (!state.gameStats.firstDead) state.gameStats.firstDead = { name: d.name, role: d.role };
      state.gameStats.deathLog.push(d);
      if (state.roles[d.id] === "Chasseur" && !state.pendingChasseurAfterTransfer) {
        // Le chasseur doit tirer APRÈS le transfert → on le diffère plutôt que de
        // changer de phase immédiatement (mayorTransfer a priorité).
        state.pendingChasseurAfterTransfer = d.id;
        state.chasseurPostContext = "night";
        state.currentChasseurShooter = d.id;
        // Ajout manuel à deadPlayers pour l'exclure des candidats au titre de maire.
        state.deadPlayers.push(d.id);
        const nmChasseur = playerName(d.id).toLowerCase();
        if (state.playerRegistry[nmChasseur]) state.playerRegistry[nmChasseur].isDead = true;
        state.io.emit("deadPlayers", state.deadPlayers);
        state.io.emit("playerDied", { id: d.id, role: state.roles[d.id], name: playerName(d.id) });
      } else {
        // Mort ordinaire : killPlayer l'ajoute à deadPlayers et gère les cascades.
        killPlayer(d.id);
      }
    }
  }

  state.nightTarget = null;
  state.witchKillTarget = null;
  state.witchSaveActive = false;

  if (state.phase === "chasseur") {
    const missionResultToReveal = (state.mission.active && !state.mission.resultRevealed) ? state.mission.result : null;
    if (missionResultToReveal !== null) state.mission.resultRevealed = true;
    state.io.emit("dawnResult", {
      deaths, saved: savedThisNight, witchKilled: witchKillThisNight,
      nightNum: state.gameStats.nightCount,
      missionResult: missionResultToReveal
    });
    // Flash au moment de l'annonce des morts (pas dans killPlayer — mauvais timing)
    try {
      if (deaths.length > 0) {
        lights.flashSequence("flash.death", deaths.length);
        if (missionResultToReveal !== null) {
          const mDelay = deaths.length * 750 + 300;
          setTimeout(() => { try { lights.flash(missionResultToReveal === "success" ? "flash.victory" : "flash.death"); } catch(_){} }, mDelay);
        }
      } else if (missionResultToReveal !== null) {
        lights.flash(missionResultToReveal === "success" ? "flash.victory" : "flash.death");
      } else {
        lights.flash("flash.dawn");
      }
    } catch (_) {}
    state.pendingDayRecap = {
      nightNum: state.gameStats.nightCount,
      previousDayDeath: state.lastDayVoteDeath,
      nightDeaths: deaths.map(d => ({ name: d.name, role: d.role, cause: d.cause })),
      saved: savedThisNight,
      savedByWitch:     protectedByWitch,
      savedBySalvateur: protectedBySalvateur,
      missionResult: missionResultToReveal
    };
    // BUG 3 : émet le récap MJ maintenant — setPhase("day") ne sera pas appelé
    // (le chasseur tire avant que le jour démarre) donc le MdJ verrait le récap
    // seulement après le tir. On l'envoie ici pour qu'il soit déjà affiché.
    if (state.mjSocketId && state.pendingDayRecap) {
      state.io.to(state.mjSocketId).emit("mjDayRecap", {
        dayNum: state.gameStats.dayCount + 1,
        ...state.pendingDayRecap
      });
      state.pendingDayRecap = null;
    }
    state.lastDayVoteDeath = null;
    state.inNightResolution = false;
    return;
  }

  const missionResultToReveal = (state.mission.active && !state.mission.resultRevealed) ? state.mission.result : null;
  if (missionResultToReveal !== null) state.mission.resultRevealed = true;

  state.io.emit("dawnResult", {
    deaths, saved: savedThisNight, witchKilled: witchKillThisNight,
    nightNum: state.gameStats.nightCount,
    missionResult: missionResultToReveal
  });
  // Flash au moment de l'annonce des morts (pas dans killPlayer — mauvais timing)
  try {
    if (deaths.length > 0) {
      lights.flashSequence("flash.death", deaths.length);
      if (missionResultToReveal !== null) {
        const mDelay = deaths.length * 750 + 300;
        setTimeout(() => { try { lights.flash(missionResultToReveal === "success" ? "flash.victory" : "flash.death"); } catch(_){} }, mDelay);
      }
    } else if (missionResultToReveal !== null) {
      lights.flash(missionResultToReveal === "success" ? "flash.victory" : "flash.death");
    } else {
      lights.flash("flash.dawn");
    }
  } catch (_) {}

  // === Carte narrative MJ — prépare le récap (émis quand la phase day démarre) ===
  state.pendingDayRecap = {
    nightNum: state.gameStats.nightCount,
    previousDayDeath: state.lastDayVoteDeath,
    nightDeaths: deaths.map(d => ({ name: d.name, role: d.role, cause: d.cause })),
    saved: savedThisNight,
    savedByWitch:     protectedByWitch,
    savedBySalvateur: protectedBySalvateur,
    missionResult: missionResultToReveal
  };
  state.lastDayVoteDeath = null;

  // BUG 5 : on sort de la résolution de nuit avant les setPhase pour que les
  // narrations/transitions normales ne soient pas retardées.
  state.inNightResolution = false;

  // BUG 5 : si une victoire s'est déclenchée pendant la résolution, endGame a
  // mis sa fonction d'émission dans state.pendingEndGame. On émet d'abord le
  // récap MJ, puis on déclenche la fin de partie après ~7 s pour laisser les
  // joueurs voir la dayDeathCard avec la chronique de la nuit.
  if (state.pendingEndGame) {
    if (state.mjSocketId && state.pendingDayRecap) {
      state.io.to(state.mjSocketId).emit("mjDayRecap", {
        dayNum: state.gameStats.dayCount + 1,
        ...state.pendingDayRecap
      });
      state.pendingDayRecap = null;
    }
    const fire = state.pendingEndGame;
    state.pendingEndGame = null;
    setTimeout(() => { try { fire(); } catch (_) {} }, 7000);
    return;
  }

  if (state.phase !== "chasseur" && state.phase !== "mayorTransfer") {
    if (state.mission.active && state.mission.result === "success" && !state.mission.bonusDone
        && state.mayor && !state.deadPlayers.includes(state.mayor)) {
      phases.setPhase("missionBonus");
    } else {
      phases.setPhase("day");
    }
  } else if (state.phase === "mayorTransfer") {
    // BUG 3 : mayorTransfer intercepte avant setPhase("day"), donc mjDayRecap ne serait
    // jamais émis. On l'envoie ici pour que le MdJ voie le récap de nuit AVANT
    // d'annoncer que le maire doit désigner son successeur.
    if (state.mjSocketId && state.pendingDayRecap) {
      state.io.to(state.mjSocketId).emit("mjDayRecap", {
        dayNum: state.gameStats.dayCount + 1,
        ...state.pendingDayRecap
      });
      state.pendingDayRecap = null;
    }
  }
}

// ===== MORT =====
function killPlayer(id) {
  if (!id || state.deadPlayers.includes(id)) return;
  log.info('killPlayer', playerName(id), `(role=${state.roles[id]})`, 'phase=' + state.phase);
  state.deadPlayers.push(id);

  const nm = playerName(id).toLowerCase();
  if (state.playerRegistry[nm]) state.playerRegistry[nm].isDead = true;

  state.io.emit("deadPlayers", state.deadPlayers);
  state.io.emit("playerDied", { id, role: state.roles[id], name: playerName(id) });

  const isMayorDying    = (id === state.mayor);
  const isChasseurDying = (state.roles[id] === "Chasseur");
  if (!isMayorDying && !isChasseurDying) sendDeadVision(id);

  if (state.lovers.includes(id)) {
    const partner = state.lovers.find(l => l !== id);
    if (partner && !state.deadPlayers.includes(partner)) {
      state.deadPlayers.push(partner);
      const pnm = playerName(partner).toLowerCase();
      if (state.playerRegistry[pnm]) state.playerRegistry[pnm].isDead = true;
      state.io.emit("deadPlayers", state.deadPlayers);
      state.io.emit("loversDeathInfo", { id: partner, name: playerName(partner), role: state.roles[partner] });
      state.io.emit("playerDied", { id: partner, role: state.roles[partner], name: playerName(partner) });
      state.gameStats.deathLog.push(buildDeath(partner, "amour"));
      if (!state.gameStats.firstDead) state.gameStats.firstDead = { name: playerName(partner), role: state.roles[partner] };
      sendDeadVision(partner);
      if (state.roles[partner] === "Chasseur") {
        if (partner === state.mayor) {
          state.dyingMayorId = partner; state.mayorTransferPending = true; state.mayor = null;
          state.dyingMayorWasChasseur = true;
          const nightP = ["wolves","seer","corbeau","witch","cupid","mission","missionVote","missionBonus"];
          state.mayorTransferContext = state.phase === "chasseur" ? "chasseur" : nightP.includes(state.phase) ? "night" : "day";
          state.io.emit("newMayor", null); state.io.emit("mayorMustTransfer", partner);
          phases.setPhase("mayorTransfer"); return;
        } else if (isMayorDying) {
          // BUG FIX : le joueur mort (id) est le maire, son amoureux (partner) est le chasseur.
          // On doit d'abord transférer l'écharpe (phase mayorTransfer), PUIS le chasseur tire.
          // Avant ce fix, setPhase("chasseur") était appelé ici → performMayorTransfer refusait
          // le transfert (phase !== "mayorTransfer") et le tiebreakPanel du maire se fermait.
          state.dyingMayorId = id; state.mayorTransferPending = true; state.mayor = null;
          state.dyingMayorWasChasseur = false;
          // Mémorise le chasseur en attente — il tirera dans performMayorTransfer après le transfert.
          state.pendingChasseurAfterTransfer = partner;
          state.chasseurPostContext = (state.phase === "day") ? "day" : "night";
          const nightP = ["wolves","seer","corbeau","witch","cupid","mission","missionVote","missionBonus"];
          state.mayorTransferContext = state.phase === "chasseur" ? "chasseur" : nightP.includes(state.phase) ? "night" : "day";
          state.io.emit("newMayor", null); state.io.emit("mayorMustTransfer", id);
          phases.setPhase("mayorTransfer");
          return; // ← CRUCIAL : ne pas tomber dans le bloc chasseur ci-dessous
        }
        // Cas simple : l'amoureux (partner) est chasseur, ni maire ni objet d'un transfert.
        // Le chasseur tire immédiatement.
        state.currentChasseurShooter = partner;
        state.chasseurPostContext = (state.phase === "day") ? "day" : "night";
        state.io.emit("chasseurMustShoot", partner);
        phases.setPhase("chasseur");
        return;
      }
      if (partner === state.mayor && !state.mayorTransferPending) {
        if (state.phase === "lobby") { phases.checkVictory(); return; }
        if (phases.checkVictory()) return;
        state.dyingMayorId = partner; state.mayorTransferPending = true; state.mayor = null;
        const nightP = ["wolves","seer","corbeau","witch","cupid","mission","missionVote","missionBonus"];
        // Phase "chasseur" : le contexte dépend de chasseurPostContext, pas de la phase courante
        state.mayorTransferContext = state.phase === "chasseur"
          ? (state.chasseurPostContext === "day" ? "chasseurFromDay" : "chasseur")
          : nightP.includes(state.phase) ? "night" : "day";
        state.io.emit("newMayor", null); state.io.emit("mayorMustTransfer", partner);
        phases.setPhase("mayorTransfer"); return;
      }
    }
  }

  if (isMayorDying && !state.mayorTransferPending) {
    if (state.phase === "lobby") { phases.checkVictory(); return; }
    if (!isChasseurDying) {
      if (phases.checkVictory()) return;
    }
    state.dyingMayorId = id; state.mayorTransferPending = true; state.mayor = null;
    state.dyingMayorWasChasseur = isChasseurDying;
    const nightPhases = ["wolves","seer","corbeau","witch","cupid","mission","missionVote","missionBonus"];
    state.mayorTransferContext = state.phase === "chasseur"
      ? (state.chasseurPostContext === "day" ? "chasseurFromDay" : "chasseur")
      : nightPhases.includes(state.phase) ? "night" : "day";
    state.io.emit("newMayor", null); state.io.emit("mayorMustTransfer", id);
    phases.setPhase("mayorTransfer"); return;
  } else if (isMayorDying && state.mayorTransferPending) {
    return;
  }

  if (isChasseurDying) {
    state.currentChasseurShooter = id;
    state.chasseurPostContext = (state.phase === "day") ? "day" : "night";
    state.io.emit("chasseurMustShoot", id);
    phases.setPhase("chasseur");
    return;
  }
  phases.checkVictory();
}

function sendDeadVision(socketId) {
  // Refonte épuration jour (mai 2026) : en mode piloté MJ, on n'envoie plus la
  // vision spectateur complète pendant la partie. Le joueur mort voit seulement
  // l'écran épuré « Vous êtes mort » + son rôle (deadFullScreen côté client,
  // déclenché par l'event `deadPlayers`). La révélation complète a lieu uniquement
  // en fin de partie (emit `deadVision` direct dans phases.js `endGame`).
  if (state.mjPilotedDay) return;
  state.io.to(socketId).emit("deadVision", {
    roles:     state.roles,
    wolves:    Object.keys(state.roles).filter(id => state.roles[id] === "Loup"),
    lovers:    state.lovers,
    mayor:     state.mayor,
    votesDay:  state.votesDay,
    votesWolf: state.votesWolf,
    mayorVote: state.mayorVote,
  });
}

// ===== CHASSEUR — TIR =====
function performChasseurShot(shooterId, targetId) {
  if (state.phase !== "chasseur") return;
  if (!(state.roles[shooterId] === "Chasseur" && state.deadPlayers.includes(shooterId))) return;
  if (state.deadPlayers.includes(targetId)) return;

  if (state.chasseurTimeout) { clearTimeout(state.chasseurTimeout); state.chasseurTimeout = null; }
  state.currentChasseurShooter = null;

  sendDeadVision(shooterId);
  const postCtx = state.chasseurPostContext;
  // NE PAS remettre chasseurPostContext à null ici : si le tir tue le Maire,
  // killPlayer déclenchera mayorTransfer et doit connaître le contexte (jour/nuit)
  // du Chasseur pour savoir où aller après le transfert du maire.
  // Refonte (mai 2026) : informe le MJ de qui le Chasseur a emporté — sinon il ne
  // voit pas facilement cette mort (elle n'est pas dans le récap de nuit/jour).
  if (state.mjSocketId) {
    state.io.to(state.mjSocketId).emit("mjChasseurShot", {
      shooterName: playerName(shooterId),
      targetName:  playerName(targetId),
      targetRole:  state.roles[targetId] || "?"
    });
  }
  killPlayer(targetId);
  try { lights.flash("flash.death"); } catch (_) {}
  if (state.phase === "chasseur") {
    if (phases.checkVictory()) return;
    if (state.mayorTransferPending && state.dyingMayorId) {
      phases.setPhase("mayorTransfer");
      return;
    }
    // BUG FIX : startNightSequence pour passer par Sœurs/Salvateur si jour→nuit
    if (postCtx === "day") { startNightSequence(); } else { phases.setPhase("day"); }
  }
}

// ===== TRANSFERT MAIRE =====
function performMayorTransfer(targetId) {
  if (state.phase !== "mayorTransfer") return;
  if (state.deadPlayers.includes(targetId)) return;
  if (targetId === state.dyingMayorId) return;

  if (state.mayorTransferTimeout) { clearTimeout(state.mayorTransferTimeout); state.mayorTransferTimeout = null; }

  const oldDyingId = state.dyingMayorId;
  const ctx = state.mayorTransferContext;
  const wasChasseur = state.dyingMayorWasChasseur;
  state.mayor = targetId;
  state.mayorTransferPending = false;
  state.dyingMayorId = null;
  state.mayorTransferContext = "";
  state.dyingMayorWasChasseur = false;
  state.io.emit("newMayor", state.mayor);
  state.io.emit("mayorTransferred", targetId);
  try { lights.flash("flash.bell"); } catch (_) {}
  if (!wasChasseur) sendDeadVision(oldDyingId);

  if (wasChasseur) {
    state.chasseurPostContext = ctx;
    state.currentChasseurShooter = oldDyingId;
    state.io.emit("chasseurMustShoot", oldDyingId);
    phases.setPhase("chasseur");
    return;
  }

  // BUG FIX : cas "maire et chasseur = deux amoureux distincts".
  // Le maire (oldDyingId) vient de transférer l'écharpe.
  // Le chasseur (pendingChasseurAfterTransfer) peut maintenant tirer.
  if (state.pendingChasseurAfterTransfer) {
    const chasseurId = state.pendingChasseurAfterTransfer;
    state.pendingChasseurAfterTransfer = null;
    state.currentChasseurShooter = chasseurId;
    // chasseurPostContext a été posé dans killPlayer au moment de la mort
    state.io.emit("chasseurMustShoot", chasseurId);
    if (!phases.checkVictory()) phases.setPhase("chasseur");
    return;
  }

  if (ctx === "chasseur") {
    // Chasseur venait d'une mort de NUIT → après le transfert, retour au jour
    if (!phases.checkVictory()) phases.setPhase("day");
  } else if (ctx === "chasseurFromDay") {
    // Chasseur venait d'un VOTE DU JOUR → après le transfert, on enchaîne la nuit
    if (!phases.checkVictory()) startNightSequence();
  } else if (ctx === "night") {
    if (!phases.checkVictory()) {
      if (state.mission.active && state.mission.result === "success" && !state.mission.bonusDone
          && state.mayor && !state.deadPlayers.includes(state.mayor)) {
        phases.setPhase("missionBonus");
      } else {
        phases.setPhase("day");
      }
    }
  } else if (ctx === "day") {
    // Maire mort pendant le vote du jour → enchaîner la nuit
    if (!phases.checkVictory()) startNightSequence();
  } else {
    // Contexte inattendu/vide : retour au jour par sécurité
    log.warn('performMayorTransfer', 'ctx inconnu=' + ctx + ' → fallback setPhase(day)');
    if (!phases.checkVictory()) phases.setPhase("day");
  }
}

// ===== ATTRIBUTION DES RÔLES =====
function assignAndStart(config, playerList) {
  log.info('assignAndStart', 'players=' + playerList.length, 'config=', config);
  const numPlayers = playerList.length;
  const numLoups = +(config.loup) || 0;
  // Les Sœurs jumelles vont par 2 (0 ou 2). Toute autre valeur est ramenée à 0.
  const numSisters = (+(config.sisters) === 2) ? 2 : 0;
  const numSpecial =
    (+(config.cupidon)     || 0) +
    (+(config.voyante)     || 0) +
    (+(config.sorciere)    || 0) +
    (+(config.chasseur)    || 0) +
    numLoups +
    (+(config.petiteFille) || 0) +
    (+(config.idiot)       || 0) +
    (+(config.corbeau)     || 0) +
    (+(config.salvateur)   || 0) +
    numSisters;

  if (numPlayers < 4) {
    if (state.mjSocketId) state.io.to(state.mjSocketId).emit("autoResolve",
      `⚠️ Au moins 4 joueurs requis (${numPlayers} connectés).`);
    return;
  }
  if (numLoups < 1) {
    if (state.mjSocketId) state.io.to(state.mjSocketId).emit("autoResolve",
      "⚠️ Il faut au moins 1 loup.");
    return;
  }
  if (numLoups * 2 >= numPlayers) {
    if (state.mjSocketId) state.io.to(state.mjSocketId).emit("autoResolve",
      `⚠️ Trop de loups : ${numLoups} loups vs ${numPlayers} joueurs — ils gagnent dès la 1ère nuit.`);
    return;
  }
  if (numSpecial > numPlayers) {
    if (state.mjSocketId) state.io.to(state.mjSocketId).emit("autoResolve",
      `⚠️ Total des rôles spéciaux (${numSpecial}) > nombre de joueurs (${numPlayers}).`);
    return;
  }

  // Mode autonome : configuré au start
  state.autoMode = !!config.autoMode;
  state.autoVoteMode = [1, 2, 4, 5].includes(+config.autoVoteMode) ? +config.autoVoteMode : 1;

  // Refonte épuration jour (mai 2026) : si la config contient `mjPilotedDay`,
  // l'appliquer ; sinon on conserve la valeur déjà posée (par défaut true au boot).
  // Le MJ peut basculer ce flag via le toggle de la config initiale.
  if (typeof config.mjPilotedDay === "boolean") {
    state.mjPilotedDay = config.mjPilotedDay;
  }

  let shuffled = fisherYates(playerList); let i = 0;
  function add(r, count) {
    for (let j = 0; j < (count || 0); j++) {
      if (!shuffled[i]) return;
      state.roles[shuffled[i].id] = r;
      i++;
    }
  }
  add("Cupidon", config.cupidon);
  add("Voyante", config.voyante);
  add("Sorcière", config.sorciere);
  add("Chasseur", config.chasseur);
  add("Loup", config.loup);
  add("PetiteFille", config.petiteFille);
  add("Idiot", config.idiot);
  add("Corbeau", config.corbeau);
  add("Salvateur", config.salvateur);
  add("Sœurs", numSisters);
  while (i < shuffled.length) { state.roles[shuffled[i].id] = "Villageois"; i++; }

  playerList.forEach(p => {
    const k = p.name.toLowerCase();
    if (state.playerRegistry[k]) state.playerRegistry[k].role = state.roles[p.id];
  });

  const wolves = Object.entries(state.roles).filter(r => r[1] === "Loup").map(r => r[0]);

  playerList.forEach(p => {
    const isWolf = state.roles[p.id] === "Loup";
    state.io.to(p.id).emit("yourRole", {
      role: state.roles[p.id],
      wolves: isWolf ? wolves : [],
      // Refonte épuration jour : le client a besoin de connaître le mode pour
      // décider d'afficher l'écran de mort épuré (deadFullScreen) plutôt que la
      // vision spectateur complète (deadVisionPanel).
      mjPilotedDay: !!state.mjPilotedDay
    });
  });

  state.io.emit("rolesMJ", { roles: state.roles, players: state.players });

  if (config.mission) {
    state.mission.active = true;
    phases.setPhase("mayorVote");
  } else {
    state.mission.active = false;
    phases.setPhase("mayorVote");
  }
}

// ===== HANDLERS SOCKETS =====
function handleCupidChoice(socket, data) {
  if (state.phase !== "cupid" || !hasRole(socket.id, "Cupidon") || state.cupidDone) return;
  // BUG FIX 3 : valider strictement le tableau avant de l'accepter
  if (!Array.isArray(data) || data.length !== 2) return;
  if (new Set(data).size !== 2) return;  // pas deux fois le même ID
  const aliveIds = alivePlayers().map(p => p.id);
  if (!data.every(id => aliveIds.includes(id))) return;  // IDs valides et vivants
  clearTimeout(state.cupidTimeout); state.cupidTimeout = null;
  state.lovers = data;
  state.cupidDone = true;
  [...new Set([socket.id, ...state.lovers])].forEach(id => state.io.to(id).emit("loversInfo", state.lovers));
  if (state.mjSocketId) state.io.to(state.mjSocketId).emit("loversInfo", state.lovers);
  if (state.mjSocketId) {
    state.io.to(state.mjSocketId).emit("soundPlay", "cupid");
    state.skipWolvesSoundOnce = true;
    // Le son loups est différé de 4s pour laisser cupid.mp3 se terminer. MAIS si
    // entre-temps on est passé par sisters/salvateur (qui durent ≥20s), la phase
    // n'est plus "wolves" à 4s — il ne FAUT PAS jouer le son ici, sinon il sonne
    // au milieu du tour des Sœurs. Dans ce cas le son loups sera joué naturellement
    // par setPhase("wolves") quand on y arrivera (skipWolvesSoundOnce sera repassé
    // à false dans ce setTimeout, et setPhase ne le skippera plus).
    setTimeout(() => {
      if (state.mjSocketId && state.phase === "wolves") {
        state.io.to(state.mjSocketId).emit("soundPlay", "wolves");
      }
      state.skipWolvesSoundOnce = false;
    }, CUPID_SOUND_MS);
  }
  startNightSequence();
}

// Le MJ déclenche manuellement le countdown 20s des Sœurs (carte narrative).
// On clear le fail-safe 5 min posé par installPhaseTimeouts, on (re)pose le vrai
// timer de 20s et on émet `sistersTimerStart` à toutes les sœurs vivantes pour
// qu'elles démarrent leur compte à rebours visuel. Idempotent : un clic en double
// ne crée pas deux timers (on clear avant de reposer).
function handleMJStartSistersTimer(socket) {
  if (!isMJ(socket.id)) return;
  if (state.phase !== "sisters") return;
  // Clear l'éventuel timer en cours (fail-safe 5 min ou re-clic MJ)
  if (state.sistersTimeout) { clearTimeout(state.sistersTimeout); state.sistersTimeout = null; }
  state.sistersTimerEnd = Date.now() + SISTERS_TIMEOUT_MS;
  state.sistersTimeout = setTimeout(() => {
    state.sistersTimerEnd = null;
    if (state.phase === "sisters") startNightAfterSisters();
  }, SISTERS_TIMEOUT_MS);
  log.info('handleMJStartSistersTimer', 'durationMs=' + SISTERS_TIMEOUT_MS);
  // Notifie tous les clients (les sœurs démarrent leur countdown, le MJ ferme sa carte)
  state.io.emit("sistersTimerStart", { durationMs: SISTERS_TIMEOUT_MS, startedAt: Date.now() });
}

function handleSalvateurAction(socket, targetId) {
  if (state.phase !== "salvateur" || !hasRole(socket.id, "Salvateur")) return;
  if (!targetId) return;
  if (state.deadPlayers.includes(targetId)) return;
  if (targetId === state.lastProtectedTarget) {
    state.io.to(socket.id).emit("salvateurReject", { reason: "Vous ne pouvez pas protéger la même personne deux nuits de suite." });
    return;
  }
  if (state.salvateurTimeout) { clearTimeout(state.salvateurTimeout); state.salvateurTimeout = null; }
  resetActivity();
  state.protectedTarget = targetId;
  state.io.to(socket.id).emit("salvateurConfirm", { targetId, targetName: playerName(targetId) });
  // Son shield.mp3 côté MJ pour souligner la confirmation
  if (state.mjSocketId) state.io.to(state.mjSocketId).emit("soundPlay", "shield");
  phases.setPhase("wolves");
}

function handleSeerChoice(socket, id) {
  if (state.phase !== "seer" || !hasRole(socket.id, "Voyante")) return;
  if (id === socket.id) return;  // la voyante ne peut pas se cibler
  resetActivity();
  clearTimeout(state.seerTimeout); state.seerTimeout = null;
  state.io.to(socket.id).emit("seerResult", { role: state.roles[id], name: playerName(id) });
  state.gameStats.seerLog.push({ name: playerName(id), role: state.roles[id] });
  if (state.mjSocketId) state.io.to(state.mjSocketId).emit("soundPlay", "seer");
  const next = nextNightPhase("seer");
  if (next === "corbeau") {
    const corbeauId = Object.keys(state.roles).find(cid => state.roles[cid] === "Corbeau" && !state.deadPlayers.includes(cid));
    if (corbeauId) state.io.to(corbeauId).emit("corbeauTurn");
    phases.setPhase("corbeau");
  } else if (next === "witch") {
    const witchId = Object.keys(state.roles).find(wid => state.roles[wid] === "Sorcière" && !state.deadPlayers.includes(wid));
    if (witchId) state.io.to(witchId).emit("nightVictim", state.nightTarget);
    phases.setPhase("witch");
  } else { doResolveNight(); }
}

function handleCorbeauAction(socket, targetId) {
  if (state.phase !== "corbeau" || !hasRole(socket.id, "Corbeau")) return;
  clearTimeout(state.corbeauTimeout); state.corbeauTimeout = null;
  resetActivity();
  state.corbeauTarget = (targetId === "skip" || !targetId) ? "skip" : targetId;
  if (state.mjSocketId) state.io.to(state.mjSocketId).emit("soundPlay", "crow");
  if (state.corbeauTarget !== "skip") {
    state.io.emit("corbeauVotesPublic", { targetId: state.corbeauTarget, targetName: playerName(state.corbeauTarget) });
  }
  if (state.corbeauTarget !== "skip") {
    const name = playerName(state.corbeauTarget);
    if (state.mjSocketId) state.io.to(state.mjSocketId).emit("corbeauMJInfo", { name, id: state.corbeauTarget });
  } else {
    if (state.mjSocketId) state.io.to(state.mjSocketId).emit("corbeauMJInfo", { name: null, id: null });
  }
  const next = nextNightPhase("corbeau");
  if (next === "witch") {
    const witchId = Object.keys(state.roles).find(id => state.roles[id] === "Sorcière" && !state.deadPlayers.includes(id));
    if (witchId) state.io.to(witchId).emit("nightVictim", state.nightTarget);
    phases.setPhase("witch");
  } else { doResolveNight(); }
}

function handleWitchSave(socket) {
  if (state.phase !== "witch" || !hasRole(socket.id, "Sorcière") || state.witchSaveUsed) return;
  if (!state.nightTarget) return;
  clearTimeout(state.witchTimeout); state.witchTimeout = null;
  state.witchSaveUsed = true;
  state.witchSaveActive = true;
  state.io.to(socket.id).emit("witchSaveConfirm");
  if (state.mjSocketId) state.io.to(state.mjSocketId).emit("soundPlay", "witch");
}

function handleWitchKill(socket, id) {
  if (state.phase !== "witch" || !hasRole(socket.id, "Sorcière") || state.witchKillUsed || state.deadPlayers.includes(id)) return;
  if (id === socket.id) return;
  if (id === state.nightTarget) {
    state.io.to(socket.id).emit("witchKillRefused", "Tu ne peux pas utiliser ta potion de mort sur la victime des loups.");
    return;
  }
  clearTimeout(state.witchTimeout); state.witchTimeout = null;
  state.witchKillUsed = true;
  state.witchKillTarget = id;
  state.io.to(socket.id).emit("witchKillConfirm");
  if (state.mjSocketId) state.io.to(state.mjSocketId).emit("soundPlay", "witch");
}

function handleWitchDone(socket) {
  if (state.phase !== "witch" || !hasRole(socket.id, "Sorcière")) return;
  clearTimeout(state.witchTimeout); state.witchTimeout = null;
  doResolveNight();
}

function handleResolveNight(socket) {
  if (!isMJ(socket.id) || state.phase !== "witch") return;
  clearTimeout(state.witchTimeout); state.witchTimeout = null;
  doResolveNight();
}

function handleChasseurAction(socket, targetId) {
  performChasseurShot(socket.id, targetId);
}

function handleMayorTransferChoice(socket, targetId) {
  if (socket.id !== state.dyingMayorId) return;
  performMayorTransfer(targetId);
}

// ===== MISSION HANDLERS =====
function handleMissionTeamChoice(socket, teamIds) {
  if (state.phase !== "mission" || socket.id !== state.mayor) return;
  if (!Array.isArray(teamIds) || teamIds.length !== 3) return;
  const alive = alivePlayers().map(p => p.id);
  // Le maire ne peut pas s'envoyer en mission
  const valid = teamIds.every(id => alive.includes(id) && id !== state.mayor);
  const unique = new Set(teamIds).size === 3;
  if (!valid || !unique) {
    socket.emit("missionError", "Sélection invalide — 3 joueurs vivants autres que vous.");
    return;
  }

  clearMissionTimeouts();
  state.mission.team = teamIds;

  state.io.emit("missionTeamSelected", {
    team: teamIds.map(id => ({ id, name: playerName(id) })),
    mayorName: playerName(state.mayor)
  });

  teamIds.forEach(id => {
    state.io.to(id).emit("missionCardChoice", {
      mayorName: playerName(state.mayor),
      teamNames: teamIds.map(tid => playerName(tid))
    });
  });

  if (state.mjSocketId) state.io.to(state.mjSocketId).emit("missionMJInfo", {
    step: "cardVote",
    team: teamIds.map(id => ({ id, name: playerName(id) }))
  });

  phases.setPhase("missionVote");
}

function handleMissionCard(socket, card) {
  if (state.phase !== "missionVote") return;
  if (!state.mission.team.includes(socket.id)) return;
  if (state.mission.cards[socket.id]) return;
  if (card !== "success" && card !== "fail") return;

  state.mission.cards[socket.id] = card;
  socket.emit("missionCardConfirm", { card });

  if (state.mjSocketId) {
    state.io.to(state.mjSocketId).emit("missionMJInfo", {
      step: "cardReceived",
      received: Object.keys(state.mission.cards).length,
      total: state.mission.team.length
    });
  }

  state.io.emit("missionCardPlayed", {
    count: Object.keys(state.mission.cards).length,
    total: state.mission.team.length
  });

  if (Object.keys(state.mission.cards).length === state.mission.team.length) {
    resolveMissionCards();
  }
}

function handleMissionBonusChoice(socket, bonusTeamIds) {
  if (state.phase !== "missionBonus" || socket.id !== state.mayor) return;
  if (!Array.isArray(bonusTeamIds) || bonusTeamIds.length !== 3) return;
  const alive = alivePlayers().map(p => p.id);
  // Le maire ne peut pas s'inspecter lui-même
  const valid = bonusTeamIds.every(id => alive.includes(id) && id !== state.mayor);
  const unique = new Set(bonusTeamIds).size === 3;
  if (!valid || !unique) {
    socket.emit("missionError", "S\u00e9lection bonus invalide \u2014 3 joueurs vivants autres que vous.");
    return;
  }

  clearMissionTimeouts();
  state.mission.bonusDone = true;

  const hasWolf = bonusTeamIds.some(id => state.roles[id] === "Loup");

  socket.emit("missionBonusResult", {
    team: bonusTeamIds.map(id => ({ id, name: playerName(id) })),
    hasWolf
  });

  if (state.mjSocketId) {
    state.io.to(state.mjSocketId).emit("missionMJBonusResult", {
      team: bonusTeamIds.map(id => ({ id, name: playerName(id) })),
      hasWolf,
      wolves: bonusTeamIds.filter(id => state.roles[id] === "Loup").map(id => playerName(id))
    });
  }

  state.io.emit("missionBonusUsed", {
    mayorName: playerName(state.mayor),
    team: bonusTeamIds.map(id => ({ id, name: playerName(id) }))
  });

  phases.setPhase("day");
}

// IMPORTANT : on MUTE l'objet module.exports (pas de r\u00e9assignation) pour ne pas
// invalider les r\u00e9f\u00e9rences captur\u00e9es par phases.js et votes.js pendant la phase
// de chargement circulaire.
Object.assign(module.exports, {
  // Mission
  clearMissionTimeouts, resetMissionState, resolveMissionCards,
  // Nuit
  startNightSequence, startNightAfterSisters, nextNightPhase, doResolveNight,
  // Alias historique (gard\u00e9 pour compat \u2014 supprimer apr\u00e8s v\u00e9rif des call-sites)
  startNightAfterCupid: startNightSequence,
  // Morts / transferts
  killPlayer, sendDeadVision,
  performChasseurShot, performMayorTransfer,
  // Attribution
  assignAndStart,
  // Handlers
  handleCupidChoice, handleSalvateurAction, handleMJStartSistersTimer, handleSeerChoice, handleCorbeauAction,
  handleWitchSave, handleWitchKill, handleWitchDone, handleResolveNight,
  handleChasseurAction, handleMayorTransferChoice,
  handleMissionTeamChoice, handleMissionCard, handleMissionBonusChoice,
});
