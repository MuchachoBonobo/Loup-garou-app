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

// Causes de mort : pictogramme et phrase (« Ana — tué par les Loups »)
const CAUSES = {
  loups:    { emoji: "🐺", texte: "tué par les Loups" },
  sorcière: { emoji: "🧪", texte: "empoisonné par la Sorcière" },
  vote:     { emoji: "☀️", texte: "éliminé par le village" },
  chasseur: { emoji: "🔫", texte: "emporté par le Chasseur" },
  amour:    { emoji: "💔", texte: "mort d'amour" },
};
const causeEnTexte = c => (CAUSES[c] || {}).texte || c || "mort";
