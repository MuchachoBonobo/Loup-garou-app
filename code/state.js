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

// ===== UNE PARTIE NEUVE =====
// La valeur de chaque champ propre à une partie. L'état au démarrage du serveur, la remise à
// zéro entre deux parties (phases.resetGameState) et la valeur d'un champ absent d'une
// sauvegarde (snapshot.js) viennent toutes d'ici : un champ ajouté ici est remis à zéro partout.
function partieNeuve() {
  return {
    // Rôles, morts, amoureux, maire
    roles: {}, deadPlayers: [], lovers: [], mayor: null, deadChatHistory: [],

    // Votes
    votesDay: {}, votesWolf: {}, mayorVote: {}, voteMode: 1,
    voteTimer: null, voteTimerEnd: null, lockedVoters: new Set(), voteRateLimit: new Map(),
    dayResolutionPending: false,
    // Vote du jour clos, résultat en cours d'annonce (suspense, égalité à trancher) : les
    // boutons du vote sont ignorés jusqu'au changement de phase (remis à false par setPhase).
    resolutionJourEnCours: false,
    fastResolveTriggered: false,
    nbVotesJour: 0,      // votes du jour résolus ou passés (l'Ange gagne au 1er)
    angeVainqueur: null, // id de l'Ange désigné au 1er vote, le temps de la révélation

    // Nuit
    nightTarget: null, witchSaveUsed: false, witchKillUsed: false, witchSaveActive: false, witchKillTarget: null,
    cupidDone: false, corbeauTarget: null, idiotRevealed: false, nightMusicPlayed: false,
    protectedTarget: null, lastProtectedTarget: null,   // Salvateur : cette nuit, la nuit d'avant
    amoureuxFin: null,               // fin des 15 s des amoureux (reconnexion)
    sistersTimerEnd: null,           // fin des 20 s des Sœurs, posée à leur réveil (reconnexion, sauvegarde)
    seerPendingResult: null,         // vision affichée, en attente du « OK » de la Voyante
    petiteFillePendingResult: null,  // réponse affichée, en attente du « OK » de la Petite Fille
    // Résolution de nuit en cours : endGame range sa fin de partie dans pendingEndGame,
    // déclenchée après l'annonce de l'aube
    inNightResolution: false, pendingEndGame: null,
    pendingEndGameTimer: null,  // les 7 s avant l'écran de fin : annulées par un reset
    pendingDayRecap: null,      // récap de la nuit pour le MJ, envoyé au plus tard au début du jour

    // Rythme du MJ. Nuit : étape qui démarrera au clic « Passer à l'étape suivante » ("cupid",
    // "sisters", "salvateur", "wolves", "seer", "petiteFille", "corbeau", "witch" ou "aube") ;
    // nuit en attente de son « 🌙 Lancer la nuit » ("premiere" ou "suivante") ; annonce du matin
    // en cours (carte des morts sur les téléphones) ; évènement du jour annoncé ; tir du Chasseur
    // ou transmission d'écharpe en attente de son clic ("chasseur" | "mayorTransfer").
    etapeNuitSuivante: null, nuitEnAttente: null, annonceMatinEnCours: false, evenementAnnonce: false,
    actionMJ: null,
    // Reconnexions : ancien identifiant de connexion → identifiant actuel du même joueur.
    // Permet d'accepter un choix envoyé depuis un écran construit avant la reconnexion.
    aliasIds: {},

    // Minuteries des phases (arrêtées par phases.clearPhaseTimeouts)
    seerTimeout: null, petiteFilleTimeout: null, nightPauseTimeout: null, witchTimeout: null, cupidTimeout: null,
    salvateurTimeout: null, sistersTimeout: null, amoureuxTimeout: null, corbeauTimeout: null,
    chasseurTimeout: null, mayorTransferTimeout: null,

    // Égalité à trancher par le maire
    tiebreakPending: false, tiebreakCandidates: [], tiebreakContext: "",

    // Transmission d'écharpe, tir du Chasseur
    mayorTransferPending: false, dyingMayorId: null, dyingMayorWasChasseur: false, mayorTransferContext: "",
    chasseurPostContext: null, currentChasseurShooter: null,
    // Chasseur amoureux qui tirera après la transmission de l'écharpe (maire et Chasseur,
    // deux amoureux distincts)
    pendingChasseurAfterTransfer: null,

    // Pause
    gamePaused: false, pausedVoteRemainingMs: null,

    // Mode autonome (réglé au lancement de la partie) et ses filets
    autoMode: false, autoVoteMode: 1,
    mayorAutoLockTimer: null, wolfConsensusTimer: null, wolvesAutoLockTimer: null, dayAutoStartTimer: null,
    mayorAllVotedNotified: false,  // le MJ a déjà été prévenu que tout le monde a voté pour le maire

    // Conseil des Morts (les minuteries d'ambiance restent dans council.js). Les évènements
    // déjà proposés au vote (choisis ou non) ne réapparaissent pas ; Les Voix Étouffées :
    // le chat écrit du jour (les vivants seuls écrivent).
    councilOptions: null, councilVotes: {}, pendingCouncilEvent: null, activeCouncilEvent: null,
    councilUsedEvents: [], silentDayChatHistory: [],

    // Mission
    mission: {
      active: false, team: [], cards: {}, result: null, resultRevealed: false, bonusDone: false,
      teamTimeout: null, cardTimeout: null, bonusTimeout: null,
    },

    // Journal de la partie : médailles et écrans de fin
    gameStats: {
      dayCount: 0, nightCount: 0,
      firstDead: null, mayorName: null, witchSaved: false, witchKilled: false,
      deathLog: [],        // chaque mort : { id, name, role, cause } (marquerMort)
      seerLog: [],
      petiteFilleLog: [],  // { names: [3 prénoms], auMoinsUnLoup } par nuit
      voteLog: [],         // par vote du jour : [{ votant, cible, cibleRole }] (prénoms) — médailles
    },
  };
}

// ===== ÉTAT MUTABLE =====
const state = {
  io: null,                 // injecté au démarrage par server.js
  players: [], playerRegistry: {}, mjSocketId: null,
  phase: "lobby",
  // true : jour piloté par le MJ — le vote ne démarre et ne s'affiche qu'à son signal ;
  // les joueurs voient « le jour se lève » puis l'écran de débat. Case de la préparation du MJ.
  mjPilotedDay: true,
  conseilActif: true,       // Conseil des Morts (case du MJ avant la partie)
  botCounter: 0,
  pendingRestore: null,     // sauvegarde trouvée au démarrage, en attente de l'avis du MJ
  // Alerte « partie bloquée »
  stuckGameTimer: null, lastActivityTime: Date.now(),
  ...partieNeuve(),
};

// ===== HELPERS =====
function alivePlayers() {
  return state.players.filter(p => !state.deadPlayers.includes(p.id));
}
// Les vivants, sauf un (celui qui désigne : Chasseur, maire, robot…)
function vivantsSauf(id) { return alivePlayers().filter(p => p.id !== id); }
function computeCounts(votes) {
  let c = {};
  Object.values(votes).forEach(id => { c[id] = (c[id] || 0) + 1; });
  return c;
}
// Identifiants des joueurs qui ont ce rôle (morts compris), et des seuls vivants
function joueursAvecRole(r) { return Object.keys(state.roles).filter(id => state.roles[id] === r); }
function vivantsAvecRole(r) { return joueursAvecRole(r).filter(id => !state.deadPlayers.includes(id)); }
// Plus de transmission d'écharpe en cours
function oublierTransfert() {
  state.mayorTransferPending = false;
  state.dyingMayorId = null;
  state.mayorTransferContext = "";
  state.dyingMayorWasChasseur = false;
}
// Ce que le Salvateur doit savoir à son réveil : qui il a protégé la veille (interdit ce soir)
function infosSalvateur() {
  return { lastProtectedId: state.lastProtectedTarget || null, lastProtectedName: state.lastProtectedTarget ? playerName(state.lastProtectedTarget) : null };
}
// Désignation du Corbeau (+2 voix au prochain vote du jour), tant que sa cible est en vie
function infosCorbeau() {
  const c = state.corbeauTarget;
  return c && c !== "skip" && !state.deadPlayers.includes(c) ? { targetId: c, targetName: playerName(c) } : null;
}
// Tout ce que voit un mort quand il voit tout (jour non piloté) et chacun en fin de partie
function visionComplete() {
  return {
    roles: state.roles, wolves: joueursAvecRole("Loup"), lovers: state.lovers, mayor: state.mayor,
    votesDay: state.votesDay, votesWolf: state.votesWolf, mayorVote: state.mayorVote,
  };
}
// Fiche d'un joueur dans le registre des prénoms (reconnexion, photo mémorisée)
function entreeRegistre(p) {
  return { id: p.id, oldId: p.id, name: p.name, role: null, photo: p.photo || null };
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
// Un élément au hasard (undefined pour une liste vide)
function auHasard(liste) { return liste[Math.floor(Math.random() * liste.length)]; }

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
    wolves:       isWolf ? joueursAvecRole("Loup") : [],
    soeurs:       state.roles[socketId] === "Sœurs" ? joueursAvecRole("Sœurs") : [],
    deathLog:     state.gameStats.deathLog,
    idiotRevealed: state.idiotRevealed,
    idiotId:      state.idiotRevealed ? joueursAvecRole("Idiot")[0] : null,
    missionActive: state.mission.active,
    missionTeam:   state.mission.team,
    missionResult: state.mission.result,
    missionPhase:  (state.phase === "mission" || state.phase === "missionVote" || state.phase === "missionBonus") ? state.phase : null,
    activeCouncilEvent: (state.phase === "day" && state.evenementAnnonce) ? council.evenementPublic(state.activeCouncilEvent) : null,
    myDayVoteId:  state.votesDay[socketId]  || null,
    myMayorVoteId: state.mayorVote[socketId] || null,
    isVoteLocked: (state.voteMode === 2 && state.lockedVoters.has(socketId)) ||
                  (state.voteMode === 5 && !!state.votesDay[socketId]),
  };

  // Jour piloté par le MJ : un mort qui se reconnecte retrouve « Vous êtes mort »,
  // pas la vision spectateur complète
  snapshot.mjPilotedDay = !!state.mjPilotedDay;
  snapshot.nuitParMJ = !state.autoMode;
  if (isDead && !state.mjPilotedDay) snapshot.deadVision = visionComplete();

  // Reconnexion pendant le tour des Sœurs ou du Salvateur : le téléphone rouvre son panneau
  // (avec le temps restant). Les autres rôles reçoivent leur demande à part
  // (server.js, resynchroniserApresReconnexion).
  if (!isDead) {
    const myRole = state.roles[socketId];
    if (state.phase === "sisters" && myRole === "Sœurs") {
      snapshot.pendingSistersTurn = {
        count: vivantsAvecRole("Sœurs").length,
        timerEndsAt: state.sistersTimerEnd || null,
        // Temps restant calculé ici : le téléphone n'a pas forcément la même heure que le PC.
        timerRemainingMs: state.sistersTimerEnd ? Math.max(0, state.sistersTimerEnd - Date.now()) : null,
      };
    }
    if (state.phase === "salvateur" && myRole === "Salvateur") snapshot.pendingSalvateurTurn = infosSalvateur();
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

// Reconnexion : partout où l'ancien identifiant de connexion du joueur le désigne, le nouveau
// le remplace (rôle, listes, votes, champs, journal des morts, anciens identifiants)
const CHAMPS_JOUEUR = ["mayor", "currentChasseurShooter", "dyingMayorId", "corbeauTarget", "nightTarget", "witchKillTarget",
  "protectedTarget", "lastProtectedTarget", "pendingChasseurAfterTransfer", "angeVainqueur"];
function remplacerIdentifiant(ancien, nouveau, role) {
  if (role) { state.roles[nouveau] = role; delete state.roles[ancien]; }
  [state.lovers, state.deadPlayers, state.mission.team, state.tiebreakCandidates].forEach(liste => {
    const i = liste.indexOf(ancien);
    if (i >= 0) liste[i] = nouveau;
  });
  CHAMPS_JOUEUR.forEach(k => { if (state[k] === ancien) state[k] = nouveau; });
  // Votes dirigés contre lui : ils pointaient sur l'ancien identifiant et étaient comptés à
  // part — un joueur pouvait échapper au vote en se reconnectant
  [state.votesDay, state.votesWolf, state.mayorVote].forEach(urne => {
    Object.keys(urne).forEach(votant => { if (urne[votant] === ancien) urne[votant] = nouveau; });
  });
  // Ses propres bulletins, et sa carte de mission
  [state.votesDay, state.votesWolf, state.mayorVote, state.councilVotes, state.mission.cards].forEach(urne => {
    if (urne[ancien] !== undefined) { urne[nouveau] = urne[ancien]; delete urne[ancien]; }
  });
  if (state.lockedVoters.delete(ancien)) state.lockedVoters.add(nouveau);
  if (state.voteRateLimit.has(ancien)) { state.voteRateLimit.set(nouveau, state.voteRateLimit.get(ancien)); state.voteRateLimit.delete(ancien); }
  // Journal des morts : son rôle reste affiché à côté de son nom
  state.gameStats.deathLog.forEach(d => { if (d.id === ancien) d.id = nouveau; });
  // Tous ses anciens identifiants pointent désormais vers le nouveau
  Object.keys(state.aliasIds).forEach(k => { if (state.aliasIds[k] === ancien) state.aliasIds[k] = nouveau; });
  state.aliasIds[ancien] = nouveau;
}

module.exports = {
  state, partieNeuve, idActuel, remplacerIdentifiant,
  // Constantes
  CORBEAU_TIMEOUT_MS, SEER_TIMEOUT_MS, SEER_ACK_TIMEOUT_MS,
  PETITE_FILLE_TIMEOUT_MS, PETITE_FILLE_ACK_TIMEOUT_MS, NIGHT_PAUSE_TIMEOUT_MS, WITCH_TIMEOUT_MS, CUPID_TIMEOUT_MS, SALVATEUR_TIMEOUT_MS,
  SISTERS_TIMEOUT_MS, AMOUREUX_TIMEOUT_MS,
  CHASSEUR_TIMEOUT_MS, MAYOR_TRANSFER_TIMEOUT_MS, VOTE_RATE_MS,
  STUCK_TIMEOUT_MS, FAST_RESOLVE_MS,
  MISSION_TEAM_TIMEOUT_MS, MISSION_CARD_TIMEOUT_MS, MISSION_BONUS_TIMEOUT_MS,
  MAYOR_AUTO_TIMEOUT_MS, WOLVES_AUTO_TIMEOUT_MS, WOLF_CONSENSUS_GRACE_MS,
  DAY_AUTO_START_DELAY_MS, BOT_MIN_DELAY_MS, BOT_MAX_DELAY_MS,
  // Helpers
  alivePlayers, vivantsSauf, computeCounts, hasRole, isMJ, playerName, fisherYates, auHasard, versMJ,
  joueursAvecRole, vivantsAvecRole, oublierTransfert, infosSalvateur, infosCorbeau, visionComplete, entreeRegistre,
  resetActivity, buildFullState,
};
