// votes.js — Tous les mécanismes de vote : maire, jour, loups, tiebreak, sprint final.
// Dépendances circulaires (phases, roles) résolues via require('./module').fn() à l'usage.

const {
  state, alivePlayers, computeCounts, playerName, isMJ, hasRole,
  VOTE_RATE_MS, FAST_RESOLVE_MS, WOLF_CONSENSUS_GRACE_MS, resetActivity,
} = require('./state');

const phases  = require('./phases');
const roles   = require('./roles');
const log     = require('./logger');
const lights  = require('./lights');
const deathNarratives = require('./death-narratives');

// Garde-fou : si le Maire ne tranche jamais une égalité (mort, déconnecté,
// absent), on départage automatiquement au hasard après ce délai.
let tiebreakTimeout = null;
const TIEBREAK_TIMEOUT_MS = 30000;

const VOTE_ROLE_LABEL = {
  Loup: "Loup-Garou", Voyante: "Voyante", Sorcière: "Sorcière",
  Chasseur: "Chasseur", Cupidon: "Cupidon", Villageois: "Villageois",
  PetiteFille: "Petite Fille", Idiot: "l'Idiot du village",
  Corbeau: "Corbeau", Salvateur: "Salvateur", Sœurs: "une des Sœurs jumelles",
};
function buildVoteNarrative(name, role, cause) {
  return deathNarratives.buildDeathNarrative({
    role, cause, name, roleLabel: VOTE_ROLE_LABEL[role] || role
  });
}

// ===== TIMER VOTE =====
function clearVoteTimer() {
  if (state.voteTimer) { clearTimeout(state.voteTimer); state.voteTimer = null; }
  state.voteTimerEnd = null;
}

// ===== TIEBREAK TIMEOUT (nettoyage au reset) =====
// tiebreakTimeout est une variable de module — invisible de resetGameState.
// Cette fonction est appelée par phases.resetGameState pour éviter qu'un timeout
// de 30 s en cours au moment du reset ne se déclenche dans la nouvelle partie.
function clearTiebreakTimeout() {
  if (tiebreakTimeout) { clearTimeout(tiebreakTimeout); tiebreakTimeout = null; }
  state.tiebreakPending    = false;
  state.tiebreakCandidates = [];
  state.tiebreakContext    = "";
}

// ===== TIEBREAK =====
function resolveVoteWithTiebreak(counts, context, onResolved) {
  if (!Object.keys(counts).length) return onResolved(null);
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const maxVotes = sorted[0][1];
  const tied = sorted.filter(e => e[1] === maxVotes).map(e => e[0]);

  if (tied.length === 1) return onResolved(tied[0]);

  if (context === "mayor" || !state.mayor || state.deadPlayers.includes(state.mayor)) {
    return onResolved(tied[Math.floor(Math.random() * tied.length)]);
  }
  // CONSEIL DES MORTS — Incendie : le maire perd son pouvoir, fallback aléatoire
  if (context === "day" && state.activeCouncilEvent === "fire") {
    state.io.emit("autoResolve", "🔥 L'écharpe du maire a brûlé — c'est le hasard qui tranche.");
    return onResolved(tied[Math.floor(Math.random() * tied.length)]);
  }

  state.tiebreakPending    = true;
  state.tiebreakCandidates = tied;
  state.tiebreakContext    = context;
  state.io.emit("tiebreakNeeded", {
    candidates: tied.map(id => ({ id, name: playerName(id) })),
    mayorName: playerName(state.mayor), context
  });
  state.io.to(state.mayor).emit("tiebreakMayor", {
    candidates: tied.map(id => ({ id, name: playerName(id) })), context
  });
  if (state.mjSocketId) state.io.to(state.mjSocketId).emit("tiebreakMJ", {
    candidates: tied.map(id => ({ id, name: playerName(id) })),
    mayorName: playerName(state.mayor), context
  });
  // Mode entraînement : si le maire est un bot, il tranche automatiquement
  maybeRunBotForTiebreak();

  // GARDE-FOU : si le Maire ne tranche pas (mort, déconnecté, AFK), on
  // départage automatiquement au hasard — sinon la partie reste bloquée
  // pour toujours sur « le Maire doit trancher ».
  if (tiebreakTimeout) clearTimeout(tiebreakTimeout);
  tiebreakTimeout = setTimeout(() => {
    if (!state.tiebreakPending) return;
    const cands = state.tiebreakCandidates || [];
    if (!cands.length) { state.tiebreakPending = false; state.tiebreakContext = ""; return; }
    const choice = cands[Math.floor(Math.random() * cands.length)];
    state.io.emit("autoResolve", "⏱ Le Maire n'a pas tranché — l'égalité est départagée au hasard.");
    finishDayTiebreak(choice);
  }, TIEBREAK_TIMEOUT_MS);
}

// ===== LOCK MAIRE / LOUPS =====
function performLockMayorVote() {
  if (state.phase !== "mayorVote") return;
  if (state.mayorAutoLockTimer) { clearTimeout(state.mayorAutoLockTimer); state.mayorAutoLockTimer = null; }
  const count = computeCounts(state.mayorVote);
  resolveVoteWithTiebreak(count, "mayor", (winnerId) => {
    state.mayor = winnerId;
    state.gameStats.mayorName = playerName(state.mayor);
    state.io.emit("newMayor", state.mayor);
    try { lights.flash("flash.bell"); } catch (_) {}
    if (state.lovers.length === 2 && state.mjSocketId) {
      state.io.to(state.mjSocketId).emit("loversInfo", state.lovers);
    }
    state.mayorVote = {};
    // Délai 5 s : laisse le temps à la lumière et au MJ d'annoncer le nouveau maire
    setTimeout(() => {
      if (state.phase !== "mayorVote") return; // phase changée manuellement pendant l'attente
      if (state.mission.active) {
        state.io.to(state.mayor).emit("missionSelectTeam", {
          mayorName: playerName(state.mayor),
          // Le maire ne peut pas s'envoyer en mission
          players: alivePlayers().filter(p => p.id !== state.mayor).map(p => ({ id: p.id, name: p.name }))
        });
        state.io.emit("missionStarted", { mayorName: playerName(state.mayor) });
        if (state.mjSocketId) state.io.to(state.mjSocketId).emit("missionMJInfo", {
          step: "teamSelection",
          mayorName: playerName(state.mayor)
        });
        phases.setPhase("mission");
      } else {
        phases.setPhase("cupid");
      }
    }, 5000);
  });
}

function performLockWolfVotes() {
  if (state.phase !== "wolves") return;
  if (state.wolfConsensusTimer)  { clearTimeout(state.wolfConsensusTimer);  state.wolfConsensusTimer  = null; }
  if (state.wolvesAutoLockTimer) { clearTimeout(state.wolvesAutoLockTimer); state.wolvesAutoLockTimer = null; }
  const count = computeCounts(state.votesWolf);
  state.nightTarget = Object.keys(count).sort((a, b) => count[b] - count[a])[0] || null;
  state.votesWolf = {};
  // AMÉLIORATION 2 : reset des validations loups quand on lock
  if (state.wolfConfirmed) state.wolfConfirmed.clear();
  // Flash : les loups ont désigné leur proie
  try { lights.flash("flash.wolves"); } catch (_) {}
  const next = roles.nextNightPhase("wolves");
  if (next === "seer") { phases.setPhase("seer"); }
  else if (next === "corbeau") {
    const corbeauId = Object.keys(state.roles).find(id => state.roles[id] === "Corbeau" && !state.deadPlayers.includes(id));
    if (corbeauId) state.io.to(corbeauId).emit("corbeauTurn");
    phases.setPhase("corbeau");
  } else if (next === "witch") {
    const witchId = Object.keys(state.roles).find(id => state.roles[id] === "Sorcière" && !state.deadPlayers.includes(id));
    if (witchId) state.io.to(witchId).emit("nightVictim", state.nightTarget);
    phases.setPhase("witch");
  } else { roles.doResolveNight(); }
}

// ===== AUTO-LOCK DU VOTE MAIRE =====
// AMÉLIORATION 1 : on verrouille dès que tout le monde a voté, en mode autonome
// comme en mode MJ — le MJ n'a plus besoin d'attendre/cliquer.
function checkMayorAutoLock() {
  if (state.phase !== "mayorVote") return;
  const alive = alivePlayers();
  if (alive.length === 0) return;
  const allVoted = alive.every(p => state.mayorVote[p.id] !== undefined);
  if (allVoted) performLockMayorVote();
}

function checkWolfConsensus() {
  if (!state.autoMode || state.phase !== "wolves") return;
  const aliveWolves = Object.keys(state.roles)
    .filter(id => state.roles[id] === "Loup" && !state.deadPlayers.includes(id));
  if (aliveWolves.length === 0) return;

  const allVoted = aliveWolves.every(wid => state.votesWolf[wid]);
  if (!allVoted) {
    if (state.wolfConsensusTimer) { clearTimeout(state.wolfConsensusTimer); state.wolfConsensusTimer = null; }
    return;
  }
  const targets = aliveWolves.map(wid => state.votesWolf[wid]);
  const allSame = targets.every(t => t === targets[0]);

  if (allSame) {
    if (state.wolfConsensusTimer) return;
    state.wolfConsensusTimer = setTimeout(() => {
      state.wolfConsensusTimer = null;
      const aw = Object.keys(state.roles).filter(id => state.roles[id] === "Loup" && !state.deadPlayers.includes(id));
      if (aw.length === 0 || !aw.every(wid => state.votesWolf[wid])) return;
      const t = aw.map(wid => state.votesWolf[wid]);
      if (t.every(x => x === t[0]) && state.phase === "wolves") {
        performLockWolfVotes();
      }
    }, WOLF_CONSENSUS_GRACE_MS);
  } else {
    if (state.wolfConsensusTimer) { clearTimeout(state.wolfConsensusTimer); state.wolfConsensusTimer = null; }
  }
}

// ===== BOT TIEBREAK =====
function maybeRunBotForTiebreak() {
  if (!state.tiebreakPending || !state.mayor) return;
  const mayorPlayer = state.players.find(pl => pl.id === state.mayor);
  if (!mayorPlayer || !mayorPlayer.isBot) return;
  phases.scheduleBot(() => {
    if (!state.tiebreakPending) return;
    if (state.deadPlayers.includes(state.mayor)) return;
    const choice = state.tiebreakCandidates[Math.floor(Math.random() * state.tiebreakCandidates.length)];
    if (!choice) return;
    const savedContext = state.tiebreakContext;
    state.tiebreakPending = false; state.tiebreakCandidates = []; state.tiebreakContext = "";
    state.io.emit("tiebreakResolved", { winner: choice, name: playerName(choice) });
    if (savedContext === "day") {
      // L'Idiot survit même si l'égalité a été tranchée en sa défaveur par le maire-bot
      if (handleIdiotDayVoteSurvival(choice)) return;
      if (state.mjSocketId) state.io.to(state.mjSocketId).emit("soundPlay", "heartbeat");
      setTimeout(() => {
        if (state.mjSocketId) {
          state.io.to(state.mjSocketId).emit("stopHeartbeat");
          setTimeout(() => state.io.to(state.mjSocketId).emit("soundPlay", "drum_roll"), 300);
        }
      }, 1200);
      setTimeout(() => {
        if (state.mjSocketId) state.io.to(state.mjSocketId).emit("soundPlay", "death");
        try { lights.flash("flash.death"); } catch (_) {}
        const cName = playerName(choice), cRole = state.roles[choice];
        state.io.emit("dayVoteResult", {
          id: choice, name: cName, role: cRole,
          narrative: buildVoteNarrative(cName, cRole, "vote")
        });
      }, 2700);
      setTimeout(() => {
        roles.killPlayer(choice);
        state.votesDay = {};
        state.io.emit("votesDayMJ", state.votesDay);
        state.io.emit("dayCountsPublic", {});
        state.io.emit("voteTimerEnd");
        // BUG FIX : check victoire AVANT toute transition de phase (chemin tiebreak)
        if (state.phase !== "lobby" && state.phase !== "chasseur" && state.phase !== "mayorTransfer") {
          if (phases.checkVictory()) return;
          // BUG FIX : routage via startNightSequence pour que Sœurs et Salvateur
          // jouent à toutes les nuits (avant, setPhase("wolves") les skippait).
          roles.startNightSequence();
        }
      }, 8200);
    }
  });
}

// ===== RÉSOLUTION D'UNE ÉGALITÉ DU VOTE DU JOUR =====
// Élimine le joueur désigné puis enchaîne la nuit. Utilisé par le garde-fou
// de timeout quand le Maire n'a pas pu trancher.
function finishDayTiebreak(winnerId) {
  if (!state.tiebreakPending) return;
  if (tiebreakTimeout) { clearTimeout(tiebreakTimeout); tiebreakTimeout = null; }
  state.tiebreakPending = false;
  state.tiebreakCandidates = [];
  state.tiebreakContext = "";
  state.io.emit("tiebreakResolved", { winner: winnerId, name: playerName(winnerId) });
  // L'Idiot survit même si l'égalité a été tranchée en sa défaveur
  if (handleIdiotDayVoteSurvival(winnerId)) return;
  if (state.mjSocketId) state.io.to(state.mjSocketId).emit("soundPlay", "heartbeat");
  setTimeout(() => {
    if (state.mjSocketId) {
      state.io.to(state.mjSocketId).emit("stopHeartbeat");
      setTimeout(() => state.io.to(state.mjSocketId).emit("soundPlay", "drum_roll"), 300);
    }
  }, 1200);
  setTimeout(() => {
    if (state.mjSocketId) state.io.to(state.mjSocketId).emit("soundPlay", "death");
    try { lights.flash("flash.death"); } catch (_) {}
    const tName = playerName(winnerId), tRole = state.roles[winnerId];
    state.io.emit("dayVoteResult", {
      id: winnerId, name: tName, role: tRole,
      narrative: buildVoteNarrative(tName, tRole, "vote")
    });
  }, 2700);
  setTimeout(() => {
    roles.killPlayer(winnerId);
    state.votesDay = {};
    state.io.emit("votesDayMJ", state.votesDay);
    state.io.emit("dayCountsPublic", {});
    state.io.emit("voteTimerEnd");
    if (state.phase !== "lobby" && state.phase !== "chasseur" && state.phase !== "mayorTransfer") {
      if (phases.checkVictory()) return;
      roles.startNightSequence();
    }
  }, 8200);
}

// ===== IDIOT DU VILLAGE =====
// L'Idiot survit s'il est désigné par le VOTE DU VILLAGE (une seule fois) : il est
// démasqué mais reste en vie. Il meurt normalement de toute autre cause (loups,
// sorcière, chasseur, chagrin d'amour) — ces causes passent par killPlayer sans
// exception. Ce helper est appelé par les 3 chemins de résolution du vote du jour
// (résolution normale + arbitrage maire + arbitrage maire-bot) pour que la survie
// soit cohérente, y compris quand l'élimination résulte d'une égalité tranchée.
// Renvoie true si l'Idiot a été épargné (l'appelant doit alors s'arrêter).
function handleIdiotDayVoteSurvival(victimId) {
  if (state.roles[victimId] !== "Idiot" || state.idiotRevealed) return false;
  state.idiotRevealed = true;
  state.io.emit("idiotRevealed", { id: victimId, name: playerName(victimId) });
  try { lights.flash("flash.idiot"); } catch (_) {}
  state.votesDay = {};
  state.io.emit("votesDayMJ", state.votesDay);
  state.io.emit("dayCountsPublic", {});
  state.io.emit("voteTimerEnd");
  if (state.phase !== "chasseur" && state.phase !== "mayorTransfer") roles.startNightSequence();
  return true;
}

// ===== VOTE JOUR — RÉSOLUTION =====
function resolveDayVote() {
  log.info('resolveDayVote', 'votes=', state.votesDay);
  clearVoteTimer(); state.lockedVoters.clear();

  if (state.corbeauTarget && state.corbeauTarget !== "skip" && !state.deadPlayers.includes(state.corbeauTarget)) {
    state.votesDay["__corbeau_1__"] = state.corbeauTarget;
    state.votesDay["__corbeau_2__"] = state.corbeauTarget;
  }
  state.corbeauTarget = null;

  const count = computeCounts(state.votesDay);

  resolveVoteWithTiebreak(count, "day", (target) => {
    if (!target) {
      const alive = alivePlayers();
      target = alive[Math.floor(Math.random() * alive.length)]?.id;
      state.io.emit("randomElim");
    }

    const victimName = playerName(target);
    const victimRole = state.roles[target];

    // L'Idiot survit au vote du village (résolution normale, sans égalité)
    if (handleIdiotDayVoteSurvival(target)) return;

    if (state.mjSocketId) state.io.to(state.mjSocketId).emit("soundPlay", "heartbeat");
    setTimeout(() => {
      if (state.mjSocketId) {
        state.io.to(state.mjSocketId).emit("stopHeartbeat");
        setTimeout(() => state.io.to(state.mjSocketId).emit("soundPlay", "drum_roll"), 300);
      }
    }, 1200);
    setTimeout(() => {
      if (state.mjSocketId) state.io.to(state.mjSocketId).emit("soundPlay", "death");
      try { lights.flash("flash.death"); } catch (_) {}
      state.io.emit("dayVoteResult", {
        id: target, name: victimName, role: victimRole,
        narrative: buildVoteNarrative(victimName, victimRole, "vote")
      });
    }, 2700);

    // Mémorise pour le récap MJ du prochain début de jour
    state.lastDayVoteDeath = { name: victimName, role: victimRole };

    setTimeout(() => {
      roles.killPlayer(target);
      state.votesDay = {};
      state.io.emit("votesDayMJ", state.votesDay);
      state.io.emit("dayCountsPublic", computeCounts(state.votesDay));
      state.io.emit("voteTimerEnd");
      // BUG FIX : check victoire AVANT toute transition de phase
      if (state.phase !== "lobby" && state.phase !== "chasseur" && state.phase !== "mayorTransfer") {
        if (phases.checkVictory()) return;
        // BUG FIX : routage via startNightSequence pour que Sœurs et Salvateur
        // jouent à toutes les nuits (avant, setPhase("wolves") les skippait).
        roles.startNightSequence();
      }
    }, 8200);
  });
}

function startDayVote(mode) {
  if (state.phase !== "day") return;
  log.info('startDayVote', 'mode=' + mode, 'event=' + (state.activeCouncilEvent || 'none'));
  // CONSEIL DES MORTS — overrides (BUG FIX 2 : pas de fallback mode=1 qui écrasait autoVoteMode)
  if      (state.activeCouncilEvent === "riot")     mode = 5;
  else if (state.activeCouncilEvent === "judgment") mode = 2;
  else if (state.activeCouncilEvent === "panic")    mode = 4;
  // else : on conserve le mode passé en argument (autoVoteMode en mode autonome)

  clearVoteTimer(); state.lockedVoters.clear(); state.voteMode = mode;
  state.fastResolveTriggered = false;
  // Modes de vote :
  //   1 = libre 60 s (défaut)
  //   2 = Jugement verrouillé 60 s (vote définitif dès qu'il tombe)
  //   4 = Panique express 30 s
  //   5 = Émeute anonyme 60 s
  const durations = { 1: 60000, 2: 60000, 4: 30000, 5: 60000 };
  let duration = durations[mode] || 60000;
  // CONSEIL DES MORTS — Le Vote Muet : raccourcit le vote à 90 s (pas de débat verbal).
  if (state.activeCouncilEvent === "voteMute") duration = 90000;
  const endsAt = Date.now() + duration + 800;
  state.voteTimerEnd = endsAt;

  const realVotes = {};
  Object.entries(state.votesDay).forEach(([voter, target]) => {
    if (!voter.startsWith("__corbeau")) realVotes[voter] = target;
  });
  const existingCounts = computeCounts(realVotes);

  const corbeauInfo = (state.corbeauTarget && state.corbeauTarget !== "skip" && !state.deadPlayers.includes(state.corbeauTarget))
    ? { targetId: state.corbeauTarget, targetName: playerName(state.corbeauTarget) }
    : null;

  state.io.emit("voteStarted", { mode, duration, endsAt, serverNow: Date.now(), existingVotes: existingCounts, corbeauInfo });
  if (state.mjSocketId) state.io.to(state.mjSocketId).emit("voteStartedMJ", { mode, duration, endsAt, serverNow: Date.now() });
  if (mode !== 5) {
    state.io.emit("votesDayPublic", realVotes);
  }
  if (corbeauInfo) state.io.emit("corbeauVotesPublic", corbeauInfo);
  // Lumières : tamise doucement la pièce quand le vote démarre — la nuit approche.
  try { lights.applyScene("dayVote"); } catch (_) {}
  state.voteTimer = setTimeout(() => { resolveDayVote(); }, duration + 800);
}

// ===== HANDLERS SOCKETS =====
function handleVoteMayor(socket, target) {
  if (state.phase !== "mayorVote" || state.deadPlayers.includes(socket.id)) return;
  if (target === socket.id) return;  // pas d'auto-vote au maire
  const now = Date.now();
  const last = state.voteRateLimit.get(socket.id) || 0;
  if (now - last < VOTE_RATE_MS) return;
  state.voteRateLimit.set(socket.id, now);
  state.mayorVote[socket.id] = target;
  state.io.emit("mayorVotesMJ", state.mayorVote);
  state.io.emit("mayorCountsPublic", computeCounts(state.mayorVote));
  state.io.emit("mayorVoted", socket.id);
  checkMayorAutoLock();
}

function handleLockMayorVote(socket) {
  if (!isMJ(socket.id)) return;
  performLockMayorVote();
}

function handleStartVote(socket) {
  if (!isMJ(socket.id) || state.phase !== "day") return;
  startDayVote(1);
}

function handleVoteDay(socket, id) {
  if (state.phase !== "day" || state.deadPlayers.includes(socket.id) || state.deadPlayers.includes(id)) return;
  if (id === socket.id) return;
  // BUG FIX 4 : en mode piloté MJ, le vote n'est accepté qu'une fois lancé officiellement
  if (state.mjPilotedDay && state.voteTimer === null) return;
  if (state.idiotRevealed && state.roles[socket.id] === "Idiot") return;
  if (state.voteMode === 2 && state.lockedVoters.has(socket.id)) return;
  const now = Date.now();
  const last = state.voteRateLimit.get(socket.id) || 0;
  if (now - last < VOTE_RATE_MS) return;
  state.voteRateLimit.set(socket.id, now);
  state.votesDay[socket.id] = id;
  if (state.voteMode === 2) state.lockedVoters.add(socket.id);
  state.io.emit("votesDayMJ", state.votesDay);
  if (state.voteMode === 5) {
    state.io.to(socket.id).emit("hasVotedConfirm", { targetName: playerName(id) });
  } else {
    state.io.emit("dayCountsPublic", computeCounts(state.votesDay));
    const publicDetail = {};
    Object.entries(state.votesDay).forEach(([voter, target]) => {
      if (!voter.startsWith("__corbeau")) publicDetail[voter] = target;
    });
    state.io.emit("votesDayPublic", publicDetail);
  }
  // Sprint final 30s — uniquement si le vote a déjà été lancé (voteTimer != null).
  // Refonte épuration jour (mai 2026) : désactivé en mode piloté MJ car le vote
  // dure déjà 60 s, raccourcir à 30 s casserait l'effet battement de cœur final.
  // En mode autonome (parties sans MJ), le sprint reste utile et conserve son
  // comportement historique.
  if (state.voteMode === 1 && !state.fastResolveTriggered && state.voteTimer && !state.mjPilotedDay) {
    const alive = alivePlayers();
    const allVoted = alive.every(p => state.votesDay[p.id] !== undefined);
    if (allVoted) {
      const remainingMs = state.voteTimerEnd ? Math.max(0, state.voteTimerEnd - Date.now()) : Infinity;
      // Ne raccourcit que si plus de 30s restantes
      if (remainingMs > FAST_RESOLVE_MS) {
        state.fastResolveTriggered = true;
        if (state.voteTimer) clearVoteTimer();
        state.voteTimerEnd = Date.now() + FAST_RESOLVE_MS;
        state.voteTimer = setTimeout(() => { resolveDayVote(); }, FAST_RESOLVE_MS);
        state.io.emit("autoResolve", "✅ Tout le village a voté — vote rapide 30s !");
        state.io.emit("voteResumed", { endsAt: state.voteTimerEnd, durationMs: FAST_RESOLVE_MS, serverNow: Date.now() });
        if (state.mjSocketId) state.io.to(state.mjSocketId).emit("voteStartedMJ", { mode: state.voteMode, duration: FAST_RESOLVE_MS, endsAt: state.voteTimerEnd, serverNow: Date.now() });
      }
    }
  }
}

function handleLockDayVotes(socket) {
  if (!isMJ(socket.id) || state.phase !== "day") return;
  if (state.dayResolutionPending) return;
  state.dayResolutionPending = true;
  clearVoteTimer();
  if (state.mjSocketId) state.io.to(state.mjSocketId).emit("soundPlay", "crowd_gasp");
  setTimeout(() => {
    state.dayResolutionPending = false;
    resolveDayVote();
  }, 800);
}

function handleSkipDayVote(socket) {
  if (!isMJ(socket.id) || state.phase !== "day") return;
  clearVoteTimer();
  state.lockedVoters.clear();
  state.votesDay = {};
  state.corbeauTarget = null;
  state.io.emit("votesDayMJ", state.votesDay);
  state.io.emit("dayCountsPublic", {});
  state.io.emit("voteTimerEnd");
  state.io.emit("daySkipped");
  // BUG FIX : passage par startNightSequence pour les Sœurs/Salvateur
  roles.startNightSequence();
}

function handleVoteWolf(socket, id) {
  if (state.phase !== "wolves" || !hasRole(socket.id, "Loup") || state.deadPlayers.includes(id)) return;
  if (state.roles[id] === "Loup") return;
  resetActivity();
  state.votesWolf[socket.id] = id;
  // AMÉLIORATION 2 : changer de proie annule la validation précédente
  if (state.wolfConfirmed) state.wolfConfirmed.delete(socket.id);
  state.io.emit("wolfVotesMJ", state.votesWolf);
  const wolfIds = Object.keys(state.roles).filter(wid => state.roles[wid] === "Loup" && !state.deadPlayers.includes(wid));
  wolfIds.forEach(wid => state.io.to(wid).emit("wolfVotesUpdate", state.votesWolf));
  // Émet l'état de validation à chaque loup (pour rafraîchir leur UI)
  emitWolfConfirmStatus();
  // Vision spectateur des morts
  state.deadPlayers.forEach(did => state.io.to(did).emit("wolfVotesUpdate", state.votesWolf));
  checkWolfConsensus();
}

function handleLockWolfVotes(socket) {
  if (!isMJ(socket.id)) return;
  performLockWolfVotes();
}

// AMÉLIORATION 2 : chaque loup peut valider son choix (comme la sorcière qui passe).
// Quand tous les loups vivants ont validé ET visent la même proie → lock auto.
function emitWolfConfirmStatus() {
  if (!state.wolfConfirmed) state.wolfConfirmed = new Set();
  const wolfIds = Object.keys(state.roles).filter(wid => state.roles[wid] === "Loup" && !state.deadPlayers.includes(wid));
  const confirmedIds = [...state.wolfConfirmed].filter(id => wolfIds.includes(id));
  const payload = {
    confirmed: confirmedIds,
    total: wolfIds.length
  };
  wolfIds.forEach(wid => state.io.to(wid).emit("wolfConfirmStatus", payload));
}

function handleWolfConfirm(socket) {
  if (state.phase !== "wolves" || !hasRole(socket.id, "Loup")) return;
  if (state.deadPlayers.includes(socket.id)) return;
  if (!state.votesWolf[socket.id]) return;  // doit avoir voté pour valider
  if (!state.wolfConfirmed) state.wolfConfirmed = new Set();
  state.wolfConfirmed.add(socket.id);
  resetActivity();
  emitWolfConfirmStatus();

  // Tous les loups ont-ils validé ?
  const wolfIds = Object.keys(state.roles).filter(wid => state.roles[wid] === "Loup" && !state.deadPlayers.includes(wid));
  const allConfirmed = wolfIds.every(wid => state.wolfConfirmed.has(wid));
  if (!allConfirmed) return;

  // Tous votent-ils la même proie ?
  const targets = wolfIds.map(wid => state.votesWolf[wid]);
  const allSame = targets.every(t => t && t === targets[0]);
  if (allSame) {
    performLockWolfVotes();
  } else {
    // Désaccord — on annule toutes les validations pour forcer un re-choix conscient
    state.wolfConfirmed.clear();
    emitWolfConfirmStatus();
    wolfIds.forEach(wid => state.io.to(wid).emit("wolfConfirmReject", {
      reason: "Vous n'êtes pas d'accord sur la même cible — réessayez."
    }));
  }
}

function handleTiebreakChoice(socket, targetId) {
  if (!state.tiebreakPending || socket.id !== state.mayor) return;
  if (state.deadPlayers.includes(state.mayor)) {
    state.tiebreakPending = false;
    state.tiebreakCandidates = [];
    return;
  }
  if (!state.tiebreakCandidates.includes(targetId)) return;
  const savedContext = state.tiebreakContext;
  state.tiebreakPending = false;
  state.tiebreakCandidates = [];
  state.tiebreakContext = "";
  state.io.emit("tiebreakResolved", { winner: targetId, name: playerName(targetId) });

  if (savedContext === "day") {
    // L'Idiot survit même si l'égalité a été tranchée en sa défaveur par le maire
    if (handleIdiotDayVoteSurvival(targetId)) return;
    if (state.mjSocketId) state.io.to(state.mjSocketId).emit("soundPlay", "heartbeat");
    setTimeout(() => {
      if (state.mjSocketId) {
        state.io.to(state.mjSocketId).emit("stopHeartbeat");
        setTimeout(() => state.io.to(state.mjSocketId).emit("soundPlay", "drum_roll"), 300);
      }
    }, 1200);
    setTimeout(() => {
      if (state.mjSocketId) state.io.to(state.mjSocketId).emit("soundPlay", "death");
      try { lights.flash("flash.death"); } catch (_) {}
      const tName = playerName(targetId), tRole = state.roles[targetId];
      state.io.emit("dayVoteResult", {
        id: targetId, name: tName, role: tRole,
        narrative: buildVoteNarrative(tName, tRole, "vote")
      });
    }, 2700);
    setTimeout(() => {
      roles.killPlayer(targetId);
      state.votesDay = {};
      state.io.emit("votesDayMJ", state.votesDay);
      state.io.emit("dayCountsPublic", {});
      state.io.emit("voteTimerEnd");
      // BUG 3 : check victoire AVANT toute transition de phase (chemin tiebreak handler)
      if (state.phase !== "lobby" && state.phase !== "chasseur" && state.phase !== "mayorTransfer") {
        if (phases.checkVictory()) return;
        // BUG FIX : startNightSequence pour Sœurs/Salvateur à toutes les nuits
        roles.startNightSequence();
      }
    }, 8200);
  }
}

// IMPORTANT : on MUTE l'objet module.exports (pas de réassignation) pour ne pas
// invalider les références capturées par phases.js et roles.js pendant la phase
// de chargement circulaire.
Object.assign(module.exports, {
  // Core
  clearVoteTimer, clearTiebreakTimeout, resolveVoteWithTiebreak,
  performLockMayorVote, performLockWolfVotes,
  checkMayorAutoLock, checkWolfConsensus, maybeRunBotForTiebreak,
  startDayVote, resolveDayVote,
  // Handlers socket
  handleVoteMayor, handleLockMayorVote,
  handleStartVote, handleVoteDay, handleLockDayVotes, handleSkipDayVote,
  handleVoteWolf, handleLockWolfVotes, handleWolfConfirm,
  handleTiebreakChoice,
});
