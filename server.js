/**
 * server.js — LOUP-GAROU (bootstrap)
 *
 * Tout l'état + la logique métier vivent dans les modules :
 *  - state.js     : état partagé, constantes, helpers
 *  - narration.js : variantes TTS par transition de phase
 *  - council.js   : Conseil des Morts (évènements + effets)
 *  - roles.js     : Salvateur, Voyante, Sorcière, Cupidon, Chasseur, Corbeau, Idiot, mission
 *  - phases.js    : setPhase, transitions, timeouts, bots, pause, reset, victoire
 *  - votes.js     : maire / jour / loups / tiebreak / sprint final
 *
 * Ce fichier ne fait QUE le câblage : Express, Socket.io, lights, registre des handlers.
 */

// === Chargement automatique du .env (loader minimal, sans dependance) ===
// IMPORTANT : doit etre AVANT tout require de module metier — lights.js lit
// process.env au moment du require. Permet de lancer simplement `node server.js`.
try {
  require("fs").readFileSync(require("path").join(__dirname, ".env"), "utf8")
    .split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    });
} catch (_) { /* pas de .env : le jeu tourne simplement sans les lumieres */ }

const express = require("express");
const os      = require("os");
const app  = express();
const http = require("http").createServer(app);
const io   = require("socket.io")(http);

// Modules métier
const lights    = require("./lights");
const S         = require("./state");
const { state, isMJ, playerName, buildFullState } = S;
const narration = require("./narration");
const council   = require("./council");
const roles     = require("./roles");
const phases    = require("./phases");
const votes     = require("./votes");
const log       = require("./logger");
const snapshot  = require("./snapshot");

// Injecte io dans l'état partagé (les modules utilisent state.io)
state.io = io;

// ===== PERSISTANCE & CRASH =====
// Au boot : si un snapshot existe (partie en cours avant un crash), on le met en
// attente. Le premier MJ qui se connecte reçoit `crashRecoveryAvailable` et peut
// arbitrer (Reprendre / Ignorer).
(function bootRestore() {
  const snap = snapshot.loadSnapshot();
  if (snap && snap.phase && snap.phase !== "lobby") {
    state.pendingRestore = snap;
    log.warn('snapshot found at boot', `savedAt=${snap.savedAt}`, `phase=${snap.phase}`, `players=${(snap.players || []).length}`);
  } else if (snap) {
    // Snapshot lobby zombie — on purge
    snapshot.clearSnapshot();
  }
})();

// Sauvegarde périodique
snapshot.startPeriodicSave(state);

// Crash : dump l'état + arrêter proprement
process.on('uncaughtException', (err) => {
  const file = snapshot.dumpCrash(state, err);
  log.error('UNCAUGHT EXCEPTION', err.message, 'dump=' + (file || 'failed'));
  log.error(err.stack);
  // On laisse Node terminer (l'état est sauvé)
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  const file = snapshot.dumpCrash(state, err);
  log.error('UNHANDLED REJECTION', err.message, 'dump=' + (file || 'failed'));
});

const PORT = 3000;
app.use(express.static("public"));

// Alias court pour l'URL du MJ : /mj → public/mj.html
app.get("/mj", (req, res) => res.sendFile(__dirname + "/public/mj.html"));

// Endpoint utilisé par le QR code de mj.html pour afficher l'URL de connexion joueur.
// Renvoie la première IPv4 non-loopback détectée sur les interfaces réseau du serveur.
function getLocalIPv4() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "127.0.0.1"; // fallback : au moins le QR code affichera quelque chose
}
app.get("/api/ip", (req, res) => res.json({ ip: getLocalIPv4(), port: PORT }));

// Events autorisés pendant la pause (chat post-game, MJ qui reprend, etc.)
const ALLOWED_DURING_PAUSE = new Set([
  "registerMJ", "register",
  "pauseGame", "resumeGame", "reset",
  "deadChatHistory", "deadChat",
]);

io.on("connection", socket => {
  log.debug('socket connected', socket.id);
  // Middleware par socket : bloque les events pendant la pause sauf whitelist
  socket.use((packet, next) => {
    const eventName = packet[0];
    if (state.gamePaused && !ALLOWED_DURING_PAUSE.has(eventName)) return; // drop silencieux
    next();
  });

  // ===== PAUSE / NARRATION / PHASE (MJ) =====
  socket.on("pauseGame",     ()       => phases.handlePauseGame(socket));
  socket.on("resumeGame",    ()       => phases.handleResumeGame(socket));
  socket.on("setPhase",      p        => phases.handleSetPhase(socket, p));
  socket.on("setNarration",  enabled  => { if (isMJ(socket.id)) narration.setNarrationEnabled(enabled); });

  // ===== ENREGISTREMENT MJ =====
  socket.on("registerMJ", () => {
    log.info('MJ connected', socket.id);
    state.mjSocketId = socket.id;
    socket.emit("rolesMJ", { roles: state.roles, players: state.players });
    socket.emit("mjReconnected", {
      phase: state.phase,
      mayor: state.mayor,
      deadPlayers: state.deadPlayers.map(id => ({ id, name: playerName(id), role: state.roles[id] })),
      lovers: state.lovers,
      gameStats: state.gameStats,
      missionActive: state.mission.active,
      missionTeam:   state.mission.team,
      missionResult: state.mission.result,
      nightTarget: state.nightTarget ? { id: state.nightTarget, name: playerName(state.nightTarget) } : null,
    });
    if (state.tiebreakPending) {
      socket.emit("tiebreakMJ", {
        candidates: state.tiebreakCandidates.map(id => ({ id, name: playerName(id) })),
        mayorName:  playerName(state.mayor),
        context:    state.tiebreakContext
      });
    }
    // Reprise après crash : propose au MJ si un snapshot est en attente
    if (state.pendingRestore) {
      socket.emit("crashRecoveryAvailable", {
        savedAt: state.pendingRestore.savedAt,
        phase: state.pendingRestore.phase,
        playerCount: (state.pendingRestore.players || []).length,
        mayorName: state.pendingRestore.mayor ? (state.pendingRestore.players || []).find(p => p.id === state.pendingRestore.mayor)?.name : null,
        dayCount: state.pendingRestore.gameStats?.dayCount || 0,
        nightCount: state.pendingRestore.gameStats?.nightCount || 0,
      });
    }
  });

  // Reprise après crash — accepté par le MJ
  socket.on("acceptCrashRecovery", () => {
    if (!isMJ(socket.id) || !state.pendingRestore) return;
    const snap = state.pendingRestore;
    log.warn('crash recovery ACCEPTED by MJ', `phase=${snap.phase}`);
    snapshot.applySnapshot(state, snap);
    state.pendingRestore = null;
    // Diffuse l'état à tout le monde et invite les joueurs à se reconnecter par leur prénom
    io.emit("gameRestored", {
      phase: state.phase,
      message: "Partie restaurée après redémarrage du serveur. Reconnectez-vous avec votre prénom."
    });
    // Re-appelle setPhase pour réinstaller proprement les timers (idempotent)
    phases.setPhase(state.phase);
  });

  // Reprise après crash — rejetée par le MJ
  socket.on("discardCrashRecovery", () => {
    if (!isMJ(socket.id) || !state.pendingRestore) return;
    log.info('crash recovery DISCARDED by MJ');
    state.pendingRestore = null;
    snapshot.clearSnapshot();
  });

  // ===== INSCRIPTION JOUEUR (avec gestion reconnexion) =====
  socket.on("register", name => {
    if (typeof name !== "string") return;
    const trimmed = name.trim().slice(0, 20).replace(/[<>"'&]/g, '');
    const key = trimmed.toLowerCase();
    if (!trimmed) return;

    if (state.playerRegistry[key] && state.phase !== "lobby") {
      const old = state.playerRegistry[key];
      const oldId = old.oldId || "";
      const idx = state.players.findIndex(p => p.name.toLowerCase() === key);
      if (idx >= 0) state.players[idx].id = socket.id;
      if (old.role) { state.roles[socket.id] = old.role; delete state.roles[oldId]; }
      const lIdx = state.lovers.indexOf(oldId);
      if (lIdx >= 0) state.lovers[lIdx] = socket.id;
      const dIdx = state.deadPlayers.indexOf(oldId);
      if (dIdx >= 0) state.deadPlayers[dIdx] = socket.id;
      if (state.mayor === oldId) state.mayor = socket.id;
      // Mission
      const mIdx = state.mission.team.indexOf(oldId);
      if (mIdx >= 0) state.mission.team[mIdx] = socket.id;
      if (state.mission.cards[oldId]) {
        state.mission.cards[socket.id] = state.mission.cards[oldId];
        delete state.mission.cards[oldId];
      }
      // Migre les votes / locks / rate-limit / cibles liés à l'ancien socket
      if (oldId) {
        if (state.votesDay[oldId]      !== undefined) { state.votesDay[socket.id]      = state.votesDay[oldId];      delete state.votesDay[oldId]; }
        if (state.votesWolf[oldId]     !== undefined) { state.votesWolf[socket.id]     = state.votesWolf[oldId];     delete state.votesWolf[oldId]; }
        if (state.mayorVote[oldId]     !== undefined) { state.mayorVote[socket.id]     = state.mayorVote[oldId];     delete state.mayorVote[oldId]; }
        if (state.councilVotes[oldId]  !== undefined) { state.councilVotes[socket.id]  = state.councilVotes[oldId];  delete state.councilVotes[oldId]; }
        if (state.lockedVoters.has(oldId))            { state.lockedVoters.delete(oldId); state.lockedVoters.add(socket.id); }
        if (state.voteRateLimit.has(oldId))           { state.voteRateLimit.set(socket.id, state.voteRateLimit.get(oldId)); state.voteRateLimit.delete(oldId); }
        const tIdx = state.tiebreakCandidates.indexOf(oldId);
        if (tIdx >= 0) state.tiebreakCandidates[tIdx] = socket.id;
        if (state.currentChasseurShooter === oldId) state.currentChasseurShooter = socket.id;
        if (state.dyingMayorId           === oldId) state.dyingMayorId           = socket.id;
        if (state.corbeauTarget          === oldId) state.corbeauTarget          = socket.id;
        if (state.nightTarget            === oldId) state.nightTarget            = socket.id;
        if (state.witchKillTarget        === oldId) state.witchKillTarget        = socket.id;
        if (state.protectedTarget        === oldId) state.protectedTarget        = socket.id;
        if (state.lastProtectedTarget    === oldId) state.lastProtectedTarget    = socket.id;
        if (state.pendingChasseurAfterTransfer === oldId) state.pendingChasseurAfterTransfer = socket.id;
        if (state.wolfConfirmed && state.wolfConfirmed.has(oldId)) {
          state.wolfConfirmed.delete(oldId); state.wolfConfirmed.add(socket.id);
        }
      }
      state.playerRegistry[key].id = socket.id;
      state.playerRegistry[key].oldId = socket.id;
      io.emit("players", state.players);
      io.emit("deadPlayers", state.deadPlayers);
      io.emit("newMayor", state.mayor);
      socket.emit("reconnected", buildFullState(socket.id));
      if (state.deadPlayers.includes(socket.id)) socket.emit("deadChatHistory", state.deadChatHistory);
      // Reconnexion loup en phase wolves : ré-envoie les votes loups pour restaurer le checkmark
      if (state.phase === "wolves" && state.roles[socket.id] === "Loup") {
        socket.emit("wolfVotesUpdate", state.votesWolf);
      }
      // Reconnexion en plein vote de mission : ré-envoie la demande de carte si non jouée
      if (state.phase === "missionVote" && state.mission.team.includes(socket.id) && !state.mission.cards[socket.id]) {
        socket.emit("missionCardChoice", {
          mayorName: playerName(state.mayor),
          teamNames: state.mission.team.map(id => playerName(id))
        });
      }
      return;
    }
    if (state.phase === "lobby" && state.playerRegistry[key]) {
      // Si le socket précédent est encore connecté, refuser
      const existing = state.players.find(p => p.name.toLowerCase() === key);
      const previousSocketStillConnected = existing
        ? !!io.sockets.sockets.get(existing.id)
        : false;
      if (existing && previousSocketStillConnected && existing.id !== socket.id) {
        socket.emit("registerError", "Ce prénom est déjà pris.");
        return;
      }
      // Reconnexion en lobby
      if (existing) {
        existing.id = socket.id;
        state.playerRegistry[key].id = socket.id;
        state.playerRegistry[key].oldId = socket.id;
        io.emit("players", state.players);
        // BUG FIX 7 : notifier le nouveau socket qu'il est bien reconnu
        socket.emit("reconnected", buildFullState(socket.id));
        return;
      }
      // Entrée orpheline
      delete state.playerRegistry[key];
    }
    // Restaure la photo si on en a une mémorisée pour ce prénom
    const prevPhoto = state.playerRegistry[key]?.photo || null;
    state.players.push({ id: socket.id, name: trimmed, photo: prevPhoto });
    state.playerRegistry[key] = { id: socket.id, oldId: socket.id, name: trimmed, role: null, isDead: false, photo: prevPhoto };
    log.info('player registered', trimmed, 'total=' + state.players.length);
    io.emit("players", state.players);
  });

  // Sauvegarde la photo (base64) d'un joueur. Cappée à 30 KB pour limiter la bande passante.
  socket.on("setPhoto", photo => {
    if (typeof photo !== "string") return;
    if (!photo.startsWith("data:image/")) return;
    if (photo.length > 35000) {
      log.warn('setPhoto rejected (too large)', socket.id, 'bytes=' + photo.length);
      return;
    }
    const me = state.players.find(p => p.id === socket.id);
    if (!me) return;
    me.photo = photo;
    const key = me.name.toLowerCase();
    if (state.playerRegistry[key]) state.playerRegistry[key].photo = photo;
    io.emit("players", state.players);
  });

  // ===== ATTRIBUTION DES RÔLES =====
  socket.on("assignRoles", config => {
    if (!isMJ(socket.id)) return;
    state.roles = {};
    roles.assignAndStart(config, state.players);
  });

  // ===== BOTS (mode entraînement) =====
  socket.on("addBot", () => {
    if (!isMJ(socket.id) || state.phase !== "lobby") return;
    state.botCounter++;
    const name = `🤖 Bot ${state.botCounter}`;
    const id   = `bot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const key  = name.toLowerCase();
    if (state.playerRegistry[key]) return;
    state.players.push({ id, name, isBot: true });
    state.playerRegistry[key] = { id, oldId: id, name, role: null, isDead: false, isBot: true };
    io.emit("players", state.players);
  });

  socket.on("removeBot", () => {
    if (!isMJ(socket.id) || state.phase !== "lobby") return;
    for (let i = state.players.length - 1; i >= 0; i--) {
      if (state.players[i].isBot) {
        const bot = state.players[i];
        state.players.splice(i, 1);
        delete state.playerRegistry[bot.name.toLowerCase()];
        io.emit("players", state.players);
        return;
      }
    }
  });

  // ===== MAIRE =====
  socket.on("voteMayor",     target => votes.handleVoteMayor(socket, target));
  socket.on("lockMayorVote", ()     => votes.handleLockMayorVote(socket));

  // ===== MISSION =====
  socket.on("missionTeamChoice",  teamIds      => roles.handleMissionTeamChoice(socket, teamIds));
  socket.on("missionCard",        card         => roles.handleMissionCard(socket, card));
  socket.on("missionBonusChoice", bonusTeamIds => roles.handleMissionBonusChoice(socket, bonusTeamIds));

  // ===== TIEBREAK =====
  socket.on("tiebreakChoice", targetId => votes.handleTiebreakChoice(socket, targetId));

  // ===== TRANSFERT MAIRE =====
  socket.on("mayorTransferChoice", targetId => roles.handleMayorTransferChoice(socket, targetId));

  // ===== RÔLES — ACTIONS DE NUIT =====
  socket.on("cupidChoice",     data     => roles.handleCupidChoice(socket, data));
  socket.on("salvateurAction", targetId => roles.handleSalvateurAction(socket, targetId));
  socket.on("mjStartSistersTimer", ()   => roles.handleMJStartSistersTimer(socket));
  socket.on("voteWolf",        id       => votes.handleVoteWolf(socket, id));
  socket.on("lockWolfVotes",   ()       => votes.handleLockWolfVotes(socket));
  socket.on("wolfConfirm",     ()       => votes.handleWolfConfirm(socket));
  socket.on("seerChoice",      id       => roles.handleSeerChoice(socket, id));
  socket.on("corbeauAction",   targetId => roles.handleCorbeauAction(socket, targetId));
  socket.on("witchSave",       ()       => roles.handleWitchSave(socket));
  socket.on("witchKill",       id       => roles.handleWitchKill(socket, id));
  socket.on("witchDone",       ()       => roles.handleWitchDone(socket));
  socket.on("resolveNight",    ()       => roles.handleResolveNight(socket));
  socket.on("chasseurAction",  targetId => roles.handleChasseurAction(socket, targetId));

  // ===== VOTE JOUR =====
  socket.on("startVote",    () => votes.handleStartVote(socket));
  socket.on("voteDay",      id => votes.handleVoteDay(socket, id));
  socket.on("lockDayVotes", () => votes.handleLockDayVotes(socket));
  socket.on("skipDayVote",  () => votes.handleSkipDayVote(socket));

  // ===== CONSEIL DES MORTS =====
  socket.on("councilVote", eventId => council.handleCouncilVote(socket, eventId));
  socket.on("mayorAbdicationChoice", targetId => council.handleAbdicationChoice(socket, targetId));
  // Les Voix Étouffées — chat écrit du jour
  socket.on("silentDayChat",        payload => council.handleSilentDayChat(socket, payload));
  socket.on("silentDayChatHistory", ()      => council.handleSilentDayChatHistory(socket));

  // ===== CHAT DES MORTS =====
  socket.on("deadChat", ({ text }) => {
    const isDeadPlayer = state.deadPlayers.includes(socket.id);
    const isMJSocket   = isMJ(socket.id);
    const isPostGame   = (state.phase === "lobby" && Object.keys(state.roles).length > 0);
    if (!isDeadPlayer && !isMJSocket && !isPostGame) return;
    if (typeof text !== "string") return;
    const name = isMJSocket ? "[MJ]" : playerName(socket.id);
    const cleanText = text.trim().slice(0, 200).replace(/[<>]/g, '');
    const msg = { name, text: cleanText, ts: Date.now() };
    if (!msg.text) return;
    state.deadChatHistory.push(msg);
    if (state.deadChatHistory.length > 100) state.deadChatHistory.shift();
    if (state.phase === "lobby" && Object.keys(state.roles).length > 0) {
      io.emit("deadChatMsg", msg);
    } else {
      state.deadPlayers.forEach(id => io.to(id).emit("deadChatMsg", msg));
      if (state.mjSocketId) io.to(state.mjSocketId).emit("deadChatMsg", msg);
    }
  });

  socket.on("deadChatHistory", () => {
    if (state.deadPlayers.includes(socket.id) || isMJ(socket.id))
      socket.emit("deadChatHistory", state.deadChatHistory);
  });

  socket.on("nightCardShown", () => {
    if (state.mjSocketId && ['cupid','wolves'].includes(state.phase) && !state.nightMusicPlayed) {
      state.nightMusicPlayed = true;
      io.to(state.mjSocketId).emit("playNightMusic");
    }
  });

  // ===== REJOUER / RESET =====
  socket.on("replayGame", config => phases.handleReplayGame(socket, config));
  socket.on("reset",      ()     => phases.handleReset(socket));

  // ===== DÉCONNEXION =====
  socket.on("disconnect", () => {
    state.voteRateLimit.delete(socket.id);
    const p = state.players.find(x => x.id === socket.id);
    if (p) {
      log.info('player disconnected', p.name, 'phase=' + state.phase);
      const key = p.name.toLowerCase();
      if (state.playerRegistry[key]) state.playerRegistry[key].oldId = socket.id;
      if (state.phase === "lobby") {
        state.players = state.players.filter(x => x.id !== socket.id);
        delete state.playerRegistry[key];
        io.emit("players", state.players);
      }
    }
    if (state.mjSocketId === socket.id) { log.warn('MJ disconnected'); state.mjSocketId = null; }
  });
});

// ===== DÉMARRAGE =====
http.listen(PORT, () => {
  log.info('=== serveur démarré ===', 'port=' + PORT, 'ip=' + getLocalIPv4());
  console.log(`🐺 Serveur Loup-Garou démarré sur http://localhost:${PORT}`);
  console.log(`   IP locale : http://${getLocalIPv4()}:${PORT}`);
  console.log(`   MJ        : http://${getLocalIPv4()}:${PORT}/mj`);
});
