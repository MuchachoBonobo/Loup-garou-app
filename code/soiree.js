// soiree.js — Classement de la soirée : 1 point par victoire, cumulé sur les parties
// enchaînées pendant une prestation (règle d'Alexandre, 2026-10-23).
//
// - Chaque joueur du camp gagnant marque 1 point, mort ou vivant : tous les loups, tout
//   le village (tous les non-loups), les deux amoureux, ou l'Ange seul.
// - Les bots ne sont pas classés (parties d'entraînement).
// - Le classement survit aux parties ET à un redémarrage du PC (fichier soiree.json dans
//   le dossier des sauvegardes, non versionné : il contient des prénoms). Il ne repart à
//   zéro que lorsque le MJ appuie sur « Nouvelle soirée ».

const fs   = require('fs');
const path = require('path');
const log  = require('./logger');
const { SNAP_DIR } = require('./snapshot');

const FICHIER = path.join(SNAP_DIR, 'soiree.json');

function vide() { return { debut: new Date().toISOString(), parties: 0, scores: {} }; }

let soiree = (() => {
  try {
    if (fs.existsSync(FICHIER)) {
      const s = JSON.parse(fs.readFileSync(FICHIER, 'utf8'));
      if (s && typeof s.scores === 'object') return s;
    }
  } catch (e) { log.error('soirée illisible, nouvelle soirée', e.message); }
  return vide();
})();

function sauver() {
  try {
    const tmp = FICHIER + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(soiree));
    fs.renameSync(tmp, FICHIER);
  } catch (e) { log.error('sauvegarde de la soirée impossible', e.message); }
}

// Classement trié (points puis prénom), avec le rang (ex æquo = même rang)
function classement() {
  const liste = Object.values(soiree.scores)
    .sort((a, b) => b.points - a.points || a.nom.localeCompare(b.nom, 'fr'));
  let rang = 0, precedent = null;
  return liste.map((s, i) => {
    if (s.points !== precedent) { rang = i + 1; precedent = s.points; }
    return { rang, nom: s.nom, points: s.points, parties: s.parties };
  });
}

// Enregistre une partie terminée et renvoie le classement à jour
function enregistrerPartie({ players, roles, lovers, winner }) {
  const gagne = p => {
    const r = roles[p.id];
    if (winner === 'wolves')    return r === 'Loup';
    if (winner === 'villagers') return !!r && r !== 'Loup';
    if (winner === 'lovers')    return (lovers || []).includes(p.id);
    if (winner === 'ange')      return r === 'Ange';
    return false;
  };
  const humains = (players || []).filter(p => !p.isBot && roles[p.id]);
  if (!humains.length) return classement();   // partie d'entraînement entre bots : rien à compter
  humains.forEach(p => {
    const cle = p.name.toLowerCase();
    if (!soiree.scores[cle]) soiree.scores[cle] = { nom: p.name, points: 0, parties: 0 };
    soiree.scores[cle].nom = p.name;
    soiree.scores[cle].parties++;
    if (gagne(p)) soiree.scores[cle].points++;
  });
  soiree.parties = (soiree.parties || 0) + 1;
  sauver();
  return classement();
}

function nouvelleSoiree() {
  soiree = vide();
  sauver();
  log.info('nouvelle soirée : classement remis à zéro');
}

// Résumé pour l'écran du MJ : nombre de parties de la soirée et classement
function resume() { return { parties: soiree.parties || 0, classement: classement() }; }

module.exports = { enregistrerPartie, classement, nouvelleSoiree, resume };
