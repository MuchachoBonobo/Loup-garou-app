/**
 * tests/navigateur.js — des parties complètes jouées dans de vrais navigateurs (Chrome invisible) :
 * chaque téléphone et la tablette du MJ cliquent sur les vrais boutons. À chaque étape, on vérifie
 * ce que chaque écran affiche (cartes, voile de nuit, listes de choix, écran de débat, écran de
 * mort, boutons de vote, fin de partie) et qu'aucune page n'a d'erreur JavaScript.
 *
 * Partie 1 — 2 loups, 4 villageois, MJ qui pilote le jour, sans Conseil ni mission.
 *   Nuit 1 : les loups tuent V1. Jour 1 : le village élimine L1. Nuit 2 : L2 tue V2.
 *   Jour 2 : le village élimine L2 → victoire du village. Le maire (V4) n'est jamais visé.
 * Partie 2 — les rôles qui choisissent : Salvateur, Voyante, Petite Fille, Corbeau, Sorcière,
 *   Chasseur (+ 1 loup, 1 villageois maire). Le loup tue le Chasseur, qui l'emporte à l'aube.
 *
 * Usage : npm run test:navigateur   (Chrome installé, puppeteer-core ; ~4 min, ports 3107 et 3112)
 */
"use strict";
// Les fonctions passées à page.evaluate / waitForFunction (dont les conditions en MAJUSCULES : AFFICHE,
// CARTE…) s'exécutent dans la page : elles ne voient pas les outils de ce fichier
/* global document, getComputedStyle, players, role, socket, window */
const puppeteer = require("puppeteer-core");
const { sleep, demarrerServeur, arreterServeur, compteur } = require("./outils");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const { check, bilan } = compteur();
const erreursJS = [];

// Un élément est-il affiché (ni display:none, ni caché, ni transparent) ?
const AFFICHE = sel => {
  const e = document.querySelector(sel);
  if (!e) return false;
  const cs = getComputedStyle(e);
  return cs.display !== "none" && cs.visibility !== "hidden" && +cs.opacity > 0.5;
};
const PRESENT = sel => !!document.querySelector(sel);
// La carte d'annonce affiche-t-elle ce texte, avec n photos ?
const CARTE = ([texte, n]) => document.getElementById("dayDeathCard").className === "show"
  && document.getElementById("dayDeathCard").innerText.includes(texte)
  && (n === undefined || document.getElementById("deathPhotos").children.length === n);
// Une liste de choix : n boutons, chacun avec la photo (ou l'initiale) puis le prénom
const LISTE = ([sel, n]) => { const b = [...document.querySelectorAll(sel + " button")]; return b.length === n && b.every(x => x.children.length === 1 && x.textContent.trim().length > 0); };

// Attend une condition dans la page ; renvoie true/false au lieu de lever une erreur
const attendre = (page, fn, arg, ms = 15000) =>
  page.waitForFunction(fn, { timeout: ms, polling: 200 }, arg).then(() => true, () => false);
const affiche = (page, sel, ms) => attendre(page, AFFICHE, sel, ms);
// Vrai sur chaque écran ; une liste d'écrans vide ne prouve rien, c'est un échec
const tous = async (pages, fn) => pages.length > 0 && (await Promise.all(pages.map(fn))).every(Boolean);
const texte = (page, id) => page.evaluate(i => document.getElementById(i).innerText, id);
// Clic (sur l'élément qui porte ce texte, si précisé) ; introuvable = échec tout de suite, pas une attente vaine plus loin
const clic = async (page, sel, libelle = null) => {
  const ok = await page.evaluate((s, t) => { const e = [...document.querySelectorAll(s)].find(x => t === null || x.textContent.trim() === t); if (e) e.click(); return !!e; }, sel, libelle);
  if (!ok) check(`bouton introuvable : ${sel}${libelle ? ` « ${libelle} »` : ""}`, false);
  return ok;
};
// Bouton d'un joueur dans la liste : vote du maire, attaque des loups, vote du jour, vision
const boutonJoueur = (action, id) => `#players button[onclick="${action}('${id}')"]`;

// Serveur, navigateurs (un par téléphone), salon, lancement par le MJ et pilote du MJ
async function preparer(navigateur, port, noms, composition) {
  const serveur = await demarrerServeur(port);
  const ouvrir = async (nom, chemin) => {
    const ctx = await navigateur.createBrowserContext();   // stockage séparé : un téléphone chacun
    const page = await ctx.newPage();
    await page.setViewport({ width: 390, height: 844 });
    page.on("pageerror", e => erreursJS.push(`${nom} : ${e.message}`));
    page.on("console", m => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) erreursJS.push(`${nom} : ${m.text()}`); });
    await page.goto(`http://localhost:${port}${chemin}`, { waitUntil: "domcontentloaded" });
    return page;
  };
  const mj = await ouvrir("MJ", "/mj");
  const tel = {};
  for (const n of noms) {
    const p = await ouvrir(n, "/");
    await clic(p, "#introScreen");
    await p.type("#name", n);
    await clic(p, 'button[onclick="join()"]');
    tel[n] = p;
  }
  const pages = Object.values(tel);
  check(`chaque téléphone voit les ${noms.length} joueurs`, await tous(pages, p => attendre(p, n => document.querySelectorAll("#players .player-row").length === n, noms.length)));
  await mj.evaluate(c => {
    document.querySelectorAll("#mjSectionStart input[type=number]").forEach(i => { i.value = 0; });
    for (const [id, n] of Object.entries(c)) document.getElementById(id).value = n;
    for (const id of ["mission", "conseil", "autoMode"]) { const x = document.getElementById(id); if (x) x.checked = false; }
    document.getElementById("mjPilotedDay").checked = true;
  }, composition);
  await clic(mj, 'button[onclick="startGame()"]');
  check("la carte « Découvre ton rôle » s'affiche partout", await tous(pages, p => affiche(p, "#roleRevealCover")));
  const roleDe = {};
  for (const n of noms) roleDe[n] = await tel[n].evaluate(() => role);
  const id = n => tel[n].evaluate(nom => players.find(p => p.name === nom)?.id, n);
  // Choix d'un joueur dans une liste de choix (photo + prénom)
  const choisir = async (page, liste, nom) => clic(page, `${liste} button[data-id="${await id(nom)}"]`);
  // La tablette du MJ propose cette action en haut (bouton actif), puis le MJ la lance
  const etapeMJ = async (nom, libelle, ms = 20000) => {
    check(nom, await attendre(mj, t => { const b = document.getElementById("mjBtnActionSuivante"); return getComputedStyle(document.getElementById("mjActionSuivante")).display !== "none" && b.textContent.includes(t) && !b.disabled; }, libelle, ms));
    await clic(mj, "#mjBtnActionSuivante");
  };
  // Le MJ de test lance la nuit et passe les étapes dès qu'on le lui propose
  let pilote = true;
  (async () => {
    while (pilote) {
      await mj.evaluate(() => {
        for (const c of ["#lancerNuitCard", "#etapeSuivanteCard"]) {
          const carte = document.querySelector(c);
          if (carte && getComputedStyle(carte).display !== "none") carte.querySelector("button").click();
        }
      }).catch(() => {});
      await sleep(500);
    }
  })();
  const fermer = async () => {
    pilote = false;
    await sleep(600);
    for (const p of [mj, ...pages]) await p.browserContext().close().catch(() => {});
    await arreterServeur(serveur);
  };
  return { mj, tel, pages, noms, roleDe, id, choisir, etapeMJ, fermer };
}

// Une partie : bandeau, préparation, déroulé ; un plantage du déroulé compte comme un échec, et tout est refermé
async function partie(navigateur, titre, port, noms, composition, deroule) {
  console.log("\n" + "━".repeat(62) + "\n" + titre + "\n" + "━".repeat(62) + "\n▶ Salon et lancement");
  const P = await preparer(navigateur, port, noms, composition);
  await deroule(P).catch(e => check(`${titre} : sans plantage du test`, false, e.message));
  await P.fermer();
}

// Découverte du rôle sur chaque téléphone : carte retournée, détails, fermeture. Avec deux loups, le
// premier doit voir son compagnon sur la carte retournée, et pas dans la description du rôle.
async function decouvrirRoles({ tel, pages }, [loup, compagnon] = []) {
  console.log("\n▶ Découverte du rôle");
  for (const p of pages) await clic(p, "#roleFlip");
  check("la carte retournée montre le rôle", await tous(pages, p => attendre(p, () => document.getElementById("rfRoleName").innerText.trim().length > 0)));
  if (compagnon) { const t = await texte(tel[loup], "rfSecrets"); check("un loup voit son compagnon sur la carte retournée", t.includes(compagnon), t); }
  check("« Voir les détails » apparaît", await tous(pages, p => affiche(p, "#roleFlipContinue")));
  for (const p of pages) await clic(p, "#roleFlipContinue");
  check("la carte de rôle détaillée s'ouvre", await tous(pages, p => attendre(p, () => document.getElementById("roleCard").className === "show")));
  if (compagnon) { const t = await texte(tel[loup], "roleCard"); check("la description du rôle ne cite pas les compagnons", !t.includes(compagnon), t.slice(0, 120)); }
  for (const p of pages) await clic(p, '#roleCard button[onclick="closeRoleCard()"]');
  check("la carte de rôle se referme", await tous(pages, p => attendre(p, () => document.getElementById("roleCard").className === "")));
}

// Élection du maire : tout le monde vote pour `maire`, qui vote pour `sonVote`
async function election({ tel, pages, noms, id, etapeMJ }, maire, sonVote) {
  console.log("\n▶ Élection du maire");
  check("les boutons « Voter » du maire sont là", await tous(pages, p => attendre(p, n => document.querySelectorAll('#players button[onclick^="voteMayor"]').length === n, noms.length - 1)));
  const pourLeMaire = boutonJoueur("voteMayor", await id(maire));
  for (const n of noms) if (n !== maire) await clic(tel[n], pourLeMaire);
  await clic(tel[maire], boutonJoueur("voteMayor", await id(sonVote)));
  await etapeMJ("MJ : « Valider le Maire » en haut", "Valider le Maire");
  check("la carte du maire s'affiche partout", await tous(pages, p => attendre(p, () => document.getElementById("mayorCard").hasAttribute("data-open"))));
}

// Fin de partie : l'écran de fin sur tous les téléphones, qui annonce la victoire du village
async function victoireDuVillage({ tel, pages }, temoin) {
  console.log("\n▶ Fin de partie");
  check(`l'écran de fin s'affiche sur les ${pages.length} téléphones`, await tous(pages, p => affiche(p, "#endCard", 30000)));
  const titre = await texte(tel[temoin], "endTitle");
  check("il annonce la victoire du village", /village/i.test(titre), titre);
}

// ═══════════════════════════════════════════════════════════════════════════════════════
async function partieVillage(P) {
  const { mj, tel, noms, roleDe, id, etapeMJ } = P;
  const loups = noms.filter(n => roleDe[n] === "Loup"), vill = noms.filter(n => roleDe[n] !== "Loup");
  check("2 loups et 4 villageois", loups.length === 2 && vill.length === 4, roleDe);
  const [L1, L2] = loups, [V1, V2, V3, V4] = vill;

  await decouvrirRoles(P, [L1, L2]);
  await election(P, V4, V3);
  const carteMaire = await tel[V1].evaluate(() => ({ nom: document.getElementById("mayorCardNom").innerText, photo: document.getElementById("mayorCardPhoto").children.length }));
  check("elle montre le nom et la photo du maire", carteMaire.nom === V4 && carteMaire.photo === 1, carteMaire);

  const morts = [];
  const vivants = () => noms.filter(n => !morts.includes(n));
  const nuit = async (num, tueurs, victime) => {
    console.log(`\n▶ Nuit ${num}`);
    check(`nuit ${num} : les villageois vivants ont le voile de nuit`, await tous(vivants().filter(n => !tueurs.includes(n)).map(n => tel[n]), p => affiche(p, "#nightCoverScreen", 30000)));
    const attaque = boutonJoueur("voteWolf", await id(victime));
    check(`nuit ${num} : les loups ont leurs boutons « Attaquer »`, await tous(tueurs.map(n => tel[n]), p => attendre(p, PRESENT, attaque)));
    for (const n of tueurs) await clic(tel[n], attaque);
    check(`nuit ${num} : le MJ voit les votes des loups en haut`, await attendre(mj, v => document.getElementById("wolfVotes").innerText.includes(v), victime));
    await etapeMJ(`nuit ${num} : MJ « Valider l'attaque des loups »`, "Valider l'attaque");
    morts.push(victime);
    const temoins = vivants().map(n => tel[n]);
    check(`aube ${num} : la carte du matin nomme ${victime}, avec sa photo`, await tous(temoins, p => attendre(p, CARTE, [victime, 1], 30000)));
    check(`aube ${num} : pas de bouton « Continuer » (le MJ mène)`, await tous(temoins, p => p.evaluate(() => getComputedStyle(document.getElementById("deathCardBtn")).display === "none")));
    await etapeMJ(`aube ${num} : MJ « Lancer le débat »`, "Lancer le débat");
    check(`jour ${num} : écran de débat chez les vivants`, await tous(temoins, p => affiche(p, "#dayDebateScreen")));
    check(`jour ${num} : écran de mort chez ${victime}`, await affiche(tel[victime], "#deadFullScreen"));
  };
  const vote = async (num, condamne, sonVote) => {
    console.log(`\n▶ Vote du jour ${num}`);
    await etapeMJ(`jour ${num} : MJ « Lancer le vote »`, "Lancer le vote", 30000);
    const votants = vivants(), autres = votants.filter(n => n !== condamne).map(n => tel[n]);
    const contre = boutonJoueur("voteDay", await id(condamne)), sien = boutonJoueur("voteDay", await id(sonVote));
    check(`jour ${num} : boutons « Voter » chez les vivants`, await tous(autres, p => attendre(p, PRESENT, contre)));
    for (const n of votants) await clic(tel[n], n === condamne ? sien : contre);
    await etapeMJ(`jour ${num} : MJ « Terminer le vote »`, "Terminer le vote");
    morts.push(condamne);
    check(`jour ${num} : la carte du vote nomme ${condamne}`, await tous(autres, p => attendre(p, CARTE, [condamne, 1])));
  };

  await nuit(1, [L1, L2], V1);
  console.log("\n▶ Tablette du MJ rechargée en plein jour");
  const mortsAvant = await texte(mj, "dead");
  mj.once("dialog", d => d.accept());   // « Une partie est en cours — vraiment quitter ? »
  await mj.reload({ waitUntil: "domcontentloaded" });
  check("MJ rechargé : la liste des morts est la même qu'avant", await attendre(mj, t => document.getElementById("dead").innerText === t && t.includes("☠️"), mortsAvant), mortsAvant);
  check("MJ rechargé : les personnages sont là", await attendre(mj, ns => ns.every(n => document.getElementById("roles").innerText.includes(n)), noms));
  await vote(1, L1, V3);
  await nuit(2, [L2], V2);
  await vote(2, L2, V3);
  await victoireDuVillage(P, V3);
}

// ═══════════════════════════════════════════════════════════════════════════════════════
async function partieRoles(P) {
  const { mj, tel, noms, roleDe, id, choisir, etapeMJ } = P;
  const [loup, voy, salv, corb, sorc, chass, pf, vill] = ["Loup", "Voyante", "Salvateur", "Corbeau", "Sorcière", "Chasseur", "PetiteFille", "Villageois"].map(r => noms.find(n => roleDe[n] === r));
  check("un joueur par rôle", [loup, voy, salv, corb, sorc, chass, pf, vill].every(Boolean), roleDe);
  await decouvrirRoles(P);
  await election(P, vill, voy);

  console.log("\n▶ Nuit 1 — Salvateur");
  check("Salvateur : la liste des 8 vivants, avec photos", await attendre(tel[salv], LISTE, ["#salvateurTargets", 8], 30000));
  await choisir(tel[salv], "#salvateurTargets", vill);

  console.log("\n▶ Nuit 1 — Loup");
  const attaque = boutonJoueur("voteWolf", await id(chass));
  check("le loup a ses boutons « Attaquer »", await attendre(tel[loup], PRESENT, attaque, 30000));
  await clic(tel[loup], attaque);
  await etapeMJ("MJ « Valider l'attaque des loups »", "Valider l'attaque");

  console.log("\n▶ Nuit 1 — Voyante");
  const vision = boutonJoueur("seerChoice", await id(loup));
  check("la Voyante a ses boutons « Voir »", await attendre(tel[voy], PRESENT, vision, 30000));
  await clic(tel[voy], vision);
  check("vision : la carte nomme le loup, avec sa photo", await attendre(tel[voy], CARTE, [loup + " est…", 1]));
  await clic(tel[voy], "#deathCardBtn");

  console.log("\n▶ Nuit 1 — Petite Fille");
  check("Petite Fille : la liste des 7 autres vivants, avec photos", await attendre(tel[pf], LISTE, ["#petiteFilleBtns", 7], 30000));
  const choix = [loup, voy, corb];
  for (const n of choix.slice(0, 2)) await choisir(tel[pf], "#petiteFilleBtns", n);
  check("à 2 joueurs, « Découvrir » reste grisé", await tel[pf].evaluate(() => document.getElementById("petiteFilleConfirmBtn").disabled));
  await choisir(tel[pf], "#petiteFilleBtns", corb);
  const sel = await tel[pf].evaluate(() => ({ actif: !document.getElementById("petiteFilleConfirmBtn").disabled, noms: document.getElementById("petiteFilleSelectedNames").innerText }));
  check("à 3 joueurs, « Découvrir » s'allume et les 3 prénoms s'affichent", sel.actif && choix.every(n => sel.noms.includes(n)), sel);
  await clic(tel[pf], "#petiteFilleConfirmBtn");
  check("résultat : « au moins un Loup », avec les 3 photos", await attendre(tel[pf], CARTE, ["au moins un Loup", 3]));
  await clic(tel[pf], "#deathCardBtn");

  console.log("\n▶ Nuit 1 — Corbeau");
  check("Corbeau : la liste des 8 vivants, avec photos", await attendre(tel[corb], LISTE, ["#corbeauTargets", 8], 30000));
  await choisir(tel[corb], "#corbeauTargets", salv);

  console.log("\n▶ Nuit 1 — Sorcière");
  check("Sorcière : « Sauver … ? » avec la victime", await attendre(tel[sorc], v => getComputedStyle(document.getElementById("witchPanel")).display !== "none" && document.getElementById("witchEtape").innerText.includes("Sauver " + v), chass, 30000));
  await clic(tel[sorc], "#witchEtape button", "Non");
  check("Sorcière : « Utiliser la potion de mort ? »", await attendre(tel[sorc], () => document.getElementById("witchEtape").innerText.includes("potion de mort")));
  await clic(tel[sorc], "#witchEtape button", "Oui");
  check("Sorcière : la liste « Qui empoisonner ? » (6, ni elle ni la victime), avec photos", await attendre(tel[sorc], LISTE, ["#witchCibles", 6]));
  await clic(tel[sorc], "#witchEtape button", "Passer");

  console.log("\n▶ Aube — le Chasseur");
  const temoins = noms.filter(n => n !== chass).map(n => tel[n]);
  check("la carte du matin nomme le Chasseur, avec sa photo", await tous(temoins, p => attendre(p, CARTE, [chass, 1], 30000)));
  // Chaque téléphone note la carte affichée juste après le tir (l'écran de fin la recouvre aussitôt)
  for (const p of temoins) await p.evaluate(() => socket.on("chasseurATire", () => setTimeout(() => {
    window.__tir = document.getElementById("dayDeathCard").innerText + "|" + document.getElementById("deathPhotos").children.length;
  }, 50)));
  await etapeMJ("MJ « Le Chasseur tire »", "Le Chasseur tire");
  check("Chasseur : la liste des 7 vivants, avec photos", await attendre(tel[chass], LISTE, ["#chasseurTargets", 7]));
  await choisir(tel[chass], "#chasseurTargets", loup);
  check("tous voient « Le Chasseur a tiré » sur le loup, avec sa photo", await tous(temoins, p => attendre(p, l => (window.__tir || "").includes("Le Chasseur a tiré") && window.__tir.includes(l) && window.__tir.endsWith("|1"), loup)));
  await victoireDuVillage(P, vill);
  const roles = await texte(mj, "roles"), morts = await texte(mj, "dead");
  check("MJ : les rôles portent leur nom (« Petite Fille », « Loup-Garou »)", roles.includes("Petite Fille") && roles.includes("Loup-Garou") && !roles.includes("PetiteFille"), roles.slice(0, 160));
  check("MJ : la liste des morts cite le Chasseur et le loup", morts.includes(chass) && morts.includes(loup), morts);
}

async function main() {
  console.log("═".repeat(62) + "\n🐺 LOUP-GAROU — Parties dans de vrais navigateurs\n" + "═".repeat(62));
  const navigateur = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  });
  await partie(navigateur, "PARTIE 1 — 2 loups, 4 villageois", 3107, ["Ana", "Bob", "Cyd", "Dan", "Eve", "Fox"], { loup: 2 }, partieVillage);
  await partie(navigateur, "PARTIE 2 — les rôles qui choisissent", 3112, ["Gil", "Hal", "Ivy", "Jon", "Kim", "Lou", "Max", "Ned"],
    { loup: 1, voyante: 1, salvateur: 1, corbeau: 1, sorciere: 1, chasseur: 1, petiteFille: 1 }, partieRoles);
  check("aucune erreur JavaScript dans les pages", erreursJS.length === 0, erreursJS.slice(0, 5).join(" ‖ "));
  await navigateur.close();
  process.exit(bilan());
}
main().catch(e => { console.error("Erreur fatale :", e.message); process.exit(2); });
