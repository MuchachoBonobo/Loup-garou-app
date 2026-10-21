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
      petiteFille: 0, idiot: 0, mission: false,
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

  for (const scenario of [s1, s2, s3, s4, s5]) {
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
