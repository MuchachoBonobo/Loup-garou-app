// Banc d'essai : parties complètes jouées par des bots (6 à 15 joueurs, rôles, mission, mode
// autonome ou nuit rythmée par le MJ, pauses du MJ, tirés au hasard), avec contrôle des règles
// à chaque évènement reçu par le MJ : ordre de la nuit, rôles morts qui ne se réveillent pas,
// jour après chaque nuit, règle de l'Ange, justesse du vainqueur, erreurs du serveur.
// Lance son propre serveur (lumières coupées, sauvegardes dans un dossier temporaire).
// Usage : node outils/banc-robots.js [port=3111] [nbParties=3] [graine=1]
//   Plusieurs bancs en parallèle : un port et une graine différents par banc.
//   CFG_FIXE='{"N":9,"cfg":{...}}' impose une composition (pour reproduire une anomalie).
// Chaque anomalie est imprimée avec le déroulé des derniers évènements et lignes du serveur.
const { sleep, demarrerServeur, arreterServeur, connecterMJ, piloterMJ } = require("../tests/outils");

const PORT = +process.argv[2] || 3111;
const NB = +process.argv[3] || 3;
let graine = +process.argv[4] || 1;
const alea = () => { graine = (graine * 1103515245 + 12345) % 2147483648; return graine / 2147483648; };
const entre = (a, b) => a + Math.floor(alea() * (b - a + 1));

// L'ordre attendu de la nuit, écrit ici exprès au lieu d'être repris du serveur : le banc vérifie
// la règle du serveur, il ne doit pas la lui emprunter. Un nouveau rôle de nuit s'ajoute aux deux.
const ORDRE_NUIT = ["cupid", "amoureux", "sisters", "salvateur", "wolves", "seer", "petiteFille", "corbeau", "witch"];

// Les lignes du serveur utiles au déroulé d'une anomalie (les 200 dernières)
const lignesServeur = [];
function surveiller(t) {
  t.split(/\r?\n/).filter(l => /setPhase|killPlayer|resolveDayVote|startDayVote|Chasseur|mayorTransfer|autoResolve|pause|resume/i.test(l))
    .forEach(l => { lignesServeur.push(l.replace(/^\[[^\]]*\] /, "").slice(0, 120)); if (lignesServeur.length > 200) lignesServeur.shift(); });
}

async function partie(num) {
  const viol = [];
  const t0 = Date.now(); const journal = []; lignesServeur.length = 0;
  // Le déroulé horodaté ; une anomalie l'emporte avec elle, avec les dernières lignes du serveur
  const noter = l => { journal.push(((Date.now() - t0) / 1000).toFixed(1) + "s " + l); };
  const anomalie = m => { viol.push(m + "\n      déroulé : " + journal.slice(-18).join(" | ") + "\n      serveur : " + lignesServeur.slice(-30).join(" || ")); };
  const { mj } = await connecterMJ(PORT);
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
  cfg.conseil = alea() < 0.75;
  if (FIXE) Object.assign(cfg, FIXE.cfg);
  const modeMJ = FIXE ? !FIXE.cfg.autoMode : alea() < 0.6;          // nuit rythmée par le MJ (sinon mode autonome)
  cfg.autoMode = !modeMJ;
  cfg.autoVoteMode = [1, 2, 4, 5][entre(0, 3)];
  cfg.mjPilotedDay = modeMJ ? alea() < 0.6 : false;
  const desc = `N=${N} ${modeMJ ? "MJ" : "auto"}${cfg.mjPilotedDay ? "+jourPiloté" : ""}${cfg.mission ? "+mission" : ""}${cfg.conseil ? "" : "+sansConseil"} rôles=` +
    Object.entries(cfg).filter(([k, v]) => typeof v === "number" && v > 0 && k !== "autoVoteMode").map(([k, v]) => k + (v > 1 ? v : "")).join(",");

  // --- Suivi ---
  let roles = {}, morts = new Set(), amoureux = [], phases = [], fin = null, angeRevele = null;
  let premierVoteFait = false, tireAuSort = false;
  let nuitEnCours = [], apresAube = false, apresFinDeJour = false, premiereNuitFaite = false;
  const vivants = () => Object.keys(roles).filter(id => !morts.has(id));
  const vivantRole = r => vivants().some(id => roles[id] === r);
  mj.on("rolesMJ", d => { if (d && d.roles && Object.keys(d.roles).length) roles = { ...d.roles }; });
  mj.on("loversInfo", l => { amoureux = l || []; });
  mj.on("playerDied", d => {
    noter("mort " + d.name + "/" + d.role);
    if (morts.has(d.id)) anomalie(`mort deux fois : ${d.name}`);
    morts.add(d.id);
  });
  mj.on("dawnResult", d => {
    noter("AUBE morts=" + (d.deaths || []).map(x => x.name + "/" + x.role).join(","));
    if (apresAube) anomalie("deux aubes sans jour entre les deux");
    apresAube = true; nuitEnCours = [];
  });
  const finDeJour = (type, d) => {
    if (type === "vote" && d && d.role === "Ange" && !premierVoteFait && !tireAuSort) anomalie(`l'Ange désigné au 1er vote est mort au lieu de gagner (${d.name})`);
    if (type === "vote" && d && morts.has(d.id)) anomalie(`éliminé au vote alors que déjà mort : ${d.name}`);
    premierVoteFait = true; tireAuSort = false;
    apresFinDeJour = true;
  };
  mj.on("randomElim", () => { tireAuSort = true; });
  mj.on("dayVoteResult", d => { noter("vote→" + d.name + "/" + d.role); finDeJour("vote", d); });
  mj.on("gamePaused", () => noter("PAUSE")); mj.on("gameResumed", () => noter("REPRISE"));
  mj.on("chasseurMustShoot", () => noter("chasseur doit tirer")); mj.on("mayorMustTransfer", () => noter("écharpe à transmettre"));
  mj.on("idiotRevealed", d => finDeJour("idiot", d));
  mj.on("daySkipped", () => finDeJour("passe"));
  mj.on("angeRevele", d => {
    if (premierVoteFait) anomalie("Ange révélé après le premier vote");
    angeRevele = d; premierVoteFait = true;
  });
  mj.on("gameEnd", m => {
    fin = m;
    const viv = vivants(), lv = viv.filter(id => roles[id] === "Loup").length, autres = viv.length - lv;
    if (m.includes("Ange")) { if (!angeRevele) anomalie("victoire de l'Ange sans révélation"); }
    else if (angeRevele) anomalie("Ange révélé mais autre vainqueur : " + m);
    else if (m.includes("Loups")) { if (!(lv > 0 && lv >= autres)) anomalie(`victoire des Loups injustifiée (loups ${lv}, autres ${autres})`); }
    else if (m.includes("Amoureux")) { if (!(viv.length === 2 && viv.every(id => amoureux.includes(id)))) anomalie("victoire des Amoureux injustifiée"); }
    else if (m.includes("Villageois")) { if (lv !== 0) anomalie(`victoire du Village avec ${lv} loup(s) vivant(s)`); }
  });

  // --- Le MJ automatique : il passe les étapes de la nuit, ouvre le tir du Chasseur et la
  // transmission du maire, lance la nuit, chaque fois en 0,3 à 3 s comme un humain ---
  piloterMJ(mj, { delai: () => entre(300, 3000), nuit: true });
  const minuteurs = [];
  const plus_tard = (ms, f) => minuteurs.push(setTimeout(f, ms));
  mj.on("councilStartMJ", () => { if (cfg.conseil === false) anomalie("Conseil des Morts ouvert alors qu'il est désactivé"); });
  // Matin : il annonce (ou non) l'évènement, puis le débat
  mj.on("matinEnAttente", d => {
    if (d && d.evenement && alea() < 0.7) plus_tard(1500, () => mj.emit("mjAnnoncerEvenement"));
    if (alea() < 0.6) plus_tard(2500, () => mj.emit("mjFinAnnonceMatin"));
  });
  let phaseCourante = null, debutPhase = Date.now(), debutVote = null;
  mj.on("voteStartedMJ", () => { debutVote = Date.now(); });
  // Un vrai MJ reclique si rien ne bouge (un clic tombé pendant une pause est ignoré)
  minuteurs.push(setInterval(() => {
    const depuis = Date.now() - debutPhase;
    if (phaseCourante === "wolves" && depuis > 13000) mj.emit("lockWolfVotes");
    if (phaseCourante === "mayorVote" && depuis > 13000) mj.emit("lockMayorVote");
    if (phaseCourante === "nightPause" && depuis > 4000) mj.emit("mjEtapeSuivante");
    if (phaseCourante === "crepuscule" && depuis > 5000) mj.emit("mjLancerNuit");
    if ((phaseCourante === "chasseur" || phaseCourante === "mayorTransfer") && depuis > 5000) mj.emit("mjOuvrirAction");
    if (phaseCourante === "day" && cfg.mjPilotedDay && !debutVote && depuis > 9000) mj.emit("startVote", 1);
    if (phaseCourante === "day" && debutVote && Date.now() - debutVote > entre(9000, 15000)) mj.emit("lockDayVotes");
  }, 2500));
  mj.on("phase", p => {
    phases.push(p); noter("phase " + p);
    phaseCourante = p; debutPhase = Date.now(); debutVote = null;
    // Contrôles de cohérence de la nuit
    if (ORDRE_NUIT.includes(p)) {
      if (apresAube) anomalie(`nuit qui reprend juste après l'aube (« ${p} » avant le jour)`);
      const besoin = { seer: "Voyante", petiteFille: "PetiteFille", corbeau: "Corbeau", witch: "Sorcière", salvateur: "Salvateur", cupid: "Cupidon" }[p];
      if (besoin && !vivantRole(besoin)) anomalie(`phase ${p} alors que ${besoin} est mort(e) ou absent(e)`);
      if (p === "sisters" && vivants().filter(id => roles[id] === "Sœurs").length < 2) anomalie("Sœurs réveillées sans 2 sœurs vivantes");
      if (p === "petiteFille") {
        const pf = vivants().find(id => roles[id] === "PetiteFille");
        if (pf && vivants().filter(id => id !== pf).length < 3) anomalie("Petite Fille réveillée avec moins de 3 autres vivants");
      }
      if (p === "cupid" && premiereNuitFaite) anomalie("Cupidon réveillé après la 1re nuit");
      if (p === "amoureux" && !nuitEnCours.includes("cupid")) anomalie("amoureux réveillés sans Cupidon cette nuit");
      const dernier = nuitEnCours[nuitEnCours.length - 1];
      if (dernier && ORDRE_NUIT.indexOf(p) <= ORDRE_NUIT.indexOf(dernier)) anomalie(`ordre de nuit incorrect : ${dernier} puis ${p}`);
      nuitEnCours.push(p);
      apresFinDeJour = false;
      premiereNuitFaite = premiereNuitFaite || p !== "cupid";
    }
    if (p === "crepuscule" && nuitEnCours.length) anomalie("crépuscule en pleine nuit");
    if (p === "day") {
      if (apresFinDeJour) anomalie("deux jours de suite sans nuit");
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
  // Bloquée = aucune phase depuis 4 min (les plus longues attentes normales sont les filets de
  // 3 min). Une partie de 15 joueurs qui avance peut dépasser 12 min depuis le crépuscule et le
  // réveil menés par le MJ : seule une durée totale de 25 min la déclare trop longue.
  while (!fin && Date.now() - debut < 25 * 60 * 1000 && Date.now() - debutPhase < 4 * 60 * 1000) await sleep(1000);
  minuteurs.forEach(clearTimeout);   // vaut aussi pour la relance (setInterval)
  const duree = Math.round((Date.now() - debut) / 1000);
  if (!fin) anomalie((Date.now() - debutPhase >= 4 * 60 * 1000 ? "partie bloquée (aucune phase depuis 4 min)" : "partie trop longue (pas de fin en 25 min)")
    + ` — dernières phases : ${phases.slice(-8).join(" → ")}`);
  mj.close();
  await sleep(9000);  // laisse s'éteindre les minuteries du serveur (7 s de fin d'aube, 8,2 s de vote)
  return { num, desc, duree, fin, viol, jours: phases.filter(p => p === "day").length, pf: phases.filter(p => p === "petiteFille").length };
}

(async () => {
  const srv = await demarrerServeur(PORT, { surLigne: surveiller });
  const resultats = [];
  for (let i = 1; i <= NB; i++) {
    const r = await partie(i);
    resultats.push(r);
    console.log(`[${PORT}] partie ${i} (${r.desc}) : ${r.duree}s, ${r.jours} jour(s), PF ${r.pf}× → ${r.fin || "AUCUNE FIN"}` + (r.viol.length ? `\n    ❌ ${r.viol.join("\n    ❌ ")}` : "  ✅"));
  }
  await arreterServeur(srv);
  const nbViol = resultats.reduce((a, r) => a + r.viol.length, 0);
  console.log(`[${PORT}] BILAN : ${resultats.length} parties, ${nbViol} anomalie(s) de règle, ${srv.erreurs.length} erreur(s) serveur`);
  srv.erreurs.forEach(e => console.log(`[${PORT}] ERREUR SERVEUR : ${e}`));
  // Une anomalie ou une erreur du serveur fait échouer le banc
  process.exit(nbViol || srv.erreurs.length ? 1 : 0);
})().catch(e => { console.error(`[${PORT}] Erreur fatale : ${e.message}`); process.exit(2); });
