/**
 * tests/conseil.js — Le Conseil des Morts (refonte du 2026-11-08) : ce que les morts lisent en
 * votant, les évènements réservés au jour mené par le MJ, puis la Main Levée, le Tour de Parole
 * (avec une pause) et le Sablier, chacun choisi par le mort de la première nuit et joué le jour 2.
 *
 * Serveur à part (port 3108) : ces trois évènements y sont proposés en premier (CONSEIL_OPTIONS), le
 * Sablier dure 1,5 s et chaque prise de parole 0,4 s.
 *
 * Usage : node tests/conseil.js   (~2 min, lumières coupées ; lancé aussi par npm test)
 */
"use strict";
const { sleep, demarrerServeur, arreterServeur, connecter, connecterMJ, attendre, attendrePhase, piloterMJ, compteur } = require("./outils");

const PORT = 3108;
const { check, bilan, arret } = compteur();
const AVEC_MJ = ["mainLevee", "sablier", "tourParole"];

// Une partie à 7 (un loup), MJ qui mène le jour ou mode autonome ; tout le monde élit le premier
// joueur, puis droit au tour des loups
async function partie(all, prefixe, autoMode) {
  const { mj } = await connecterMJ(PORT); all.push(mj);
  piloterMJ(mj, { nuit: true });
  mj.emit("fullReset");
  await sleep(600);
  const joueurs = [];
  for (const l of "ABCDEFG") { const s = await connecter(PORT, prefixe + l); all.push(s); joueurs.push({ nom: prefixe + l, s }); }
  await sleep(300);
  const roles = {};
  const rolesP = joueurs.map(j => new Promise(res => j.s.once("yourRole", d => { roles[j.nom] = d.role; res(); })));
  const maireP = attendrePhase(joueurs[0].s, "mayorVote");
  mj.emit("assignRoles", { loup: 1, autoMode, mjPilotedDay: !autoMode, autoVoteMode: 1 });
  await Promise.all([...rolesP, maireP]);
  joueurs.forEach(j => { if (j !== joueurs[0]) j.s.emit("voteMayor", joueurs[0].s.id); });
  joueurs[0].s.emit("voteMayor", joueurs[1].s.id);
  await sleep(150);
  if (!autoMode) {
    const loupsP = attendrePhase(joueurs[0].s, "wolves");
    mj.emit("lockMayorVote");
    await attendre(joueurs[0].s, "newMayor", 6000);
    mj.emit("setPhase", "wolves");
    await loupsP;
  } else await attendrePhase(joueurs[0].s, "wolves", 30000);
  const loup = joueurs.find(j => roles[j.nom] === "Loup");
  // Les victimes du test : jamais le maire (sa mort ouvrirait la transmission d'écharpe)
  const villageois = joueurs.filter(j => j !== loup && j !== joueurs[0]);
  return { mj, joueurs, loup, villageois };
}

// Nuit : le loup tue `victime` ; avec un MJ, il valide l'attaque
async function nuit(mj, joueurs, loup, victime, autoMode) {
  const jourP = attendrePhase(joueurs.find(j => j !== victime && j !== loup).s, "day", 30000);
  loup.s.emit("voteWolf", victime.s.id);
  await sleep(150);
  if (!autoMode) mj.emit("lockWolfVotes");
  await jourP;
}

// Jour 1 (MJ) : le mort choisit `evenement` ; le village élimine `condamne` ; nuit 2 : le loup tue
// `victime2`. Renvoie le matin du jour 2, quand le MJ peut annoncer l'évènement
async function jusquAuJour2(all, prefixe, evenement) {
  const P = await partie(all, prefixe, false);
  const { mj, joueurs, loup, villageois } = P;
  const [mort1, condamne, victime2] = villageois;
  const conseilP = attendre(mort1.s, "councilStart", 15000);
  await nuit(mj, joueurs, loup, mort1, false);
  const conseil = await conseilP;
  mort1.s.emit("councilVote", evenement);
  mj.emit("mjFinAnnonceMatin");
  await sleep(300);
  mj.emit("startVote");
  await attendre(condamne.s, "voteStarted", 5000);
  joueurs.filter(j => j !== mort1).forEach(j => j.s.emit("voteDay", (j === condamne ? loup : condamne).s.id));
  await sleep(300);
  const loupsP = attendrePhase(loup.s, "wolves", 30000);
  mj.emit("lockDayVotes");
  await loupsP;
  const matinP = attendre(mj, "matinEnAttente", 30000, m => !!(m && m.evenement));
  await nuit(mj, joueurs, loup, victime2, false);
  const matin = await matinP;
  const vivants = joueurs.filter(j => ![mort1, condamne, victime2].includes(j));
  return { ...P, conseil, matin, vivants };
}

// Le MJ annonce l'évènement du jour : la carte sur les téléphones, l'éclair et le souffle chez lui
async function annonce(mj, temoin, evenement, code) {
  const actifP = attendre(temoin.s, "councilEventActive", 5000);
  const souffleP = attendre(mj, "annonceConseil", 5000).then(() => true, () => false);
  mj.emit("mjAnnoncerEvenement");
  const actif = await actifP;
  check(`${code}-l'évènement du jour est « ${evenement} »`, actif && actif.id === evenement, actif && actif.id);
  check(`${code}-son annonce a sa scène (souffle de murmures chez le MJ)`, await souffleP);
}

async function main() {
  console.log("═".repeat(62) + "\n🪦 Conseil des Morts — port " + PORT + "\n" + "═".repeat(62));
  const serveur = await demarrerServeur(PORT, { env: { CONSEIL_OPTIONS: AVEC_MJ.join(","), SABLIER_MS: "1500", TOUR_PAROLE_MS: "400" } });

  console.log("\n▶ C1 — Mode autonome : pas d'évènement qui a besoin du MJ");
  {
    const all = [];
    const { mj, joueurs, loup, villageois } = await partie(all, "ca_", true);
    const conseilP = attendre(villageois[0].s, "councilStart", 20000).catch(() => null);
    await nuit(mj, joueurs, loup, villageois[0], true);
    const c = await conseilP;
    check("C1-le mort reçoit 3 évènements", !!c && c.options.length === 3, c && c.options.map(o => o.id));
    check("C1-aucun n'a besoin du MJ (Main Levée, Sablier, Tour de Parole)", !!c && c.options.every(o => !AVEC_MJ.includes(o.id)), c && c.options.map(o => o.id));
    all.forEach(s => s.disconnect());
    await sleep(800);
  }

  console.log("\n▶ C2 — La Main Levée");
  {
    const all = [];
    const { mj, loup, conseil, matin, vivants } = await jusquAuJour2(all, "cb_", "mainLevee");
    check("C2-avec un MJ, les trois évènements sont proposés", AVEC_MJ.every(id => conseil.options.some(o => o.id === id)), conseil.options.map(o => o.id));
    check("C2-les morts lisent ce que fait chacun (une ligne)", conseil.options.every(o => typeof o.resume === "string" && o.resume.length > 10), conseil.options.map(o => o.resume));
    check("C2-le MJ trouve la Main Levée à annoncer", matin.evenement.id === "mainLevee", matin.evenement.id);
    const temoin = vivants.find(j => j !== loup);
    await annonce(mj, temoin, "mainLevee", "C2");
    mj.emit("mjFinAnnonceMatin");
    let voteOuvert = false, verdictTropTot = false;
    temoin.s.on("voteStarted", () => { voteOuvert = true; });
    temoin.s.once("dayVoteResult", () => { verdictTropTot = true; });
    temoin.s.emit("mjMainLevee", loup.s.id);   // un joueur n'a pas ce pouvoir
    await sleep(4000);
    check("C2-un joueur ne peut pas désigner le condamné", !verdictTropTot);
    const verdictP = attendre(temoin.s, "dayVoteResult", 8000).catch(() => null);
    mj.emit("mjMainLevee", loup.s.id);
    const verdict = await verdictP;
    check("C2-le MJ désigne le condamné : le verdict tombe sur lui", !!verdict && verdict.id === loup.s.id, verdict && verdict.name);
    check("C2-aucun vote sur les téléphones", !voteOuvert);
    const fin = await attendre(temoin.s, "gameEnd", 15000).catch(() => null);
    check("C2-le loup éliminé : le village gagne", !!fin && /Villageois/.test(fin), fin);
    all.forEach(s => s.disconnect());
    await sleep(800);
  }

  console.log("\n▶ C3 — Le Tour de Parole (avec une pause)");
  {
    const all = [];
    const { mj, matin, vivants } = await jusquAuJour2(all, "cc_", "tourParole");
    check("C3-le MJ trouve le Tour de Parole à annoncer", matin.evenement.id === "tourParole", matin.evenement.id);
    await annonce(mj, vivants[0], "tourParole", "C3");
    const etats = [];
    mj.on("debatMJ", d => etats.push(d));
    mj.emit("mjFinAnnonceMatin");
    await sleep(600);
    check("C3-rien ne part avant le clic du MJ", etats.length === 0, etats);
    let voteA = 0;
    vivants[0].s.on("voteStarted", () => { voteA = Date.now(); });
    mj.emit("mjCommencerTour");
    await sleep(100);
    const premier = etats[0];
    check("C3-tour 1, premier des vivants", !!premier && premier.tour === 1 && premier.rang === 1 && premier.total === vivants.length, premier);
    mj.emit("mjParoleSuivante");
    await sleep(100);
    check("C3-« Parole suivante » passe la main tout de suite", etats.at(-1).rang === 2, etats.at(-1));
    mj.emit("pauseGame");
    await sleep(100);
    const gele = etats.at(-1), nb = etats.length;
    await sleep(1200);
    check("C3-en pause, le temps de parole est gelé", gele.restant != null && etats.length === nb && !voteA, { gele, nb: etats.length });
    mj.emit("resumeGame");
    const debutReprise = Date.now();
    await attendre(vivants[0].s, "voteStarted", 8000).catch(() => null);
    const passages = etats.filter(e => e && e.tour && e.restant == null).map(e => `${e.tour}.${e.rang}`);
    const suite = passages.filter((p, i) => p !== passages[i - 1]);   // la reprise republie la parole en cours
    check("C3-deux tours complets, chacun son tour", suite.join(" ") === [1, 2].flatMap(t => vivants.map((_, i) => `${t}.${i + 1}`)).join(" "), passages.join(" "));
    check("C3-après le 2ᵉ tour, le vote s'ouvre tout seul", voteA > 0 && voteA - debutReprise > 400 * (2 * vivants.length - 3), voteA ? (voteA - debutReprise) + " ms après la reprise" : "pas de vote");
    check("C3-le tour s'efface au lancement du vote", etats.at(-1) === null, etats.at(-1));
    all.forEach(s => s.disconnect());
    await sleep(800);
  }

  console.log("\n▶ C4 — Le Sablier");
  {
    const all = [];
    const { mj, matin, vivants } = await jusquAuJour2(all, "cd_", "sablier");
    check("C4-le MJ trouve le Sablier à annoncer", matin.evenement.id === "sablier", matin.evenement.id);
    await annonce(mj, vivants[0], "sablier", "C4");
    const sablierP = attendre(mj, "debatMJ", 3000, d => !!(d && d.sablierFin)).catch(() => null);
    const t0 = Date.now();
    const voteP = attendre(vivants[0].s, "voteStarted", 6000).then(() => Date.now() - t0, () => null);
    mj.emit("mjFinAnnonceMatin");
    check("C4-le sablier part avec « Lancer le débat »", !!(await sablierP));
    const delai = await voteP;
    check("C4-à la fin du sablier, le vote s'ouvre tout seul", delai !== null && delai >= 1300 && delai < 4000, delai);
    all.forEach(s => s.disconnect());
    await sleep(500);
  }

  await arreterServeur(serveur);
  process.exit(bilan());
}

main().catch(arret);
