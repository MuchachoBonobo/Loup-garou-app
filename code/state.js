// state.js — État global mutable + constantes + helpers.
// Tous les modules font: const { state, alivePlayers, ... } = require('./state')
// puis accèdent à state.players, state.phase, etc.
// IMPORTANT: ne JAMAIS faire `const { players } = state` au top — toujours `state.players`.

// ===== CONSTANTES =====
const CORBEAU_TIMEOUT_MS        = 45000;
const SEER_TIMEOUT_MS           = 45000;
// Après sa vision, la Voyante doit appuyer sur « OK, j'ai vu » ; filet de sécurité
// si son téléphone ne répond plus (déconnexion, écran verrouillé).
const SEER_ACK_TIMEOUT_MS       = 30000;
// Petite Fille : même rythme que la Voyante (45 s pour désigner ses 3 joueurs, puis
// 30 s de filet pour appuyer sur « OK, j'ai vu » une fois la réponse affichée).
const PETITE_FILLE_TIMEOUT_MS     = 45000;
const PETITE_FILLE_ACK_TIMEOUT_MS = 30000;
// Pause entre deux étapes de nuit : filet de sécurité si le MJ ne clique pas
// (tablette déconnectée…). La nuit continue alors d'elle-même.
const NIGHT_PAUSE_TIMEOUT_MS    = 3 * 60 * 1000;
const WITCH_TIMEOUT_MS          = 90000;
const CUPID_TIMEOUT_MS          = 60000;
const SALVATEUR_TIMEOUT_MS      = 45000;
const SISTERS_TIMEOUT_MS        = 20000;  // 20 s pendant lesquelles les Sœurs se reconnaissent IRL
// Réveil des amoureux après Cupidon : le temps de se regarder (puis pause du MJ)
const AMOUREUX_TIMEOUT_MS       = 15000;
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
  // Vote du jour clos, résultat en cours d'annonce (suspense, égalité à trancher) : les
  // boutons du vote sont ignorés jusqu'au changement de phase (remis à false par setPhase).
  resolutionJourEnCours: false,
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
  nbVotesJour:      0,     // votes du jour résolus ou passés (l'Ange gagne au 1er)
  angeVainqueur:    null,  // id de l'Ange désigné au 1er vote, le temps de la révélation
  nightMusicPlayed: false,

  // Salvateur
  protectedTarget:     null,
  lastProtectedTarget: null,
  salvateurTimeout:    null,

  // Sœurs jumelles
  sistersTimeout:      null,
  amoureuxTimeout:     null,
  amoureuxFin:         null,  // fin des 15 s des amoureux (reconnexion)
  sistersTimerEnd:     null,  // Date d'expiration du 20s (null si pas démarré) — utilisé pour reconnexion + persistance

  // Timeouts divers
  seerTimeout:          null,
  seerPendingResult:    null,   // vision affichée, en attente du « OK » de la Voyante
  petiteFilleTimeout:       null,
  petiteFillePendingResult: null,  // réponse affichée, en attente du « OK » de la Petite Fille
  // Nuit rythmée par le MJ : étape qui démarrera au clic « Passer à l'étape suivante »
  // ("cupid", "sisters", "salvateur", "wolves", "seer", "petiteFille", "corbeau", "witch" ou "aube").
  etapeNuitSuivante:    null,
  // Rythme du MJ : nuit en attente de son « 🌙 Lancer la nuit » ("premiere" ou "suivante"),
  // annonce du matin en cours (carte des morts sur les téléphones), évènement du jour annoncé
  nuitEnAttente:        null,
  annonceMatinEnCours:  false,
  evenementAnnonce:     false,
  // Tir du Chasseur ou transmission d'écharpe en attente du clic du MJ ("chasseur" | "mayorTransfer")
  actionMJ:             null,
  // Reconnexions : ancien identifiant de connexion → identifiant actuel du même joueur.
  // Permet d'accepter un choix envoyé depuis un écran construit avant la reconnexion.
  aliasIds:             {},
  nightPauseTimeout:    null,
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
  // Chasseur amoureux qui tirera après la transmission de l'écharpe (maire et Chasseur,
  // deux amoureux distincts)
  pendingChasseurAfterTransfer: null,

  // Pause
  gamePaused:            false,
  pausedVoteRemainingMs: null,

  // Mode autonome
  autoMode:            false,
  autoVoteMode:        1,
  mayorAutoLockTimer:  null,
  mayorAllVotedNotified: false,  // le MJ a déjà été prévenu que tout le monde a voté pour le maire
  wolfConsensusTimer:  null,
  wolvesAutoLockTimer: null,
  dayAutoStartTimer:   null,

  // true : jour piloté par le MJ — le vote ne démarre et ne s'affiche qu'à son signal ;
  // les joueurs voient « le jour se lève » puis l'écran de débat. Case de la préparation du MJ.
  mjPilotedDay:        true,

  // Conseil des Morts activé pour cette partie (case du MJ avant la partie, 2026-10-26)
  conseilActif:        true,

  // Bots
  botCounter: 0,

  // Reprise après crash : snapshot chargé au boot en attente d'arbitrage MJ
  pendingRestore: null,

  // Récap narratif jour
  pendingDayRecap:     null,
  skipWolvesSoundOnce: false,
  // Résolution de nuit en cours : endGame range sa fin de partie dans pendingEndGame,
  // déclenchée après l'annonce de l'aube
  inNightResolution:   false,
  pendingEndGame:      null,
  pendingEndGameTimer: null,  // les 7 s avant l'écran de fin : annulées par un reset

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
    petiteFilleLog: [],  // { names: [3 prénoms], auMoinsUnLoup } par nuit
    voteLog:     [],     // par vote du jour : [{ votant, cible, cibleRole }] (prénoms) — médailles
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

// Envoi à la tablette du MJ, s'il est connecté
function versMJ(...args) {
  if (state.mjSocketId) state.io.to(state.mjSocketId).emit(...args);
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
    activeCouncilEvent: (state.phase === "day" && ev && state.evenementAnnonce) ? {
      id:        state.activeCouncilEvent,
      title:     ev.title,
      narrative: ev.narrative,
    } : null,
    myDayVoteId:  state.votesDay[socketId]  || null,
    myMayorVoteId: state.mayorVote[socketId] || null,
    isVoteLocked: (state.voteMode === 2 && state.lockedVoters.has(socketId)) ||
                  (state.voteMode === 5 && !!state.votesDay[socketId]),
  };

  // Jour piloté par le MJ : un mort qui se reconnecte retrouve « Vous êtes mort »,
  // pas la vision spectateur complète
  snapshot.mjPilotedDay = !!state.mjPilotedDay;
  snapshot.nuitParMJ = !state.autoMode;
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
        // Temps restant calculé ici : le téléphone n'a pas forcément la même heure que le PC.
        timerRemainingMs: state.sistersTimerEnd ? Math.max(0, state.sistersTimerEnd - Date.now()) : null,
      };
    }
    if (state.phase === "salvateur" && myRole === "Salvateur") {
      snapshot.pendingSalvateurTurn = {
        lastProtectedId:   state.lastProtectedTarget || null,
        lastProtectedName: state.lastProtectedTarget ? playerName(state.lastProtectedTarget) : null,
      };
    }
  }

  snapshot.serverNow = Date.now();
  return snapshot;
}

// Identifiant actuel d'un joueur, même si on reçoit un ancien identifiant (écran ouvert
// avant une reconnexion). Renvoie l'identifiant tel quel s'il n'a jamais changé.
function idActuel(id) {
  let courant = id, garde = 0;
  while (typeof courant === "string" && state.aliasIds[courant] && garde++ < 20) courant = state.aliasIds[courant];
  return courant;
}

module.exports = {
  state, idActuel,
  // Constantes
  CORBEAU_TIMEOUT_MS, SEER_TIMEOUT_MS, SEER_ACK_TIMEOUT_MS,
  PETITE_FILLE_TIMEOUT_MS, PETITE_FILLE_ACK_TIMEOUT_MS, NIGHT_PAUSE_TIMEOUT_MS, WITCH_TIMEOUT_MS, CUPID_TIMEOUT_MS, SALVATEUR_TIMEOUT_MS,
  SISTERS_TIMEOUT_MS, AMOUREUX_TIMEOUT_MS,
  CHASSEUR_TIMEOUT_MS, MAYOR_TRANSFER_TIMEOUT_MS, VOTE_RATE_MS, CUPID_SOUND_MS,
  STUCK_TIMEOUT_MS, FAST_RESOLVE_MS,
  MISSION_TEAM_TIMEOUT_MS, MISSION_CARD_TIMEOUT_MS, MISSION_BONUS_TIMEOUT_MS,
  MAYOR_AUTO_TIMEOUT_MS, WOLVES_AUTO_TIMEOUT_MS, WOLF_CONSENSUS_GRACE_MS,
  DAY_AUTO_START_DELAY_MS, BOT_MIN_DELAY_MS, BOT_MAX_DELAY_MS,
  // Helpers
  alivePlayers, computeCounts, hasRole, isMJ, playerName, fisherYates, versMJ,
  resetActivity, buildFullState,
};
