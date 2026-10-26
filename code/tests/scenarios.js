/**
 * tests/scenarios.js — Runner de tests d'intégration pour LoupGarouVoteApp
 *
 * Lance un serveur sur le port 3099, connecte de vrais sockets socket.io-client,
 * et vérifie le comportement bout-en-bout pour 5 scénarios ciblés.
 *
 * Usage : npm test   (ou : node tests/scenarios.js)
 *
 * Scénarios :
 *  S1 — BUG 1 regression : Chasseur tué la nuit + Sorcière empoisonne aussi
 *  S2 — BUG 2 regression : Reconnexion Corbeau pendant sa phase
 *  S3 — BUG 2 regression : Reconnexion Sorcière pendant sa phase
 *  S4 — Chasseur linché au vote de jour → reçoit chasseurMustShoot
 *  S5 — Smoke test : partie complète en autoMode (bots)
 */

"use strict";
const { spawn }    = require("child_process");
const { io: ioc }  = require("socket.io-client");
const path         = require("path");
const os           = require("os");
const fs           = require("fs");

// Dossier de sauvegarde jetable : le serveur de test ne doit pas laisser une
// partie « à reprendre » dans le vrai dossier snapshots/.
const TEST_SNAP_DIR = path.join(os.tmpdir(), "loupgarou-tests-snapshots");

const TEST_PORT = 3099;
const BASE_URL  = `http://localhost:${TEST_PORT}`;

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Attend un événement sur un socket, timeout en erreur. */
function waitFor(socket, event, ms = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout(${ms}ms) sur "${event}"`)), ms);
    socket.once(event, d => { clearTimeout(t); resolve(d); });
  });
}

/**
 * Attend que le socket reçoive phase===target.
 * Les phases intermédiaires sont ignorées.
 */
function waitForPhase(socket, target, ms = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout phase "${target}"`)), ms);
    function h(p) {
      if (p === target) { clearTimeout(t); resolve(); }
      else socket.once("phase", h);
    }
    socket.once("phase", h);
  });
}

/** Connecte un socket joueur et envoie register. */
function makeClient(name) {
  return new Promise((resolve, reject) => {
    const s = ioc(BASE_URL, { transports: ["websocket"], forceNew: true, timeout: 5000 });
    s.once("connect",       () => { if (name) s.emit("register", name); resolve(s); });
    s.once("connect_error", reject);
    setTimeout(() => reject(new Error(`connect timeout (${name})`)), 7000);
  });
}

/** Connecte un socket MJ, purge tout état résiduel. */
function makeMJ() {
  return new Promise((resolve, reject) => {
    const s = ioc(BASE_URL, { transports: ["websocket"], forceNew: true, timeout: 5000 });
    s.once("connect", () => {
      s.emit("registerMJ");
      s.emit("discardCrashRecovery");
      // Nuit rythmée par le MJ : le MJ de test clique « Passer à l'étape suivante »
      // une demi-seconde après chaque pause entre deux rôles de nuit.
      s.on("etapeNuitEnAttente", () => setTimeout(() => s.emit("mjEtapeSuivante"), 500));
      // Crépuscule : le MJ de test lance la nuit une demi-seconde après
      s.on("nuitEnAttente", () => setTimeout(() => s.emit("mjLancerNuit"), 500));
      resolve(s);
    });
    s.once("connect_error", reject);
    setTimeout(() => reject(new Error("connect timeout (MJ)")), 7000);
  });
}

function closeAll(sockets) {
  for (const s of sockets) try { if (s.connected) s.disconnect(); } catch (_) {}
  return sleep(500);
}

// ═══════════════════════════════════════════════════════════
// Compteurs de résultats
// ═══════════════════════════════════════════════════════════
let pass = 0, fail = 0;
const errors = [];
function ok()                       { pass++; }
function ko(label, detail)          { fail++; errors.push(detail ? `${label} | ${detail}` : label); console.error("  ❌", label, detail || ""); }
function check(label, cond, detail) { cond ? ok() : ko(label, detail); }

// ═══════════════════════════════════════════════════════════
// Helper de setup : reset complet, inscription joueurs, assignation rôles, wolves.
// ═══════════════════════════════════════════════════════════
async function setupGame(all, names, config) {
  const mj = await makeMJ(); all.push(mj);

  // Reset complet : vide state.players pour éviter les contaminations entre scénarios
  mj.emit("fullReset");
  await sleep(600);

  // Inscrire les joueurs
  const players = [];
  for (const n of names) {
    const s = await makeClient(n);
    all.push(s);
    players.push({ name: n, s });
  }
  await sleep(300);

  // Écouter les événements phase et yourRole AVANT d'émettre assignRoles
  const roleOf = {};
  const rolePs      = players.map(p => new Promise(res =>
    p.s.once("yourRole", d => { roleOf[p.name] = d.role; res(); })
  ));
  const mayorVoteP  = waitForPhase(players[0].s, "mayorVote");

  mj.emit("assignRoles", { ...config, autoMode: false, mjPilotedDay: true });
  await Promise.all([...rolePs, mayorVoteP]);
  console.log("  Rôles:", JSON.stringify(roleOf));

  // Tous votent pour players[0] ; MJ verrouille immédiatement
  players.forEach(p => { if (p !== players[0]) p.s.emit("voteMayor", players[0].s.id); });
  await sleep(100);

  const newMayorP = waitFor(players[0].s, "newMayor", 6000);
  mj.emit("lockMayorVote");
  await newMayorP;

  // Force passage à wolves pour court-circuiter la phase Cupidon (délai 60 s)
  const wolvesP = waitForPhase(players[0].s, "wolves");
  mj.emit("setPhase", "wolves");
  await wolvesP;

  return { mj, players, roleOf };
}

// ═══════════════════════════════════════════════════════════
// S1 — Chasseur tué la nuit + Sorcière empoisonne quelqu'un
// Régression BUG 1 : les deux doivent être dans deadPlayers après l'aube.
// ═══════════════════════════════════════════════════════════
async function s1() {
  console.log("\n▶ S1 — Chasseur tué nuit + poison Sorcière");
  const all = [];
  try {
    const NAMES = ["s1_Loup","s1_Hunt","s1_Witch","s1_V1","s1_V2"];
    const cfg   = { loup:1, chasseur:1, sorciere:1, voyante:0, cupidon:0, corbeau:0,
                    salvateur:0, sisters:0, petiteFille:0, idiot:0, mission:false };
    const { mj, players, roleOf } = await setupGame(all, NAMES, cfg);

    const loupP   = players.find(p => roleOf[p.name] === "Loup");
    const huntP   = players.find(p => roleOf[p.name] === "Chasseur");
    const witchP  = players.find(p => roleOf[p.name] === "Sorcière");
    const vills   = players.filter(p => roleOf[p.name] === "Villageois");
    if (!loupP || !huntP || !witchP || vills.length < 1) {
      ko("S1-setup", "rôle introuvable: " + JSON.stringify(roleOf)); return;
    }

    // Surveiller deadPlayers en continu (les events arrivent AVANT dawnResult)
    let latestDeadPlayers = [];
    players[0].s.on("deadPlayers", dp => { latestDeadPlayers = dp; });

    // Sorcière reçoit nightVictim après que les loups aient verrouillé
    const nightVictimP = waitFor(witchP.s, "nightVictim", 10000);
    loupP.s.emit("voteWolf", huntP.s.id);
    await sleep(100);
    loupP.s.emit("wolfConfirm"); // lock immédiat (1 seul loup)
    const victim = await nightVictimP;
    check("S1-nightVictim=chasseur", victim === huntP.s.id, `victim=${victim}`);

    // Sorcière empoisonne un villageois puis passe
    witchP.s.emit("witchKill", vills[0].s.id);
    await sleep(100);
    witchP.s.emit("witchDone");

    // Attendre dawnResult (les deadPlayers sont déjà arrivés avant)
    const dawn = await waitFor(players[0].s, "dawnResult", 10000);
    const dawnNames = (dawn.deaths || []).map(d => `${d.name}/${d.role}`);
    console.log("  dawnResult:", dawnNames.join(", ") || "(aucun)");

    await sleep(300); // laisser les éventuels derniers deadPlayers arriver
    const idToName = {}; players.forEach(p => { idToName[p.s.id] = p.name; });
    console.log("  deadPlayers:", latestDeadPlayers.map(id => idToName[id] || id).join(", "));
    check("S1-chasseur dans deadPlayers",          latestDeadPlayers.includes(huntP.s.id),  "deadPlayers=" + latestDeadPlayers.join(","));
    check("S1-villageois empoisonné dans deadPlayers", latestDeadPlayers.includes(vills[0].s.id), "deadPlayers=" + latestDeadPlayers.join(","));

    // Le Chasseur doit tirer pour libérer la phase
    const alive = players.filter(p => !latestDeadPlayers.includes(p.s.id) && p.s.id !== huntP.s.id);
    if (alive.length > 0) { huntP.s.emit("chasseurAction", alive[0].s.id); await sleep(600); }

  } catch (e) {
    ko("S1 crash", e.message);
    console.error("  Stack:", e.stack);
  } finally {
    await closeAll(all);
  }
}

// ═══════════════════════════════════════════════════════════
// S2 — Reconnexion Corbeau pendant sa phase → reçoit corbeauTurn
// Régression BUG 2 (Corbeau).
// ═══════════════════════════════════════════════════════════
async function s2() {
  console.log("\n▶ S2 — Reconnexion Corbeau en phase corbeau");
  const all = [];
  try {
    const NAMES = ["s2_Loup","s2_Crow","s2_V1","s2_V2","s2_V3"];
    const cfg   = { loup:1, chasseur:0, sorciere:0, voyante:0, cupidon:0, corbeau:1,
                    salvateur:0, sisters:0, petiteFille:0, idiot:0, mission:false };
    const { mj, players, roleOf } = await setupGame(all, NAMES, cfg);

    const loupP = players.find(p => roleOf[p.name] === "Loup");
    let   crowP = players.find(p => roleOf[p.name] === "Corbeau");
    const vills = players.filter(p => roleOf[p.name] === "Villageois");
    if (!loupP || !crowP) { ko("S2-setup", JSON.stringify(roleOf)); return; }

    // Wolves → corbeau phase
    const corbeauPhaseP = waitForPhase(crowP.s, "corbeau", 10000);
    crowP.s.once("corbeauTurn", () => {}); // vider l'éventuel premier event
    loupP.s.emit("voteWolf", vills[0].s.id);
    await sleep(100);
    loupP.s.emit("wolfConfirm");
    await corbeauPhaseP;

    // Déconnecter et reconnecter le Corbeau
    console.log("  → Déconnexion Corbeau...");
    const oldSock = crowP.s;
    oldSock.disconnect();
    all.splice(all.indexOf(oldSock), 1);
    await sleep(400);

    console.log("  → Reconnexion Corbeau...");
    const newSock = await makeClient(crowP.name);
    all.push(newSock);
    crowP.s = newSock;

    const got = await Promise.race([
      waitFor(newSock, "corbeauTurn", 4000).then(() => true),
      sleep(4200).then(() => false)
    ]);
    check("S2-corbeau reçoit corbeauTurn après reconnexion", got);

    newSock.emit("corbeauAction", "skip"); // libère la phase
    await sleep(600);
  } catch (e) {
    ko("S2 crash", e.message);
  } finally {
    await closeAll(all);
  }
}

// ═══════════════════════════════════════════════════════════
// S3 — Reconnexion Sorcière pendant sa phase → reçoit nightVictim
// Régression BUG 2 (Sorcière).
// ═══════════════════════════════════════════════════════════
async function s3() {
  console.log("\n▶ S3 — Reconnexion Sorcière en phase witch");
  const all = [];
  try {
    const NAMES = ["s3_Loup","s3_Witch","s3_V1","s3_V2","s3_V3"];
    const cfg   = { loup:1, chasseur:0, sorciere:1, voyante:0, cupidon:0, corbeau:0,
                    salvateur:0, sisters:0, petiteFille:0, idiot:0, mission:false };
    const { mj, players, roleOf } = await setupGame(all, NAMES, cfg);

    const loupP  = players.find(p => roleOf[p.name] === "Loup");
    let   witchP = players.find(p => roleOf[p.name] === "Sorcière");
    const vills  = players.filter(p => roleOf[p.name] === "Villageois");
    if (!loupP || !witchP) { ko("S3-setup", JSON.stringify(roleOf)); return; }

    // Attendre nightVictim initial AVANT la déconnexion
    const firstVictimP = waitFor(witchP.s, "nightVictim", 10000);
    loupP.s.emit("voteWolf", vills[0].s.id);
    await sleep(100);
    loupP.s.emit("wolfConfirm");
    await firstVictimP;

    // Déconnecter et reconnecter la Sorcière
    console.log("  → Déconnexion Sorcière...");
    const oldSock = witchP.s;
    oldSock.disconnect();
    all.splice(all.indexOf(oldSock), 1);
    await sleep(400);

    console.log("  → Reconnexion Sorcière...");
    const newSock = await makeClient(witchP.name);
    all.push(newSock);
    witchP.s = newSock;

    const victim = await Promise.race([
      waitFor(newSock, "nightVictim", 4000),
      sleep(4200).then(() => null)
    ]);
    check("S3-sorcière reçoit nightVictim après reconnexion", victim !== null,
      victim === null ? "nightVictim non reçu dans 4s" : `victim=${victim}`);

    newSock.emit("witchDone"); // libère la phase
    await sleep(600);
  } catch (e) {
    ko("S3 crash", e.message);
  } finally {
    await closeAll(all);
  }
}

// ═══════════════════════════════════════════════════════════
// S4 — Chasseur linché au vote de jour → reçoit chasseurMustShoot
// ═══════════════════════════════════════════════════════════
async function s4() {
  console.log("\n▶ S4 — Chasseur linché par vote de jour");
  const all = [];
  try {
    const NAMES = ["s4_Loup","s4_Hunt","s4_V1","s4_V2","s4_V3"];
    const cfg   = { loup:1, chasseur:1, sorciere:0, voyante:0, cupidon:0, corbeau:0,
                    salvateur:0, sisters:0, petiteFille:0, idiot:0, mission:false };
    const { mj, players, roleOf } = await setupGame(all, NAMES, cfg);

    const loupP  = players.find(p => roleOf[p.name] === "Loup");
    const huntP  = players.find(p => roleOf[p.name] === "Chasseur");
    const vills  = players.filter(p => roleOf[p.name] === "Villageois");
    if (!loupP || !huntP) { ko("S4-setup", JSON.stringify(roleOf)); return; }

    let latestDeadPlayers = [];
    players[0].s.on("deadPlayers", dp => { latestDeadPlayers = dp; });

    // Nuit 1 : loup tue un villageois qui n'est PAS le maire (players[0])
    // → évite mayorTransfer. On exclut aussi le Chasseur explicitement.
    const wolfTarget = vills.find(v => v.s.id !== players[0].s.id && v.s.id !== huntP.s.id)
                    || vills.find(v => v.s.id !== huntP.s.id)
                    || vills[0];
    console.log(`  wolfTarget: ${wolfTarget.name} (${roleOf[wolfTarget.name]}) — hunt: ${huntP.name} — mayor: ${players[0].name}`);

    // Poser les listeners AVANT wolfKill pour éviter la race condition
    const dawnP = waitFor(players[0].s, "dawnResult", 12000);
    const dayP  = waitForPhase(players[0].s, "day", 20000);

    loupP.s.emit("voteWolf", wolfTarget.s.id);
    await sleep(100);
    loupP.s.emit("wolfConfirm");
    const dawn = await dawnP;
    console.log(`  dawnResult: morts=[${(dawn.deaths||[]).map(d=>d.name+"/"+d.role).join(", ")||"aucun"}]`);
    await sleep(300);

    // Si le chasseur est mort la nuit (bug unlikely mais possible), il doit tirer
    // avant que la phase jour démarre — sans ça dayP ne se résoudra jamais.
    if (latestDeadPlayers.includes(huntP.s.id)) {
      console.log("  [S4] Chasseur mort la nuit — tir automatique pour débloquer la phase jour.");
      const aliveForShot = players.filter(p => !latestDeadPlayers.includes(p.s.id) && p.s.id !== huntP.s.id);
      if (aliveForShot.length > 0) huntP.s.emit("chasseurAction", aliveForShot[0].s.id);
    }

    await dayP;
    console.log("  phase:day reçue");
    await sleep(300);

    // MJ démarre le vote ; joueurs vivants votent pour le Chasseur ; MJ verrouille
    mj.emit("startVote");
    await sleep(300);
    players.forEach(p => {
      if (!latestDeadPlayers.includes(p.s.id) && p.s.id !== huntP.s.id)
        p.s.emit("voteDay", huntP.s.id);
    });
    await sleep(300);

    // Si le Chasseur est AUSSI le maire, lyncher déclenche d'abord `mayorTransfer`,
    // puis `chasseurMustShoot` seulement après que le successeur est désigné.
    // On écoute `mayorMustTransfer` et on auto-choisit un successeur sans bloquer.
    players[0].s.once("mayorMustTransfer", dyingId => {
      if (dyingId !== huntP.s.id) return;
      const cand = players.find(p => !latestDeadPlayers.includes(p.s.id) && p.s.id !== huntP.s.id);
      if (cand) setTimeout(() => huntP.s.emit("mayorTransferChoice", cand.s.id), 300);
    });

    // lockDayVotes → 800ms → resolveDayVote → 8200ms → killPlayer(chasseur) → chasseurMustShoot
    // (ou mayorTransfer → 300ms → mayorTransferChoice → chasseurMustShoot si chasseur==maire)
    const mustShootP = waitFor(huntP.s, "chasseurMustShoot", 20000);
    mj.emit("lockDayVotes");
    const fired = await mustShootP.then(() => true).catch(() => false);
    check("S4-chasseur reçoit chasseurMustShoot après lynchage", fired);

    // Faire tirer le Chasseur pour libérer la partie
    await sleep(300);
    const aliveIds = players.filter(p => !latestDeadPlayers.includes(p.s.id) && p.s.id !== huntP.s.id);
    if (aliveIds.length > 0) { huntP.s.emit("chasseurAction", aliveIds[0].s.id); await sleep(600); }
  } catch (e) {
    ko("S4 crash", e.message);
  } finally {
    await closeAll(all);
  }
}

// ═══════════════════════════════════════════════════════════
// S5 — Smoke test : partie complète en autoMode (bots uniquement)
// Vérifie que la partie se termine (gameEnd) sans blocage.
// ═══════════════════════════════════════════════════════════
async function s5() {
  console.log("\n▶ S5 — Smoke test autoMode bots (max 240s)");
  const all = [];
  try {
    const mj = await makeMJ(); all.push(mj);
    mj.emit("fullReset");
    await sleep(600);

    // 5 bots : 1 loup + 1 voyante + 3 villageois
    // (1 seul loup → consensus garanti, pas de timeout 120s)
    for (let i = 0; i < 5; i++) mj.emit("addBot");
    await sleep(400);

    const gameEndP = waitFor(mj, "gameEnd", 245000);
    mj.emit("assignRoles", {
      loup: 1, chasseur: 0, sorciere: 0, voyante: 1,
      cupidon: 0, corbeau: 0, salvateur: 0, sisters: 0,
      petiteFille: 1, idiot: 0, mission: false,
      autoMode: true, autoVoteMode: 4, mjPilotedDay: false
    });

    const result = await Promise.race([
      gameEndP.then(() => true),
      sleep(246000).then(() => false)
    ]);
    check("S5-gameEnd reçu dans les temps", result, result ? "" : "timeout 240s sans gameEnd");
  } catch (e) {
    ko("S5 crash", e.message);
  } finally {
    await closeAll(all);
  }
}

// ═══════════════════════════════════════════════════════════
// Helper : nuit où le loup unique tue `victime`, puis attend le jour.
// ═══════════════════════════════════════════════════════════
async function nuitLoupUnique(players, loupP, victime) {
  const dayP = waitForPhase(players[0].s, "day", 20000);
  loupP.s.emit("voteWolf", victime.s.id);
  await sleep(100);
  loupP.s.emit("wolfConfirm");
  await dayP;
  await sleep(300);
}

// ═══════════════════════════════════════════════════════════
// S6 — Ange désigné au premier vote du village : il gagne seul.
// ═══════════════════════════════════════════════════════════
async function s6() {
  console.log("\n▶ S6 — Ange désigné au premier vote");
  const all = [];
  try {
    const NAMES = ["s6_A","s6_B","s6_C","s6_D","s6_E"];
    const cfg   = { loup:1, ange:1, chasseur:0, sorciere:0, voyante:0, cupidon:0, corbeau:0,
                    salvateur:0, sisters:0, petiteFille:0, idiot:0, mission:false };
    const { mj, players, roleOf } = await setupGame(all, NAMES, cfg);
    const loupP = players.find(p => roleOf[p.name] === "Loup");
    const angeP = players.find(p => roleOf[p.name] === "Ange");
    if (!loupP || !angeP) { ko("S6-setup", JSON.stringify(roleOf)); return; }

    // Nuit 1 : le loup tue un villageois qui n'est pas le maire (évite mayorTransfer)
    const victime = players.find(p => roleOf[p.name] === "Villageois" && p !== players[0]);
    await nuitLoupUnique(players, loupP, victime);

    // Jour 1 : tous votent l'Ange (lui vote le loup)
    mj.emit("startVote");
    await sleep(300);
    players.filter(p => p !== victime).forEach(p => p.s.emit("voteDay", p === angeP ? loupP.s.id : angeP.s.id));
    await sleep(300);

    const reveleP = waitFor(mj, "angeRevele", 12000);
    const finP    = waitFor(mj, "gameEnd", 16000);
    const resumeP = waitFor(mj, "gameSummary", 16000);
    mj.emit("lockDayVotes");
    const revele = await reveleP.catch(() => null);
    check("S6-l'Ange est révélé", revele && revele.id === angeP.s.id, JSON.stringify(revele));
    const fin = await finP.catch(() => null);
    check("S6-la partie se termine sur la victoire de l'Ange", typeof fin === "string" && fin.includes("Ange"), String(fin));

    // Médailles (une au plus par joueur, « Ange gardien » pour lui) et classement de la soirée
    const resume = await resumeP.catch(() => null);
    const medailles = (resume && resume.badges) || {};
    check("S6-une médaille au plus par joueur", Object.values(medailles).every(l => l.length <= 1), JSON.stringify(medailles));
    check("S6-l'Ange reçoit « Ange gardien »", (medailles[angeP.name] || [])[0]?.label === "Ange gardien", JSON.stringify(medailles[angeP.name]));
    const cl = (resume && resume.classement) || [];
    const pts = n => (cl.find(c => c.nom === n) || {}).points;
    check("S6-classement : 1 point pour l'Ange seul", pts(angeP.name) === 1 && NAMES.filter(n => n !== angeP.name).every(n => pts(n) === 0), JSON.stringify(cl));
    const soireeP = waitFor(mj, "soireeMJ", 4000);
    mj.emit("nouvelleSoiree");
    const soiree = await soireeP.catch(() => null);
    check("S6-« Nouvelle soirée » remet le classement à zéro", soiree && soiree.parties === 0 && soiree.classement.length === 0, JSON.stringify(soiree));
  } catch (e) {
    ko("S6 crash", e.message);
  } finally {
    await closeAll(all);
  }
}

// ═══════════════════════════════════════════════════════════
// S7 — Premier vote passé par le MJ : l'Ange perd sa chance et meurt
// comme un villageois s'il est désigné au vote suivant.
// ═══════════════════════════════════════════════════════════
async function s7() {
  console.log("\n▶ S7 — Ange désigné après un premier vote passé");
  const all = [];
  try {
    const NAMES = ["s7_A","s7_B","s7_C","s7_D","s7_E","s7_F"];
    const cfg   = { loup:1, ange:1, chasseur:0, sorciere:0, voyante:0, cupidon:0, corbeau:0,
                    salvateur:0, sisters:0, petiteFille:0, idiot:0, mission:false };
    const { mj, players, roleOf } = await setupGame(all, NAMES, cfg);
    const loupP = players.find(p => roleOf[p.name] === "Loup");
    const angeP = players.find(p => roleOf[p.name] === "Ange");
    if (!loupP || !angeP) { ko("S7-setup", JSON.stringify(roleOf)); return; }
    const villageois = players.filter(p => roleOf[p.name] === "Villageois" && p !== players[0]);

    // Nuit 1, puis le MJ passe le vote du jour 1
    await nuitLoupUnique(players, loupP, villageois[0]);
    const nuit2P = waitForPhase(players[0].s, "wolves", 20000);
    mj.emit("skipDayVote");
    await nuit2P;
    await nuitLoupUnique(players, loupP, villageois[1]);

    // Jour 2 : tous votent l'Ange
    let angeRevele = false;
    mj.on("angeRevele", () => { angeRevele = true; });
    mj.emit("startVote");
    await sleep(300);
    players.filter(p => p !== villageois[0] && p !== villageois[1])
      .forEach(p => p.s.emit("voteDay", p === angeP ? loupP.s.id : angeP.s.id));
    await sleep(300);

    const resultP = waitFor(mj, "dayVoteResult", 12000);
    mj.emit("lockDayVotes");
    const res = await resultP.catch(() => null);
    check("S7-l'Ange est éliminé comme un villageois", res && res.id === angeP.s.id && res.role === "Ange", JSON.stringify(res));
    check("S7-pas de victoire de l'Ange", !angeRevele);
  } catch (e) {
    ko("S7 crash", e.message);
  } finally {
    await closeAll(all);
  }
}

// ═══════════════════════════════════════════════════════════
// S8 — Petite Fille : chaque nuit, 3 joueurs désignés → « au moins un loup » ou « aucun ».
// Nuit 1 : choix invalide refusé, puis 3 joueurs dont le loup ; la nuit attend son « OK ».
// Nuit 2 : 3 villageois → aucun loup.
// ═══════════════════════════════════════════════════════════
async function s8() {
  console.log("\n▶ S8 — Petite Fille enquêtrice (2 nuits)");
  const all = [];
  try {
    const NAMES = ["s8_A","s8_B","s8_C","s8_D","s8_E","s8_F","s8_G"];
    const cfg   = { loup:1, petiteFille:1, chasseur:0, sorciere:0, voyante:0, cupidon:0, corbeau:0,
                    salvateur:0, sisters:0, idiot:0, mission:false };
    const { mj, players, roleOf } = await setupGame(all, NAMES, cfg);
    const loupP = players.find(p => roleOf[p.name] === "Loup");
    const pfP   = players.find(p => roleOf[p.name] === "PetiteFille");
    if (!loupP || !pfP) { ko("S8-setup", JSON.stringify(roleOf)); return; }
    const villageois = players.filter(p => roleOf[p.name] === "Villageois" && p !== players[0]);
    let mjInfo = null;
    mj.on("petiteFilleMJInfo", d => { mjInfo = d; });

    // Nuit 1 : le loup tue un villageois, puis c'est au tour de la Petite Fille
    const pfTourP = waitForPhase(pfP.s, "petiteFille", 20000);
    loupP.s.emit("voteWolf", villageois[0].s.id);
    await sleep(100);
    loupP.s.emit("wolfConfirm");
    await pfTourP;
    check("S8-la Petite Fille se réveille après les Loups (pas de Voyante)", true);

    // Choix invalide : elle-même dans la liste
    const erreurP = waitFor(pfP.s, "petiteFilleError", 4000);
    pfP.s.emit("petiteFilleChoice", [pfP.s.id, loupP.s.id, villageois[1].s.id]);
    const erreur = await erreurP.catch(() => null);
    check("S8-se désigner elle-même est refusé", typeof erreur === "string", String(erreur));

    // Choix valide avec le loup
    const resP = waitFor(pfP.s, "petiteFilleResult", 4000);
    pfP.s.emit("petiteFilleChoice", [loupP.s.id, villageois[1].s.id, villageois[2].s.id]);
    const res = await resP.catch(() => null);
    check("S8-nuit 1 : « au moins un loup »", res && res.auMoinsUnLoup === true && res.names.length === 3, JSON.stringify(res));
    await sleep(300);
    check("S8-le MJ voit la réponse et le nom du loup", mjInfo && mjInfo.auMoinsUnLoup && mjInfo.loups.includes(loupP.name), JSON.stringify(mjInfo));

    // La nuit attend son « OK »
    let jour = false;
    const onPhase = p => { if (p === "day") jour = true; };
    players[0].s.on("phase", onPhase);
    await sleep(1500);
    check("S8-la nuit attend le « OK » de la Petite Fille", !jour);
    const day1P = waitForPhase(players[0].s, "day", 20000);
    pfP.s.emit("petiteFilleDone");
    await day1P;
    players[0].s.off("phase", onPhase);
    await sleep(300);

    // Jour 1 passé, nuit 2 : 3 villageois → aucun loup
    const nuit2P = waitForPhase(players[0].s, "wolves", 20000);
    mj.emit("skipDayVote");
    await nuit2P;
    const pfTour2P = waitForPhase(pfP.s, "petiteFille", 20000);
    loupP.s.emit("voteWolf", villageois[1].s.id);
    await sleep(100);
    loupP.s.emit("wolfConfirm");
    await pfTour2P;
    const trois = players.filter(p => roleOf[p.name] === "Villageois" && p !== villageois[0] && p !== villageois[1]).slice(0, 3);
    const res2P = waitFor(pfP.s, "petiteFilleResult", 4000);
    pfP.s.emit("petiteFilleChoice", trois.map(p => p.s.id));
    const res2 = await res2P.catch(() => null);
    check("S8-nuit 2 : « aucun loup »", res2 && res2.auMoinsUnLoup === false, JSON.stringify(res2) + " choisis=" + trois.map(p => p.name));
    const day2P = waitForPhase(players[0].s, "day", 20000);
    pfP.s.emit("petiteFilleDone");
    const day2 = await day2P.then(() => true).catch(() => false);
    check("S8-après son « OK », le jour 2 se lève", day2);
  } catch (e) {
    ko("S8 crash", e.message);
  } finally {
    await closeAll(all);
  }
}

// ═══════════════════════════════════════════════════════════
// S9 — Boutons du MJ pendant le suspense d'un vote clos (double appui sur
// « Terminer », « Lancer le vote », « Passer vote ») : un seul dépouillement.
// ═══════════════════════════════════════════════════════════
async function s9() {
  console.log("\n▶ S9 — Boutons du MJ pendant le suspense du vote");
  const all = [];
  try {
    const NAMES = ["s9_A","s9_B","s9_C","s9_D","s9_E","s9_F","s9_G"];
    const cfg   = { loup:1, chasseur:0, sorciere:0, voyante:0, cupidon:0, corbeau:0,
                    salvateur:0, sisters:0, petiteFille:0, idiot:0, ange:0, mission:false };
    const { mj, players, roleOf } = await setupGame(all, NAMES, cfg);
    const loupP = players.find(p => roleOf[p.name] === "Loup");
    const villageois = players.filter(p => roleOf[p.name] === "Villageois" && p !== players[0]);
    await nuitLoupUnique(players, loupP, villageois[0]);

    let resultats = 0, lancements = 0, nuits = 0;
    mj.on("dayVoteResult", () => resultats++);
    mj.on("voteStartedMJ", () => lancements++);
    mj.on("phase", p => { if (p === "wolves") nuits++; });
    mj.emit("startVote", 1);
    await sleep(400);
    players.filter(p => p !== villageois[0] && p !== villageois[1]).forEach(p => p.s.emit("voteDay", villageois[1].s.id));
    await sleep(400);
    mj.emit("lockDayVotes");
    await sleep(2000); mj.emit("lockDayVotes");
    await sleep(1000); mj.emit("startVote", 1);
    await sleep(1000); mj.emit("skipDayVote");
    await sleep(9000);
    check("S9-le vote n'est dépouillé qu'une fois", resultats === 1, resultats + " résultats");
    check("S9-aucun vote relancé pendant le suspense", lancements === 1, lancements + " lancements");
    check("S9-une seule nuit démarre ensuite", nuits <= 1, nuits + " nuits");
  } catch (e) {
    ko("S9 crash", e.message);
  } finally {
    await closeAll(all);
  }
}

// ═══════════════════════════════════════════════════════════
// S10 — Partie gagnée à l'aube (nuit résolue d'urgence par le MJ) : pendant les 7 s
// avant l'écran de fin, des clics tardifs ne relancent pas une deuxième aube.
// ═══════════════════════════════════════════════════════════
async function s10() {
  console.log("\n▶ S10 — Clics tardifs pendant une fin de partie à l'aube");
  const all = [];
  try {
    const NAMES = ["s10_A","s10_B","s10_C","s10_D"];
    const cfg   = { loup:1, sorciere:1, chasseur:0, voyante:0, cupidon:0, corbeau:0,
                    salvateur:0, sisters:0, petiteFille:0, idiot:0, ange:0, mission:false };
    const { mj, players, roleOf } = await setupGame(all, NAMES, cfg);
    const loupP = players.find(p => roleOf[p.name] === "Loup");
    const sorcP = players.find(p => roleOf[p.name] === "Sorcière");
    const vill  = players.filter(p => roleOf[p.name] === "Villageois");
    const v1 = vill.find(p => p !== players[0]) || vill[0];   // pas le maire : évite la transmission d'écharpe
    const v2 = vill.find(p => p !== v1);
    if (!loupP || !sorcP || !v1 || !v2) { ko("S10-setup", JSON.stringify(roleOf)); return; }
    let aubes = 0, fins = [];
    mj.on("dawnResult", () => aubes++);
    mj.on("gameEnd", m => fins.push(m));

    const sorcTourP = waitForPhase(sorcP.s, "witch", 20000);
    loupP.s.emit("voteWolf", v1.s.id);
    await sleep(100);
    loupP.s.emit("wolfConfirm");
    await sorcTourP;
    sorcP.s.emit("witchKill", v2.s.id);   // loup + sorcière restants : victoire des loups à l'aube
    await sleep(300);
    mj.emit("resolveNight");               // résolution d'urgence, sans pause
    await sleep(1500);
    sorcP.s.emit("witchDone");             // clics tardifs
    await sleep(800);
    mj.emit("lockWolfVotes");
    await sleep(8000);
    check("S10-une seule aube", aubes === 1, aubes + " aubes");
    check("S10-une seule fin de partie, gagnée par les Loups", fins.length === 1 && fins[0].includes("Loups"), JSON.stringify(fins));
  } catch (e) {
    ko("S10 crash", e.message);
  } finally {
    await closeAll(all);
  }
}

// ═══════════════════════════════════════════════════════════
// S11 — Pastilles de connexion de l'écran MJ : 🟢 ok, 🟠 écran éteint, 🔴 perdu ;
// alerte au bout de 5 s de coupure, alerte au retour, rien pour un simple rechargement.
// ═══════════════════════════════════════════════════════════
async function s11() {
  console.log("\n▶ S11 — Pastilles de connexion chez le MJ");
  const all = [];
  try {
    const NAMES = ["s11_A","s11_B","s11_C","s11_D","s11_E"];
    const cfg   = { loup:1, chasseur:0, sorciere:0, voyante:0, cupidon:0, corbeau:0,
                    salvateur:0, sisters:0, petiteFille:0, idiot:0, ange:0, mission:false };
    const { mj, players } = await setupGame(all, NAMES, cfg);
    let etats = {}; const perdus = [], revenus = [];
    mj.on("connexionsMJ", e => { etats = e; });
    mj.on("joueurPerdu",  d => perdus.push(d.name));
    mj.on("joueurRevenu", d => revenus.push(d.name));
    const [a, b] = players;

    // Écran éteint puis rallumé
    a.s.emit("visibilite", false); await sleep(300);
    check("S11-écran éteint → 🟠", etats[a.s.id] === "veille", JSON.stringify(etats));
    a.s.emit("visibilite", true); await sleep(300);
    check("S11-écran rallumé → 🟢", etats[a.s.id] === "ok", JSON.stringify(etats));

    // Coupure qui dure : pastille rouge tout de suite, alerte au bout de 5 s
    const ancienA = a.s.id;
    a.s.disconnect(); await sleep(600);
    check("S11-coupure → 🔴 immédiatement", etats[ancienA] === "perdu", JSON.stringify(etats));
    check("S11-pas d'alerte avant 5 s", perdus.length === 0, JSON.stringify(perdus));
    await sleep(5200);
    check("S11-alerte « a perdu la connexion » au bout de 5 s", perdus.includes(a.name), JSON.stringify(perdus));

    // Retour du joueur avec son prénom
    const a2 = await makeClient(a.name); all.push(a2);
    await sleep(800);
    check("S11-retour → 🟢 sous son nouvel identifiant", etats[a2.id] === "ok" && !(ancienA in etats), JSON.stringify(etats));
    check("S11-alerte « est de retour »", revenus.includes(a.name), JSON.stringify(revenus));

    // Simple rechargement de page (retour en moins d'une seconde) : aucune alerte
    b.s.disconnect(); await sleep(300);
    const b2 = await makeClient(b.name); all.push(b2);
    await sleep(6000);
    check("S11-rechargement rapide : pas d'alerte de coupure", !perdus.includes(b.name), JSON.stringify(perdus));
    check("S11-rechargement rapide : 🟢", etats[b2.id] === "ok", JSON.stringify(etats));
  } catch (e) {
    ko("S11 crash", e.message);
  } finally {
    await closeAll(all);
  }
}

// ═══════════════════════════════════════════════════════════
// S12 — Une partie se termine, puis le MJ appuie sur « 🚀 Lancer la partie » (et non
// « Relancer ») : téléphones remis à zéro, personne ne reste mort, pas de maire hérité.
// Puis, au salon, le MJ retire un joueur : son téléphone est prévenu.
// ═══════════════════════════════════════════════════════════
async function s12() {
  console.log("\n▶ S12 — Nouvelle partie après une partie terminée ; retrait d'un joueur");
  const all = [];
  try {
    const NAMES = ["s12_A","s12_B","s12_C","s12_D"];
    const cfg   = { loup:1, chasseur:0, sorciere:0, voyante:0, cupidon:0, corbeau:0,
                    salvateur:0, sisters:0, petiteFille:0, idiot:0, ange:0, mission:false };
    const { mj, players, roleOf } = await setupGame(all, NAMES, cfg);
    const loupP = players.find(p => roleOf[p.name] === "Loup");
    const vill  = players.filter(p => roleOf[p.name] === "Villageois" && p !== players[0]);
    // Nuit : le loup tue un villageois ; jour : loup + maire éliminent le dernier → loups gagnants
    await nuitLoupUnique(players, loupP, vill[0]);
    mj.emit("startVote", 1); await sleep(400);
    players.filter(p => p !== vill[0] && p !== vill[1]).forEach(p => p.s.emit("voteDay", vill[1].s.id));
    await sleep(400);
    const finP = waitFor(mj, "gameEnd", 16000);
    mj.emit("lockDayVotes");
    const fin = await finP.catch(() => null);
    check("S12-la 1re partie se termine", typeof fin === "string", String(fin));

    let resets = 0;
    players.forEach(p => p.s.on("gameReset", () => resets++));
    mj.emit("assignRoles", { ...cfg, autoMode: false, mjPilotedDay: true });   // « Lancer la partie »
    await sleep(1500);
    check("S12-« Lancer la partie » remet tous les téléphones à zéro", resets === players.length, resets + " remises à zéro");
    const etat = await new Promise(res => { players[1].s.once("reconnected", res); players[1].s.emit("register", players[1].name); });
    check("S12-personne ne reste mort de la partie précédente", (etat.deadPlayers || []).length === 0, JSON.stringify(etat.deadPlayers));
    check("S12-pas de maire hérité", !etat.mayor, String(etat.mayor));

    // Retour au salon, puis le MJ retire un joueur
    mj.emit("reset"); await sleep(800);
    const retireP = waitFor(players[3].s, "retireParMJ", 4000);
    const listeP  = waitFor(mj, "players", 4000);
    mj.emit("retirerJoueur", players[3].s.id);
    const retire = await retireP.then(() => true).catch(() => false);
    const liste  = await listeP.catch(() => []);
    check("S12-le joueur retiré est prévenu", retire);
    check("S12-il n'est plus dans la liste", !liste.some(p => p.name === players[3].name), JSON.stringify(liste.map(p => p.name)));
  } catch (e) {
    ko("S12 crash", e.message);
  } finally {
    await closeAll(all);
  }
}

// ═══════════════════════════════════════════════════════════
// Démarrage serveur + exécution des scénarios
// ═══════════════════════════════════════════════════════════
async function main() {
  console.log("═".repeat(62));
  console.log("🐺 LOUP-GAROU — Tests intégration — port " + TEST_PORT);
  console.log("═".repeat(62));

  const server = spawn("node", ["server.js"], {
    cwd:   path.join(__dirname, ".."),
    env:   { ...process.env, PORT: String(TEST_PORT), LIGHTS_ENABLED: "false", SNAPSHOT_DIR: TEST_SNAP_DIR },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let serverReady = false;
  server.stdout.on("data", d => { if (d.toString().includes("démarré")) serverReady = true; });
  server.stderr.on("data", d => process.stderr.write("[srv] " + d.toString()));

  await new Promise((resolve, reject) => {
    const iv = setInterval(() => { if (serverReady) { clearInterval(iv); resolve(); } }, 100);
    setTimeout(() => { clearInterval(iv); reject(new Error("Serveur non démarré dans 10s")); }, 10000);
  });
  console.log("  Serveur test prêt : " + BASE_URL + "\n");

  for (const scenario of [s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12]) {
    try { await scenario(); }
    catch (e) { ko("crash non rattrapé", e.message); }
    await sleep(800);
  }

  server.kill();
  await sleep(300);
  try { fs.rmSync(TEST_SNAP_DIR, { recursive: true, force: true }); } catch (_) {}

  console.log("\n" + "═".repeat(62));
  console.log("RAPPORT FINAL");
  console.log(`  ✅ Passé  : ${pass}`);
  console.log(`  ❌ Échoué : ${fail}`);
  if (errors.length) {
    console.log("\nDétail des échecs :");
    errors.forEach(e => console.log("  •", e));
  }
  console.log("═".repeat(62));
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { console.error("Erreur fatale :", err.message); process.exit(2); });
