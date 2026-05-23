// state.js — État global mutable + constantes + helpers.
// Tous les modules font: const { state, alivePlayers, ... } = require('./state')
// puis accèdent à state.players, state.phase, etc.
// IMPORTANT: ne JAMAIS faire `const { players } = state` au top — toujours `state.players`.

// ===== CONSTANTES =====
const CORBEAU_TIMEOUT_MS        = 45000;
const SEER_TIMEOUT_MS           = 45000;
const WITCH_TIMEOUT_MS          = 90000;
const CUPID_TIMEOUT_MS          = 60000;
const SALVATEUR_TIMEOUT_MS      = 45000;
const SISTERS_TIMEOUT_MS        = 20000;  // 20 s pendant lesquelles les Sœurs se reconnaissent IRL
const CHASSEUR_TIMEOUT_MS       = 60000;
const MAYOR_TRANSFER_TIMEOUT_MS = 60000;
const VOTE_RATE_MS              = 1000;
const CUPID_SOUND_MS            = 4000;
const STUCK_TIMEOUT_MS          = 10 * 60 * 1000;
const FAST_RESOLVE_MS           = 30000;
const MISSION_TEAM_TIMEOUT_MS   = 120000;
const MISSION_CARD_TIMEOUT_MS   = 90000;
const MISSION_BONUS_TIMEOUT_MS  = 90000;
const MAYOR_AUTO_TIMEOUT_MS     = 90000;
const WOLVES_AUTO_TIMEOUT_MS    = 120000;
const WOLF_CONSENSUS_GRACE_MS   = 3000;
const DAY_AUTO_START_DELAY_MS   = 2000;
const BOT_MIN_DELAY_MS          = 2000;
const BOT_MAX_DELAY_MS          = 8000;

// ===== ÉTAT MUTABLE =====
const state = {
  // Connectivité (injectés au boot par server.js)
  io: null,

  // Joueurs / rôles / lobby
  players:        [],
  roles:          {},
  deadPlayers:    [],
  lovers:         [],
  mayor:          null,
  phase:          "lobby",
  playerRegistry: {},
  deadChatHistory: [],
  mjSocketId:     null,

  // Votes
  votesDay:             {},
  votesWolf:            {},
  mayorVote:            {},
  voteMode:             1,
  voteTimer:            null,
  voteTimerEnd:         null,
  lockedVoters:         new Set(),
  dayResolutionPending: false,
  fastResolveTriggered: false,
  voteRateLimit:        new Map(),

  // Nuit
  nightTarget:      null,
  witchSaveUsed:    false,
  witchKillUsed:    false,
  witchSaveActive:  false,
  witchKillTarget:  null,
  cupidDone:        false,
  corbeauTarget:    null,
  corbeauTimeout:   null,
  idiotRevealed:    false,
  nightMusicPlayed: false,

  // Salvateur
  protectedTarget:     null,
  lastProtectedTarget: null,
  salvateurTimeout:    null,

  // Sœurs jumelles
  sistersTimeout:      null,
  sistersTimerEnd:     null,  // Date d'expiration du 20s (null si pas démarré) — utilisé pour reconnexion + persistance

  // Timeouts divers
  seerTimeout:          null,
  witchTimeout:         null,
  cupidTimeout:         null,
  chasseurTimeout:      null,
  mayorTransferTimeout: null,
  stuckGameTimer:       null,
  lastActivityTime:     Date.now(),

  // Tiebreak
  tiebreakPending:    false,
  tiebreakCandidates: [],
  tiebreakContext:    "",

  // Transfert maire / chasseur
  mayorTransferPending:  false,
  dyingMayorId:          null,
  dyingMayorWasChasseur: false,
  mayorTransferContext:  "",
  chasseurPostContext:   null,
  currentChasseurShooter: null,
  // BUG FIX : chasseur amoureux en attente après un transfert de maire
  // (cas : maire et chasseur = deux personnes différentes, toutes deux amoureuses)
  pendingChasseurAfterTransfer: null,

  // Pause
  gamePaused:            false,
  pausedVoteRemainingMs: null,

  // Mode autonome
  autoMode:            false,
  autoVoteMode:        1,
  mayorAutoLockTimer:  null,
  wolfConsensusTimer:  null,
  wolvesAutoLockTimer: null,
  dayAutoStartTimer:   null,

  // Refonte épuration jour (mai 2026) : quand `true`, la phase jour est pilotée
  // entièrement par le MJ — pas d'auto-démarrage du vote, pas d'écran de vote
  // affiché aux joueurs tant que le MJ ne l'a pas lancé explicitement. Les joueurs
  // voient seulement une carte « le jour se lève » puis un écran de débat épuré
  // (cf. handler `phase=day` côté client). Default ON. Toggle dans la config MJ.
  mjPilotedDay:        true,

  // Bots
  botCounter: 0,

  // Reprise après crash : snapshot chargé au boot en attente d'arbitrage MJ
  pendingRestore: null,

  // Récap narratif jour
  lastDayVoteDeath:    null,
  pendingDayRecap:     null,
  skipWolvesSoundOnce: false,
  // BUG 5 : marqueur "on est en train de résoudre une nuit" — endGame diffère alors
  // ses émissions et stocke la fonction de fin dans pendingEndGame ; doResolveNight
  // la déclenche après dawnResult + mjDayRecap pour que la carte chronique s'affiche
  // avant l'écran de fin de partie.
  inNightResolution:   false,
  pendingEndGame:      null,
  // AMÉLIORATION 2 : ids des loups qui ont validé leur choix de proie (Set)
  wolfConfirmed:       new Set(),

  // Conseil des morts (état partagé — les timers privés restent dans council.js)
  councilOptions:        null,
  councilVotes:          {},
  pendingCouncilEvent:   null,
  activeCouncilEvent:    null,
  // Évènements déjà proposés au vote (qu'ils aient été choisis ou non) — ne réapparaissent pas
  councilUsedEvents:     [],
  // Les Voix Étouffées : historique du chat écrit du jour (vivants seuls écrivent)
  silentDayChatHistory:  [],

  // Mission
  mission: {
    active:        false,
    team:          [],
    cards:         {},
    result:        null,
    resultRevealed: false,
    bonusDone:     false,
    teamTimeout:   null,
    cardTimeout:   null,
    bonusTimeout:  null,
  },

  // Stats partie
  gameStats: {
    dayCount:    0,
    nightCount:  0,
    firstDead:   null,
    mayorName:   null,
    witchSaved:  false,
    witchKilled: false,
    deathLog:    [],
    survivors:   [],
    seerLog:     [],
    startTime:   null,
  },
};

// ===== HELPERS =====
function alivePlayers() {
  return state.players.filter(p => !state.deadPlayers.includes(p.id));
}
function computeCounts(votes) {
  let c = {};
  Object.values(votes).forEach(id => { c[id] = (c[id] || 0) + 1; });
  return c;
}
function hasRole(socketId, r) {
  return state.roles[socketId] === r && !state.deadPlayers.includes(socketId);
}
function isMJ(socketId) {
  return state.mjSocketId === socketId;
}
function playerName(id) {
  const p = state.players.find(x => x.id === id);
  return p ? p.name : "?";
}
function fisherYates(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function resetActivity() {
  state.lastActivityTime = Date.now();
  if (state.stuckGameTimer) { clearTimeout(state.stuckGameTimer); state.stuckGameTimer = null; }
}

// Construit le snapshot d'état envoyé à un client qui reconnecte.
function buildFullState(socketId) {
  const council = require('./council');
  const isDead = state.deadPlayers.includes(socketId);
  const isWolf = state.roles[socketId] === "Loup";
  const ev = state.activeCouncilEvent && council.COUNCIL_EVENTS[state.activeCouncilEvent];

  const snapshot = {
    players:      state.players,
    deadPlayers:  state.deadPlayers,
    phase:        state.phase,
    mayor:        state.mayor,
    lovers:       state.lovers,
    mayorCounts:  computeCounts(state.mayorVote),
    dayCounts:    computeCounts(state.votesDay),
    mayorVote:    state.mayorVote,
    voteTimerEnd: state.voteTimerEnd,
    voteMode:     state.voteMode,
    role:         state.roles[socketId],
    wolves:       isWolf ? Object.keys(state.roles).filter(id => state.roles[id] === "Loup") : [],
    deathLog:     state.gameStats.deathLog,
    idiotRevealed: state.idiotRevealed,
    idiotId:      state.idiotRevealed ? Object.keys(state.roles).find(id => state.roles[id] === "Idiot") : null,
    missionActive: state.mission.active,
    missionTeam:   state.mission.team,
    missionResult: state.mission.result,
    missionPhase:  (state.phase === "mission" || state.phase === "missionVote" || state.phase === "missionBonus") ? state.phase : null,
    activeCouncilEvent: (state.phase === "day" && ev) ? {
      id:        state.activeCouncilEvent,
      title:     ev.title,
      narrative: ev.narrative,
    } : null,
  };

  // Refonte épuration jour (mai 2026) : en mode piloté MJ, un mort qui reconnecte
  // ne reçoit PAS la vision spectateur complète — il retombe sur l'écran épuré
  // (deadFullScreen côté client, déclenché par `isDead` + flag `mjPilotedDay`).
  // En mode legacy, on conserve la vision complète à la reconnexion.
  snapshot.mjPilotedDay = !!state.mjPilotedDay;
  if (isDead && !state.mjPilotedDay) {
    snapshot.deadVision = {
      roles:     state.roles,
      wolves:    Object.keys(state.roles).filter(id => state.roles[id] === "Loup"),
      lovers:    state.lovers,
      mayor:     state.mayor,
      votesDay:  state.votesDay,
      votesWolf: state.votesWolf,
      mayorVote: state.mayorVote,
    };
  }

  // Reconnexion en plein milieu d'une phase nocturne : on indique au client qu'il
  // doit ré-ouvrir le panneau correspondant (avec le timer restant le cas échéant).
  // Aujourd'hui couvert : Sœurs et Salvateur. À étendre si besoin pour Voyante, Sorcière, Corbeau, Cupidon.
  if (!isDead) {
    const myRole = state.roles[socketId];
    if (state.phase === "sisters" && myRole === "Sœurs") {
      const aliveSisters = Object.keys(state.roles).filter(id => state.roles[id] === "Sœurs" && !state.deadPlayers.includes(id));
      snapshot.pendingSistersTurn = {
        count: aliveSisters.length,
        // sistersTimerEnd est non-null uniquement si le MJ a déjà lancé le 20s
        timerEndsAt: state.sistersTimerEnd || null,
      };
    }
    if (state.phase === "salvateur" && myRole === "Salvateur") {
      snapshot.pendingSalvateurTurn = {
        lastProtectedId:   state.lastProtectedTarget || null,
        lastProtectedName: state.lastProtectedTarget ? playerName(state.lastProtectedTarget) : null,
      };
    }
  }

  return snapshot;
}

module.exports = {
  state,
  // Constantes
  CORBEAU_TIMEOUT_MS, SEER_TIMEOUT_MS, WITCH_TIMEOUT_MS, CUPID_TIMEOUT_MS, SALVATEUR_TIMEOUT_MS,
  SISTERS_TIMEOUT_MS,
  CHASSEUR_TIMEOUT_MS, MAYOR_TRANSFER_TIMEOUT_MS, VOTE_RATE_MS, CUPID_SOUND_MS,
  STUCK_TIMEOUT_MS, FAST_RESOLVE_MS,
  MISSION_TEAM_TIMEOUT_MS, MISSION_CARD_TIMEOUT_MS, MISSION_BONUS_TIMEOUT_MS,
  MAYOR_AUTO_TIMEOUT_MS, WOLVES_AUTO_TIMEOUT_MS, WOLF_CONSENSUS_GRACE_MS,
  DAY_AUTO_START_DELAY_MS, BOT_MIN_DELAY_MS, BOT_MAX_DELAY_MS,
  // Helpers
  alivePlayers, computeCounts, hasRole, isMJ, playerName, fisherYates,
  resetActivity, buildFullState,
};
