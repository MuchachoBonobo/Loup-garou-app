// Banc d'essai : parties complètes jouées par des bots (6 à 15 joueurs, rôles, mission, mode
// autonome ou nuit rythmée par le MJ, pauses du MJ, tirés au hasard), avec contrôle des règles
// à chaque évènement reçu par le MJ : ordre de la nuit, rôles morts qui ne se réveillent pas,
// jour après chaque nuit, règle de l'Ange, justesse du vainqueur, erreurs du serveur.
// Lance son propre serveur (lumières coupées, sauvegardes dans un dossier temporaire).
// Usage : node outils/banc-robots.js [port=3111] [nbParties=3] [graine=1]
//   Plusieurs bancs en parallèle : un port et une graine différents par banc.
//   CFG_FIXE='{"N":9,"cfg":{...}}' impose une composition (pour reproduire une anomalie).
// Chaque anomalie est imprimée avec le déroulé des derniers évènements et lignes du serveur.
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { io: ioc } = require("socket.io-client");

const PORT = +process.argv[2] || 3111;
const NB = +process.argv[3] || 3;
let graine = +process.argv[4] || 1;
const alea = () => { graine = (graine * 1103515245 + 12345) % 2147483648; return graine / 2147483648; };
const entre = (a, b) => a + Math.floor(alea() * (b - a + 1));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SNAP = path.join(os.tmpdir(), "loupgarou-banc-" + PORT);

const ORDRE_NUIT = ["cupid", "sisters", "salvateur", "wolves", "seer", "petiteFille", "corbeau", "witch"];
const PHASES_ROLE_NUIT = new Set(ORDRE_NUIT);

let erreursServeur = []; const lignesServeur = [];
function demarrerServeur() {
  return new Promise((res, rej) => {
    const srv = spawn("node", ["server.js"], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, PORT: String(PORT), LIGHTS_ENABLED: "false", SNAPSHOT_DIR: SNAP },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let pret = false;
    const surveille = d => {
      const t = d.toString();
      t.split(/\r?\n/).filter(l => /setPhase|killPlayer|resolveDayVote|startDayVote|Chasseur|mayorTransfer|autoResolve|pause|resume/i.test(l))
        .forEach(l => { lignesServeur.push(l.replace(/^\[[^\]]*\] /, "").slice(0, 120)); if (lignesServeur.length > 200) lignesServeur.shift(); });
      if (t.includes("démarré")) { pret = true; res(srv); }
      if (/TypeError|ReferenceError|RangeError|UNCAUGHT|UNHANDLED|Cannot read|is not a function|is not defined/.test(t)) erreursServeur.push(t.trim().slice(0, 400));
    };
    srv.stdout.on("data", surveille);
    srv.stderr.on("data", surveille);
    setTimeout(() => { if (!pret) rej(new Error("serveur non démarré")); }, 15000);
  });
}

async function partie(num) {
  const viol = [];
  const t0 = Date.now(); const journal = []; lignesServeur.length = 0;
  const J = l => { journal.push(((Date.now() - t0) / 1000).toFixed(1) + "s " + l); };
  const V = m => { viol.push(m + "\n      déroulé : " + journal.slice(-18).join(" | ") + "\n      serveur : " + lignesServeur.slice(-30).join(" || ")); };
  const mj = ioc(`http://localhost:${PORT}`, { transports: ["websocket"], forceNew: true });
  await new Promise(r => mj.on("connect", r));
  mj.emit("registerMJ"); mj.emit("discardCrashRecovery");
  await sleep(300);
  mj.emit("fullReset");
  await sleep(600);

  // --- Composition au hasard ---
  const FIXE = process.env.CFG_FIXE ? JSON.parse(process.env.CFG_FIXE) : null;
  const N = FIXE ? FIXE.N : entre(6, 15);
  for (let i = 0; i < N; i++) mj.emit("addBot");
  await sleep(500);
  const loups = N <= 7 ? 1 : N <= 11 ? 2 : 3;
  const cfg = { loup: loups };
  let places = N - loups - 1;  // au moins un villageois
  for (const r of ["voyante", "sorciere", "chasseur", "cupidon", "petiteFille", "idiot", "ange", "corbeau", "salvateur"]) {
    cfg[r] = (places > 0 && alea() < 0.55) ? 1 : 0; places -= cfg[r];
  }
  cfg.sisters = (places >= 2 && alea() < 0.4) ? 2 : 0;
  cfg.mission = alea() < 0.3;
  if (FIXE) Object.assign(cfg, FIXE.cfg);
  const modeMJ = FIXE ? !FIXE.cfg.autoMode : alea() < 0.6;          // nuit rythmée par le MJ (sinon mode autonome)
  cfg.autoMode = !modeMJ;
  cfg.autoVoteMode = [1, 2, 4, 5][entre(0, 3)];
  cfg.mjPilotedDay = modeMJ ? alea() < 0.6 : false;
  const desc = `N=${N} ${modeMJ ? "MJ" : "auto"}${cfg.mjPilotedDay ? "+jourPiloté" : ""}${cfg.mission ? "+mission" : ""} rôles=` +
    Object.entries(cfg).filter(([k, v]) => typeof v === "number" && v > 0 && k !== "autoVoteMode").map(([k, v]) => k + (v > 1 ? v : "")).join(",");

  // --- Suivi ---
  let roles = {}, morts = new Set(), amoureux = [], phases = [], fin = null, angeRevele = null;
  let premierVoteFait = false, finsDeJour = 0;
  let nuitEnCours = [], apresAube = false, apresFinDeJour = false, premiereNuitFaite = false;
  const vivants = () => Object.keys(roles).filter(id => !morts.has(id));
  const vivantRole = r => vivants().some(id => roles[id] === r);
  mj.on("rolesMJ", d => { if (d && d.roles && Object.keys(d.roles).length) roles = { ...d.roles }; });
  mj.on("loversInfo", l => { amoureux = l || []; });
  mj.on("playerDied", d => {
    J("mort " + d.name + "/" + d.role);
    if (morts.has(d.id)) V(`mort deux fois : ${d.name}`);
    morts.add(d.id);
  });
  mj.on("dawnResult", d => {
    J("AUBE morts=" + (d.deaths || []).map(x => x.name + "/" + x.role).join(","));
    if (apresAube) V("deux aubes sans jour entre les deux");
    apresAube = true; nuitEnCours = [];
  });
  const finDeJour = (type, d) => {
    finsDeJour++;
    if (type === "vote" && d && d.role === "Ange" && !premierVoteFait && !tireAuSort) V(`l'Ange désigné au 1er vote est mort au lieu de gagner (${d.name})`);
    if (type === "vote" && d && morts.has(d.id)) V(`éliminé au vote alors que déjà mort : ${d.name}`);
    premierVoteFait = true; tireAuSort = false;
    apresFinDeJour = true;
  };
  let tireAuSort = false;
  mj.on("randomElim", () => { tireAuSort = true; });
  mj.on("dayVoteResult", d => { J("vote→" + d.name + "/" + d.role); finDeJour("vote", d); });
  mj.on("gamePaused", () => J("PAUSE")); mj.on("gameResumed", () => J("REPRISE"));
  mj.on("chasseurMustShoot", () => J("chasseur doit tirer")); mj.on("mayorMustTransfer", () => J("écharpe à transmettre"));
  mj.on("idiotRevealed", d => finDeJour("idiot", d));
  mj.on("daySkipped", () => finDeJour("passe"));
  mj.on("angeRevele", d => {
    if (premierVoteFait) V("Ange révélé après le premier vote");
    angeRevele = d; premierVoteFait = true;
  });
  mj.on("gameEnd", m => {
    fin = m;
    const viv = vivants(), lv = viv.filter(id => roles[id] === "Loup").length, autres = viv.length - lv;
    if (m.includes("Ange")) { if (!angeRevele) V("victoire de l'Ange sans révélation"); }
    else if (angeRevele) V("Ange révélé mais autre vainqueur : " + m);
    else if (m.includes("Loups")) { if (!(lv > 0 && lv >= autres)) V(`victoire des Loups injustifiée (loups ${lv}, autres ${autres})`); }
    else if (m.includes("Amoureux")) { if (!(viv.length === 2 && viv.every(id => amoureux.includes(id)))) V("victoire des Amoureux injustifiée"); }
    else if (m.includes("Villageois")) { if (lv !== 0) V(`victoire du Village avec ${lv} loup(s) vivant(s)`); }
  });

  // --- Le MJ automatique ---
  const minuteurs = [];
  const plus_tard = (ms, f) => minuteurs.push(setTimeout(f, ms));
  mj.on("etapeNuitEnAttente", () => plus_tard(300, () => mj.emit("mjEtapeSuivante")));
  let phaseCourante = null, debutPhase = Date.now(), debutVote = null;
  mj.on("voteStartedMJ", () => { debutVote = Date.now(); });
  // Un vrai MJ reclique si rien ne bouge (un clic tombé pendant une pause est ignoré)
  const relance = setInterval(() => {
    const depuis = Date.now() - debutPhase;
    if (phaseCourante === "wolves" && depuis > 13000) mj.emit("lockWolfVotes");
    if (phaseCourante === "mayorVote" && depuis > 13000) mj.emit("lockMayorVote");
    if (phaseCourante === "nightPause" && depuis > 4000) mj.emit("mjEtapeSuivante");
    if (phaseCourante === "day" && cfg.mjPilotedDay && !debutVote && depuis > 9000) mj.emit("startVote", 1);
    if (phaseCourante === "day" && debutVote && Date.now() - debutVote > entre(9000, 15000)) mj.emit("lockDayVotes");
  }, 2500);
  minuteurs.push(relance);
  mj.on("phase", p => {
    phases.push(p); J("phase " + p);
    phaseCourante = p; debutPhase = Date.now(); debutVote = null;
    // Contrôles de cohérence de la nuit
    if (PHASES_ROLE_NUIT.has(p)) {
      if (apresAube) V(`nuit qui reprend juste après l'aube (« ${p} » avant le jour)`);
      const besoin = { seer: "Voyante", petiteFille: "PetiteFille", corbeau: "Corbeau", witch: "Sorcière", salvateur: "Salvateur", cupid: "Cupidon" }[p];
      if (besoin && !vivantRole(besoin)) V(`phase ${p} alors que ${besoin} est mort(e) ou absent(e)`);
      if (p === "sisters" && vivants().filter(id => roles[id] === "Sœurs").length < 2) V("Sœurs réveillées sans 2 sœurs vivantes");
      if (p === "petiteFille") {
        const pf = vivants().find(id => roles[id] === "PetiteFille");
        if (pf && vivants().filter(id => id !== pf).length < 3) V("Petite Fille réveillée avec moins de 3 autres vivants");
      }
      if (p === "cupid" && premiereNuitFaite) V("Cupidon réveillé après la 1re nuit");
      const dernier = nuitEnCours[nuitEnCours.length - 1];
      if (dernier && ORDRE_NUIT.indexOf(p) <= ORDRE_NUIT.indexOf(dernier)) V(`ordre de nuit incorrect : ${dernier} puis ${p}`);
      nuitEnCours.push(p);
      apresFinDeJour = false;
      premiereNuitFaite = premiereNuitFaite || p !== "cupid";
    }
    if (p === "day") {
      if (apresFinDeJour) V("deux jours de suite sans nuit");
      apresAube = false; nuitEnCours = [];
    }
    // Actions du MJ (complétées par la relance ci-dessus)
    if (p === "day" && cfg.mjPilotedDay) {
      if (alea() < 0.1) plus_tard(4000, () => mj.emit("skipDayVote"));
      else plus_tard(4000, () => mj.emit("startVote", 1));
    }
    // Pauses du MJ au hasard, pour éprouver la reprise
    if (alea() < 0.06 && p !== "lobby") plus_tard(1500, () => { mj.emit("pauseGame"); plus_tard(2500, () => mj.emit("resumeGame")); });
  });

  const debut = Date.now();
  mj.emit("assignRoles", cfg);
  while (!fin && Date.now() - debut < 12 * 60 * 1000) await sleep(1000);
  minuteurs.forEach(m => { clearTimeout(m); clearInterval(m); });
  const duree = Math.round((Date.now() - debut) / 1000);
  if (!fin) V(`partie bloquée (pas de fin en 12 min) — dernières phases : ${phases.slice(-8).join(" → ")}`);
  mj.close();
  await sleep(9000);  // laisse s'éteindre les minuteries du serveur (7 s de fin d'aube, 8,2 s de vote)
  return { num, desc, duree, fin, viol, jours: phases.filter(p => p === "day").length, pf: phases.filter(p => p === "petiteFille").length };
}

(async () => {
  try { fs.rmSync(SNAP, { recursive: true, force: true }); } catch (_) {}
  const srv = await demarrerServeur();
  const resultats = [];
  for (let i = 1; i <= NB; i++) {
    const r = await partie(i);
    resultats.push(r);
    console.log(`[${PORT}] partie ${i} (${r.desc}) : ${r.duree}s, ${r.jours} jour(s), PF ${r.pf}× → ${r.fin || "AUCUNE FIN"}` + (r.viol.length ? `\n    ❌ ${r.viol.join("\n    ❌ ")}` : "  ✅"));
  }
  srv.kill();
  try { fs.rmSync(SNAP, { recursive: true, force: true }); } catch (_) {}
  const nbViol = resultats.reduce((a, r) => a + r.viol.length, 0);
  console.log(`[${PORT}] BILAN : ${resultats.length} parties, ${nbViol} anomalie(s) de règle, ${erreursServeur.length} erreur(s) serveur`);
  erreursServeur.forEach(e => console.log(`[${PORT}] ERREUR SERVEUR : ${e}`));
  process.exit(0);
})();
