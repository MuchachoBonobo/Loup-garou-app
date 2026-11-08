// essai-evenements.js — OUTIL D'ESSAI TEMPORAIRE (2026-11-08), demandé par Alexandre pour la partie
// où il essaie chaque évènement du Conseil des Morts (lumières, sons), sans attendre que les morts
// le tirent. À RETIRER après cette partie : supprimer ce fichier et public/js/essai-evenements.js,
// puis les deux lignes qui les branchent (cherche « essai-evenements » dans server.js et mj.html).
//
// En plein jour, hors vote, le MJ touche un évènement : celui en cours s'arrête comme en fin de
// journée (sons, lumière, débat rythmé), et le nouveau devient l'évènement du jour, à annoncer
// comme au matin (« 📜 Annoncer l'évènement », puis « ▶ Lancer le débat »).

const { state, isMJ, versMJ } = require('./state');
const council = require('./council');
const votes   = require('./votes');
const lights  = require('./lights');
const log     = require('./logger');

function declencher(socket, id) {
  if (!isMJ(socket.id) || state.phase !== "day" || !council.evenementPublic(id)) return;
  if (state.voteTimer || state.resolutionJourEnCours) {
    versMJ("autoResolve", "🧪 Essai : le vote est en cours. Essaie cet évènement au jour suivant.");
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

function brancher(socket) {
  socket.on("essaiListe", () => socket.emit("essaiListe",
    Object.keys(council.COUNCIL_EVENTS).map(id => ({ id, title: council.COUNCIL_EVENTS[id].title }))));
  socket.on("essaiEvenement", id => declencher(socket, id));
}

module.exports = { brancher };
