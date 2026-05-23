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

const SNAP_DIR  = path.join(__dirname, 'snapshots');
try { if (!fs.existsSync(SNAP_DIR)) fs.mkdirSync(SNAP_DIR, { recursive: true }); } catch (_) {}

const SNAP_FILE = path.join(SNAP_DIR, 'state-snapshot.json');
const SAVE_INTERVAL_MS = 5000;

let saveTimer = null;

// Extrait les champs sérialisables de state. Les timers, Sets, Maps et state.io
// ne sont jamais sérialisés.
function serializeState(state) {
  return {
    savedAt: new Date().toISOString(),
    // Phase et infos partie
    phase: state.phase,
    players: state.players,
    roles: state.roles,
    deadPlayers: state.deadPlayers,
    lovers: state.lovers,
    mayor: state.mayor,
    playerRegistry: state.playerRegistry,
    deadChatHistory: state.deadChatHistory,
    // Votes
    votesDay: state.votesDay,
    votesWolf: state.votesWolf,
    mayorVote: state.mayorVote,
    voteMode: state.voteMode,
    voteTimerEnd: state.voteTimerEnd,
    lockedVoters: Array.from(state.lockedVoters || []),
    fastResolveTriggered: state.fastResolveTriggered,
    wolfConfirmed: Array.from(state.wolfConfirmed || []),
    // Nuit
    nightTarget: state.nightTarget,
    witchSaveUsed: state.witchSaveUsed,
    witchKillUsed: state.witchKillUsed,
    witchSaveActive: state.witchSaveActive,
    witchKillTarget: state.witchKillTarget,
    cupidDone: state.cupidDone,
    corbeauTarget: state.corbeauTarget,
    idiotRevealed: state.idiotRevealed,
    // Salvateur + Sœurs
    protectedTarget: state.protectedTarget,
    lastProtectedTarget: state.lastProtectedTarget,
    sistersTimerEnd: state.sistersTimerEnd,
    // Mission
    mission: state.mission ? {
      active: state.mission.active,
      team: state.mission.team,
      cards: state.mission.cards,
      result: state.mission.result,
      resultRevealed: state.mission.resultRevealed,
      bonusDone: state.mission.bonusDone,
    } : null,
    // Conseil des morts
    activeCouncilEvent: state.activeCouncilEvent,
    pendingCouncilEvent: state.pendingCouncilEvent,
    silentDayChatHistory: state.silentDayChatHistory,
    // Stats + récap
    gameStats: state.gameStats,
    lastDayVoteDeath: state.lastDayVoteDeath,
    pendingDayRecap: state.pendingDayRecap,
    // Tiebreak
    tiebreakPending: state.tiebreakPending,
    tiebreakCandidates: state.tiebreakCandidates,
    tiebreakContext: state.tiebreakContext,
    // Mode autonome
    autoMode: state.autoMode,
    autoVoteMode: state.autoVoteMode,
    // BUG FIX 6 : champs manquants pour la reprise après crash
    mjPilotedDay: state.mjPilotedDay,
    gamePaused: state.gamePaused,
    // Phase chasseur
    currentChasseurShooter: state.currentChasseurShooter,
    chasseurPostContext: state.chasseurPostContext,
    // Phase mayorTransfer
    dyingMayorId: state.dyingMayorId,
    mayorTransferPending: state.mayorTransferPending,
    dyingMayorWasChasseur: state.dyingMayorWasChasseur,
    mayorTransferContext: state.mayorTransferContext,
  };
}

// Repose les champs du snapshot dans state. Les Sets/Maps sont reconstitués.
// Ne touche PAS aux timers ni à state.io.
function applySnapshot(state, snap) {
  state.phase = snap.phase;
  state.players = snap.players || [];
  state.roles = snap.roles || {};
  state.deadPlayers = snap.deadPlayers || [];
  state.lovers = snap.lovers || [];
  state.mayor = snap.mayor || null;
  state.playerRegistry = snap.playerRegistry || {};
  state.deadChatHistory = snap.deadChatHistory || [];
  state.votesDay = snap.votesDay || {};
  state.votesWolf = snap.votesWolf || {};
  state.mayorVote = snap.mayorVote || {};
  state.voteMode = snap.voteMode || 1;
  state.voteTimerEnd = snap.voteTimerEnd || null;
  state.lockedVoters = new Set(snap.lockedVoters || []);
  state.fastResolveTriggered = !!snap.fastResolveTriggered;
  state.wolfConfirmed = new Set(snap.wolfConfirmed || []);
  state.nightTarget = snap.nightTarget || null;
  state.witchSaveUsed = !!snap.witchSaveUsed;
  state.witchKillUsed = !!snap.witchKillUsed;
  state.witchSaveActive = !!snap.witchSaveActive;
  state.witchKillTarget = snap.witchKillTarget || null;
  state.cupidDone = !!snap.cupidDone;
  state.corbeauTarget = snap.corbeauTarget || null;
  state.idiotRevealed = !!snap.idiotRevealed;
  state.protectedTarget = snap.protectedTarget || null;
  state.lastProtectedTarget = snap.lastProtectedTarget || null;
  state.sistersTimerEnd = snap.sistersTimerEnd || null;
  if (snap.mission) Object.assign(state.mission, snap.mission);
  state.activeCouncilEvent = snap.activeCouncilEvent || null;
  state.pendingCouncilEvent = snap.pendingCouncilEvent || null;
  state.silentDayChatHistory = snap.silentDayChatHistory || [];
  if (snap.gameStats) state.gameStats = snap.gameStats;
  state.lastDayVoteDeath = snap.lastDayVoteDeath || null;
  state.pendingDayRecap = snap.pendingDayRecap || null;
  state.tiebreakPending = !!snap.tiebreakPending;
  state.tiebreakCandidates = snap.tiebreakCandidates || [];
  state.tiebreakContext = snap.tiebreakContext || '';
  state.autoMode = !!snap.autoMode;
  state.autoVoteMode = snap.autoVoteMode || 1;
  // BUG FIX 6 : restauration des champs manquants
  if (typeof snap.mjPilotedDay === 'boolean') state.mjPilotedDay = snap.mjPilotedDay;
  state.gamePaused = !!snap.gamePaused;
  state.currentChasseurShooter = snap.currentChasseurShooter || null;
  state.chasseurPostContext = snap.chasseurPostContext || null;
  state.dyingMayorId = snap.dyingMayorId || null;
  state.mayorTransferPending = !!snap.mayorTransferPending;
  state.dyingMayorWasChasseur = !!snap.dyingMayorWasChasseur;
  state.mayorTransferContext = snap.mayorTransferContext || '';
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
  serializeState, applySnapshot,
  saveSnapshot, loadSnapshot, clearSnapshot, dumpCrash,
  startPeriodicSave, stopPeriodicSave, cleanOldCrashes,
};
