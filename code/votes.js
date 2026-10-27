// votes.js — Tous les mécanismes de vote : maire, jour, loups, tiebreak, sprint final.
// Dépendances circulaires (phases, roles) résolues via require('./module').fn() à l'usage.

const {
  state, alivePlayers, computeCounts, playerName, isMJ, hasRole, versMJ,
  VOTE_RATE_MS, FAST_RESOLVE_MS, WOLF_CONSENSUS_GRACE_MS, resetActivity,
} = require('./state');

const phases  = require('./phases');
const roles   = require('./roles');
const log     = require('./logger');
const lights  = require('./lights');
const deathNarratives = require('./death-narratives');
const council = require('./council');

// Garde-fou : si le Maire ne tranche jamais une égalité (mort, déconnecté,
// absent), on départage automatiquement au hasard après ce délai.
let tiebreakTimeout = null;
const TIEBREAK_TIMEOUT_MS = 30000;

const VOTE_ROLE_LABEL = deathNarratives.ROLE_LABEL;
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
  versMJ("tiebreakMJ", {
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
    trancherEgalite(choice);
  }, TIEBREAK_TIMEOUT_MS);
}

// ===== LOCK MAIRE / LOUPS =====
function performLockMayorVote() {
  // Maire déjà élu (5 s d'annonce avant la nuit) : un second clic relançait l'élection, urne vide
  if (state.phase !== "mayorVote" || state.mayor) return;
  state.mayorAllVotedNotified = false;
  if (state.mayorAutoLockTimer) { clearTimeout(state.mayorAutoLockTimer); state.mayorAutoLockTimer = null; }
  const count = computeCounts(state.mayorVote);
  resolveVoteWithTiebreak(count, "mayor", (winnerId) => {
    state.mayor = winnerId;
    state.gameStats.mayorName = playerName(state.mayor);
    state.io.emit("newMayor", state.mayor);
    try { lights.flash("flash.bell"); } catch (_) {}
    if (state.lovers.length === 2 && state.mjSocketId) {
      versMJ("loversInfo", state.lovers);
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
        versMJ("missionMJInfo", {
          step: "teamSelection",
          mayorName: playerName(state.mayor)
        });
        phases.setPhase("mission");
      } else {
        roles.ouvrirNuit(true);
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
  // Flash : les loups ont désigné leur proie
  try { lights.flash("flash.wolves"); } catch (_) {}
  roles.allerEtapeNuit(roles.etapeApres("wolves"));
}

// ===== AUTO-LOCK DU VOTE MAIRE =====
// AMÉLIORATION 1 : on verrouille dès que tout le monde a voté, en mode autonome
// comme en mode MJ — le MJ n'a plus besoin d'attendre/cliquer.
// Quand tout le monde a voté pour le maire : verrouillage automatique en mode
// autonome uniquement. Sinon c'est le MJ qui verrouille (bouton du panneau
// « Vote du Maire ») ; on le prévient simplement que tout le monde a voté.
function checkMayorAutoLock() {
  if (state.phase !== "mayorVote") return;
  const alive = alivePlayers();
  if (alive.length === 0) return;
  const allVoted = alive.every(p => state.mayorVote[p.id] !== undefined);
  if (!allVoted) return;
  if (state.autoMode) { performLockMayorVote(); return; }
  if (state.mjSocketId && !state.mayorAllVotedNotified) {
    state.mayorAllVotedNotified = true;
    versMJ("autoResolve", "🏛️ Tout le monde a voté pour le maire — cliquez sur « Valider le Maire ».");
  }
}

const loupsVivants = () => Object.keys(state.roles).filter(id => state.roles[id] === "Loup" && !state.deadPlayers.includes(id));

function checkWolfConsensus() {
  if (!state.autoMode || state.phase !== "wolves") return;
  const aliveWolves = loupsVivants();
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
      const aw = loupsVivants();
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
    if (choice) trancherEgalite(choice);
  });
}

// ===== FIN D'UNE ÉGALITÉ =====
// Le maire, le maire-bot ou le hasard (garde-fou des 30 s) a désigné le perdant. Seul
// le vote du jour passe par là : une égalité à l'élection du maire est tirée au sort.
function trancherEgalite(choix) {
  if (tiebreakTimeout) { clearTimeout(tiebreakTimeout); tiebreakTimeout = null; }
  state.tiebreakPending = false;
  state.tiebreakCandidates = [];
  state.tiebreakContext = "";
  state.io.emit("tiebreakResolved", { winner: choix, name: playerName(choix) });
  executerVerdict(choix);
}

// ===== VERDICT DU VOTE DU JOUR =====
// Suspense chez le MJ : battement de cœur, puis roulement de tambour
function suspenseVerdict() {
  versMJ("soundPlay", "heartbeat");
  setTimeout(() => {
    if (!state.mjSocketId) return;
    versMJ("stopHeartbeat");
    setTimeout(() => versMJ("soundPlay", "drum_roll"), 300);
  }, 1200);
}

// Urne vidée et vote clos sur tous les écrans
function viderVoteDuJour() {
  state.votesDay = {};
  state.io.emit("votesDayMJ", state.votesDay);
  state.io.emit("dayCountsPublic", {});
  state.io.emit("voteTimerEnd");
}

// Le village a désigné `cible` (vote, ou égalité tranchée) : l'Ange gagne seul au premier
// vote, l'Idiot survit ; sinon suspense, annonce, mort, puis la victoire ou la nuit.
function executerVerdict(cible, angePossible = true) {
  if (angePossible && handleAngeVictoire(cible)) return;
  if (handleIdiotDayVoteSurvival(cible)) return;
  const nom = playerName(cible), role = state.roles[cible];
  suspenseVerdict();
  setTimeout(() => {
    if (!state.resolutionJourEnCours) return;  // jour quitté ou partie relancée entre-temps
    versMJ("soundPlay", "death");
    try { lights.flash("flash.death"); } catch (_) {}
    state.io.emit("dayVoteResult", { id: cible, name: nom, role, narrative: buildVoteNarrative(nom, role, "vote") });
  }, 2700);
  setTimeout(() => {
    if (!state.resolutionJourEnCours) return;
    roles.killPlayer(cible);
    viderVoteDuJour();
    // Victoire vérifiée avant toute transition ; la nuit passe par ouvrirNuit (Sœurs, Salvateur)
    if (state.phase !== "lobby" && state.phase !== "chasseur" && state.phase !== "mayorTransfer") {
      if (phases.checkVictory()) return;
      roles.ouvrirNuit(false);
    }
  }, 8200);
}

// ===== IDIOT DU VILLAGE =====
// L'Idiot survit s'il est désigné par le VOTE DU VILLAGE (une seule fois) : il est
// démasqué mais reste en vie. Il meurt normalement de toute autre cause (loups,
// sorcière, chasseur, chagrin d'amour) — ces causes passent par killPlayer sans
// exception. Appelé par executerVerdict : la survie vaut aussi quand l'élimination
// résulte d'une égalité tranchée.
// Renvoie true si l'Idiot a été épargné (l'appelant doit alors s'arrêter).
function handleIdiotDayVoteSurvival(victimId) {
  if (state.roles[victimId] !== "Idiot" || state.idiotRevealed) return false;
  state.idiotRevealed = true;
  state.io.emit("idiotRevealed", { id: victimId, name: playerName(victimId) });
  try { lights.flash("flash.idiot"); } catch (_) {}
  viderVoteDuJour();
  if (state.phase !== "chasseur" && state.phase !== "mayorTransfer") roles.ouvrirNuit(false);
  return true;
}

// ===== ANGE =====
// L'Ange gagne SEUL s'il est désigné par le PREMIER vote du village (celui du
// lendemain de la 1re nuit), y compris quand une égalité est tranchée en sa
// défaveur (maire, maire-bot, hasard). Tué de toute autre façon (loups,
// sorcière, chasseur, chagrin d'amour) ou désigné à un vote suivant, c'est un
// simple villageois. `nbVotesJour` compte les votes résolus ET les votes passés
// par le MJ : un premier vote passé lui fait perdre sa chance (choix du
// 2026-10-23). Appelé par executerVerdict, comme l'Idiot.
// Renvoie true si l'Ange a gagné (l'appelant doit alors s'arrêter).
function handleAngeVictoire(victimId) {
  if (state.roles[victimId] !== "Ange" || state.nbVotesJour !== 1) return false;
  state.angeVainqueur = victimId;
  // Même suspense qu'une élimination, puis la révélation à la place de la mort. Le vote
  // n'est clos côté écrans qu'à la fin (comme une élimination) : sinon les téléphones
  // repassaient sur « Discutez » pendant le roulement de tambour.
  suspenseVerdict();
  setTimeout(() => {
    if (state.angeVainqueur !== victimId) return;  // partie réinitialisée entre-temps
    try { lights.flash("flash.ange"); } catch (_) {}
    state.io.emit("angeRevele", { id: victimId, name: playerName(victimId) });
  }, 2700);
  setTimeout(() => {
    if (state.angeVainqueur !== victimId || state.phase === "lobby") return;
    viderVoteDuJour();
    phases.checkVictory();
  }, 8200);
  return true;
}

// ===== VOTE JOUR — RÉSOLUTION =====
function resolveDayVote() {
  // Un seul dépouillement par jour : un 2e appui sur « Terminer », ou la fin du minuteur
  // pendant le suspense, est ignoré (avant : vote résolu deux fois, plusieurs nuits lancées).
  if (state.phase !== "day" || state.resolutionJourEnCours) return;
  state.resolutionJourEnCours = true;
  // Écran MJ : boutons du vote grisés jusqu'à la fin du jour
  versMJ("voteClosMJ");
  log.info('resolveDayVote', 'votes=', state.votesDay);
  clearVoteTimer(); state.lockedVoters.clear();
  state.nbVotesJour++;  // le 1er vote est celui où l'Ange peut gagner

  // Mémoire des bulletins (par prénom : stable malgré les reconnexions) pour les médailles
  // « Flair » et « Insoupçonnable » de fin de partie
  if (!Array.isArray(state.gameStats.voteLog)) state.gameStats.voteLog = [];
  state.gameStats.voteLog.push(Object.entries(state.votesDay)
    .filter(([votant]) => !votant.startsWith("__corbeau"))
    .map(([votant, cible]) => ({ votant: playerName(votant), cible: playerName(cible), cibleRole: state.roles[cible] })));

  if (state.corbeauTarget && state.corbeauTarget !== "skip" && !state.deadPlayers.includes(state.corbeauTarget)) {
    state.votesDay["__corbeau_1__"] = state.corbeauTarget;
    state.votesDay["__corbeau_2__"] = state.corbeauTarget;
  }
  state.corbeauTarget = null;

  const count = computeCounts(state.votesDay);

  resolveVoteWithTiebreak(count, "day", (target) => {
    // Personne n'a voté : un joueur tiré au sort, et l'Ange ne peut pas gagner ainsi
    // (le village ne l'a pas désigné)
    const tireAuSort = !target;
    if (tireAuSort) {
      const alive = alivePlayers();
      target = alive[Math.floor(Math.random() * alive.length)]?.id;
      state.io.emit("randomElim");
    }
    executerVerdict(target, !tireAuSort);
  });
}

function startDayVote(mode) {
  if (state.phase !== "day" || state.resolutionJourEnCours) return;
  // Vote lancé avant la fin de l'annonce du matin : l'évènement est annoncé d'abord, la carte
  // des morts se ferme sur les téléphones ; l'évènement tout juste annoncé reste à lire
  const vientDEtreAnnonce = council.annoncerEvenement();
  council.finAnnonceMatin(!vientDEtreAnnonce);
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
  versMJ("voteStartedMJ", { mode, duration, endsAt, serverNow: Date.now() });
  if (mode !== 5) {
    state.io.emit("votesDayPublic", realVotes);
  }
  if (corbeauInfo) state.io.emit("corbeauVotesPublic", corbeauInfo);
  // Lumières : tamise doucement la pièce quand le vote démarre — la nuit approche.
  try { lights.applyScene("dayVote"); } catch (_) {}
  state.voteTimer = setTimeout(() => { resolveDayVote(); }, duration + 800);
  // Jour piloté : les bots attendaient le lancement officiel du vote pour voter.
  if (state.mjPilotedDay) phases.runBotsForPhase("day");
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

// Le MJ a appuyé sur un bouton du vote alors que le vote est déjà clos : on le lui dit.
function voteDejaClos() {
  versMJ("autoResolve", "⏳ Le vote est déjà clos — le résultat est en cours d'annonce.");
}

function handleStartVote(socket) {
  if (!isMJ(socket.id) || state.phase !== "day") return;
  if (state.resolutionJourEnCours) { voteDejaClos(); return; }
  // Déjà lancé (double appui) : on ne relance pas le compte à rebours
  if (state.voteTimer) {
    versMJ("autoResolve", "🗳️ Le vote est déjà en cours.");
    return;
  }
  startDayVote(1);
}

function handleVoteDay(socket, id) {
  if (state.phase !== "day" || state.deadPlayers.includes(socket.id) || state.deadPlayers.includes(id)) return;
  if (id === socket.id) return;
  if (state.resolutionJourEnCours) return;  // vote clos : plus de changement
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
        versMJ("voteStartedMJ", { mode: state.voteMode, duration: FAST_RESOLVE_MS, endsAt: state.voteTimerEnd, serverNow: Date.now() });
      }
    }
  }
}

function handleLockDayVotes(socket) {
  if (!isMJ(socket.id) || state.phase !== "day") return;
  if (state.resolutionJourEnCours) { voteDejaClos(); return; }
  if (state.dayResolutionPending) return;
  state.dayResolutionPending = true;
  clearVoteTimer();
  versMJ("soundPlay", "crowd_gasp");
  setTimeout(() => {
    state.dayResolutionPending = false;
    resolveDayVote();
  }, 800);
}

function handleSkipDayVote(socket) {
  if (!isMJ(socket.id) || state.phase !== "day") return;
  if (state.resolutionJourEnCours || state.dayResolutionPending) { voteDejaClos(); return; }
  clearVoteTimer();
  state.lockedVoters.clear();
  state.nbVotesJour++;  // un 1er vote passé fait perdre sa chance à l'Ange
  state.corbeauTarget = null;
  viderVoteDuJour();
  state.io.emit("daySkipped");
  // BUG FIX : passage par startNightSequence pour les Sœurs/Salvateur
  roles.ouvrirNuit(false);
}

function handleVoteWolf(socket, id) {
  if (state.phase !== "wolves" || !hasRole(socket.id, "Loup") || state.deadPlayers.includes(id)) return;
  if (state.roles[id] === "Loup") return;
  resetActivity();
  state.votesWolf[socket.id] = id;
  state.io.emit("wolfVotesMJ", state.votesWolf);
  loupsVivants().forEach(wid => state.io.to(wid).emit("wolfVotesUpdate", state.votesWolf));
  // Vision spectateur des morts
  state.deadPlayers.forEach(did => state.io.to(did).emit("wolfVotesUpdate", state.votesWolf));
  checkWolfConsensus();
}

function handleLockWolfVotes(socket) {
  if (!isMJ(socket.id)) return;
  performLockWolfVotes();
}

function handleTiebreakChoice(socket, targetId) {
  // Un maire mort ne tranche plus : le garde-fou des 30 s tire alors au sort (avant,
  // l'égalité était effacée sans verdict et le jour restait bloqué)
  if (!state.tiebreakPending || socket.id !== state.mayor || state.deadPlayers.includes(state.mayor)) return;
  if (state.tiebreakCandidates.includes(targetId)) trancherEgalite(targetId);
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
  handleVoteWolf, handleLockWolfVotes,
  handleTiebreakChoice,
});
