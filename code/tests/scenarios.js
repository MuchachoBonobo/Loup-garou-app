/**
 * tests/scenarios.js — Tests d'intégration du serveur
 *
 * Lance un serveur sur le port 3099, connecte de vrais sockets socket.io-client,
 * et vérifie le comportement de bout en bout. Chaque scénario (S1 à S16) est décrit
 * au-dessus de sa fonction.
 *
 * Usage : npm test   (ou : node tests/scenarios.js)
 */

"use strict";
const { sleep, demarrerServeur, arreterServeur, connecter, connecterMJ, attendre, attendrePhase, arrive, piloterMJ, compteur } = require("./outils");
const { buildBadges } = require("../badges");

const TEST_PORT = 3099;
const { check, bilan, arret } = compteur();
const ko = (nom, detail) => check(nom, false, detail);

// La tablette du MJ, sans reprise après plantage ; le MJ automatique lance la nuit, passe les
// étapes et ouvre les actions (Chasseur, maire mourant) une demi-seconde après qu'on les lui propose
async function nouveauMJ() {
  const { mj } = await connecterMJ(TEST_PORT);
  piloterMJ(mj, { nuit: true });
  return mj;
}

// Encadrement d'un scénario : son titre, ses sockets (`all`) fermés à la fin ; une exception
// compte comme un échec « Sx crash »
async function scenario(code, titre, corps) {
  console.log(`\n▶ ${code} — ${titre}`);
  const all = [];
  try { await corps(all); }
  catch (e) { ko(code + " crash", e.message); console.error("  Pile :", e.stack); }
  finally {
    for (const s of all) try { if (s.connected) s.disconnect(); } catch { /* déjà fermé */ }
    await sleep(500);
  }
}

// Mise en place commune : remise à zéro, inscription des joueurs, rôles (un rôle absent de la
// composition vaut 0, comme pour le serveur), players[0] élu maire (ou celui que désigne
// `choisirMaire(players, roleOf)`), puis droit au tour des Loups (sans attendre le crépuscule ni
// les rôles de la première nuit). `avecRole("Loup")` : les joueurs qui ont ce rôle.
async function preparerPartie(all, names, composition, choisirMaire = players => players[0]) {
  const mj = await nouveauMJ(); all.push(mj);
  mj.emit("fullReset");   // vide la partie précédente
  await sleep(600);

  const players = [];
  for (const n of names) {
    const s = await connecter(TEST_PORT, n);
    all.push(s);
    players.push({ name: n, s });
  }
  await sleep(300);

  // yourRole et la phase écoutés AVANT le lancement
  const roleOf = {}, infos = {};
  const rolePs = players.map(p => new Promise(res =>
    p.s.once("yourRole", d => { roleOf[p.name] = d.role; infos[p.name] = d; res(); })
  ));
  const mayorVoteP = attendrePhase(players[0].s, "mayorVote");
  mj.emit("assignRoles", { ...composition, autoMode: false, mjPilotedDay: true });
  await Promise.all([...rolePs, mayorVoteP]);
  console.log("  Rôles:", JSON.stringify(roleOf));

  // Tous votent pour le futur maire ; le MJ valide aussitôt
  const maire = choisirMaire(players, roleOf);
  players.forEach(p => { if (p !== maire) p.s.emit("voteMayor", maire.s.id); });
  await sleep(100);
  const newMayorP = attendre(players[0].s, "newMayor", 6000);
  mj.emit("lockMayorVote");
  await newMayorP;

  const wolvesP = attendrePhase(players[0].s, "wolves");
  mj.emit("setPhase", "wolves");
  await wolvesP;

  const avecRole = r => players.filter(p => roleOf[p.name] === r);
  return { mj, players, roleOf, infos, avecRole };
}

// Le loup désigne sa proie, le MJ valide l'attaque
async function attaqueDuLoup(mj, loupP, cible) {
  loupP.s.emit("voteWolf", cible.s.id);
  await sleep(100);
  mj.emit("lockWolfVotes");
}

// Une nuit où le loup unique tue `victime`, jusqu'au jour
async function nuitLoupUnique(mj, players, loupP, victime) {
  const dayP = attendrePhase(players[0].s, "day", 20000);
  await attaqueDuLoup(mj, loupP, victime);
  await dayP;
  await sleep(300);
}

// Le joueur recharge sa page : déconnexion, puis retour avec son prénom (nouveau socket)
async function reconnecter(all, joueur) {
  console.log(`  → ${joueur.name} se déconnecte puis revient`);
  joueur.s.disconnect();
  all.splice(all.indexOf(joueur.s), 1);
  await sleep(400);
  joueur.s = await connecter(TEST_PORT, joueur.name);
  all.push(joueur.s);
  return joueur.s;
}

// S1 — Chasseur tué la nuit + Sorcière empoisonne quelqu'un
// Régression BUG 1 : les deux doivent être dans deadPlayers après l'aube.
const s1 = () => scenario("S1", "Chasseur tué nuit + poison Sorcière", async all => {
  const { mj, players, roleOf, avecRole } = await preparerPartie(all, ["s1_Loup","s1_Hunt","s1_Witch","s1_V1","s1_V2"], { loup: 1, chasseur: 1, sorciere: 1 });
  const [loupP] = avecRole("Loup"), [huntP] = avecRole("Chasseur"), [witchP] = avecRole("Sorcière"), vills = avecRole("Villageois");
  if (!loupP || !huntP || !witchP || vills.length < 1) { ko("S1-setup", "rôle introuvable: " + JSON.stringify(roleOf)); return; }

  // Surveiller deadPlayers en continu (les messages arrivent AVANT dawnResult)
  let latestDeadPlayers = [];
  players[0].s.on("deadPlayers", dp => { latestDeadPlayers = dp; });

  // La Sorcière reçoit nightVictim une fois l'attaque validée
  const nightVictimP = attendre(witchP.s, "nightVictim", 10000);
  await attaqueDuLoup(mj, loupP, huntP);
  const victim = await nightVictimP;
  check("S1-nightVictim=chasseur", victim === huntP.s.id, `victim=${victim}`);

  // Elle empoisonne un villageois puis passe
  witchP.s.emit("witchKill", vills[0].s.id);
  await sleep(100);
  witchP.s.emit("witchDone");

  const dawn = await attendre(players[0].s, "dawnResult", 10000);
  console.log("  dawnResult:", (dawn.deaths || []).map(d => `${d.name}/${d.role}`).join(", ") || "(aucun)");

  await sleep(300); // laisser les éventuels derniers deadPlayers arriver
  const idToName = {}; players.forEach(p => { idToName[p.s.id] = p.name; });
  console.log("  deadPlayers:", latestDeadPlayers.map(id => idToName[id] || id).join(", "));
  check("S1-chasseur dans deadPlayers",          latestDeadPlayers.includes(huntP.s.id),  "deadPlayers=" + latestDeadPlayers.join(","));
  check("S1-villageois empoisonné dans deadPlayers", latestDeadPlayers.includes(vills[0].s.id), "deadPlayers=" + latestDeadPlayers.join(","));

  // Le Chasseur tire pour libérer la phase
  const alive = players.filter(p => !latestDeadPlayers.includes(p.s.id) && p.s.id !== huntP.s.id);
  if (alive.length > 0) { huntP.s.emit("chasseurAction", alive[0].s.id); await sleep(600); }
});

// S2 — Reconnexion du Corbeau pendant son tour → il reçoit corbeauTurn
// Régression BUG 2 (Corbeau).
const s2 = () => scenario("S2", "Reconnexion Corbeau en phase corbeau", async all => {
  const { mj, roleOf, avecRole } = await preparerPartie(all, ["s2_Loup","s2_Crow","s2_V1","s2_V2","s2_V3"], { loup: 1, corbeau: 1 });
  const [loupP] = avecRole("Loup"), [crowP] = avecRole("Corbeau"), vills = avecRole("Villageois");
  if (!loupP || !crowP) { ko("S2-setup", JSON.stringify(roleOf)); return; }

  // Loups → tour du Corbeau
  const tourP = attendrePhase(crowP.s, "corbeau", 10000);
  await attaqueDuLoup(mj, loupP, vills[0]);
  await tourP;

  const s = await reconnecter(all, crowP);
  check("S2-corbeau reçoit corbeauTurn après reconnexion", await arrive(attendre(s, "corbeauTurn", 4000)));
  s.emit("corbeauAction", "skip"); // libère la phase
  await sleep(600);
});

// S3 — Reconnexion de la Sorcière pendant son tour → elle reçoit nightVictim
// Régression BUG 2 (Sorcière).
const s3 = () => scenario("S3", "Reconnexion Sorcière en phase witch", async all => {
  const { mj, roleOf, avecRole } = await preparerPartie(all, ["s3_Loup","s3_Witch","s3_V1","s3_V2","s3_V3"], { loup: 1, sorciere: 1 });
  const [loupP] = avecRole("Loup"), [witchP] = avecRole("Sorcière"), vills = avecRole("Villageois");
  if (!loupP || !witchP) { ko("S3-setup", JSON.stringify(roleOf)); return; }

  // Premier nightVictim reçu AVANT la déconnexion
  const firstVictimP = attendre(witchP.s, "nightVictim", 10000);
  await attaqueDuLoup(mj, loupP, vills[0]);
  await firstVictimP;

  const s = await reconnecter(all, witchP);
  const victim = await attendre(s, "nightVictim", 4000).catch(() => null);
  check("S3-sorcière reçoit nightVictim après reconnexion", victim !== null,
    victim === null ? "nightVictim non reçu dans 4s" : `victim=${victim}`);
  s.emit("witchDone"); // libère la phase
  await sleep(600);
});

// S4 — Chasseur lynché au vote du jour → il reçoit chasseurMustShoot
const s4 = () => scenario("S4", "Chasseur lynché par vote de jour", async all => {
  const { mj, players, roleOf, avecRole } = await preparerPartie(all, ["s4_Loup","s4_Hunt","s4_V1","s4_V2","s4_V3"], { loup: 1, chasseur: 1 });
  const [loupP] = avecRole("Loup"), [huntP] = avecRole("Chasseur"), vills = avecRole("Villageois");
  if (!loupP || !huntP) { ko("S4-setup", JSON.stringify(roleOf)); return; }

  let latestDeadPlayers = [];
  players[0].s.on("deadPlayers", dp => { latestDeadPlayers = dp; });

  // Nuit 1 : le loup tue un villageois qui n'est pas le maire (players[0]) → pas de transmission d'écharpe
  const wolfTarget = vills.find(v => v !== players[0]) || vills[0];
  console.log(`  wolfTarget: ${wolfTarget.name} (${roleOf[wolfTarget.name]}) — hunt: ${huntP.name} — mayor: ${players[0].name}`);
  const dawnP = attendre(players[0].s, "dawnResult", 12000);
  const dayP  = attendrePhase(players[0].s, "day", 20000);
  await attaqueDuLoup(mj, loupP, wolfTarget);
  const dawn = await dawnP;
  console.log(`  dawnResult: morts=[${(dawn.deaths||[]).map(d=>d.name+"/"+d.role).join(", ")||"aucun"}]`);
  await dayP;
  console.log("  phase:day reçue");
  await sleep(300);

  // Le MJ lance le vote ; les vivants votent pour le Chasseur ; le MJ clôt
  mj.emit("startVote");
  await sleep(300);
  players.forEach(p => {
    if (!latestDeadPlayers.includes(p.s.id) && p.s.id !== huntP.s.id) p.s.emit("voteDay", huntP.s.id);
  });
  await sleep(300);

  // Si le Chasseur est AUSSI le maire, son élimination ouvre d'abord la transmission d'écharpe,
  // puis chasseurMustShoot une fois le successeur désigné : on le choisit sans bloquer.
  players[0].s.once("mayorMustTransfer", dyingId => {
    if (dyingId !== huntP.s.id) return;
    const cand = players.find(p => !latestDeadPlayers.includes(p.s.id) && p.s.id !== huntP.s.id);
    if (cand) setTimeout(() => huntP.s.emit("mayorTransferChoice", cand.s.id), 300);
  });

  // lockDayVotes → 800ms → resolveDayVote → 8200ms → killPlayer(chasseur) → chasseurMustShoot
  // (ou mayorTransfer → 300ms → mayorTransferChoice → chasseurMustShoot si chasseur==maire)
  const mustShootP = attendre(huntP.s, "chasseurMustShoot", 20000);
  mj.emit("lockDayVotes");
  check("S4-chasseur reçoit chasseurMustShoot après lynchage", await arrive(mustShootP));

  // Le Chasseur tire pour libérer la partie
  await sleep(300);
  const aliveIds = players.filter(p => !latestDeadPlayers.includes(p.s.id) && p.s.id !== huntP.s.id);
  if (aliveIds.length > 0) { huntP.s.emit("chasseurAction", aliveIds[0].s.id); await sleep(600); }
});

// S5 — Partie complète en mode autonome, robots seuls : elle se termine (gameEnd) sans blocage
const s5 = () => scenario("S5", "Partie complète de robots en mode autonome (max 240s)", async all => {
  const mj = await nouveauMJ(); all.push(mj);
  mj.emit("fullReset");
  await sleep(600);

  // 5 robots : 1 loup (consensus garanti, pas d'attente de 120 s), 1 Voyante, 1 Petite Fille, 2 villageois
  for (let i = 0; i < 5; i++) mj.emit("addBot");
  await sleep(400);

  const finP = attendre(mj, "gameEnd", 245000);
  mj.emit("assignRoles", { loup: 1, voyante: 1, petiteFille: 1, autoMode: true, autoVoteMode: 4, mjPilotedDay: false });
  const fin = await arrive(finP);
  check("S5-gameEnd reçu dans les temps", fin, fin ? "" : "pas de fin de partie en 245 s");
});

// S6 — Ange désigné au premier vote du village : il gagne seul.
const s6 = () => scenario("S6", "Ange désigné au premier vote", async all => {
  const NAMES = ["s6_A","s6_B","s6_C","s6_D","s6_E"];
  const { mj, players, roleOf, avecRole } = await preparerPartie(all, NAMES, { loup: 1, ange: 1 });
  const [loupP] = avecRole("Loup"), [angeP] = avecRole("Ange");
  if (!loupP || !angeP) { ko("S6-setup", JSON.stringify(roleOf)); return; }

  // Nuit 1 : le loup tue un villageois qui n'est pas le maire (pas de transmission d'écharpe)
  const victime = avecRole("Villageois").find(p => p !== players[0]);
  await nuitLoupUnique(mj, players, loupP, victime);

  // Jour 1 : tous votent l'Ange (lui vote le loup)
  mj.emit("startVote");
  await sleep(300);
  players.filter(p => p !== victime).forEach(p => p.s.emit("voteDay", p === angeP ? loupP.s.id : angeP.s.id));
  await sleep(300);

  const reveleP = attendre(mj, "angeRevele", 12000);
  const finP    = attendre(mj, "gameEnd", 16000);
  const resumeP = attendre(mj, "gameSummary", 16000);
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
  const soireeP = attendre(mj, "soireeMJ", 4000);
  mj.emit("nouvelleSoiree");
  const soiree = await soireeP.catch(() => null);
  check("S6-« Nouvelle soirée » remet le classement à zéro", soiree && soiree.parties === 0 && soiree.classement.length === 0, JSON.stringify(soiree));
});

// S7 — Premier vote passé par le MJ : l'Ange perd sa chance et meurt
// comme un villageois s'il est désigné au vote suivant.
const s7 = () => scenario("S7", "Ange désigné après un premier vote passé", async all => {
  const { mj, players, roleOf, avecRole } = await preparerPartie(all, ["s7_A","s7_B","s7_C","s7_D","s7_E","s7_F"], { loup: 1, ange: 1 });
  const [loupP] = avecRole("Loup"), [angeP] = avecRole("Ange");
  if (!loupP || !angeP) { ko("S7-setup", JSON.stringify(roleOf)); return; }
  const villageois = avecRole("Villageois").filter(p => p !== players[0]);

  // Nuit 1, puis le MJ passe le vote du jour 1
  await nuitLoupUnique(mj, players, loupP, villageois[0]);
  const nuit2P = attendrePhase(players[0].s, "wolves", 20000);
  mj.emit("skipDayVote");
  await nuit2P;
  await nuitLoupUnique(mj, players, loupP, villageois[1]);

  // Jour 2 : tous votent l'Ange
  let angeRevele = false;
  mj.on("angeRevele", () => { angeRevele = true; });
  mj.emit("startVote");
  await sleep(300);
  players.filter(p => p !== villageois[0] && p !== villageois[1])
    .forEach(p => p.s.emit("voteDay", p === angeP ? loupP.s.id : angeP.s.id));
  await sleep(300);

  const resultP = attendre(mj, "dayVoteResult", 12000);
  mj.emit("lockDayVotes");
  const res = await resultP.catch(() => null);
  check("S7-l'Ange est éliminé comme un villageois", res && res.id === angeP.s.id && res.role === "Ange", JSON.stringify(res));
  check("S7-pas de victoire de l'Ange", !angeRevele);
});

// S8 — Petite Fille : chaque nuit, 3 joueurs désignés → « au moins un loup » ou « aucun ».
// Nuit 1 : choix invalide refusé, puis 3 joueurs dont le loup ; la nuit attend son « OK ».
// Nuit 2 : 3 villageois → aucun loup.
const s8 = () => scenario("S8", "Petite Fille enquêtrice (2 nuits)", async all => {
  const { mj, players, roleOf, avecRole } = await preparerPartie(all, ["s8_A","s8_B","s8_C","s8_D","s8_E","s8_F","s8_G"], { loup: 1, petiteFille: 1 });
  const [loupP] = avecRole("Loup"), [pfP] = avecRole("PetiteFille");
  if (!loupP || !pfP) { ko("S8-setup", JSON.stringify(roleOf)); return; }
  const villageois = avecRole("Villageois").filter(p => p !== players[0]);
  let mjInfo = null;
  mj.on("petiteFilleMJInfo", d => { mjInfo = d; });

  // Nuit 1 : le loup tue un villageois, puis c'est au tour de la Petite Fille
  const pfTourP = attendrePhase(pfP.s, "petiteFille", 20000);
  await attaqueDuLoup(mj, loupP, villageois[0]);
  if (!check("S8-la Petite Fille se réveille après les Loups (pas de Voyante)", await arrive(pfTourP))) return;

  // Choix invalide : elle-même dans la liste
  const erreurP = attendre(pfP.s, "petiteFilleError", 4000);
  pfP.s.emit("petiteFilleChoice", [pfP.s.id, loupP.s.id, villageois[1].s.id]);
  const erreur = await erreurP.catch(() => null);
  check("S8-se désigner elle-même est refusé", typeof erreur === "string", String(erreur));

  // Choix valide avec le loup
  const resP = attendre(pfP.s, "petiteFilleResult", 4000);
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
  const day1P = attendrePhase(players[0].s, "day", 20000);
  pfP.s.emit("petiteFilleDone");
  await day1P;
  players[0].s.off("phase", onPhase);
  await sleep(300);

  // Jour 1 passé, nuit 2 : 3 villageois → aucun loup
  const nuit2P = attendrePhase(players[0].s, "wolves", 20000);
  mj.emit("skipDayVote");
  await nuit2P;
  const pfTour2P = attendrePhase(pfP.s, "petiteFille", 20000);
  await attaqueDuLoup(mj, loupP, villageois[1]);
  await pfTour2P;
  const trois = avecRole("Villageois").filter(p => p !== villageois[0] && p !== villageois[1]).slice(0, 3);
  const res2P = attendre(pfP.s, "petiteFilleResult", 4000);
  pfP.s.emit("petiteFilleChoice", trois.map(p => p.s.id));
  const res2 = await res2P.catch(() => null);
  check("S8-nuit 2 : « aucun loup »", res2 && res2.auMoinsUnLoup === false, JSON.stringify(res2) + " choisis=" + trois.map(p => p.name));
  const day2P = attendrePhase(players[0].s, "day", 20000);
  pfP.s.emit("petiteFilleDone");
  check("S8-après son « OK », le jour 2 se lève", await arrive(day2P));
});

// S9 — Boutons du MJ pendant le suspense d'un vote clos (double appui sur
// « Terminer », « Lancer le vote », « Passer vote ») : un seul dépouillement.
const s9 = () => scenario("S9", "Boutons du MJ pendant le suspense du vote", async all => {
  const { mj, players, avecRole } = await preparerPartie(all, ["s9_A","s9_B","s9_C","s9_D","s9_E","s9_F","s9_G"], { loup: 1 });
  const [loupP] = avecRole("Loup");
  const villageois = avecRole("Villageois").filter(p => p !== players[0]);
  await nuitLoupUnique(mj, players, loupP, villageois[0]);

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
});

// S10 — Partie gagnée à l'aube (nuit résolue d'urgence par le MJ) : pendant les 7 s
// avant l'écran de fin, des clics tardifs ne relancent pas une deuxième aube.
const s10 = () => scenario("S10", "Clics tardifs pendant une fin de partie à l'aube", async all => {
  const { mj, players, roleOf, avecRole } = await preparerPartie(all, ["s10_A","s10_B","s10_C","s10_D"], { loup: 1, sorciere: 1 });
  const [loupP] = avecRole("Loup"), [sorcP] = avecRole("Sorcière"), vill = avecRole("Villageois");
  const v1 = vill.find(p => p !== players[0]) || vill[0];   // pas le maire : évite la transmission d'écharpe
  const v2 = vill.find(p => p !== v1);
  if (!loupP || !sorcP || !v1 || !v2) { ko("S10-setup", JSON.stringify(roleOf)); return; }
  let aubes = 0;
  const fins = [];
  mj.on("dawnResult", () => aubes++);
  mj.on("gameEnd", m => fins.push(m));

  const sorcTourP = attendrePhase(sorcP.s, "witch", 20000);
  await attaqueDuLoup(mj, loupP, v1);
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
});

// S11 — Pastilles de connexion de l'écran MJ : 🟢 ok, 🟠 écran éteint, 🔴 perdu ;
// alerte au bout de 5 s de coupure, alerte au retour, rien pour un simple rechargement.
const s11 = () => scenario("S11", "Pastilles de connexion chez le MJ", async all => {
  const { mj, players } = await preparerPartie(all, ["s11_A","s11_B","s11_C","s11_D","s11_E"], { loup: 1 });
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
  const a2 = await connecter(TEST_PORT, a.name); all.push(a2);
  await sleep(800);
  check("S11-retour → 🟢 sous son nouvel identifiant", etats[a2.id] === "ok" && !(ancienA in etats), JSON.stringify(etats));
  check("S11-alerte « est de retour »", revenus.includes(a.name), JSON.stringify(revenus));

  // Simple rechargement de page (retour en moins d'une seconde) : aucune alerte
  b.s.disconnect(); await sleep(300);
  const b2 = await connecter(TEST_PORT, b.name); all.push(b2);
  await sleep(6000);
  check("S11-rechargement rapide : pas d'alerte de coupure", !perdus.includes(b.name), JSON.stringify(perdus));
  check("S11-rechargement rapide : 🟢", etats[b2.id] === "ok", JSON.stringify(etats));
});

// S12 — Une partie se termine, puis le MJ appuie sur « 🚀 Lancer la partie » (et non
// « Relancer ») : téléphones remis à zéro, personne ne reste mort, pas de maire hérité.
// Puis, au salon, le MJ retire un joueur : son téléphone est prévenu.
const s12 = () => scenario("S12", "Nouvelle partie après une partie terminée ; retrait d'un joueur", async all => {
  const composition = { loup: 1 };
  const { mj, players, avecRole } = await preparerPartie(all, ["s12_A","s12_B","s12_C","s12_D"], composition);
  const [loupP] = avecRole("Loup");
  const vill = avecRole("Villageois").filter(p => p !== players[0]);
  // Nuit : le loup tue un villageois ; jour : loup + maire éliminent le dernier → loups gagnants
  await nuitLoupUnique(mj, players, loupP, vill[0]);
  mj.emit("startVote", 1); await sleep(400);
  players.filter(p => p !== vill[0] && p !== vill[1]).forEach(p => p.s.emit("voteDay", vill[1].s.id));
  await sleep(400);
  const finP = attendre(mj, "gameEnd", 16000);
  mj.emit("lockDayVotes");
  const fin = await finP.catch(() => null);
  check("S12-la 1re partie se termine", typeof fin === "string", String(fin));

  let resets = 0;
  players.forEach(p => p.s.on("gameReset", () => resets++));
  mj.emit("assignRoles", { ...composition, autoMode: false, mjPilotedDay: true });   // « Lancer la partie »
  await sleep(1500);
  check("S12-« Lancer la partie » remet tous les téléphones à zéro", resets === players.length, resets + " remises à zéro");
  const etat = await new Promise(res => { players[1].s.once("reconnected", res); players[1].s.emit("register", players[1].name); });
  check("S12-personne ne reste mort de la partie précédente", (etat.deadPlayers || []).length === 0, JSON.stringify(etat.deadPlayers));
  check("S12-pas de maire hérité", !etat.mayor, String(etat.mayor));

  // Retour au salon, puis le MJ retire un joueur
  mj.emit("reset"); await sleep(800);
  const retireP = attendre(players[3].s, "retireParMJ", 4000);
  const listeP  = attendre(mj, "players", 4000);
  mj.emit("retirerJoueur", players[3].s.id);
  const retire = await arrive(retireP);
  const liste  = await listeP.catch(() => []);
  check("S12-le joueur retiré est prévenu", retire);
  check("S12-il n'est plus dans la liste", !liste.some(p => p.name === players[3].name), JSON.stringify(liste.map(p => p.name)));
});

// S13 — Égalités au vote du jour. Jour 1 : le maire tranche. Jour 2 : il ne répond
// pas, le hasard tranche au bout de 30 s. Chaque fois, le désigné meurt et la nuit suit.
const s13 = () => scenario("S13", "Égalités au vote : le maire tranche, puis le hasard (≈ 50 s)", async all => {
  const { mj, players, roleOf, avecRole } = await preparerPartie(all, ["s13_A","s13_B","s13_C","s13_D","s13_E","s13_F","s13_G"], { loup: 1 });
  const maire = players[0];
  const [loupP] = avecRole("Loup");
  if (!loupP) { ko("S13-setup", JSON.stringify(roleOf)); return; }
  const vill  = players.filter(p => p !== maire && p !== loupP);
  const autre = loupP !== maire ? loupP : vill[5];   // un votant de plus, que le loup soit maire ou non
  const voter = bulletins => bulletins.forEach(([de, pour]) => de.s.emit("voteDay", pour.s.id));

  // Jour 1 : 2 voix contre vill[1], 2 contre vill[2] ; le maire désigne vill[2]
  await nuitLoupUnique(mj, players, loupP, vill[0]);
  mj.emit("startVote"); await sleep(300);
  voter([[maire, vill[1]], [vill[3], vill[1]], [vill[1], vill[2]], [vill[4], vill[2]]]);
  await sleep(300);
  const egaliteP = attendre(maire.s, "tiebreakMayor", 6000);
  mj.emit("lockDayVotes");
  const egalite = await egaliteP.catch(() => null);
  const candidats = (egalite?.candidates || []).map(c => c.id).sort();
  check("S13-le maire tranche entre les deux ex æquo", JSON.stringify(candidats) === JSON.stringify([vill[1].s.id, vill[2].s.id].sort()), JSON.stringify(egalite));
  const resultat1P = attendre(mj, "dayVoteResult", 8000);
  const nuit2P = attendrePhase(maire.s, "wolves", 25000);
  maire.s.emit("tiebreakChoice", vill[2].s.id);
  const r1 = await resultat1P.catch(() => null);
  check("S13-le désigné par le maire est éliminé", r1 && r1.id === vill[2].s.id, JSON.stringify(r1));
  check("S13-la nuit suit la décision du maire", await arrive(nuit2P));

  // Jour 2 : 2 voix contre vill[1], 2 contre vill[4] ; le maire ne répond pas
  await nuitLoupUnique(mj, players, loupP, vill[3]);
  let hasard = false;
  mj.on("autoResolve", m => { if (String(m).includes("n'a pas tranché")) hasard = true; });
  mj.emit("startVote"); await sleep(300);
  voter([[maire, vill[1]], [vill[4], vill[1]], [vill[1], vill[4]], [autre, vill[4]]]);
  await sleep(300);
  const resultat2P = attendre(mj, "dayVoteResult", 40000);
  const nuit3P = attendrePhase(maire.s, "wolves", 50000);
  mj.emit("lockDayVotes");
  const r2 = await resultat2P.catch(() => null);
  check("S13-sans réponse du maire, le hasard tranche", hasard);
  check("S13-l'élu du hasard est l'un des deux ex æquo", r2 && [vill[1].s.id, vill[4].s.id].includes(r2.id), JSON.stringify(r2));
  check("S13-la nuit suit le tirage au sort", await arrive(nuit3P));
});

// S14 — Les Sœurs savent dès l'attribution des rôles avec qui elles sont, comme les Loups ;
// personne d'autre ne l'apprend
const s14 = () => scenario("S14", "Les Sœurs se connaissent dès le début", async all => {
  const { players, roleOf, infos, avecRole } = await preparerPartie(all, ["s14_A","s14_B","s14_C","s14_D","s14_E"], { loup: 1, sisters: 2 });
  const soeurs = avecRole("Sœurs");
  const ids = soeurs.map(p => p.s.id).sort().join();
  check("S14-deux Sœurs tirées", soeurs.length === 2, JSON.stringify(roleOf));
  check("S14-chaque Sœur reçoit les deux Sœurs", soeurs.every(p => [...(infos[p.name].soeurs || [])].sort().join() === ids));
  check("S14-les autres ne reçoivent aucune Sœur", players.filter(p => roleOf[p.name] !== "Sœurs").every(p => (infos[p.name].soeurs || []).length === 0));
});

// S15 — Deux Chasseurs à la chaîne après un vote : le village élimine un Chasseur, qui abat
// l'autre ; le second tire à son tour, puis la nuit tombe (comme après tout vote). Chaque mort
// reste au journal avec sa cause, même pour un téléphone rechargé ; le détail des votes (loups,
// jour) ne va qu'au MJ. Le maire est un villageois : pas de transmission d'écharpe.
const s15 = () => scenario("S15", "Deux Chasseurs à la chaîne après un vote ; journal des morts", async all => {
  const unVillageois = (players, roleOf) => players.find(p => roleOf[p.name] === "Villageois");
  const { mj, players, roleOf, avecRole } = await preparerPartie(all, ["s15_A","s15_B","s15_C","s15_D","s15_E","s15_F","s15_G","s15_H"],
    { loup: 1, chasseur: 2 }, unVillageois);
  const [loupP] = avecRole("Loup"), [c1, c2] = avecRole("Chasseur");
  const maire = unVillageois(players, roleOf), vills = avecRole("Villageois").filter(p => p !== maire);
  // Le détail des votes : au MJ, jamais à un téléphone
  const reserves = ["wolfVotesMJ", "votesDayMJ"], recusParMJ = new Set(), recusParTelephones = new Set();
  reserves.forEach(e => { mj.on(e, () => recusParMJ.add(e)); players.forEach(p => p.s.on(e, () => recusParTelephones.add(e))); });

  // Nuit : le loup dévore un villageois ; jour : le village élimine le premier Chasseur
  await nuitLoupUnique(mj, players, loupP, vills[0]);
  mj.emit("startVote");
  await sleep(300);
  const tir1 = attendre(c1.s, "chasseurMustShoot", 20000, id => id === c1.s.id);
  players.filter(p => p !== vills[0]).forEach(p => p.s.emit("voteDay", (p === c1 ? maire : c1).s.id));
  await sleep(300);
  mj.emit("lockDayVotes");
  check("S15-le premier Chasseur est appelé à tirer", await arrive(tir1));

  // Il abat le second Chasseur, qui tire à son tour (le MJ automatique ouvre son tir)
  const tir2 = attendre(c2.s, "chasseurMustShoot", 12000, id => id === c2.s.id);
  c1.s.emit("chasseurAction", c2.s.id);
  check("S15-le second Chasseur tire à son tour", await arrive(tir2));
  const nuitP = attendrePhase(maire.s, "crepuscule", 12000);
  c2.s.emit("chasseurAction", vills[1].s.id);
  check("S15-après les tirs qui suivent un vote, la nuit tombe", await arrive(nuitP));

  // Le journal des morts tel qu'un téléphone rechargé le reçoit
  const s = await reconnecter(all, maire);
  const etat = await attendre(s, "reconnected", 6000).catch(() => null);
  const journal = ((etat && etat.deathLog) || []).map(d => `${d.name}:${d.cause}`).join(", ");
  const attendu = [`${vills[0].name}:loups`, `${c1.name}:vote`, `${c2.name}:chasseur`, `${vills[1].name}:chasseur`].join(", ");
  check("S15-journal des morts : loups, vote, puis les deux tirs", journal === attendu, journal);
  check("S15-le MJ reçoit le détail des votes des loups et du jour", reserves.every(e => recusParMJ.has(e)), [...recusParMJ].join());
  check("S15-aucun téléphone ne le reçoit", recusParTelephones.size === 0, [...recusParTelephones].join());

  // « Tireur d'élite » : le Chasseur dont le tir emporte un loup (le dernier Chasseur mort avant lui)
  const joueurs = ["C1", "C2", "L"].map(n => ({ id: n, name: n }));
  const medailles = buildBadges({ players: joueurs, roles: { C1: "Chasseur", C2: "Chasseur", L: "Loup" }, deadPlayers: ["C1", "C2", "L"],
    lovers: [], winner: "villagers", gameStats: { deathLog: [
      { name: "C1", role: "Chasseur", cause: "vote" }, { name: "C2", role: "Chasseur", cause: "chasseur" }, { name: "L", role: "Loup", cause: "chasseur" }] } });
  check("S15-« Tireur d'élite » au Chasseur qui a abattu le loup, pas à l'autre",
    medailles.C2[0].label === "Tireur d'élite" && medailles.C1[0].label !== "Tireur d'élite", JSON.stringify(medailles));
});

// S16 — Bouton d'urgence « 🔮 Voyante » du MJ dans une partie sans Voyante : la nuit passe à
// l'étape suivante qui a lieu (la Sorcière), qui reçoit ses potions comme dans la nuit normale
const s16 = () => scenario("S16", "Bouton d'urgence « Voyante » sans Voyante", async all => {
  const { mj, roleOf, avecRole } = await preparerPartie(all, ["s16_A","s16_B","s16_C","s16_D","s16_E"], { loup: 1, sorciere: 1 });
  const [witchP] = avecRole("Sorcière");
  if (!witchP) { ko("S16-setup", JSON.stringify(roleOf)); return; }
  const potionsP = attendre(witchP.s, "etatPotions", 6000);
  const sorciereP = attendrePhase(witchP.s, "witch", 6000);
  mj.emit("setPhase", "seer");
  check("S16-la nuit passe à la Sorcière", await arrive(sorciereP));
  check("S16-la Sorcière reçoit ses potions", await arrive(potionsP));
});

// Démarrage du serveur et exécution des scénarios
async function main() {
  console.log("═".repeat(62));
  console.log("🐺 LOUP-GAROU — Tests intégration — port " + TEST_PORT);
  console.log("═".repeat(62));

  const serveur = await demarrerServeur(TEST_PORT);
  console.log("  Serveur test prêt : http://localhost:" + TEST_PORT + "\n");

  for (const s of [s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12, s13, s14, s15, s16]) {
    await s();
    await sleep(800);
  }

  await arreterServeur(serveur);
  process.exit(bilan());
}

main().catch(arret);
