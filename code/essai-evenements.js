// essai-evenements.js — OUTIL D'ESSAI TEMPORAIRE (2026-11-08 ; mode essai le 2026-11-11), demandé par
// Alexandre pour essayer chaque évènement du Conseil des Morts (cartes du MJ et des joueurs, lumières,
// sons) sans jouer de partie. À RETIRER après : supprimer ce fichier et public/js/essai-evenements.js,
// puis les deux lignes qui les branchent (cherche « essai-evenements » dans server.js et mj.html).
//
// Au salon (ou le soir d'une journée d'essai), le MJ touche un évènement : une JOURNÉE D'ESSAI commence
// aussitôt. Des robots complètent la table jusqu'à 8, chacun reçoit un rôle, un maire est tiré au sort,
// et c'est le matin, l'évènement à annoncer (« 📜 Annoncer l'évènement », puis « ▶ Lancer le débat »),
// sans élection ni nuit. Débat, vote et verdict comme en partie ; au lieu de la nuit, la tablette
// propose l'évènement suivant (une nouvelle journée, tout le monde en vie). En plein jour, hors vote,
// un toucher change d'évènement sur place. Pendant l'essai, ni victoire ni nuit.

const { state, isMJ, versMJ, auHasard, alivePlayers, entreeRegistre } = require('./state');
const council = require('./council');
const votes   = require('./votes');
const phases  = require('./phases');
const roles   = require('./roles');
const lights  = require('./lights');
const log     = require('./logger');

const JOUEURS_ESSAI = 8;
const COMPOSITION_ESSAI = { loup: 2, voyante: 1, sorciere: 1, autoMode: false, mjPilotedDay: true, autoVoteMode: 1, conseil: true };
let actif = false;
const enEssai = () => actif && state.phase !== "lobby";
const direEtat = () => versMJ("essaiEtat", { actif: enEssai() });

// Pendant l'essai, ni victoire ni nuit : les autres modules appellent ces fonctions par l'objet du
// module, on les enveloppe donc ici (rien à défaire ailleurs le jour où l'outil part)
const victoire = phases.checkVictory;
phases.checkVictory = (...a) => (enEssai() ? false : victoire(...a));
const nuit = roles.lancerNuitAttendue;
roles.lancerNuitAttendue = (...a) => { if (!enEssai()) nuit(...a); };
const lancerPartie = phases.handleLancerPartie;
phases.handleLancerPartie = (...a) => { actif = false; lancerPartie(...a); direEtat(); };   // une vraie partie

// En plein jour, hors vote : l'évènement en cours s'arrête comme en fin de journée, et le nouveau
// devient l'évènement du jour, à annoncer comme au matin
function declencher(id) {
  if (state.voteTimer || state.resolutionJourEnCours) {
    versMJ("autoResolve", "🧪 Essai : le vote est en cours. Choisis l'évènement suivant après le verdict.");
    return;
  }
  log.info('essai', id);
  votes.arreterDebat();
  council.clearCouncilEffects();
  state.io.emit("councilEventEnd");
  lights.applyScene("day");
  state.activeCouncilEvent = id;
  state.evenementAnnonce = false;
  if (council.annonceMatinParMJ()) {
    state.annonceMatinEnCours = true;
    versMJ("matinEnAttente", { evenement: council.evenementPublic(id) });
  } else {
    council.annoncerEvenement();
  }
}

// Une journée d'essai neuve : robots jusqu'à 8 (au salon : ils restent ensuite d'une journée à
// l'autre), rôles distribués, maire tiré au sort, matin avec l'évènement à annoncer
function demarrer(socket, id) {
  log.info('essai', 'journée', id);
  if (state.phase === "lobby") {
    while (state.players.length < JOUEURS_ESSAI) {
      state.botCounter++;
      const bot = { id: `bot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, name: `🤖 Bot ${state.botCounter}`, isBot: true };
      const cle = bot.name.toLowerCase();
      if (state.playerRegistry[cle]) continue;
      state.players.push(bot);
      state.playerRegistry[cle] = entreeRegistre(bot);
    }
    state.io.emit("players", state.players);
  }
  actif = true;
  lancerPartie(socket, COMPOSITION_ESSAI);
  if (state.phase !== "mayorVote") { actif = false; direEtat(); return; }   // lancement refusé
  const maire = auHasard(alivePlayers());
  state.mayor = maire.id;
  state.gameStats.mayorName = maire.name;
  state.io.emit("newMayor", state.mayor);
  state.pendingCouncilEvent = id;
  phases.setPhase("day");
  direEtat();
}

function brancher(socket) {
  socket.on("essaiListe", () => {
    socket.emit("essaiListe", Object.keys(council.COUNCIL_EVENTS).map(id => ({ id, title: council.COUNCIL_EVENTS[id].title })));
    if (isMJ(socket.id)) direEtat();
  });
  socket.on("essaiEvenement", id => {
    if (!isMJ(socket.id) || !council.evenementPublic(id)) return;
    if (state.phase === "day") return declencher(id);
    if (state.phase === "lobby" || enEssai()) return demarrer(socket, id);
    versMJ("autoResolve", "🧪 Essai : choisis un évènement au salon, ou en plein jour.");
  });
}

module.exports = { brancher };
