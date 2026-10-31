// votes.js — Tous les mécanismes de vote : maire, jour, loups, tiebreak, sprint final.
// Dépendances circulaires (phases, roles) résolues via require('./module').fn() à l'usage.

const {
  state, alivePlayers, vivantsSauf, computeCounts, playerName, isMJ, hasRole, auHasard, versMJ, vivantsAvecRole, infosCorbeau,
  VOTE_RATE_MS, FAST_RESOLVE_MS, WOLF_CONSENSUS_GRACE_MS, resetActivity,
} = require('./state');

const phases  = require('./phases');
const roles   = require('./roles');
const log     = require('./logger');
const lights  = require('./lights');
const { buildDeathNarrative } = require('./death-narratives');
const council = require('./council');

// Garde-fou : si le Maire ne tranche jamais une égalité (mort, déconnecté,
// absent), on départage automatiquement au hasard après ce délai.
let tiebreakTimeout = null;
const TIEBREAK_TIMEOUT_MS = 30000;

// ===== TIMER VOTE =====
function clearVoteTimer() {
  if (state.voteTimer) { clearTimeout(state.voteTimer); state.voteTimer = null; }
  state.voteTimerEnd = null;
}

// ===== ÉGALITÉ =====
// Plus d'égalité en attente : le garde-fou des 30 s (variable de ce module) est arrêté aussi,
// pour qu'il ne se déclenche pas dans la partie suivante (appelé aussi par resetGameState)
function oublierEgalite() {
  if (tiebreakTimeout) { clearTimeout(tiebreakTimeout); tiebreakTimeout = null; }
  state.tiebreakPending    = false;
  state.tiebreakCandidates = [];
  state.tiebreakContext    = "";
}

// L'égalité en attente telle que les écrans la reçoivent (téléphones, maire, MJ ; reconnexion)
function egaliteEnCours() {
  return {
    candidates: state.tiebreakCandidates.map(id => ({ id, name: playerName(id) })),
    mayorName: playerName(state.mayor), context: state.tiebreakContext
  };
}

function resolveVoteWithTiebreak(counts, context, onResolved) {
  if (!Object.keys(counts).length) return onResolved(null);
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const maxVotes = sorted[0][1];
  const tied = sorted.filter(e => e[1] === maxVotes).map(e => e[0]);

  if (tied.length === 1) return onResolved(tied[0]);

  if (context === "mayor" || !state.mayor || state.deadPlayers.includes(state.mayor)) {
    return onResolved(auHasard(tied));
  }
  // CONSEIL DES MORTS — Incendie : le maire perd son pouvoir, c'est le hasard qui tranche
  if (context === "day" && council.effetDuJour().mayorPowerless) {
    state.io.emit("autoResolve", "🔥 L'écharpe du maire a brûlé — c'est le hasard qui tranche.");
    return onResolved(auHasard(tied));
  }

  state.tiebreakPending    = true;
  state.tiebreakCandidates = tied;
  state.tiebreakContext    = context;
  const egalite = egaliteEnCours();
  state.io.emit("tiebreakNeeded", egalite);
  state.io.to(state.mayor).emit("tiebreakMayor", egalite);
  versMJ("tiebreakMJ", egalite);
  // Mode entraînement : si le maire est un bot, il tranche automatiquement
  maybeRunBotForTiebreak();

  // GARDE-FOU : si le Maire ne tranche pas (mort, déconnecté, AFK), on
  // départage automatiquement au hasard — sinon la partie reste bloquée
  // pour toujours sur « le Maire doit trancher ».
  if (tiebreakTimeout) clearTimeout(tiebreakTimeout);
  tiebreakTimeout = setTimeout(() => {
    if (!state.tiebreakPending || !state.tiebreakCandidates.length) return;
    state.io.emit("autoResolve", "⏱️ Le Maire n'a pas tranché — l'égalité est départagée au hasard.");
    trancherEgalite(auHasard(state.tiebreakCandidates));
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
    lights.flash("flash.bell");
    if (state.lovers.length === 2) versMJ("loversInfo", state.lovers);
    state.mayorVote = {};
    // Délai 5 s : laisse le temps à la lumière et au MJ d'annoncer le nouveau maire
    setTimeout(() => {
      if (state.phase !== "mayorVote") return; // phase changée manuellement pendant l'attente
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
  lights.flash("flash.wolves");
  roles.allerEtapeNuit(roles.etapeApres("wolves"));
}

// ===== VOTE DU MAIRE : TOUT LE MONDE A VOTÉ =====
// Mode autonome : verrouillage automatique. Avec un MJ, il est seulement prévenu
// (c'est lui qui valide le maire).
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

// Mode autonome : les loups vivants sont tous d'accord → l'attaque est verrouillée après un
// court délai de grâce (le temps de changer d'avis)
function cibleCommuneDesLoups() {
  const cibles = vivantsAvecRole("Loup").map(id => state.votesWolf[id]);
  return cibles.length && cibles.every(c => c && c === cibles[0]) ? cibles[0] : null;
}
function checkWolfConsensus() {
  if (!state.autoMode || state.phase !== "wolves") return;
  if (!cibleCommuneDesLoups()) { clearTimeout(state.wolfConsensusTimer); state.wolfConsensusTimer = null; return; }
  if (state.wolfConsensusTimer) return;
  state.wolfConsensusTimer = setTimeout(() => {
    state.wolfConsensusTimer = null;
    if (state.phase === "wolves" && cibleCommuneDesLoups()) performLockWolfVotes();
  }, WOLF_CONSENSUS_GRACE_MS);
}

// ===== BOT TIEBREAK =====
function maybeRunBotForTiebreak() {
  if (!state.tiebreakPending || !state.mayor) return;
  const mayorPlayer = state.players.find(pl => pl.id === state.mayor);
  if (!mayorPlayer || !mayorPlayer.isBot) return;
  phases.scheduleBot(() => {
    if (!state.tiebreakPending) return;
    if (state.deadPlayers.includes(state.mayor)) return;
    const choice = auHasard(state.tiebreakCandidates);
    if (choice) trancherEgalite(choice);
  });
}

// ===== FIN D'UNE ÉGALITÉ =====
// Le maire, le maire-bot ou le hasard (garde-fou des 30 s) a désigné le perdant. Seul
// le vote du jour passe par là : une égalité à l'élection du maire est tirée au sort.
function trancherEgalite(choix) {
  oublierEgalite();
  state.io.emit("tiebreakResolved", { winner: choix, name: playerName(choix) });
  executerVerdict(choix);
}

// ===== VERDICT DU VOTE DU JOUR =====
// Suspense chez le MJ : un battement de cœur avant le verdict
function suspenseVerdict() {
  versMJ("soundPlay", "heartbeat");
  setTimeout(() => versMJ("stopHeartbeat"), 1200);
}

// Urne vidée et vote clos sur tous les écrans
function viderVoteDuJour() {
  state.votesDay = {};
  versMJ("votesDayMJ", state.votesDay);
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
    lights.flash("flash.death");
    state.io.emit("dayVoteResult", { id: cible, name: nom, role, narrative: buildDeathNarrative({ role, cause: "vote", name: nom }) });
  }, 2700);
  setTimeout(() => {
    if (!state.resolutionJourEnCours) return;
    roles.killPlayer(cible, "vote");
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
  lights.flash("flash.idiot");
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
    lights.flash("flash.ange");
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
  // pendant le suspense, est ignoré.
  if (state.phase !== "day" || state.resolutionJourEnCours) return;
  state.resolutionJourEnCours = true;
  // Écran MJ : boutons du vote grisés jusqu'à la fin du jour
  versMJ("voteClosMJ");
  log.info('resolveDayVote', 'votes=', state.votesDay);
  clearVoteTimer(); state.lockedVoters.clear();
  state.nbVotesJour++;  // le 1er vote est celui où l'Ange peut gagner

  // Mémoire des bulletins (par prénom : stable malgré les reconnexions) pour les médailles
  // « Flair » et « Insoupçonnable » de fin de partie
  state.gameStats.voteLog.push(Object.entries(votesDuVillage())
    .map(([votant, cible]) => ({ votant: playerName(votant), cible: playerName(cible), cibleRole: state.roles[cible] })));

  // Les deux voix du Corbeau s'ajoutent au dépouillement
  const corbeau = infosCorbeau();
  if (corbeau) {
    state.votesDay["__corbeau_1__"] = corbeau.targetId;
    state.votesDay["__corbeau_2__"] = corbeau.targetId;
  }
  state.corbeauTarget = null;

  const count = computeCounts(state.votesDay);

  resolveVoteWithTiebreak(count, "day", (target) => {
    // Personne n'a voté : un joueur tiré au sort, et l'Ange ne peut pas gagner ainsi
    // (le village ne l'a pas désigné)
    const tireAuSort = !target;
    if (tireAuSort) {
      target = auHasard(alivePlayers())?.id;
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
  // Conseil des Morts : l'évènement du jour peut imposer son mode de vote (Émeute, Jugement,
  // Panique) et sa durée (Vote Muet) ; sinon, le mode passé en argument (autoVoteMode en mode autonome)
  const effet = council.effetDuJour();
  if (effet.forceVoteMode) mode = effet.forceVoteMode;

  clearVoteTimer(); state.lockedVoters.clear(); state.voteMode = mode;
  state.fastResolveTriggered = false;
  // Modes de vote :
  //   1 = libre 60 s (défaut)
  //   2 = Jugement verrouillé 60 s (vote définitif dès qu'il tombe)
  //   4 = Panique express 30 s
  //   5 = Émeute anonyme 60 s
  const durations = { 1: 60000, 2: 60000, 4: 30000, 5: 60000 };
  const duration = effet.voteDurationMs || durations[mode] || 60000;
  const endsAt = Date.now() + duration + 800;
  state.voteTimerEnd = endsAt;

  const realVotes = votesDuVillage();
  const corbeauInfo = infosCorbeau();
  state.io.emit("voteStarted", { mode, duration, endsAt, serverNow: Date.now(), existingVotes: computeCounts(realVotes), corbeauInfo });
  versMJ("voteStartedMJ", { mode, duration, endsAt, serverNow: Date.now() });
  if (mode !== 5) {
    state.io.emit("votesDayPublic", realVotes);
  }
  roles.annoncerCorbeau();
  // Lumières : tamise doucement la pièce quand le vote démarre — la nuit approche.
  lights.applyScene("dayVote");
  state.voteTimer = setTimeout(() => { resolveDayVote(); }, duration + 800);
  // Jour piloté : les bots attendaient le lancement officiel du vote pour voter.
  if (state.mjPilotedDay) phases.runBotsForPhase("day");
}

// ===== PUBLICATION DES VOTES =====
// Bulletins du vote du jour, sans les deux voix du Corbeau (ajoutées au seul dépouillement)
function votesDuVillage() {
  return Object.fromEntries(Object.entries(state.votesDay).filter(([votant]) => !votant.startsWith("__corbeau")));
}
// Le détail (qui vote pour qui) va au seul MJ ; les téléphones voient les voix, sauf pendant
// l'Émeute (vote anonyme)
function publierVotesDuJour() {
  versMJ("votesDayMJ", state.votesDay);
  if (state.voteMode === 5) return;
  state.io.emit("dayCountsPublic", computeCounts(state.votesDay));
  state.io.emit("votesDayPublic", votesDuVillage());
}
function publierVotesDuMaire() {
  versMJ("mayorVotesMJ", state.mayorVote);
  state.io.emit("mayorCountsPublic", computeCounts(state.mayorVote));
}
// Votes des loups : au MJ, aux loups vivants, et aux morts quand ils voient tout (jour non piloté)
function publierVotesDesLoups() {
  versMJ("wolfVotesMJ", state.votesWolf);
  const destinataires = vivantsAvecRole("Loup").concat(state.mjPilotedDay ? [] : state.deadPlayers);
  destinataires.forEach(id => state.io.to(id).emit("wolfVotesUpdate", state.votesWolf));
}

// ===== HANDLERS SOCKETS =====
// Un vote par seconde au plus et par joueur (double toucher)
function voteTropRapide(id) {
  const maintenant = Date.now();
  if (maintenant - (state.voteRateLimit.get(id) || 0) < VOTE_RATE_MS) return true;
  state.voteRateLimit.set(id, maintenant);
  return false;
}

function handleVoteMayor(socket, target) {
  if (state.phase !== "mayorVote" || state.deadPlayers.includes(socket.id)) return;
  if (target === socket.id) return;  // pas d'auto-vote au maire
  if (voteTropRapide(socket.id)) return;
  state.mayorVote[socket.id] = target;
  publierVotesDuMaire();
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
  // Jour piloté par le MJ : vote accepté seulement une fois lancé
  if (state.mjPilotedDay && state.voteTimer === null) return;
  if (state.idiotRevealed && state.roles[socket.id] === "Idiot") return;
  if (state.voteMode === 2 && state.lockedVoters.has(socket.id)) return;
  if (voteTropRapide(socket.id)) return;
  state.votesDay[socket.id] = id;
  if (state.voteMode === 2) state.lockedVoters.add(socket.id);
  publierVotesDuJour();
  // Émeute : seul le votant apprend pour qui il a voté
  if (state.voteMode === 5) socket.emit("hasVotedConfirm", { targetName: playerName(id) });
  // Sprint final de 30 s quand tout le monde a voté — mode autonome seulement : avec un
  // MJ, le vote dure 60 s et le battement de cœur final doit aller au bout
  if (state.voteMode === 1 && !state.fastResolveTriggered && state.voteTimer && !state.mjPilotedDay) {
    const alive = alivePlayers();
    const allVoted = alive.every(p => state.votesDay[p.id] !== undefined);
    if (allVoted) {
      const remainingMs = state.voteTimerEnd ? Math.max(0, state.voteTimerEnd - Date.now()) : Infinity;
      // Ne raccourcit que si plus de 30s restantes
      if (remainingMs > FAST_RESOLVE_MS) {
        state.fastResolveTriggered = true;
        clearVoteTimer();
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
  roles.ouvrirNuit(false);
}

function handleVoteWolf(socket, id) {
  if (state.phase !== "wolves" || !hasRole(socket.id, "Loup") || state.deadPlayers.includes(id)) return;
  if (state.roles[id] === "Loup") return;
  resetActivity();
  state.votesWolf[socket.id] = id;
  publierVotesDesLoups();
  checkWolfConsensus();
}

function handleLockWolfVotes(socket) {
  if (!isMJ(socket.id)) return;
  performLockWolfVotes();
}

function handleTiebreakChoice(socket, targetId) {
  // Un maire mort ne tranche plus : le garde-fou des 30 s tire alors au sort
  if (!state.tiebreakPending || socket.id !== state.mayor || state.deadPlayers.includes(state.mayor)) return;
  if (state.tiebreakCandidates.includes(targetId)) trancherEgalite(targetId);
}

// IMPORTANT : on MUTE l'objet module.exports (pas de réassignation) pour ne pas
// invalider les références capturées par phases.js et roles.js pendant la phase
// de chargement circulaire.
Object.assign(module.exports, {
  // Core
  clearVoteTimer, oublierEgalite, egaliteEnCours,
  performLockMayorVote, performLockWolfVotes,
  startDayVote, resolveDayVote,
  publierVotesDuJour, publierVotesDuMaire, publierVotesDesLoups,
  // Handlers socket
  handleVoteMayor, handleLockMayorVote,
  handleStartVote, handleVoteDay, handleLockDayVotes, handleSkipDayVote,
  handleVoteWolf, handleLockWolfVotes,
  handleTiebreakChoice,
});
