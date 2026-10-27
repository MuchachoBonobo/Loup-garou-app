// snapshot.js — Persistance de l'état de partie + dump au crash.
//
// Stratégie :
//  - Toutes les 5s, on sérialise l'état "métier" (sans io, sans timers, Sets → Arrays)
//    dans snapshots/state-snapshot.json (écriture atomique via .tmp + rename).
//  - Au crash (uncaughtException / unhandledRejection), on dump tout + le stack dans
//    snapshots/crash-{timestamp}.json pour forensics.
//  - Au boot, si un snapshot existe ET que la phase n'est pas "lobby", on le pose
//    dans state.pendingRestore. Le MJ qui se connecte reçoit `crashRecoveryAvailable`
//    et peut choisir Reprendre / Ignorer via la UI.
//
// Note : pas d'auto-restart des timers à la reprise. On ré-appelle setPhase(phase)
// pour que installPhaseTimeouts repose les timers proprement. Les timers de vote
// du jour sont sauvegardés via voteTimerEnd → on calcule le restant à la reprise.

const fs   = require('fs');
const path = require('path');
const log  = require('./logger');

// SNAPSHOT_DIR permet aux tests d'utiliser un dossier jetable (sinon une partie
// de test serait proposée en « reprise » au prochain vrai lancement).
const SNAP_DIR  = process.env.SNAPSHOT_DIR || path.join(__dirname, 'snapshots');
try { if (!fs.existsSync(SNAP_DIR)) fs.mkdirSync(SNAP_DIR, { recursive: true }); } catch (_) {}

const SNAP_FILE = path.join(SNAP_DIR, 'state-snapshot.json');
const SAVE_INTERVAL_MS = 5000;

let saveTimer = null;

// Champs sauvegardés, avec la valeur qu'ils prennent quand ils manquent à la relecture :
// chaque champ n'est écrit qu'ici (deux listes parallèles, une pour écrire et une pour relire,
// avaient laissé des champs oubliés à la reprise). Relu selon sa valeur par défaut : un booléen
// en vrai/faux, un nombre en nombre, le reste tel quel ou la valeur par défaut.
const CHAMPS = {
  // Phase et infos partie
  phase: undefined, players: [], roles: {}, deadPlayers: [], lovers: [], mayor: null, playerRegistry: {}, deadChatHistory: [],
  // Votes
  votesDay: {}, votesWolf: {}, mayorVote: {}, voteMode: 1, voteTimerEnd: null, fastResolveTriggered: false,
  // Nuit
  nightTarget: null, witchSaveUsed: false, witchKillUsed: false, witchSaveActive: false, witchKillTarget: null,
  cupidDone: false, corbeauTarget: null, idiotRevealed: false, nbVotesJour: 0, angeVainqueur: null,
  // Salvateur, Sœurs, rythme du MJ
  protectedTarget: null, lastProtectedTarget: null, sistersTimerEnd: null, etapeNuitSuivante: null,
  nuitEnAttente: null, evenementAnnonce: false, aliasIds: {},
  // Conseil des morts, récap, égalité
  activeCouncilEvent: null, pendingCouncilEvent: null, silentDayChatHistory: [], pendingDayRecap: null,
  tiebreakPending: false, tiebreakCandidates: [], tiebreakContext: "",
  // Mode autonome, pause
  autoMode: false, autoVoteMode: 1, gamePaused: false,
  // Chasseur, transmission d'écharpe
  currentChasseurShooter: null, chasseurPostContext: null,
  dyingMayorId: null, mayorTransferPending: false, dyingMayorWasChasseur: false, mayorTransferContext: "",
};
const relire = (v, defaut) => typeof defaut === "boolean" ? !!v
  : typeof defaut === "number" ? (+v || defaut)
  : defaut === undefined ? v
  : v || (Array.isArray(defaut) ? [] : defaut && typeof defaut === "object" ? {} : defaut);

// Extrait les champs sérialisables de state. Les timers, Sets, Maps et state.io
// ne sont jamais sérialisés.
function serializeState(state) {
  return {
    savedAt: new Date().toISOString(),
    ...Object.fromEntries(Object.keys(CHAMPS).map(k => [k, state[k]])),
    lockedVoters: Array.from(state.lockedVoters || []),
    mission: state.mission ? {
      active: state.mission.active,
      team: state.mission.team,
      cards: state.mission.cards,
      result: state.mission.result,
      resultRevealed: state.mission.resultRevealed,
      bonusDone: state.mission.bonusDone,
    } : null,
    gameStats: state.gameStats,
    mjPilotedDay: state.mjPilotedDay,
    conseilActif: state.conseilActif,
  };
}

// Repose les champs du snapshot dans state. Les Sets/Maps sont reconstitués.
// Ne touche PAS aux timers ni à state.io.
function applySnapshot(state, snap) {
  for (const [k, defaut] of Object.entries(CHAMPS)) state[k] = relire(snap[k], defaut);
  state.lockedVoters = new Set(snap.lockedVoters || []);
  if (snap.mission) Object.assign(state.mission, snap.mission);
  if (snap.gameStats) {
    state.gameStats = snap.gameStats;
    // Sauvegarde antérieure à la Petite Fille enquêtrice : journal absent
    if (!Array.isArray(state.gameStats.petiteFilleLog)) state.gameStats.petiteFilleLog = [];
  }
  // Absents des anciennes sauvegardes : on garde alors la valeur en place
  if (typeof snap.mjPilotedDay === 'boolean') state.mjPilotedDay = snap.mjPilotedDay;
  if (typeof snap.conseilActif === 'boolean') state.conseilActif = snap.conseilActif;
}

function saveSnapshot(state) {
  try {
    // Pas de snapshot en lobby (rien à sauver) — et on supprime tout snapshot pré-existant
    // pour ne pas proposer une reprise zombie au prochain boot.
    if (state.phase === 'lobby') {
      clearSnapshot();
      return;
    }
    const data = serializeState(state);
    const tmp = SNAP_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, SNAP_FILE);  // atomique
  } catch (e) {
    log.error('snapshot save failed', e.message);
  }
}

function loadSnapshot() {
  try {
    if (!fs.existsSync(SNAP_FILE)) return null;
    return JSON.parse(fs.readFileSync(SNAP_FILE, 'utf8'));
  } catch (e) {
    log.error('snapshot load failed', e.message);
    return null;
  }
}

function clearSnapshot() {
  try { if (fs.existsSync(SNAP_FILE)) fs.unlinkSync(SNAP_FILE); } catch (_) {}
}

function dumpCrash(state, err) {
  try {
    const ts = Date.now();
    const file = path.join(SNAP_DIR, `crash-${ts}.json`);
    const data = {
      crashedAt: new Date().toISOString(),
      error: err ? { message: err.message, stack: err.stack, name: err.name } : null,
      state: serializeState(state),
    };
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return file;
  } catch (e) {
    log.error('crash dump failed', e.message);
    return null;
  }
}

function cleanOldCrashes(maxAgeDays) {
  const days = (typeof maxAgeDays === 'number' && maxAgeDays > 0) ? maxAgeDays : 7;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  try {
    const files = fs.readdirSync(SNAP_DIR).filter(f => /^crash-\d+\.json$/.test(f));
    let removed = 0;
    for (const f of files) {
      const fp = path.join(SNAP_DIR, f);
      try {
        const { mtimeMs } = fs.statSync(fp);
        if (mtimeMs < cutoff) { fs.unlinkSync(fp); removed++; }
      } catch (_) {}
    }
    if (removed > 0) log.info('crash cleanup', `removed ${removed} crash snapshot(s) older than ${days}d`);
  } catch (e) {
    log.error('crash cleanup failed', e.message);
  }
}

function startPeriodicSave(state) {
  stopPeriodicSave();
  cleanOldCrashes();
  saveTimer = setInterval(() => saveSnapshot(state), SAVE_INTERVAL_MS);
  log.info('snapshot periodic save started', `interval=${SAVE_INTERVAL_MS}ms`);
}

function stopPeriodicSave() {
  if (saveTimer) { clearInterval(saveTimer); saveTimer = null; }
}

module.exports = {
  SNAP_DIR,   // dossier des sauvegardes (aussi utilisé par soiree.js)
  serializeState, applySnapshot,
  saveSnapshot, loadSnapshot, clearSnapshot, dumpCrash,
  startPeriodicSave, stopPeriodicSave, cleanOldCrashes,
};
