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
// Les fonctions passées à page.evaluate / waitForFunction s'exécutent dans la page
/* global document, getComputedStyle, players, role, socket, window */
const { spawn } = require("child_process");
const puppeteer = require("puppeteer-core");
const path = require("path"), os = require("os"), fs = require("fs");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const erreurs = [], erreursJS = [];
function check(label, cond, detail) {
  if (cond) { pass++; console.log("  ✅", label); }
  else { fail++; erreurs.push(label + (detail ? " | " + detail : "")); console.log("  ❌", label, detail || ""); }
}

// Un élément est-il affiché (ni display:none, ni caché, ni transparent) ?
const AFFICHE = sel => {
  const e = document.querySelector(sel);
  if (!e) return false;
  const cs = getComputedStyle(e);
  return cs.display !== "none" && cs.visibility !== "hidden" && +cs.opacity > 0.5;
};
// Attend une condition dans la page ; renvoie true/false au lieu de lever une erreur
const attendre = (page, fn, arg, ms = 15000) =>
  page.waitForFunction(fn, { timeout: ms, polling: 200 }, arg).then(() => true, () => false);
const affiche = (page, sel, ms) => attendre(page, AFFICHE, sel, ms);
const tous = async (pages, fn) => (await Promise.all(pages.map(fn))).every(Boolean);
const clic = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); if (e) e.click(); return !!e; }, sel);
const clicTexte = (page, sel, texte) => page.evaluate((s, t) => {
  const b = [...document.querySelectorAll(s)].find(x => x.textContent.trim() === t);
  if (b) b.click(); return !!b;
}, sel, texte);
// La carte d'annonce affiche-t-elle ce texte, avec n photos ?
const CARTE = ([texte, n]) => document.getElementById("dayDeathCard").className === "show"
  && document.getElementById("dayDeathCard").innerText.includes(texte)
  && (n === undefined || document.getElementById("deathPhotos").children.length === n);

// Serveur, navigateurs (un par téléphone), salon, lancement par le MJ et pilote du MJ
async function preparer(navigateur, port, noms, composition) {
  const serveur = spawn("node", ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(port), LIGHTS_ENABLED: "false", SNAPSHOT_DIR: path.join(os.tmpdir(), "loupgarou-tests-navigateur-" + port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((res, rej) => {
    serveur.stdout.on("data", d => { if (d.toString().includes("démarré")) res(); });
    setTimeout(() => rej(new Error("serveur non démarré en 10 s")), 10000);
  });
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
  const barre = (txt, ms = 20000) => attendre(mj, t => { const b = document.getElementById("mjBtnActionSuivante"); return getComputedStyle(document.getElementById("mjActionSuivante")).display !== "none" && b.textContent.includes(t) && !b.disabled; }, txt, ms);
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
    serveur.kill();
  };
  return { mj, tel, pages, roleDe, id, barre, fermer };
}

// Élection du maire : tout le monde vote pour `maire`, qui vote pour `sonVote`
async function election({ mj, tel, pages, id, barre }, noms, maire, sonVote) {
  console.log("\n▶ Élection du maire");
  const idMaire = await id(maire);
  check("les boutons « Voter » du maire sont là", await tous(pages, p => attendre(p, n => document.querySelectorAll('#players button[onclick^="voteMayor"]').length === n, noms.length - 1)));
  for (const n of noms) if (n !== maire) await clic(tel[n], `#players button[onclick="voteMayor('${idMaire}')"]`);
  await clic(tel[maire], `#players button[onclick="voteMayor('${await id(sonVote)}')"]`);
  check("MJ : « Valider le Maire » en haut", await barre("Valider le Maire"));
  await clic(mj, "#mjBtnActionSuivante");
  check("la carte du maire s'affiche partout", await tous(pages, p => attendre(p, () => document.getElementById("mayorCard").hasAttribute("data-open"))));
  return idMaire;
}

// ═══════════════════════════════════════════════════════════════════════════════════════
async function partieVillage(navigateur) {
  console.log("\n" + "━".repeat(62) + "\nPARTIE 1 — 2 loups, 4 villageois\n" + "━".repeat(62) + "\n▶ Salon et lancement");
  const NOMS = ["Ana", "Bob", "Cyd", "Dan", "Eve", "Fox"];
  const P = await preparer(navigateur, 3107, NOMS, { loup: 2 });
  const { mj, tel, pages, roleDe, id, barre } = P;
  try {
    const loups = NOMS.filter(n => roleDe[n] === "Loup"), vill = NOMS.filter(n => roleDe[n] !== "Loup");
    check("2 loups et 4 villageois", loups.length === 2 && vill.length === 4, JSON.stringify(roleDe));
    const [L1, L2] = loups, [V1, V2, V3, V4] = vill;

    console.log("\n▶ Découverte du rôle");
    for (const n of NOMS) await clic(tel[n], "#roleFlip");
    check("la carte retournée montre le rôle", await tous(pages, p => attendre(p, () => document.getElementById("rfRoleName").innerText.trim().length > 0)));
    const compagnon = await tel[L1].evaluate(() => document.getElementById("rfSecrets").innerText);
    check("un loup voit son compagnon sur la carte retournée", compagnon.includes(L2), compagnon);
    check("« Voir les détails » apparaît", await tous(pages, p => affiche(p, "#roleFlipContinue")));
    for (const n of NOMS) await clic(tel[n], "#roleFlipContinue");
    check("la carte de rôle détaillée s'ouvre", await tous(pages, p => attendre(p, () => document.getElementById("roleCard").className === "show")));
    const details = await tel[L1].evaluate(() => document.getElementById("roleCard").innerText);
    check("la description du rôle ne cite pas les compagnons", !details.includes(L2), details.slice(0, 120));
    for (const n of NOMS) await clic(tel[n], '#roleCard button[onclick="closeRoleCard()"]');
    check("la carte de rôle se referme", await tous(pages, p => attendre(p, () => document.getElementById("roleCard").className === "")));

    await election(P, NOMS, V4, V3);
    const carteMaire = await tel[V1].evaluate(() => ({ nom: document.getElementById("mayorCardNom").innerText, photo: document.getElementById("mayorCardPhoto").children.length }));
    check("elle montre le nom et la photo du maire", carteMaire.nom === V4 && carteMaire.photo === 1, JSON.stringify(carteMaire));

    const morts = [];
    const nuit = async (num, tueurs, victime) => {
      console.log(`\n▶ Nuit ${num}`);
      const dormeurs = NOMS.filter(n => !tueurs.includes(n) && !morts.includes(n)).map(n => tel[n]);
      check(`nuit ${num} : les villageois vivants ont le voile de nuit`, await tous(dormeurs, p => affiche(p, "#nightCoverScreen", 30000)));
      const idVictime = await id(victime);
      check(`nuit ${num} : les loups ont leurs boutons « Attaquer »`, await tous(tueurs.map(n => tel[n]), p => attendre(p, i => !!document.querySelector(`#players button[onclick="voteWolf('${i}')"]`), idVictime)));
      for (const n of tueurs) await clic(tel[n], `#players button[onclick="voteWolf('${idVictime}')"]`);
      check(`nuit ${num} : le MJ voit les votes des loups en haut`, await attendre(mj, v => document.getElementById("wolfVotes").innerText.includes(v), victime));
      check(`nuit ${num} : MJ « Valider l'attaque des loups »`, await barre("Valider l'attaque"));
      await clic(mj, "#mjBtnActionSuivante");
      morts.push(victime);
      const vivants = NOMS.filter(n => !morts.includes(n)).map(n => tel[n]);
      check(`aube ${num} : la carte du matin nomme ${victime}, avec sa photo`, await tous(vivants, p => attendre(p, CARTE, [victime, 1], 30000)));
      check(`aube ${num} : pas de bouton « Continuer » (le MJ mène)`, await tous(vivants, p => p.evaluate(() => getComputedStyle(document.getElementById("deathCardBtn")).display === "none")));
      check(`aube ${num} : MJ « Lancer le débat »`, await barre("Lancer le débat"));
      await clic(mj, "#mjBtnActionSuivante");
      check(`jour ${num} : écran de débat chez les vivants`, await tous(vivants, p => affiche(p, "#dayDebateScreen")));
      check(`jour ${num} : écran de mort chez ${victime}`, await affiche(tel[victime], "#deadFullScreen"));
    };
    const vote = async (num, condamne, sonVote) => {
      console.log(`\n▶ Vote du jour ${num}`);
      check(`jour ${num} : MJ « Lancer le vote »`, await barre("Lancer le vote", 30000));
      await clic(mj, "#mjBtnActionSuivante");
      const vivants = NOMS.filter(n => !morts.includes(n));
      const idC = await id(condamne), idS = await id(sonVote);
      check(`jour ${num} : boutons « Voter » chez les vivants`, await tous(vivants.filter(n => n !== condamne).map(n => tel[n]), p => attendre(p, i => !!document.querySelector(`#players button[onclick="voteDay('${i}')"]`), idC)));
      for (const n of vivants) await clic(tel[n], `#players button[onclick="voteDay('${n === condamne ? idS : idC}')"]`);
      check(`jour ${num} : MJ « Terminer le vote »`, await barre("Terminer le vote"));
      await clic(mj, "#mjBtnActionSuivante");
      morts.push(condamne);
      check(`jour ${num} : la carte du vote nomme ${condamne}`, await tous(vivants.filter(n => n !== condamne).map(n => tel[n]), p => attendre(p, CARTE, [condamne, 1])));
    };

    await nuit(1, [L1, L2], V1);
    console.log("\n▶ Tablette du MJ rechargée en plein jour");
    const mortsAvant = await mj.evaluate(() => document.getElementById("dead").innerText);
    mj.once("dialog", d => d.accept());   // « Une partie est en cours — vraiment quitter ? »
    await mj.reload({ waitUntil: "domcontentloaded" });
    check("MJ rechargé : la liste des morts est la même qu'avant", await attendre(mj, t => document.getElementById("dead").innerText === t && t.includes("☠️"), mortsAvant), mortsAvant);
    check("MJ rechargé : les personnages sont là", await attendre(mj, noms => noms.every(n => document.getElementById("roles").innerText.includes(n)), NOMS));
    await vote(1, L1, V3);
    await nuit(2, [L2], V2);
    await vote(2, L2, V3);

    console.log("\n▶ Fin de partie");
    check("l'écran de fin s'affiche sur les 6 téléphones", await tous(pages, p => affiche(p, "#endCard", 30000)));
    const titre = await tel[V3].evaluate(() => document.getElementById("endTitle").innerText);
    check("il annonce la victoire du village", /village/i.test(titre), titre);
  } catch (e) {
    fail++; erreurs.push("partie 1, crash : " + e.message); console.log("  ❌ crash :", e.message);
  }
  await P.fermer();
}

// ═══════════════════════════════════════════════════════════════════════════════════════
async function partieRoles(navigateur) {
  console.log("\n" + "━".repeat(62) + "\nPARTIE 2 — les rôles qui choisissent\n" + "━".repeat(62) + "\n▶ Salon et lancement");
  const NOMS = ["Gil", "Hal", "Ivy", "Jon", "Kim", "Lou", "Max", "Ned"];
  const P = await preparer(navigateur, 3112, NOMS, { loup: 1, voyante: 1, salvateur: 1, corbeau: 1, sorciere: 1, chasseur: 1, petiteFille: 1 });
  const { mj, tel, pages, roleDe, id, barre } = P;
  try {
    const qui = r => NOMS.find(n => roleDe[n] === r);
    const [loup, voy, salv, corb, sorc, chass, pf, vill] = ["Loup", "Voyante", "Salvateur", "Corbeau", "Sorcière", "Chasseur", "PetiteFille", "Villageois"].map(qui);
    check("un joueur par rôle", [loup, voy, salv, corb, sorc, chass, pf, vill].every(Boolean), JSON.stringify(roleDe));
    for (const n of NOMS) { await clic(tel[n], "#roleFlip"); await clic(tel[n], "#roleFlipContinue"); await clic(tel[n], '#roleCard button[onclick="closeRoleCard()"]'); }
    await election(P, NOMS, vill, voy);
    // Une liste de choix : n boutons, chacun avec la photo (ou l'initiale) puis le prénom
    const LISTE = ([sel, n]) => { const b = [...document.querySelectorAll(sel + " button")]; return b.length === n && b.every(x => x.children.length === 1 && x.textContent.trim().length > 0); };

    console.log("\n▶ Nuit 1 — Salvateur");
    check("Salvateur : la liste des 8 vivants, avec photos", await attendre(tel[salv], LISTE, ["#salvateurTargets", 8], 30000));
    await clic(tel[salv], `#salvateurTargets button[data-id="${await id(vill)}"]`);

    console.log("\n▶ Nuit 1 — Loup");
    const idChass = await id(chass), idLoup = await id(loup);
    check("le loup a ses boutons « Attaquer »", await attendre(tel[loup], i => !!document.querySelector(`#players button[onclick="voteWolf('${i}')"]`), idChass, 30000));
    await clic(tel[loup], `#players button[onclick="voteWolf('${idChass}')"]`);
    check("MJ « Valider l'attaque des loups »", await barre("Valider l'attaque"));
    await clic(mj, "#mjBtnActionSuivante");

    console.log("\n▶ Nuit 1 — Voyante");
    check("la Voyante a ses boutons « Voir »", await attendre(tel[voy], i => !!document.querySelector(`#players button[onclick="seerChoice('${i}')"]`), idLoup, 30000));
    await clic(tel[voy], `#players button[onclick="seerChoice('${idLoup}')"]`);
    check("vision : la carte nomme le loup, avec sa photo", await attendre(tel[voy], CARTE, [loup + " est…", 1]));
    await clic(tel[voy], "#deathCardBtn");

    console.log("\n▶ Nuit 1 — Petite Fille");
    check("Petite Fille : la liste des 7 autres vivants, avec photos", await attendre(tel[pf], LISTE, ["#petiteFilleBtns", 7], 30000));
    const choix = [loup, voy, corb];
    for (const n of choix.slice(0, 2)) await clic(tel[pf], `#petiteFilleBtns button[data-id="${await id(n)}"]`);
    check("à 2 joueurs, « Découvrir » reste grisé", await tel[pf].evaluate(() => document.getElementById("petiteFilleConfirmBtn").disabled));
    await clic(tel[pf], `#petiteFilleBtns button[data-id="${await id(corb)}"]`);
    const sel = await tel[pf].evaluate(() => ({ actif: !document.getElementById("petiteFilleConfirmBtn").disabled, noms: document.getElementById("petiteFilleSelectedNames").innerText }));
    check("à 3 joueurs, « Découvrir » s'allume et les 3 prénoms s'affichent", sel.actif && choix.every(n => sel.noms.includes(n)), JSON.stringify(sel));
    await clic(tel[pf], "#petiteFilleConfirmBtn");
    check("résultat : « au moins un Loup », avec les 3 photos", await attendre(tel[pf], CARTE, ["au moins un Loup", 3]));
    await clic(tel[pf], "#deathCardBtn");

    console.log("\n▶ Nuit 1 — Corbeau");
    check("Corbeau : la liste des 8 vivants, avec photos", await attendre(tel[corb], LISTE, ["#corbeauTargets", 8], 30000));
    await clic(tel[corb], `#corbeauTargets button[data-id="${await id(salv)}"]`);

    console.log("\n▶ Nuit 1 — Sorcière");
    check("Sorcière : « Sauver … ? » avec la victime", await attendre(tel[sorc], v => getComputedStyle(document.getElementById("witchPanel")).display !== "none" && document.getElementById("witchEtape").innerText.includes("Sauver " + v), chass, 30000));
    await clicTexte(tel[sorc], "#witchEtape button", "Non");
    check("Sorcière : « Utiliser la potion de mort ? »", await attendre(tel[sorc], () => document.getElementById("witchEtape").innerText.includes("potion de mort")));
    await clicTexte(tel[sorc], "#witchEtape button", "Oui");
    check("Sorcière : la liste « Qui empoisonner ? » (6, ni elle ni la victime), avec photos", await attendre(tel[sorc], LISTE, ["#witchCibles", 6]));
    await clicTexte(tel[sorc], "#witchEtape button", "Passer");

    console.log("\n▶ Aube — le Chasseur");
    const vivants = NOMS.filter(n => n !== chass).map(n => tel[n]);
    check("la carte du matin nomme le Chasseur, avec sa photo", await tous(vivants, p => attendre(p, CARTE, [chass, 1], 30000)));
    check("MJ « Le Chasseur tire »", await barre("Le Chasseur tire"));
    for (const p of vivants) await p.evaluate(() => socket.on("chasseurATire", () => setTimeout(() => {
      window.__tir = document.getElementById("dayDeathCard").innerText + "|" + document.getElementById("deathPhotos").children.length;
    }, 50)));
    await clic(mj, "#mjBtnActionSuivante");
    check("Chasseur : la liste des 7 vivants, avec photos", await attendre(tel[chass], LISTE, ["#chasseurTargets", 7]));
    await clic(tel[chass], `#chasseurTargets button[data-id="${idLoup}"]`);
    check("tous voient « Le Chasseur a tiré » sur le loup, avec sa photo", await tous(vivants, p => attendre(p, l => (window.__tir || "").includes("Le Chasseur a tiré") && window.__tir.includes(l) && window.__tir.endsWith("|1"), loup)));
    check("l'écran de fin s'affiche sur les 8 téléphones", await tous(pages, p => affiche(p, "#endCard", 30000)));
    const vueMJ = await mj.evaluate(() => ({ roles: document.getElementById("roles").innerText, morts: document.getElementById("dead").innerText }));
    check("MJ : les rôles portent leur nom (« Petite Fille », « Loup-Garou »)", vueMJ.roles.includes("Petite Fille") && vueMJ.roles.includes("Loup-Garou") && !vueMJ.roles.includes("PetiteFille"), vueMJ.roles.slice(0, 160));
    check("MJ : la liste des morts cite le Chasseur et le loup", vueMJ.morts.includes(chass) && vueMJ.morts.includes(loup), vueMJ.morts);
    const titre = await tel[vill].evaluate(() => document.getElementById("endTitle").innerText);
    check("il annonce la victoire du village", /village/i.test(titre), titre);
  } catch (e) {
    fail++; erreurs.push("partie 2, crash : " + e.message); console.log("  ❌ crash :", e.message);
  }
  await P.fermer();
}

async function main() {
  console.log("═".repeat(62) + "\n🐺 LOUP-GAROU — Parties dans de vrais navigateurs\n" + "═".repeat(62));
  const navigateur = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  });
  await partieVillage(navigateur);
  await partieRoles(navigateur);
  check("aucune erreur JavaScript dans les pages", erreursJS.length === 0, erreursJS.slice(0, 5).join(" ‖ "));
  await navigateur.close();
  for (const port of [3107, 3112]) try { fs.rmSync(path.join(os.tmpdir(), "loupgarou-tests-navigateur-" + port), { recursive: true, force: true }); } catch (_) {}
  console.log("\n" + "═".repeat(62) + `\nBILAN : ${pass}/${pass + fail} vérifications passées`);
  if (erreurs.length) erreurs.forEach(e => console.log("  •", e));
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error("Erreur fatale :", e.message); process.exit(2); });
