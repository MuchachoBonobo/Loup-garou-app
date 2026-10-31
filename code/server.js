/**
 * server.js — LOUP-GAROU (démarrage et câblage)
 *
 * Ce fichier ne fait QUE le câblage : lecture du .env, Express, Socket.io, registre des
 * évènements reçus des écrans, reconnexion par prénom, reprise après plantage. Toute la
 * logique de jeu vit dans les modules (voir la Carte du code de HANDOFF.md).
 */

const path = require("path");

// === Chargement automatique du .env (lecteur minimal, sans dépendance) ===
// IMPORTANT : doit être AVANT tout require de module métier — lights.js lit
// process.env au moment du require. Permet de lancer simplement `node server.js`.
try {
  require("fs").readFileSync(path.join(__dirname, ".env"), "utf8")
    .split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    });
} catch { /* pas de .env : le jeu tourne simplement sans les lumières */ }

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
const S         = require("./state");
const { state, isMJ, playerName, buildFullState, idActuel, joueursAvecRole, versMJ, entreeRegistre, remplacerIdentifiant } = S;
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

// ===== SAUVEGARDE & PLANTAGE =====
// Au démarrage : si une sauvegarde existe (partie en cours avant un plantage), elle est mise
// en attente. Le premier MJ qui se connecte reçoit `crashRecoveryAvailable` et choisit
// (Reprendre / Ignorer).
(function bootRestore() {
  const snap = snapshot.loadSnapshot();
  if (snap && snap.phase && snap.phase !== "lobby") {
    state.pendingRestore = snap;
    log.warn('sauvegarde trouvée au démarrage', `savedAt=${snap.savedAt}`, `phase=${snap.phase}`, `players=${(snap.players || []).length}`);
  } else if (snap) {
    // Sauvegarde prise au salon : rien à reprendre
    snapshot.clearSnapshot();
  }
})();

// Sauvegarde périodique
snapshot.startPeriodicSave(state);

// Plantage : l'état est écrit dans un fichier, puis le serveur s'arrête
process.on('uncaughtException', (err) => {
  const file = snapshot.dumpCrash(state, err);
  log.error('ERREUR NON RATTRAPÉE', err.message, 'dump=' + (file || 'échec'));
  log.error(err.stack);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  const file = snapshot.dumpCrash(state, err);
  log.error('PROMESSE REJETÉE NON TRAITÉE', err.message, 'dump=' + (file || 'échec'));
});

const PORT = parseInt(process.env.PORT) || 3000;
app.use(express.static(path.join(__dirname, "public")));

// Alias court pour l'URL du MJ : /mj → public/mj.html
app.get("/mj", (req, res) => res.sendFile(path.join(__dirname, "public", "mj.html")));

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
// même sans Internet.
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

// Évènements acceptés pendant la pause (chat d'après-partie, MJ qui reprend, etc.)
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
function envoyerConnexionsMJ() { versMJ("connexionsMJ", etatConnexions()); }

// Le joueur retrouve sa place (liste des joueurs, registre des prénoms) sous sa nouvelle connexion
function reprendrePlace(entree, p, id) {
  if (p) { p.id = id; p.connecte = true; p.ecranVisible = true; }
  entree.id = entree.oldId = id;
}

// Un joueur quitte le salon (retiré par le MJ, robot retiré, téléphone parti avant la partie)
function retirerDuSalon(p) {
  state.players = state.players.filter(x => x !== p);
  delete state.playerRegistry[p.name.toLowerCase()];
  io.emit("players", state.players);
  envoyerConnexionsMJ();
}

io.on("connection", socket => {
  log.debug('connexion', socket.id);
  // Pendant la pause, seuls les évènements de la liste passent (les autres sont ignorés)
  socket.use((packet, next) => {
    const eventName = packet[0];
    if (state.gamePaused && !ALLOWED_DURING_PAUSE.has(eventName)) return;
    next();
  });

  // ===== PAUSE / NARRATION / PHASE (MJ) =====
  socket.on("pauseGame",     ()       => phases.handlePauseGame(socket));
  socket.on("resumeGame",    ()       => phases.handleResumeGame(socket));
  socket.on("setPhase",      p        => phases.handleSetPhase(socket, p));
  socket.on("setNarration",  enabled  => { if (isMJ(socket.id)) narration.setNarrationEnabled(enabled); });

  // ===== ENREGISTREMENT MJ =====
  socket.on("registerMJ", () => {
    log.info('MJ connecté', socket.id);
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
      etapeNuitLibelle: state.phase === "nightPause" ? roles.LIBELLES_ETAPES_NUIT[state.etapeNuitSuivante] : null,
      // État du vote du jour, pour griser les bons boutons d'une tablette rechargée
      voteEnCours:  state.phase === "day" && !!state.voteTimer,
      voteClos:     state.phase === "day" && (state.resolutionJourEnCours || state.dayResolutionPending),
      nuitEnAttente: state.phase === "crepuscule",
      actionMJ: state.actionMJ ? { type: state.actionMJ, nom: playerName(state.actionMJ === "chasseur" ? state.currentChasseurShooter : state.dyingMayorId) } : null,
      matin: (state.phase === "day" && state.annonceMatinEnCours)
        ? { evenement: state.evenementAnnonce ? null : council.evenementPublic(state.activeCouncilEvent) } : null,
      activeCouncilEvent: (state.phase === "day" && state.evenementAnnonce) ? council.evenementPublic(state.activeCouncilEvent) : null,
    });
    if (state.tiebreakPending) socket.emit("tiebreakMJ", votes.egaliteEnCours());
    // Reprise après plantage : proposée au MJ si une sauvegarde est en attente
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

  // Reprise après plantage — acceptée par le MJ
  socket.on("acceptCrashRecovery", () => {
    if (!isMJ(socket.id) || !state.pendingRestore) return;
    const snap = state.pendingRestore;
    log.warn('reprise après plantage ACCEPTÉE par le MJ', `phase=${snap.phase}`);
    snapshot.applySnapshot(state, snap);
    state.pendingRestore = null;
    // Après un redémarrage, aucun téléphone n'est encore revenu : pastilles rouges
    // jusqu'à ce que chacun se reconnecte avec son prénom.
    state.players.forEach(p => { if (!p.isBot) p.connecte = false; });
    envoyerConnexionsMJ();
    // Diffuse l'état à tout le monde et invite les joueurs à se reconnecter par leur prénom
    io.emit("gameRestored", {
      phase: state.phase,
      message: "Partie restaurée après redémarrage du serveur. Reconnecte-toi avec ton prénom."
    });
    // Reprise en plein jour : setPhase("day") compte un jour de plus et repart de l'évènement
    // « pour demain » — sans ceci, le jour 2 devenait le jour 3 et l'évènement du jour était
    // perdu. On lui rend l'évènement, que le MJ réannonce.
    if (state.phase === "day") {
      if (state.gameStats.dayCount > 0) state.gameStats.dayCount--;
      if (state.activeCouncilEvent && !state.pendingCouncilEvent) {
        state.pendingCouncilEvent = state.activeCouncilEvent;
        state.activeCouncilEvent = null;
      }
    }
    // Re-appelle setPhase pour réinstaller proprement les timers (idempotent)
    phases.setPhase(state.phase);
  });

  // Reprise après plantage — refusée par le MJ
  socket.on("discardCrashRecovery", () => {
    if (!isMJ(socket.id) || !state.pendingRestore) return;
    log.info('reprise après plantage ÉCARTÉE par le MJ');
    state.pendingRestore = null;
    snapshot.clearSnapshot();
  });

  // ===== INSCRIPTION JOUEUR (avec gestion reconnexion) =====
  socket.on("register", name => {
    if (typeof name !== "string") return;
    const trimmed = name.trim().slice(0, 20).replace(/[<>"'&]/g, '');
    const key = trimmed.toLowerCase();
    if (!trimmed) return;

    // En partie : le joueur reprend sa place sous sa nouvelle connexion (page rechargée,
    // téléphone sorti de veille, autre téléphone)
    if (state.playerRegistry[key] && state.phase !== "lobby") {
      const entree = state.playerRegistry[key];
      const oldId = entree.oldId || "";
      const p = state.players.find(x => x.name.toLowerCase() === key);
      // Le joueur était-il signalé comme déconnecté ? (pour prévenir le MJ de son retour)
      const etaitPerdu = !!p && p.connecte === false;
      reprendrePlace(entree, p, socket.id);
      if (alertesDeconnexion[key]) { clearTimeout(alertesDeconnexion[key]); delete alertesDeconnexion[key]; }
      if (oldId && oldId !== socket.id) remplacerIdentifiant(oldId, socket.id, entree.role);
      io.emit("players", state.players);
      io.emit("deadPlayers", state.deadPlayers);
      io.emit("newMayor", state.mayor, { reconnexion: true });
      // L'écran du MJ repère les rôles par identifiant de connexion : sans cette mise à
      // jour, il affichait « ? » pour un joueur qui s'était reconnecté.
      versMJ("rolesMJUpdate", { roles: state.roles, players: state.players });
      versMJ("loversInfo", state.lovers);
      envoyerConnexionsMJ();
      if (etaitPerdu) versMJ("joueurRevenu", { name: playerName(socket.id) });
      // Les téléphones des loups, des sœurs et des amoureux mémorisent leurs partenaires par
      // identifiant : on leur renvoie la liste à jour, sinon un loup ne reconnaissait
      // plus son coéquipier reconnecté (et pouvait cliquer pour le dévorer).
      for (const [r, evenement] of [["Loup", "loupsMisAJour"], ["Sœurs", "soeursMisAJour"]]) {
        if (state.roles[socket.id] !== r) continue;
        const ids = joueursAvecRole(r);
        ids.filter(id => id !== socket.id).forEach(id => io.to(id).emit(evenement, ids));
      }
      if (state.lovers.includes(socket.id)) {
        const cupidons = joueursAvecRole("Cupidon");
        [...state.lovers, ...cupidons].filter(id => id !== socket.id).forEach(id => io.to(id).emit("loversInfo", state.lovers));
      }
      socket.emit("reconnected", buildFullState(socket.id));
      if (state.deadPlayers.includes(socket.id)) socket.emit("deadChatHistory", state.deadChatHistory);
      resynchroniserApresReconnexion(socket);
      return;
    }
    if (state.phase === "lobby" && state.playerRegistry[key]) {
      const existing = state.players.find(p => p.name.toLowerCase() === key);
      // Prénom déjà pris par un téléphone encore connecté
      if (existing && existing.id !== socket.id && io.sockets.sockets.get(existing.id)) {
        socket.emit("registerError", "Ce prénom est déjà pris.");
        return;
      }
      // Reconnexion au salon : le nouveau socket apprend qu'il est reconnu
      if (existing) {
        reprendrePlace(state.playerRegistry[key], existing, socket.id);
        io.emit("players", state.players);
        socket.emit("reconnected", buildFullState(socket.id));
        return;
      }
      // Entrée orpheline
      delete state.playerRegistry[key];
    }
    const joueur = { id: socket.id, name: trimmed, photo: null, connecte: true, ecranVisible: true };
    state.players.push(joueur);
    state.playerRegistry[key] = entreeRegistre(joueur);
    log.info('joueur inscrit', trimmed, 'total=' + state.players.length);
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
      log.warn('photo refusée (trop lourde)', socket.id, 'octets=' + photo.length);
      return;
    }
    const me = state.players.find(p => p.id === socket.id);
    if (!me) return;
    me.photo = photo;
    const key = me.name.toLowerCase();
    if (state.playerRegistry[key]) state.playerRegistry[key].photo = photo;
    io.emit("players", state.players);
  });

  // ===== LANCEMENT DE LA PARTIE (« 🚀 Lancer la partie », « Relancer ») =====
  socket.on("assignRoles", config => phases.handleLancerPartie(socket, config));
  socket.on("replayGame",  config => phases.handleLancerPartie(socket, config));

  // ===== BOTS (mode entraînement) =====
  socket.on("addBot", () => {
    if (!isMJ(socket.id) || state.phase !== "lobby") return;
    state.botCounter++;
    const name = `🤖 Bot ${state.botCounter}`;
    const id   = `bot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const key  = name.toLowerCase();
    if (state.playerRegistry[key]) return;
    const bot = { id, name, isBot: true };
    state.players.push(bot);
    state.playerRegistry[key] = entreeRegistre(bot);
    io.emit("players", state.players);
  });

  // Le MJ retire un joueur entre deux parties (croix à côté de son nom, dans le salon).
  // Son téléphone est prévenu et oublie son prénom, pour ne pas revenir tout seul.
  socket.on("retirerJoueur", id => {
    if (!isMJ(socket.id) || state.phase !== "lobby") return;
    const p = state.players.find(x => x.id === id);
    if (!p) return;
    log.info('joueur retiré par le MJ', p.name);
    if (!p.isBot) io.to(id).emit("retireParMJ");
    retirerDuSalon(p);
  });

  // Le dernier robot ajouté quitte le salon
  socket.on("removeBot", () => {
    if (!isMJ(socket.id) || state.phase !== "lobby") return;
    const bot = [...state.players].reverse().find(p => p.isBot);
    if (bot) retirerDuSalon(bot);
  });

  // ===== MAIRE =====
  socket.on("voteMayor",     target => votes.handleVoteMayor(socket, actuel(target)));
  socket.on("lockMayorVote", ()     => votes.handleLockMayorVote(socket));

  // ===== MISSION =====
  socket.on("missionTeamChoice",  teamIds      => roles.handleMissionTeamChoice(socket, actuel(teamIds)));
  socket.on("missionCard",        card         => roles.handleMissionCard(socket, card));
  socket.on("missionBonusChoice", bonusTeamIds => roles.handleMissionBonusChoice(socket, actuel(bonusTeamIds)));

  // ===== ÉGALITÉ TRANCHÉE PAR LE MAIRE =====
  socket.on("tiebreakChoice", targetId => votes.handleTiebreakChoice(socket, actuel(targetId)));

  // ===== TRANSMISSION D'ÉCHARPE =====
  socket.on("mayorTransferChoice", targetId => roles.handleMayorTransferChoice(socket, actuel(targetId)));

  // ===== RÔLES — ACTIONS DE NUIT =====
  socket.on("cupidChoice",     data     => roles.handleCupidChoice(socket, actuel(data)));
  socket.on("salvateurAction", targetId => roles.handleSalvateurAction(socket, actuel(targetId)));
  socket.on("mjEtapeSuivante",   ()  => roles.handleMJEtapeSuivante(socket));
  // Rythme du MJ : lancer la nuit, annoncer l'évènement, clore l'annonce du matin
  socket.on("mjLancerNuit",      ()  => roles.handleMJLancerNuit(socket));
  socket.on("mjOuvrirAction",    ()  => { if (isMJ(socket.id)) phases.ouvrirActionMJ(); });
  socket.on("mjAnnoncerEvenement", () => { if (isMJ(socket.id)) council.annoncerEvenement(); });
  socket.on("mjFinAnnonceMatin", ()  => {
    if (!isMJ(socket.id) || state.phase !== "day") return;
    // Évènement pas encore annoncé : il l'est maintenant et reste à lire ; sinon sa carte se ferme avec celle des morts
    const vientDEtreAnnonce = council.annoncerEvenement();
    council.finAnnonceMatin(!vientDEtreAnnonce);
  });
  socket.on("voteWolf",        id       => votes.handleVoteWolf(socket, actuel(id)));
  socket.on("lockWolfVotes",   ()       => votes.handleLockWolfVotes(socket));
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
  // Les morts et le MJ pendant la partie ; tout le monde au salon, une fois la partie finie
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
    if (isPostGame) {
      io.emit("deadChatMsg", msg);
    } else {
      state.deadPlayers.forEach(id => io.to(id).emit("deadChatMsg", msg));
      versMJ("deadChatMsg", msg);
    }
  });

  socket.on("deadChatHistory", () => {
    if (state.deadPlayers.includes(socket.id) || isMJ(socket.id))
      socket.emit("deadChatHistory", state.deadChatHistory);
  });

  // Première carte de nuit affichée sur un téléphone : la musique de nuit démarre chez le MJ
  socket.on("nightCardShown", () => {
    if (!state.mjSocketId || state.nightMusicPlayed || !['cupid', 'wolves', 'nightPause'].includes(state.phase)) return;
    state.nightMusicPlayed = true;
    versMJ("playNightMusic");
  });

  // ===== CLASSEMENT DE LA SOIRÉE =====
  // « Nouvelle soirée » (écran MJ) : le classement repart à zéro
  socket.on("nouvelleSoiree", () => {
    if (!isMJ(socket.id)) return;
    soiree.nouvelleSoiree();
    socket.emit("soireeMJ", soiree.resume());
  });

  // ===== RETOUR AU SALON =====
  socket.on("reset",      () => phases.handleReset(socket));
  // Reset complet (tests automatisés uniquement) : efface aussi la liste des joueurs
  socket.on("fullReset",  () => phases.handleReset(socket, false));

  // ===== DÉCONNEXION =====
  socket.on("disconnect", () => {
    state.voteRateLimit.delete(socket.id);
    const p = state.players.find(x => x.id === socket.id);
    if (p) {
      log.info('joueur déconnecté', p.name, 'phase=' + state.phase);
      const key = p.name.toLowerCase();
      if (state.phase === "lobby") {
        retirerDuSalon(p);
      } else {
        // En partie, le joueur garde sa place : pastille rouge chez le MJ, alerte si la
        // coupure dure (un rechargement de page revient avant)
        if (state.playerRegistry[key]) state.playerRegistry[key].oldId = socket.id;
        p.connecte = false;
        envoyerConnexionsMJ();
        if (alertesDeconnexion[key]) clearTimeout(alertesDeconnexion[key]);
        alertesDeconnexion[key] = setTimeout(() => {
          delete alertesDeconnexion[key];
          const q = state.players.find(x => x.name.toLowerCase() === key);
          if (q && q.connecte === false && state.phase !== "lobby") versMJ("joueurPerdu", { name: q.name });
        }, DELAI_ALERTE_DECONNEXION_MS);
      }
    }
    if (state.mjSocketId === socket.id) { log.warn('MJ déconnecté'); state.mjSocketId = null; }
  });
});

// ===== RECONNEXION : REMISE À JOUR DES ÉCRANS =====
// Un joueur vient de changer d'identifiant (il a déjà reçu « reconnected »). S'il doit agir
// à l'étape en cours, il retrouve sa demande ; les autres écrans reçoivent ce qui dépend de
// son identifiant (votes, égalité, transmission d'écharpe, victime montrée à la Sorcière…).
// Les pages joueurs corrigent elles-mêmes leurs identifiants en mémoire (liste « players »).
function resynchroniserApresReconnexion(socket) {
  const id = socket.id, role = state.roles[id], vivant = !state.deadPlayers.includes(id);
  // Votes en cours
  if (state.phase === "mayorVote") votes.publierVotesDuMaire();
  if (state.phase === "wolves") votes.publierVotesDesLoups();
  if (state.phase === "day" && Object.keys(state.votesDay).length) votes.publierVotesDuJour();
  if (state.phase === "day") roles.annoncerCorbeau();
  // Égalité en attente d'arbitrage : panneaux du maire et du MJ reconstruits
  if (state.tiebreakPending && state.mayor && state.tiebreakCandidates.length) {
    const egalite = votes.egaliteEnCours();
    io.to(state.mayor).emit("tiebreakMayor", egalite);
    versMJ("tiebreakMJ", egalite);
  }
  // Étape de nuit en cours : le joueur qui doit agir retrouve sa demande (sinon la nuit
  // attendait jusqu'au filet de son étape)
  if (vivant && state.phase === "corbeau" && role === "Corbeau") socket.emit("corbeauTurn");
  // La Sorcière s'est reconnectée, ou la victime des loups (la Sorcière reçoit son nouvel identifiant)
  if (state.phase === "witch" && ((vivant && role === "Sorcière") || state.nightTarget === id)) roles.informerSorciere();
  // Voyante ou Petite Fille reconnectée avant d'avoir confirmé : on lui remontre la réponse
  // (sans réponse en attente, la page de la Petite Fille rouvre seule le choix des 3 joueurs)
  if (state.phase === "seer" && role === "Voyante" && state.seerPendingResult) socket.emit("seerResult", state.seerPendingResult);
  if (state.phase === "petiteFille" && role === "PetiteFille" && state.petiteFillePendingResult) {
    socket.emit("petiteFilleResult", state.petiteFillePendingResult);
  }
  // Amoureux reconnecté pendant leur réveil : il revoit l'autre, avec le temps restant
  if (state.phase === "amoureux" && state.lovers.includes(id) && state.amoureuxFin) roles.montrerPartenaire(id);
  // Chasseur ou maire mourant dont l'action est ouverte (tout le monde sait qui transmet l'écharpe)
  if (state.phase === "chasseur" && state.currentChasseurShooter === id && !state.actionMJ) socket.emit("chasseurMustShoot", id);
  if (state.phase === "mayorTransfer" && state.dyingMayorId === id && !state.actionMJ) io.emit("mayorMustTransfer", id);
  // Vote de mission : la demande de carte, si elle n'est pas encore jouée
  if (state.phase === "missionVote" && state.mission.team.includes(id) && !state.mission.cards[id]) roles.demanderCarteMission(id);
  // Conseil des Morts en cours : le mort reconnecté retrouve son vote
  if (state.councilOptions && !vivant) socket.emit("councilStart", council.optionsDuConseil());
}

// ===== DÉMARRAGE =====
http.listen(PORT, () => {
  log.info('=== serveur démarré ===', 'port=' + PORT, 'ip=' + getLocalIPv4());
  console.log(`🐺 Serveur Loup-Garou démarré sur http://localhost:${PORT}`);
  console.log(`   IP locale : http://${getLocalIPv4()}:${PORT}`);
  console.log(`   MJ        : http://${getLocalIPv4()}:${PORT}/mj`);
});
