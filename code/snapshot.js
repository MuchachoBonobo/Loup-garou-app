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
const { partieNeuve } = require('./state');

// SNAPSHOT_DIR permet aux tests d'utiliser un dossier jetable (sinon une partie
// de test serait proposée en « reprise » au prochain vrai lancement).
const SNAP_DIR  = process.env.SNAPSHOT_DIR || path.join(__dirname, 'snapshots');
try { if (!fs.existsSync(SNAP_DIR)) fs.mkdirSync(SNAP_DIR, { recursive: true }); } catch { /* écrit plus tard, ou journalisé */ }

const SNAP_FILE = path.join(SNAP_DIR, 'state-snapshot.json');
const SAVE_INTERVAL_MS = 5000;

let saveTimer = null;

// Champs sauvegardés : cette liste sert à écrire ET à relire (deux listes parallèles avaient
// laissé des champs oubliés à la reprise). Un champ absent d'une sauvegarde reprend sa valeur
// d'une partie neuve (state.partieNeuve). Relu selon cette valeur : un booléen en vrai/faux,
// un nombre en nombre, le reste tel quel ou la valeur par défaut.
const CHAMPS = [
  // Phase et infos partie
  "phase", "players", "roles", "deadPlayers", "lovers", "mayor", "playerRegistry", "deadChatHistory",
  // Votes
  "votesDay", "votesWolf", "mayorVote", "voteMode", "voteTimerEnd", "fastResolveTriggered",
  // Nuit
  "nightTarget", "witchSaveUsed", "witchKillUsed", "witchSaveActive", "witchKillTarget",
  "cupidDone", "corbeauTarget", "idiotRevealed", "nbVotesJour", "angeVainqueur",
  // Salvateur, Sœurs, rythme du MJ
  "protectedTarget", "lastProtectedTarget", "sistersTimerEnd", "etapeNuitSuivante",
  "nuitEnAttente", "evenementAnnonce", "aliasIds",
  // Conseil des morts, récap, égalité
  "activeCouncilEvent", "pendingCouncilEvent", "silentDayChatHistory", "pendingDayRecap",
  "tiebreakPending", "tiebreakCandidates", "tiebreakContext",
  // Mode autonome, pause
  "autoMode", "autoVoteMode", "gamePaused",
  // Chasseur, transmission d'écharpe
  "currentChasseurShooter", "chasseurPostContext",
  "dyingMayorId", "mayorTransferPending", "dyingMayorWasChasseur", "mayorTransferContext",
];
// Valeur par défaut : celle d'une partie neuve ; la phase est reprise telle quelle
const defauts = () => ({ ...partieNeuve(), phase: undefined, players: [], playerRegistry: {} });
const relire = (v, defaut) => typeof defaut === "boolean" ? !!v
  : typeof defaut === "number" ? (+v || defaut)
  : defaut === undefined ? v
  : v || (Array.isArray(defaut) ? [] : defaut && typeof defaut === "object" ? {} : defaut);

// Extrait les champs sérialisables de state. Les timers, Sets, Maps et state.io
// ne sont jamais sérialisés.
function serializeState(state) {
  return {
    savedAt: new Date().toISOString(),
    ...Object.fromEntries(CHAMPS.map(k => [k, state[k]])),
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
  const d = defauts();
  for (const k of CHAMPS) state[k] = relire(snap[k], d[k]);
  state.lockedVoters = new Set(snap.lockedVoters || []);
  if (snap.mission) Object.assign(state.mission, snap.mission);
  // Journal de la partie : une sauvegarde plus ancienne garde les rubriques apparues depuis
  if (snap.gameStats) state.gameStats = { ...d.gameStats, ...snap.gameStats };
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
    log.error('sauvegarde impossible', e.message);
  }
}

function loadSnapshot() {
  try {
    if (!fs.existsSync(SNAP_FILE)) return null;
    return JSON.parse(fs.readFileSync(SNAP_FILE, 'utf8'));
  } catch (e) {
    log.error('sauvegarde illisible', e.message);
    return null;
  }
}

function clearSnapshot() {
  try { if (fs.existsSync(SNAP_FILE)) fs.unlinkSync(SNAP_FILE); } catch { /* déjà absente */ }
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
    log.error('dump du plantage impossible', e.message);
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
      } catch { /* fichier déjà parti */ }
    }
    if (removed > 0) log.info('ménage des plantages', `${removed} dump(s) de plus de ${days} jours supprimé(s)`);
  } catch (e) {
    log.error('ménage des plantages impossible', e.message);
  }
}

function startPeriodicSave(state) {
  stopPeriodicSave();
  cleanOldCrashes();
  saveTimer = setInterval(() => saveSnapshot(state), SAVE_INTERVAL_MS);
  log.info('sauvegarde périodique lancée', `intervalle=${SAVE_INTERVAL_MS}ms`);
}

function stopPeriodicSave() {
  if (saveTimer) { clearInterval(saveTimer); saveTimer = null; }
}

module.exports = {
  SNAP_DIR,   // dossier des sauvegardes (aussi utilisé par soiree.js)
  applySnapshot, loadSnapshot, clearSnapshot, dumpCrash, startPeriodicSave,
};
