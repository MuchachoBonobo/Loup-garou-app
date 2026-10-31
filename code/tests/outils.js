// tests/outils.js — outils communs à tous les tests (et au banc de robots) : serveur jetable,
// faux téléphones, tablette du MJ, attentes, MJ automatique, compte des vérifications, arrêt
// imprévu. Un changement ici vaut pour tous les tests.
"use strict";
const { spawn } = require("child_process");
const path = require("path"), os = require("os"), fs = require("fs");
const { io: ioc } = require("socket.io-client");

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Tous les serveurs jetables du test : ceux encore allumés (à éteindre si le test s'arrête net)
// et leurs erreurs JavaScript (qui font échouer le bilan)
const serveursAllumes = new Set();
const erreursServeur = [];

// Serveur jetable : lumières coupées, sauvegardes dans un dossier temporaire (vidé au départ,
// sauf `viderDossier: false` pour une reprise après plantage). `surLigne(texte)` reçoit tout ce
// que le serveur écrit ; ses erreurs JavaScript s'affichent toujours et restent dans `srv.erreurs`.
function demarrerServeur(port, { viderDossier = true, surLigne } = {}) {
  const dossier = path.join(os.tmpdir(), "loupgarou-test-" + port);
  if (viderDossier) try { fs.rmSync(dossier, { recursive: true, force: true }); } catch { /* dossier temporaire : tant pis s'il résiste */ }
  return new Promise((res, rej) => {
    const srv = spawn(process.execPath, ["server.js"], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, PORT: String(port), LIGHTS_ENABLED: "false", SNAPSHOT_DIR: dossier },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let pret = false;
    const erreurs = [];
    const lire = d => {
      const t = String(d);
      if (surLigne) surLigne(t);
      if (/TypeError|ReferenceError|RangeError|NON RATTRAPÉE|NON TRAITÉE|Cannot read|is not a function|is not defined/.test(t)) {
        const e = t.trim().slice(0, 400);
        erreurs.push(e); erreursServeur.push(e); console.log("[serveur] " + e);
      }
      if (!pret && t.includes("démarré")) { pret = true; serveursAllumes.add(srv); res(Object.assign(srv, { dossier, erreurs })); }
    };
    srv.stdout.on("data", lire);
    srv.stderr.on("data", lire);
    setTimeout(() => { if (!pret) rej(new Error("serveur non démarré en 15 s")); }, 15000);
  });
}

// Arrêt du serveur : normal, ou brutal comme un plantage ; son dossier de sauvegardes est effacé,
// sauf s'il doit servir à la reprise
async function arreterServeur(srv, { brutal = false, garderDossier = false } = {}) {
  serveursAllumes.delete(srv);
  if (srv.exitCode === null) await new Promise(r => { srv.once("exit", r); srv.kill(brutal ? "SIGKILL" : "SIGTERM"); });
  if (!garderDossier) try { fs.rmSync(srv.dossier, { recursive: true, force: true }); } catch { /* dossier temporaire : tant pis s'il résiste */ }
}

// Faux téléphone (ou tablette) : une connexion ; avec un prénom, il rejoint la partie
function connecter(port, nom) {
  return new Promise((res, rej) => {
    const s = ioc(`http://localhost:${port}`, { transports: ["websocket"], forceNew: true, reconnection: false });
    s.once("connect", () => { if (nom) s.emit("register", nom); res(s); });
    s.once("connect_error", rej);
    setTimeout(() => rej(new Error("connexion impossible" + (nom ? ` (${nom})` : ""))), 7000);
  });
}

// Tablette du MJ : connectée, reconnue par le serveur (`etat` = ce qu'il renvoie à une tablette
// rechargée) ; une sauvegarde d'avant plantage est écartée, sauf `reprise: true`
async function connecterMJ(port, { reprise = false } = {}) {
  const mj = await connecter(port);
  const reponse = attendre(mj, "mjReconnected", 5000);
  mj.emit("registerMJ");
  const etat = await reponse;
  if (!reprise) mj.emit("discardCrashRecovery");
  return { mj, etat };
}

// Attend un message du serveur ; `filtre` écarte ceux qui ne conviennent pas
function attendre(s, evenement, ms = 10000, filtre) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { s.off(evenement, h); rej(new Error(`attente de « ${evenement} » dépassée (${ms} ms)`)); }, ms);
    function h(d) { if (filtre && !filtre(d)) return; clearTimeout(t); s.off(evenement, h); res(d); }
    s.on(evenement, h);
  });
}
const attendrePhase = (s, phase, ms = 15000) => attendre(s, "phase", ms, p => p === phase);
// Vrai si l'attente aboutit, faux si son délai est dépassé : de quoi en faire une vérification
const arrive = attente => attente.then(() => true, () => false);

// MJ automatique : passe les pauses de nuit, ouvre les actions (Chasseur, maire mourant), et selon
// les options lance la nuit et valide l'attaque des loups (un test qui vérifie une de ces étapes
// la laisse au test). `delai` : en ms, ou une fonction qui le tire à chaque clic.
function piloterMJ(mj, { delai = 500, etapes = true, actions = true, nuit = false, loupsApres = 0 } = {}) {
  const cliquer = evenement => () => setTimeout(() => mj.emit(evenement), typeof delai === "function" ? delai() : delai);
  if (etapes) mj.on("etapeNuitEnAttente", cliquer("mjEtapeSuivante"));
  if (actions) mj.on("actionMJEnAttente", cliquer("mjOuvrirAction"));
  if (nuit) mj.on("nuitEnAttente", cliquer("mjLancerNuit"));
  if (loupsApres) mj.on("phase", p => { if (p === "wolves") setTimeout(() => mj.emit("lockWolfVotes"), loupsApres); });
}

// Compte des vérifications : chacune s'affiche ; bilan() ajoute « aucune erreur JavaScript du
// serveur », imprime le total et la liste des échecs, et rend le code de sortie (0 si tout est
// passé) ; arret(erreur) termine un test qui s'arrête net : bilan partiel, serveurs éteints.
function compteur() {
  let reussies = 0;
  const echecs = [];
  function check(nom, cond, detail) {
    const texte = detail === undefined ? "" : typeof detail === "string" ? detail : JSON.stringify(detail);
    if (cond) { reussies++; console.log("  ✅ " + nom); }
    else { echecs.push(nom + (texte ? " | " + texte : "")); console.log("  ❌ " + nom + (texte ? "  — " + texte : "")); }
    return !!cond;
  }
  function bilan(partiel = false) {
    check("aucune erreur JavaScript du serveur", erreursServeur.length === 0, erreursServeur.slice(0, 3).join(" ‖ "));
    console.log(`\n${partiel ? "BILAN PARTIEL" : "BILAN"} : ${reussies}/${reussies + echecs.length} vérifications passées`);
    echecs.forEach(e => console.log("  • " + e));
    return echecs.length ? 1 : 0;
  }
  async function arret(e) {
    console.log("\n❌ ARRÊT : " + (e && e.message || e));
    bilan(true);
    for (const srv of serveursAllumes) await arreterServeur(srv, { brutal: true });
    process.exit(2);
  }
  // Une attente lancée d'avance qui échoue pendant qu'on en attend une autre arrête aussi le test
  // proprement (sinon Node s'arrête net : ni bilan, ni serveur éteint)
  process.on("unhandledRejection", arret);
  return { check, bilan, arret };
}

module.exports = { sleep, demarrerServeur, arreterServeur, connecter, connecterMJ, attendre, attendrePhase, arrive, piloterMJ, compteur };
