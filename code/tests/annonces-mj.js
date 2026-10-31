// tests/annonces-mj.js — Chasseur et maire mourant lancés par le MJ (2026-10-26).
// Partie entièrement pilotée (pas de robots) : 5 joueurs, 1 loup, 1 Chasseur, des villageois.
// Le maire élu est un villageois ; la nuit, le loup tue le Chasseur ; à l'aube, la carte des
// morts reste jusqu'au MJ, le Chasseur ne peut pas tirer avant son clic ; il tire sur le maire,
// dont la transmission d'écharpe attend à son tour le MJ. Vérifie aussi l'annonce du tir.
// Lancement : npm run test:rythme (après tests/rythme-mj.js) ou node tests/annonces-mj.js
"use strict";
const { sleep, demarrerServeur, arreterServeur, connecter, connecterMJ, attendre, attendrePhase, arrive, piloterMJ, compteur } = require("./outils");
const PORT = 3106;
const { check, bilan, arret } = compteur();

(async () => {
  const srv = await demarrerServeur(PORT);
  const { mj } = await connecterMJ(PORT);
  const evMJ = { phases: [], actions: [] };
  mj.on("phase", p => evMJ.phases.push(p));
  mj.on("actionMJEnAttente", d => evMJ.actions.push(d));
  piloterMJ(mj, { delai: 200, actions: false });   // le tir et la transmission : c'est ce qu'on vérifie

  // 5 joueurs pilotés à la main
  const noms = ["Anna", "Bruno", "Chloe", "David", "Emma"];
  const J = {};
  for (const n of noms) {
    const s = await connecter(PORT);
    J[n] = { s, nom: n, role: null, ev: { aube: [], tir: [], transfert: [], aTire: [], phase: [] } };
    s.on("yourRole", d => { J[n].role = d.role; });
    s.on("dawnResult", d => J[n].ev.aube.push(d));
    s.on("chasseurMustShoot", d => J[n].ev.tir.push(d));
    s.on("mayorMustTransfer", d => J[n].ev.transfert.push(d));
    s.on("chasseurATire", d => J[n].ev.aTire.push(d));
    s.on("phase", p => J[n].ev.phase.push(p));
    s.emit("register", n);
  }
  let joueurs = [];
  mj.on("players", p => { joueurs = p; });
  await sleep(800);
  const id = n => (joueurs.find(p => p.name === n) || {}).id;

  mj.emit("assignRoles", { loup: 1, chasseur: 1, conseil: false, autoMode: false, mjPilotedDay: true });
  await sleep(1200);
  const loup = noms.find(n => J[n].role === "Loup"), chasseur = noms.find(n => J[n].role === "Chasseur");
  const villageois = noms.filter(n => n !== loup && n !== chasseur);
  const maire = villageois[0];
  console.log(`  (loup ${loup}, chasseur ${chasseur}, maire visé ${maire})`);

  console.log("\n▶ Élection du maire, nuit : le loup tue le Chasseur");
  noms.forEach(n => J[n].s.emit("voteMayor", id(maire)));
  await sleep(600);
  mj.emit("lockMayorVote");
  await attendre(mj, "nuitEnAttente", 9000);
  mj.emit("mjLancerNuit");
  await attendrePhase(mj, "wolves");
  J[loup].s.emit("voteWolf", id(chasseur));
  await sleep(500);
  mj.emit("lockWolfVotes");
  await attendrePhase(mj, "chasseur");
  await sleep(1500);

  const aube = J[maire].ev.aube[J[maire].ev.aube.length - 1];
  check("aube : la carte des morts attend le MJ (annonceParMJ)", aube && aube.annonceParMJ === true, aube && aube.annonceParMJ);
  check("aube : le Chasseur figure parmi les morts, avec son nom", aube && aube.deaths.some(d => d.name === chasseur), aube && aube.deaths.map(d => d.name));
  check("le MJ est prévenu : « 🔫 Le Chasseur tire — nom »", evMJ.actions.some(a => a.type === "chasseur" && a.nom === chasseur), evMJ.actions);
  check("personne n'est appelé à tirer avant le clic du MJ", noms.every(n => J[n].ev.tir.length === 0));
  J[chasseur].s.emit("chasseurAction", id(maire));
  await sleep(800);
  check("un tir avant le clic du MJ est ignoré", evMJ.phases[evMJ.phases.length - 1] === "chasseur" && J[maire].ev.aTire.length === 0, evMJ.phases.slice(-2));
  await sleep(4000);
  check("toujours en attente 5 s plus tard (pas de minuterie du Chasseur)", evMJ.phases[evMJ.phases.length - 1] === "chasseur");

  console.log("\n▶ Le MJ lance le tir ; le Chasseur tire sur le maire");
  mj.emit("mjOuvrirAction");
  await sleep(600);
  check("après le clic, tout le monde est appelé (chasseurMustShoot)", noms.every(n => J[n].ev.tir.length === 1), noms.map(n => J[n].ev.tir.length));
  J[chasseur].s.emit("chasseurAction", id(maire));
  await sleep(800);
  const tir = J[villageois[1]].ev.aTire[0];
  check("tout le monde voit qui le Chasseur a emporté (de nuit)", tir && tir.name === maire && tir.nuit === true, tir);
  check("le maire touché : transmission d'écharpe en attente du MJ", evMJ.phases[evMJ.phases.length - 1] === "mayorTransfer" && evMJ.actions.some(a => a.type === "mayorTransfer" && a.nom === maire), { phase: evMJ.phases[evMJ.phases.length - 1], actions: evMJ.actions });
  check("le maire mourant n'est pas appelé avant le clic du MJ", noms.every(n => J[n].ev.transfert.length === 0));
  J[maire].s.emit("mayorTransferChoice", id(villageois[1]));
  await sleep(800);
  check("une transmission avant le clic du MJ est ignorée", evMJ.phases[evMJ.phases.length - 1] === "mayorTransfer");

  console.log("\n▶ Le MJ lance la transmission");
  mj.emit("mjOuvrirAction");
  await sleep(600);
  check("après le clic, le maire mourant est appelé (mayorMustTransfer)", J[maire].ev.transfert.length === 1);
  const versJour = arrive(attendrePhase(mj, "day", 5000));
  J[maire].s.emit("mayorTransferChoice", id(villageois[1]));
  check("après la transmission, le jour se lève", await versJour, evMJ.phases.slice(-3));

  // Rechargement de la tablette pendant une attente : déjà couvert par mjReconnected.actionMJ
  mj.close(); noms.forEach(n => J[n].s.close());
  await arreterServeur(srv, { brutal: true });
  process.exit(bilan());
})().catch(arret);
