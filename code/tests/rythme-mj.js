// tests/rythme-mj.js — Le MJ donne le rythme (2026-10-26) : crépuscule (« 🌙 Lancer la nuit »),
// réveil (carte des morts gardée, « 📜 Annoncer l'évènement », « ▶ Lancer le débat »), reconnexions
// du MJ et des joueurs, pause, double clic, reprise après plantage du serveur (en plein jour et
// au crépuscule). Complète tests/scenarios.js, qui ne couvre ni les reconnexions ni les plantages.
// Lancement : npm run test:rythme   (~2 min, serveur jetable sur le port 3105)
"use strict";
const path = require("path"), fs = require("fs");
const { sleep, demarrerServeur, arreterServeur, connecter, connecterMJ, attendre, attendrePhase, piloterMJ, compteur } = require("./outils");
const PORT = 3105;
const { check, bilan, arret } = compteur();
let srv = null;
const client = () => connecter(PORT);
function lireSnapshot() { try { return JSON.parse(fs.readFileSync(path.join(srv.dossier, "state-snapshot.json"), "utf8")); } catch { return null; } }
// Plantage du serveur, puis redémarrage sur la même sauvegarde
async function planterPuisRedemarrer() {
  await arreterServeur(srv, { brutal: true, garderDossier: true });
  srv = await demarrerServeur(PORT, { viderDossier: false });
}

// Le MJ (re)connecté ; MJ automatique pendant la nuit. Les loups robots votent entre 2 et 8 s
// (BOT_MAX_DELAY_MS) : le MJ valide après, sinon la nuit passe parfois sans mort (et sans
// Conseil des Morts le lendemain)
async function nouveauMJ(reprise) {
  const r = await connecterMJ(PORT, { reprise });
  piloterMJ(r.mj, { delai: 300, loupsApres: 9000 });
  return r;
}

(async () => {
  srv = await demarrerServeur(PORT);
  let { mj } = await nouveauMJ(false);
  const evMJ = { phases: [], nuitEnAttente: 0, matins: [], conseil: [] };
  const suivreMJ = m => {
    m.on("phase", p => evMJ.phases.push(p));
    m.on("nuitEnAttente", () => evMJ.nuitEnAttente++);
    m.on("matinEnAttente", d => evMJ.matins.push(d));
    m.on("councilResolvedMJ", d => evMJ.conseil.push(d.winner));
  };
  suivreMJ(mj);

  // Un « vrai » joueur (pour les écrans et les reconnexions) + 8 robots
  let joueur = await client();
  const evJ = { phases: [], aubes: [], finMatin: [], evenements: [] };
  let monRole = null, joueurs = [], morts = [];
  const suivreJoueur = j => {
    j.on("phase", p => evJ.phases.push(p));
    j.on("dawnResult", d => evJ.aubes.push(d));
    j.on("finAnnonceMatin", d => evJ.finMatin.push(d));
    j.on("councilEventActive", d => evJ.evenements.push(d));
    j.on("yourRole", d => { monRole = d.role; });
    j.on("players", p => { joueurs = p; });
    j.on("phase", p => { if (p === "wolves" && monRole === "Loup") { const cible = joueurs.find(x => x.isBot); if (cible) j.emit("voteWolf", cible.id); } });
    // Élu maire puis tué, il transmet l'écharpe à un robot vivant, comme le ferait un robot
    // (sans réponse, la partie attendrait 60 s et le matin ne viendrait pas à temps)
    j.on("deadPlayers", d => { morts = d; });
    j.on("mayorMustTransfer", mourant => {
      if (mourant !== j.id) return;
      const successeur = joueurs.find(x => x.isBot && !morts.includes(x.id));
      if (successeur) setTimeout(() => j.emit("mayorTransferChoice", successeur.id), 500);
    });
  };
  suivreJoueur(joueur);
  joueur.emit("register", "Testeur");
  // Le joueur recharge sa page : il revient sous son prénom ; rend l'état que le serveur lui renvoie
  const rechargerJoueur = async () => {
    joueur.close();
    joueur = await client(); suivreJoueur(joueur);
    const etat = attendre(joueur, "reconnected", 5000);
    joueur.emit("register", "Testeur");
    return etat;
  };
  for (let i = 0; i < 8; i++) mj.emit("addBot");
  await sleep(1000);

  console.log("\n▶ 1. Élection du maire puis crépuscule");
  const roleP = attendre(joueur, "yourRole", 5000);
  mj.emit("assignRoles", { loup: 1, autoMode: false, mjPilotedDay: true });
  const role = await roleP;
  check("le téléphone sait que la nuit attend le MJ (yourRole.nuitParMJ)", role.nuitParMJ === true, role.nuitParMJ);
  await sleep(2500);
  const crep1 = attendre(mj, "nuitEnAttente", 9000);
  mj.emit("lockMayorVote");
  await crep1;
  await sleep(3000);
  check("toujours au crépuscule 3 s après (la nuit ne démarre pas seule)", evMJ.phases[evMJ.phases.length - 1] === "crepuscule", evMJ.phases.slice(-3));

  console.log("\n▶ 2. Un joueur ne peut pas lancer la nuit");
  joueur.emit("mjLancerNuit");
  await sleep(1000);
  check("clic « Lancer la nuit » d'un joueur ignoré", evMJ.phases[evMJ.phases.length - 1] === "crepuscule");

  console.log("\n▶ 3. Tablette du MJ rechargée au crépuscule");
  mj.close();
  ({ mj } = await nouveauMJ(false).then(r => { suivreMJ(r.mj); check("mjReconnected.nuitEnAttente vrai", r.etat.nuitEnAttente === true, r.etat.nuitEnAttente); return r; }));

  console.log("\n▶ 4. Pause puis reprise au crépuscule, puis double clic");
  mj.emit("pauseGame"); await sleep(800); mj.emit("resumeGame"); await sleep(800);
  check("toujours au crépuscule après pause/reprise", evMJ.phases[evMJ.phases.length - 1] === "crepuscule");
  const avant = evMJ.phases.length;
  mj.emit("mjLancerNuit"); mj.emit("mjLancerNuit");
  await sleep(1500);
  const apres = evMJ.phases.slice(avant);
  check("double clic : une seule entrée dans la nuit", apres.filter(p => p === "nightPause").length === 1 && apres[0] === "nightPause", apres);

  console.log("\n▶ 5. Premier matin (sans évènement)");
  const matin1 = attendre(mj, "matinEnAttente", 40000);
  await attendrePhase(joueur, "day", 40000);
  const m1 = await matin1;
  const aube1 = evJ.aubes[evJ.aubes.length - 1];
  const transfert1 = evMJ.phases.includes("mayorTransfer");
  check("carte du matin gardée par le MJ (annonceParMJ) sauf maire mort", aube1 && aube1.annonceParMJ === !transfert1, { annonceParMJ: aube1 && aube1.annonceParMJ, transfert: transfert1 });
  check("matinEnAttente sans évènement le 1er jour", m1 && m1.evenement === null, m1);
  mj.emit("mjFinAnnonceMatin");
  const f1 = await attendre(joueur, "finAnnonceMatin", 3000).catch(() => null);
  check("« Lancer le débat » ferme la carte des téléphones (finAnnonceMatin)", !!f1, f1);
  mj.emit("mjFinAnnonceMatin"); await sleep(600);
  check("second « Lancer le débat » sans effet", evJ.finMatin.length === 1, evJ.finMatin.length);
  await sleep(5000);  // le Conseil des Morts s'ouvre 4 s après l'aube
  const crep2 = attendre(mj, "nuitEnAttente", 6000);
  mj.emit("skipDayVote");
  await crep2;
  await sleep(500);
  check("vote passé → crépuscule ; évènement du Conseil tiré pour demain", evMJ.phases[evMJ.phases.length - 1] === "crepuscule" && evMJ.conseil.length === 1, { phase: evMJ.phases[evMJ.phases.length - 1], conseil: evMJ.conseil });

  console.log("\n▶ 6. Deuxième matin : l'évènement attend le MJ");
  const matin2 = attendre(mj, "matinEnAttente", 40000);
  mj.emit("mjLancerNuit");
  await attendrePhase(joueur, "day", 40000);
  const m2 = await matin2;
  check("matinEnAttente donne l'évènement à annoncer", m2 && m2.evenement && m2.evenement.id === evMJ.conseil[0], m2 && m2.evenement);
  const nbEvAvant = evJ.evenements.length;
  await sleep(4500);
  check("l'évènement n'est PAS appliqué seul après 3 s", evJ.evenements.length === nbEvAvant, evJ.evenements.length - nbEvAvant);
  // Joueur qui recharge sa page avant l'annonce
  let etatJ = await rechargerJoueur();
  check("joueur reconnecté avant l'annonce : pas d'évènement dans son état", !etatJ.activeCouncilEvent, etatJ.activeCouncilEvent);
  check("joueur reconnecté : nuitParMJ présent dans son état", etatJ.nuitParMJ === true, etatJ.nuitParMJ);

  console.log("\n▶ 7. Plantage du serveur en plein réveil, puis reprise");
  await sleep(6000);  // sauvegarde toutes les 5 s
  const avantCrash = lireSnapshot();
  await planterPuisRedemarrer();
  ({ mj } = await nouveauMJ(true));
  suivreMJ(mj);
  joueur.close();
  const matinReprise = attendre(mj, "matinEnAttente", 5000).catch(() => null);
  mj.emit("acceptCrashRecovery");
  const mR = await matinReprise;
  await sleep(6000);
  const apresCrash = lireSnapshot();
  check("reprise en plein jour : le jour n'est pas compté deux fois", apresCrash && avantCrash && apresCrash.gameStats.dayCount === avantCrash.gameStats.dayCount, { avant: avantCrash && avantCrash.gameStats.dayCount, apres: apresCrash && apresCrash.gameStats.dayCount });
  check("reprise en plein jour : l'évènement du jour est conservé", apresCrash && apresCrash.activeCouncilEvent === avantCrash.activeCouncilEvent && !!apresCrash.activeCouncilEvent, { avant: avantCrash && avantCrash.activeCouncilEvent, apres: apresCrash && apresCrash.activeCouncilEvent });
  check("reprise : le MJ retrouve l'évènement à annoncer", mR && mR.evenement && mR.evenement.id === (avantCrash && avantCrash.activeCouncilEvent), mR);

  console.log("\n▶ 8. Annonce de l'évènement, puis débat, puis vote");
  await rechargerJoueur();
  const evP = attendre(joueur, "councilEventActive", 3000).catch(() => null);
  mj.emit("mjAnnoncerEvenement");
  const ev = await evP;
  check("annonce : les téléphones reçoivent l'évènement (parMJ)", ev && ev.parMJ === true, ev && { id: ev.id, parMJ: ev.parMJ });
  const n = evJ.evenements.length;
  mj.emit("mjAnnoncerEvenement"); await sleep(800);
  check("second clic « Annoncer » sans effet", evJ.evenements.length === n, evJ.evenements.length - n);
  etatJ = await rechargerJoueur();
  check("joueur reconnecté après l'annonce : il retrouve l'évènement", etatJ.activeCouncilEvent && etatJ.activeCouncilEvent.id === ev.id, etatJ.activeCouncilEvent);
  const fP = attendre(joueur, "finAnnonceMatin", 3000).catch(() => null);
  mj.emit("mjFinAnnonceMatin");
  const f2 = await fP;
  check("« Lancer le débat » après l'annonce ferme aussi la carte de l'évènement", f2 && f2.fermerEvenement === true, f2);
  const nf = evJ.finMatin.length;
  mj.emit("startVote", 1); await sleep(1000);
  check("lancer le vote ensuite ne renvoie pas de fin d'annonce", evJ.finMatin.length === nf, evJ.finMatin.length - nf);

  console.log("\n▶ 9. Plantage au crépuscule, puis reprise et nuit");
  const crep3 = attendre(mj, "nuitEnAttente", 6000);
  mj.emit("skipDayVote");
  await crep3;
  await sleep(6000);
  await planterPuisRedemarrer();
  ({ mj } = await nouveauMJ(true));
  const evMJ2 = []; mj.on("phase", p => evMJ2.push(p));
  mj.emit("acceptCrashRecovery");
  await sleep(1500);
  check("reprise au crépuscule : la nuit attend toujours le MJ", evMJ2[evMJ2.length - 1] === "crepuscule", evMJ2);
  mj.emit("mjLancerNuit"); await sleep(1500);
  check("reprise au crépuscule : « Lancer la nuit » fonctionne", evMJ2.includes("nightPause"), evMJ2);

  mj.close(); joueur.close();
  await arreterServeur(srv, { brutal: true });
  process.exit(bilan());
})().catch(arret);
