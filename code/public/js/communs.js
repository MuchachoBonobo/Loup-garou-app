// communs.js — chargé par l'écran des joueurs ET par celui du MJ : les deux écrans nomment
// toujours les rôles et les causes de mort de la même façon (un changement ici vaut pour les
// deux). Le serveur garde ses propres libellés, accordés pour les récits de mort
// (death-narratives.js).

const ROLES = {
  Loup:        { emoji: "🐺", nom: "Loup-Garou" },
  Voyante:     { emoji: "🔮", nom: "Voyante" },
  Sorcière:    { emoji: "🧪", nom: "Sorcière" },
  Chasseur:    { emoji: "🔫", nom: "Chasseur" },
  Cupidon:     { emoji: "💘", nom: "Cupidon" },
  Villageois:  { emoji: "🏠", nom: "Villageois" },
  Maire:       { emoji: "🏛️", nom: "Maire" },
  PetiteFille: { emoji: "👧", nom: "Petite Fille" },
  Idiot:       { emoji: "🤡", nom: "Idiot du village" },
  Ange:        { emoji: "👼", nom: "Ange" },
  Corbeau:     { emoji: "🪶", nom: "Corbeau" },
  Salvateur:   { emoji: "🛡️", nom: "Salvateur" },
  Sœurs:       { emoji: "👯‍♀️", nom: "Sœur jumelle" },
};
// Un rôle inconnu garde son identifiant (ou « ? »), sans pictogramme
const emojiDuRole = r => (ROLES[r] || {}).emoji || "";
const nomDuRole   = r => (ROLES[r] || {}).nom || r || "?";

// Causes de mort : pictogramme et phrase, neutre pour tout le monde (« Ana — victime des Loups »,
// « Ana est victime des Loups » dans le récit lu par le MJ)
const CAUSES = {
  loups:    { emoji: "🐺", texte: "victime des Loups" },
  sorcière: { emoji: "🧪", texte: "victime du poison de la Sorcière" },
  vote:     { emoji: "☀️", texte: "victime du vote du village" },
  chasseur: { emoji: "🔫", texte: "victime du tir du Chasseur" },
  amour:    { emoji: "💔", texte: "victime d'un chagrin d'amour" },
};
const causeEnTexte = c => (CAUSES[c] || {}).texte || c || "mort";

// Voix du vote du jour, plus les 2 voix du Corbeau sur sa cible tant qu'elle est en vie (le
// serveur les ajoute au dépouillement, votes.js) : affichées pareil sur les deux écrans
const VOIX_DU_CORBEAU = 2;
function voixAvecCorbeau(voix, cibleCorbeau, morts) {
  const total = { ...voix };
  if (cibleCorbeau && !morts.includes(cibleCorbeau)) total[cibleCorbeau] = (total[cibleCorbeau] || 0) + VOIX_DU_CORBEAU;
  return total;
}

// Fin du vote à l'heure de cet appareil : son horloge peut avoir quelques secondes d'écart avec
// celle du PC (d.serverNow : l'heure du PC à l'envoi)
function finDuVote(d) { return d.serverNow && d.endsAt ? d.endsAt + (Date.now() - d.serverNow) : d.endsAt; }
