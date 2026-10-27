// tests/outils.js — outils communs à tous les tests (et au banc de robots) : serveur jetable,
// faux téléphones, attentes, MJ automatique, compte des vérifications. Un changement ici vaut
// pour tous les tests.
"use strict";
const { spawn } = require("child_process");
const path = require("path"), os = require("os"), fs = require("fs");
const { io: ioc } = require("socket.io-client");

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Serveur jetable : lumières coupées, sauvegardes dans un dossier temporaire (vidé au départ,
// sauf `viderDossier: false` pour une reprise après plantage). `surLigne(texte)` reçoit tout ce
// que le serveur écrit ; ses erreurs JavaScript s'affichent toujours.
function demarrerServeur(port, { viderDossier = true, surLigne } = {}) {
  const dossier = path.join(os.tmpdir(), "loupgarou-test-" + port);
  if (viderDossier) try { fs.rmSync(dossier, { recursive: true, force: true }); } catch (_) {}
  return new Promise((res, rej) => {
    const srv = spawn(process.execPath, ["server.js"], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, PORT: String(port), LIGHTS_ENABLED: "false", SNAPSHOT_DIR: dossier },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let pret = false;
    const lire = d => {
      const t = String(d);
      if (surLigne) surLigne(t);
      if (/TypeError|ReferenceError|RangeError|UNCAUGHT|UNHANDLED|Cannot read|is not a function|is not defined/.test(t)) console.log("[serveur] " + t.trim().slice(0, 400));
      if (!pret && t.includes("démarré")) { pret = true; res(Object.assign(srv, { dossier })); }
    };
    srv.stdout.on("data", lire);
    srv.stderr.on("data", lire);
    setTimeout(() => { if (!pret) rej(new Error("serveur non démarré en 15 s")); }, 15000);
  });
}

// Arrêt du serveur : normal, ou brutal comme un plantage ; son dossier de sauvegardes est effacé,
// sauf s'il doit servir à la reprise
async function arreterServeur(srv, { brutal = false, garderDossier = false } = {}) {
  if (srv.exitCode === null) await new Promise(r => { srv.once("exit", r); srv.kill(brutal ? "SIGKILL" : "SIGTERM"); });
  if (!garderDossier) try { fs.rmSync(srv.dossier, { recursive: true, force: true }); } catch (_) {}
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

// Attend un message du serveur ; `filtre` écarte ceux qui ne conviennent pas
function attendre(s, evenement, ms = 10000, filtre) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { s.off(evenement, h); rej(new Error(`attente de « ${evenement} » dépassée (${ms} ms)`)); }, ms);
    function h(d) { if (filtre && !filtre(d)) return; clearTimeout(t); s.off(evenement, h); res(d); }
    s.on(evenement, h);
  });
}
const attendrePhase = (s, phase, ms = 15000) => attendre(s, "phase", ms, p => p === phase);

// MJ automatique : passe les pauses de nuit, ouvre les actions (Chasseur, maire mourant), et selon
// les options lance la nuit et valide l'attaque des loups (un test qui vérifie une de ces étapes
// la laisse au test)
function piloterMJ(mj, { delai = 500, etapes = true, actions = true, nuit = false, loupsApres = 0 } = {}) {
  if (etapes) mj.on("etapeNuitEnAttente", () => setTimeout(() => mj.emit("mjEtapeSuivante"), delai));
  if (actions) mj.on("actionMJEnAttente", () => setTimeout(() => mj.emit("mjOuvrirAction"), delai));
  if (nuit) mj.on("nuitEnAttente", () => setTimeout(() => mj.emit("mjLancerNuit"), delai));
  if (loupsApres) mj.on("phase", p => { if (p === "wolves") setTimeout(() => mj.emit("lockWolfVotes"), loupsApres); });
}

// Compte des vérifications : chacune s'affiche ; bilan() imprime le total et la liste des échecs,
// et rend le code de sortie (0 si tout est passé)
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
    console.log(`\n${partiel ? "BILAN PARTIEL" : "BILAN"} : ${reussies}/${reussies + echecs.length} vérifications passées`);
    echecs.forEach(e => console.log("  • " + e));
    return echecs.length ? 1 : 0;
  }
  return { check, bilan };
}

module.exports = { sleep, demarrerServeur, arreterServeur, connecter, attendre, attendrePhase, piloterMJ, compteur };
