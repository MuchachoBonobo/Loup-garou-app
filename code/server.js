/**
 * server.js — LOUP-GAROU (bootstrap)
 *
 * Tout l'état + la logique métier vivent dans les modules :
 *  - state.js     : état partagé, constantes, helpers
 *  - narration.js : variantes TTS par transition de phase
 *  - council.js   : Conseil des Morts (évènements + effets)
 *  - roles.js     : Salvateur, Voyante, Petite Fille, Sorcière, Cupidon, Chasseur, Corbeau, Idiot, mission
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
// Délais de détection d'un joueur parti : un téléphone dont l'écran se verrouille, ou
// un onglet que le navigateur met en veille, ne répond plus pendant un moment. Avec les
// valeurs par défaut (25 s + 20 s), ces joueurs étaient déclarés partis très vite ; on
// laisse 25 s + 60 s pour qu'un verrouillage bref passe sans déconnexion visible.
const io   = require("socket.io")(http, { pingInterval: 25000, pingTimeout: 60000 });

// Modules métier
const lights    = require("./lights");
const S         = require("./state");
const { state, isMJ, playerName, buildFullState, idActuel, computeCounts } = S;
// Choix reçus des téléphones : un identifiant de joueur périmé (écran construit avant une
// reconnexion) est traduit vers le joueur actuel. Fonctionne aussi pour une liste.
const actuel = x => Array.isArray(x) ? x.map(idActuel) : idActuel(x);
const narration = require("./narration");
const council   = require("./council");
const roles     = require("./roles");
const phases    = require("./phases");
const votes     = require("./votes");
const log       = require("./logger");
const snapshot  = require("./snapshot");
const soiree    = require("./soiree");

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

const PORT = parseInt(process.env.PORT) || 3000;
app.use(express.static(require("path").join(__dirname, "public")));

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

// QR code de connexion des joueurs, dessiné par le serveur (image SVG) : il s'affiche
// même sans Internet (avant, l'écran MJ téléchargeait un outil depuis un site externe).
// ?theme=sombre → modules clairs sur fond sombre (petit QR du panneau MJ) ;
// sinon noir sur blanc (QR plein écran, le plus facile à scanner).
const QRCode = require("qrcode");
app.get("/api/qr.svg", async (req, res) => {
  const url = `http://${getLocalIPv4()}:${PORT}`;
  const sombre = req.query.theme === "sombre";
  try {
    const svg = await QRCode.toString(url, {
      type: "svg", errorCorrectionLevel: "M", margin: 1,
      color: sombre ? { dark: "#ffffffff", light: "#111111ff" } : { dark: "#0a0a0aff", light: "#ffffffff" }
    });
    res.set("Cache-Control", "no-store").type("image/svg+xml").send(svg);
  } catch (e) {
    log.warn("QR code impossible à générer", e && e.message);
    res.status(500).end();
  }
});

// Events autorisés pendant la pause (chat post-game, MJ qui reprend, etc.)
const ALLOWED_DURING_PAUSE = new Set([
  "registerMJ", "register",
  "pauseGame", "resumeGame", "reset",
  "deadChatHistory", "deadChat",
  "visibilite",
]);

// ===== ÉTAT DES TÉLÉPHONES (pastilles de l'écran MJ) =====
// Pour chaque joueur humain : "ok" (connecté, page du jeu à l'écran), "veille" (écran
// éteint ou application quittée : la page n'est plus au premier plan) ou "perdu"
// (connexion coupée). Une coupure n'est signalée par une alerte qu'au bout de
// DELAI_ALERTE_DECONNEXION_MS : un rechargement de page ne dérange pas le MJ.
const DELAI_ALERTE_DECONNEXION_MS = 5000;
const alertesDeconnexion = {};   // prénom en minuscules → minuteur de l'alerte
function etatConnexions() {
  const etats = {};
  state.players.forEach(p => {
    if (p.isBot) return;
    etats[p.id] = p.connecte === false ? "perdu" : p.ecranVisible === false ? "veille" : "ok";
  });
  return etats;
}
function envoyerConnexionsMJ() {
  if (state.mjSocketId) io.to(state.mjSocketId).emit("connexionsMJ", etatConnexions());
}

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
    socket.emit("connexionsMJ", etatConnexions());
    socket.emit("soireeMJ", soiree.resume());
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
      etapeNuitSuivante: state.phase === "nightPause" ? state.etapeNuitSuivante : null,
      // État du vote du jour, pour griser les bons boutons d'une tablette rechargée
      voteEnCours:  state.phase === "day" && !!state.voteTimer,
      voteClos:     state.phase === "day" && (state.resolutionJourEnCours || state.dayResolutionPending),
      nuitEnAttente: state.phase === "crepuscule",
      matin: (state.phase === "day" && state.annonceMatinEnCours) ? {
        evenement: (state.activeCouncilEvent && !state.evenementAnnonce && council.COUNCIL_EVENTS[state.activeCouncilEvent])
          ? { id: state.activeCouncilEvent, title: council.COUNCIL_EVENTS[state.activeCouncilEvent].title, narrative: council.COUNCIL_EVENTS[state.activeCouncilEvent].narrative }
          : null } : null,
      activeCouncilEvent: (state.phase === "day" && state.evenementAnnonce && state.activeCouncilEvent && council.COUNCIL_EVENTS[state.activeCouncilEvent])
        ? { id: state.activeCouncilEvent,
            title: council.COUNCIL_EVENTS[state.activeCouncilEvent].title,
            narrative: council.COUNCIL_EVENTS[state.activeCouncilEvent].narrative }
        : null,
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
    // Après un redémarrage, aucun téléphone n'est encore revenu : pastilles rouges
    // jusqu'à ce que chacun se reconnecte avec son prénom.
    state.players.forEach(p => { if (!p.isBot) p.connecte = false; });
    envoyerConnexionsMJ();
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
      // Le joueur était-il signalé comme déconnecté ? (pour prévenir le MJ de son retour)
      const etaitPerdu = idx >= 0 && state.players[idx].connecte === false;
      if (idx >= 0) {
        state.players[idx].id = socket.id;
        state.players[idx].connecte = true;
        state.players[idx].ecranVisible = true;
      }
      if (alertesDeconnexion[key]) { clearTimeout(alertesDeconnexion[key]); delete alertesDeconnexion[key]; }
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
        // Votes DIRIGÉS CONTRE ce joueur : ils pointaient sur son ancien identifiant et
        // étaient comptés à part — un joueur pouvait échapper au vote en se reconnectant.
        [state.votesDay, state.votesWolf, state.mayorVote].forEach(urne => {
          Object.keys(urne).forEach(votant => { if (urne[votant] === oldId) urne[votant] = socket.id; });
        });
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
      // Journal des morts : il garde l'identifiant de connexion du défunt ; on le met à
      // jour pour que son rôle reste affiché à côté de son nom après une reconnexion.
      if (oldId && oldId !== socket.id) {
        (state.gameStats.deathLog || []).forEach(d => { if (d.id === oldId) d.id = socket.id; });
        // Tous les anciens identifiants de ce joueur pointent désormais vers le nouveau
        Object.keys(state.aliasIds).forEach(k => { if (state.aliasIds[k] === oldId) state.aliasIds[k] = socket.id; });
        state.aliasIds[oldId] = socket.id;
      }
      state.playerRegistry[key].id = socket.id;
      state.playerRegistry[key].oldId = socket.id;
      io.emit("players", state.players);
      io.emit("deadPlayers", state.deadPlayers);
      io.emit("newMayor", state.mayor);
      // L'écran du MJ repère les rôles par identifiant de connexion : sans cette mise à
      // jour, il affichait « ? » pour un joueur qui s'était reconnecté.
      if (state.mjSocketId) {
        io.to(state.mjSocketId).emit("rolesMJUpdate", { roles: state.roles, players: state.players });
        io.to(state.mjSocketId).emit("loversInfo", state.lovers);
        envoyerConnexionsMJ();
        if (etaitPerdu) io.to(state.mjSocketId).emit("joueurRevenu", { name: playerName(socket.id) });
      }
      // Les téléphones des loups et des amoureux mémorisent leurs partenaires par
      // identifiant : on leur renvoie la liste à jour, sinon un loup ne reconnaissait
      // plus son coéquipier reconnecté (et pouvait cliquer pour le dévorer).
      if (state.roles[socket.id] === "Loup") {
        const loups = Object.keys(state.roles).filter(id => state.roles[id] === "Loup");
        loups.filter(id => id !== socket.id).forEach(id => io.to(id).emit("loupsMisAJour", loups));
      }
      if (state.lovers.includes(socket.id)) {
        const cupidons = Object.keys(state.roles).filter(id => state.roles[id] === "Cupidon");
        [...state.lovers, ...cupidons].filter(id => id !== socket.id).forEach(id => io.to(id).emit("loversInfo", state.lovers));
      }
      socket.emit("reconnected", buildFullState(socket.id));
      if (state.deadPlayers.includes(socket.id)) socket.emit("deadChatHistory", state.deadChatHistory);
      // Reconnexion loup en phase wolves : ré-envoie les votes loups pour restaurer le checkmark
      if (state.phase === "wolves" && state.roles[socket.id] === "Loup") {
        socket.emit("wolfVotesUpdate", state.votesWolf);
      }
      // Reconnexion en phase de nuit : ré-envoie la demande d'action pour éviter blocage 45-90s
      if (state.phase === "corbeau" && state.roles[socket.id] === "Corbeau" && !state.deadPlayers.includes(socket.id)) {
        socket.emit("corbeauTurn");
      }
      if (state.phase === "witch" && state.roles[socket.id] === "Sorcière" && !state.deadPlayers.includes(socket.id)) {
        socket.emit("etatPotions", { vie: !state.witchSaveUsed, mort: !state.witchKillUsed });
        socket.emit("nightVictim", state.nightTarget);
      }
      if (state.phase === "chasseur" && state.currentChasseurShooter === socket.id) {
        socket.emit("chasseurMustShoot", socket.id);
      }
      // Voyante reconnectée avant d'avoir confirmé sa vision : on la lui remontre
      if (state.phase === "seer" && state.roles[socket.id] === "Voyante" && state.seerPendingResult) {
        socket.emit("seerResult", state.seerPendingResult);
      }
      // Amoureux reconnecté pendant leur réveil : on lui remontre l'autre, avec le temps restant
      if (state.phase === "amoureux" && state.lovers.includes(socket.id) && state.amoureuxFin) {
        const autre = state.lovers.find(l => l !== socket.id);
        socket.emit("amoureuxTurn", { partenaireId: autre, partenaire: playerName(autre), dureeMs: Math.max(0, state.amoureuxFin - Date.now()) });
      }
      // Petite Fille reconnectée avant d'avoir confirmé : on lui remontre la réponse
      // (sans réponse en attente, sa page rouvre seule le choix des 3 joueurs : phase connue)
      if (state.phase === "petiteFille" && state.roles[socket.id] === "PetiteFille" && state.petiteFillePendingResult) {
        socket.emit("petiteFilleResult", state.petiteFillePendingResult);
      }
      resynchroniserApresReconnexion(socket);
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
        existing.connecte = true;
        existing.ecranVisible = true;
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
    state.players.push({ id: socket.id, name: trimmed, photo: prevPhoto, connecte: true, ecranVisible: true });
    state.playerRegistry[key] = { id: socket.id, oldId: socket.id, name: trimmed, role: null, isDead: false, photo: prevPhoto };
    log.info('player registered', trimmed, 'total=' + state.players.length);
    io.emit("players", state.players);
    envoyerConnexionsMJ();
  });

  // La page du jeu passe au second plan (écran éteint, autre application) ou revient
  socket.on("visibilite", visible => {
    const p = state.players.find(x => x.id === socket.id);
    if (!p || p.isBot) return;
    const v = !!visible;
    if (p.ecranVisible === v) return;
    p.ecranVisible = v;
    envoyerConnexionsMJ();
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
    // « 🚀 Lancer la partie » remet tout à zéro, comme « Relancer » : sinon, lancé après
    // une partie terminée, il gardait les morts, les amoureux et le maire de la précédente,
    // et les téléphones réaffichaient l'ancien écran de victoire (corrigé le 2026-10-25).
    phases.resetGameState(true);
    io.emit("gameReset", { players: state.players });
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

  // Le MJ retire un joueur entre deux parties (croix à côté de son nom, dans le salon).
  // Son téléphone est prévenu et oublie son prénom, pour ne pas revenir tout seul.
  socket.on("retirerJoueur", id => {
    if (!isMJ(socket.id) || state.phase !== "lobby") return;
    const p = state.players.find(x => x.id === id);
    if (!p) return;
    state.players = state.players.filter(x => x.id !== id);
    delete state.playerRegistry[p.name.toLowerCase()];
    log.info('player removed by MJ', p.name);
    if (!p.isBot) io.to(id).emit("retireParMJ");
    io.emit("players", state.players);
    envoyerConnexionsMJ();
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
  socket.on("voteMayor",     target => votes.handleVoteMayor(socket, actuel(target)));
  socket.on("lockMayorVote", ()     => votes.handleLockMayorVote(socket));

  // ===== MISSION =====
  socket.on("missionTeamChoice",  teamIds      => roles.handleMissionTeamChoice(socket, actuel(teamIds)));
  socket.on("missionCard",        card         => roles.handleMissionCard(socket, card));
  socket.on("missionBonusChoice", bonusTeamIds => roles.handleMissionBonusChoice(socket, actuel(bonusTeamIds)));

  // ===== TIEBREAK =====
  socket.on("tiebreakChoice", targetId => votes.handleTiebreakChoice(socket, actuel(targetId)));

  // ===== TRANSFERT MAIRE =====
  socket.on("mayorTransferChoice", targetId => roles.handleMayorTransferChoice(socket, actuel(targetId)));

  // ===== RÔLES — ACTIONS DE NUIT =====
  socket.on("cupidChoice",     data     => roles.handleCupidChoice(socket, actuel(data)));
  socket.on("salvateurAction", targetId => roles.handleSalvateurAction(socket, actuel(targetId)));
  socket.on("mjEtapeSuivante",   ()  => roles.handleMJEtapeSuivante(socket));
  // Rythme du MJ : lancer la nuit, annoncer l'évènement, clore l'annonce du matin
  socket.on("mjLancerNuit",      ()  => roles.handleMJLancerNuit(socket));
  socket.on("mjAnnoncerEvenement", () => { if (isMJ(socket.id)) council.annoncerEvenement(); });
  socket.on("mjFinAnnonceMatin", ()  => {
    if (!isMJ(socket.id) || state.phase !== "day") return;
    // Évènement pas encore annoncé : il l'est maintenant et reste à lire ; sinon sa carte se ferme avec celle des morts
    const vientDEtreAnnonce = council.annoncerEvenement();
    council.finAnnonceMatin(!vientDEtreAnnonce);
  });
  socket.on("voteWolf",        id       => votes.handleVoteWolf(socket, actuel(id)));
  socket.on("lockWolfVotes",   ()       => votes.handleLockWolfVotes(socket));
  socket.on("wolfConfirm",     ()       => votes.handleWolfConfirm(socket));
  socket.on("seerChoice",      id       => roles.handleSeerChoice(socket, actuel(id)));
  socket.on("seerDone",        ()       => roles.handleSeerDone(socket));
  socket.on("petiteFilleChoice", ids    => roles.handlePetiteFilleChoice(socket, actuel(ids)));
  socket.on("petiteFilleDone",   ()     => roles.handlePetiteFilleDone(socket));
  socket.on("corbeauAction",   targetId => roles.handleCorbeauAction(socket, actuel(targetId)));
  socket.on("witchSave",       ()       => roles.handleWitchSave(socket));
  socket.on("witchKill",       id       => roles.handleWitchKill(socket, actuel(id)));
  socket.on("witchDone",       ()       => roles.handleWitchDone(socket));
  socket.on("resolveNight",    ()       => roles.handleResolveNight(socket));
  socket.on("chasseurAction",  targetId => roles.handleChasseurAction(socket, actuel(targetId)));

  // ===== VOTE JOUR =====
  socket.on("startVote",    () => votes.handleStartVote(socket));
  socket.on("voteDay",      id => votes.handleVoteDay(socket, actuel(id)));
  socket.on("lockDayVotes", () => votes.handleLockDayVotes(socket));
  socket.on("skipDayVote",  () => votes.handleSkipDayVote(socket));

  // ===== CONSEIL DES MORTS =====
  socket.on("councilVote", eventId => council.handleCouncilVote(socket, eventId));
  socket.on("mayorAbdicationChoice", targetId => council.handleAbdicationChoice(socket, actuel(targetId)));
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
    if (state.mjSocketId && ['cupid','wolves','nightPause'].includes(state.phase) && !state.nightMusicPlayed) {
      state.nightMusicPlayed = true;
      io.to(state.mjSocketId).emit("playNightMusic");
    }
  });

  // ===== CLASSEMENT DE LA SOIRÉE =====
  // « Nouvelle soirée » (écran MJ) : le classement repart à zéro
  socket.on("nouvelleSoiree", () => {
    if (!isMJ(socket.id)) return;
    soiree.nouvelleSoiree();
    socket.emit("soireeMJ", soiree.resume());
  });

  // ===== REJOUER / RESET =====
  socket.on("replayGame", config => phases.handleReplayGame(socket, config));
  socket.on("reset",      ()     => phases.handleReset(socket));
  // Reset complet (tests automatisés uniquement) : efface aussi la liste des joueurs
  socket.on("fullReset",  ()     => {
    if (!isMJ(socket.id)) return;
    phases.resetGameState(false);
    state.io.emit("gameReset", { players: [] });
    phases.setPhase("lobby");
  });

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
      } else {
        // En partie, le joueur garde sa place : pastille rouge chez le MJ, alerte si la
        // coupure dure (un rechargement de page revient avant)
        p.connecte = false;
        envoyerConnexionsMJ();
        if (alertesDeconnexion[key]) clearTimeout(alertesDeconnexion[key]);
        alertesDeconnexion[key] = setTimeout(() => {
          delete alertesDeconnexion[key];
          const q = state.players.find(x => x.name.toLowerCase() === key);
          if (q && q.connecte === false && state.phase !== "lobby" && state.mjSocketId) {
            io.to(state.mjSocketId).emit("joueurPerdu", { name: q.name });
          }
        }, DELAI_ALERTE_DECONNEXION_MS);
      }
    }
    if (state.mjSocketId === socket.id) { log.warn('MJ disconnected'); state.mjSocketId = null; }
  });
});

// ===== RECONNEXION : REMISE À JOUR DES ÉCRANS =====
// Un joueur vient de changer d'identifiant. Les pages joueurs corrigent elles-mêmes leurs
// identifiants en mémoire (à la réception de la liste « players ») ; ici on renvoie ce qui
// dépend d'un écran déjà ouvert : votes affichés chez le MJ, panneau d'égalité du maire,
// transmission d'écharpe, victime montrée à la Sorcière, vote du Conseil des Morts.
function resynchroniserApresReconnexion(socket) {
  const id = socket.id;
  const mj = state.mjSocketId;
  // Votes en cours (MJ : votes détaillés ; joueurs : décomptes)
  if (state.phase === "mayorVote") {
    io.emit("mayorVotesMJ", state.mayorVote);
    io.emit("mayorCountsPublic", computeCounts(state.mayorVote));
  }
  if (state.phase === "wolves") {
    if (mj) io.to(mj).emit("wolfVotesMJ", state.votesWolf);
    Object.keys(state.roles).filter(w => state.roles[w] === "Loup").forEach(w => io.to(w).emit("wolfVotesUpdate", state.votesWolf));
  }
  if (state.phase === "day" && Object.keys(state.votesDay).length) {
    io.emit("votesDayMJ", state.votesDay);
    if (state.voteMode !== 5) {
      io.emit("dayCountsPublic", computeCounts(state.votesDay));
      const detail = {};
      Object.entries(state.votesDay).forEach(([v, t]) => { if (!v.startsWith("__corbeau")) detail[v] = t; });
      io.emit("votesDayPublic", detail);
    }
  }
  if (state.phase === "day" && state.corbeauTarget && state.corbeauTarget !== "skip") {
    io.emit("corbeauVotesPublic", { targetId: state.corbeauTarget, targetName: playerName(state.corbeauTarget) });
  }
  // Égalité en attente d'arbitrage : panneau du maire et du MJ reconstruits
  if (state.tiebreakPending && state.mayor && state.tiebreakCandidates.length) {
    const candidates = state.tiebreakCandidates.map(c => ({ id: c, name: playerName(c) }));
    io.to(state.mayor).emit("tiebreakMayor", { candidates, context: state.tiebreakContext });
    if (mj) io.to(mj).emit("tiebreakMJ", { candidates, mayorName: playerName(state.mayor), context: state.tiebreakContext });
  }
  // Transmission d'écharpe : le maire mourant s'est reconnecté → tout le monde le sait
  if (state.phase === "mayorTransfer" && state.dyingMayorId === id) {
    io.emit("mayorMustTransfer", id);
  }
  // Sorcière : la victime des loups s'est reconnectée → la Sorcière reçoit le bon identifiant
  if (state.phase === "witch" && state.nightTarget === id) {
    const witchId = Object.keys(state.roles).find(w => state.roles[w] === "Sorcière" && !state.deadPlayers.includes(w));
    if (witchId) {
      io.to(witchId).emit("etatPotions", { vie: !state.witchSaveUsed, mort: !state.witchKillUsed });
      io.to(witchId).emit("nightVictim", state.nightTarget);
    }
  }
  // Conseil des Morts en cours : le mort reconnecté retrouve son vote
  if (state.councilOptions && state.deadPlayers.includes(id)) {
    socket.emit("councilStart", { options: state.councilOptions.map(c => ({ id: c, title: council.COUNCIL_EVENTS[c].title })) });
  }
}

// ===== DÉMARRAGE =====
http.listen(PORT, () => {
  log.info('=== serveur démarré ===', 'port=' + PORT, 'ip=' + getLocalIPv4());
  console.log(`🐺 Serveur Loup-Garou démarré sur http://localhost:${PORT}`);
  console.log(`   IP locale : http://${getLocalIPv4()}:${PORT}`);
  console.log(`   MJ        : http://${getLocalIPv4()}:${PORT}/mj`);
});
