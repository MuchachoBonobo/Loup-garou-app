/**
 * tests/navigateur.js — une partie complète jouée dans de vrais navigateurs (Chrome invisible) :
 * six téléphones et la tablette du MJ, qui cliquent sur les vrais boutons. À chaque étape, on
 * vérifie ce que chaque écran affiche (cartes, voile de nuit, écran de débat, écran de mort,
 * boutons de vote, fin de partie) et qu'aucune page n'a d'erreur JavaScript.
 *
 * Partie : 2 loups, 4 villageois, MJ qui pilote le jour, sans Conseil ni mission.
 * Nuit 1 : les loups tuent V1. Jour 1 : le village élimine L1. Nuit 2 : L2 tue V2.
 * Jour 2 : le village élimine L2 → victoire du village. Le maire (V4) n'est jamais visé.
 *
 * Usage : npm run test:navigateur   (Chrome installé, puppeteer-core ; ~3 min, port 3107)
 */
"use strict";
// Les fonctions passées à page.evaluate / waitForFunction s'exécutent dans la page
/* global document, getComputedStyle, players, role, AFFICHE_MJ */
const { spawn } = require("child_process");
const puppeteer = require("puppeteer-core");
const path = require("path"), os = require("os"), fs = require("fs");

const PORT = 3107, URL = `http://localhost:${PORT}`;
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const SNAP = path.join(os.tmpdir(), "loupgarou-tests-navigateur");
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const erreurs = [];
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

async function main() {
  console.log("═".repeat(62) + "\n🐺 LOUP-GAROU — Partie dans de vrais navigateurs — port " + PORT + "\n" + "═".repeat(62));
  const serveur = spawn("node", ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(PORT), LIGHTS_ENABLED: "false", SNAPSHOT_DIR: SNAP },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((res, rej) => {
    serveur.stdout.on("data", d => { if (d.toString().includes("démarré")) res(); });
    setTimeout(() => rej(new Error("serveur non démarré en 10 s")), 10000);
  });
  const navigateur = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  });
  const erreursJS = [];
  const ouvrir = async (nom, chemin) => {
    const ctx = await navigateur.createBrowserContext();   // stockage séparé : un téléphone chacun
    const page = await ctx.newPage();
    await page.setViewport({ width: 390, height: 844 });
    page.on("pageerror", e => erreursJS.push(`${nom} : ${e.message}`));
    page.on("console", m => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) erreursJS.push(`${nom} : ${m.text()}`); });
    await page.goto(URL + chemin, { waitUntil: "domcontentloaded" });
    return page;
  };

  try {
    // ── Salon ──────────────────────────────────────────────────
    console.log("\n▶ Salon");
    const mj = await ouvrir("MJ", "/mj");
    const NOMS = ["Ana", "Bob", "Cyd", "Dan", "Eve", "Fox"];
    const tel = {};
    for (const n of NOMS) {
      const p = await ouvrir(n, "/");
      await clic(p, "#introScreen");
      await p.type("#name", n);
      await clic(p, 'button[onclick="join()"]');
      tel[n] = p;
    }
    const pages = Object.values(tel);
    check("chaque téléphone voit les 6 joueurs", await tous(pages, p => attendre(p, () => document.querySelectorAll("#players .player-row").length === 6)));

    // ── Lancement par le MJ ────────────────────────────────────
    console.log("\n▶ Lancement et découverte du rôle");
    await mj.evaluate(() => {
      document.querySelectorAll("#mjSectionStart input[type=number]").forEach(i => { i.value = 0; });
      document.getElementById("loup").value = 2;
      for (const id of ["mission", "conseil", "autoMode"]) { const c = document.getElementById(id); if (c) c.checked = false; }
      document.getElementById("mjPilotedDay").checked = true;
    });
    await clic(mj, 'button[onclick="startGame()"]');
    check("la carte « Découvre ton rôle » s'affiche partout", await tous(pages, p => affiche(p, "#roleRevealCover")));
    const roleDe = {};
    for (const n of NOMS) roleDe[n] = await tel[n].evaluate(() => role);
    const loups = NOMS.filter(n => roleDe[n] === "Loup"), vill = NOMS.filter(n => roleDe[n] !== "Loup");
    check("2 loups et 4 villageois", loups.length === 2 && vill.length === 4, JSON.stringify(roleDe));
    const [L1, L2] = loups, [V1, V2, V3, V4] = vill;
    const id = async n => tel[n].evaluate(nom => players.find(p => p.name === nom)?.id, n);

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

    // ── Élection du maire ──────────────────────────────────────
    console.log("\n▶ Élection du maire");
    const idV4 = await id(V4);
    check("les boutons « Voter » du maire sont là", await tous(pages, p => attendre(p, () => document.querySelectorAll('#players button[onclick^="voteMayor"]').length === 5)));
    for (const n of NOMS) if (n !== V4) await clic(tel[n], `#players button[onclick="voteMayor('${idV4}')"]`);
    await clic(tel[V4], `#players button[onclick="voteMayor('${await id(V3)}')"]`);
    const barre = (txt, ms = 20000) => attendre(mj, t => { const b = document.getElementById("mjBtnActionSuivante"); return AFFICHE_MJ(b) && b.textContent.includes(t) && !b.disabled; }, txt, ms);
    await mj.evaluate(`window.AFFICHE_MJ = b => !!b && getComputedStyle(document.getElementById("mjActionSuivante")).display !== "none"`);
    check("MJ : « Valider le Maire » en haut", await barre("Valider le Maire"));
    await clic(mj, "#mjBtnActionSuivante");
    check("la carte du maire s'affiche partout", await tous(pages, p => attendre(p, () => document.getElementById("mayorCard").hasAttribute("data-open"))));
    const carteMaire = await tel[V1].evaluate(() => ({ nom: document.getElementById("mayorCardNom").innerText, photo: document.getElementById("mayorCardPhoto").children.length }));
    check("elle montre le nom et la photo du maire", carteMaire.nom === V4 && carteMaire.photo === 1, JSON.stringify(carteMaire));

    // Le MJ de test lance la nuit et passe les étapes dès qu'on le lui propose
    let piloteActif = true;
    (async () => {
      while (piloteActif) {
        await mj.evaluate(() => {
          for (const c of ["#lancerNuitCard", "#etapeSuivanteCard"]) {
            const carte = document.querySelector(c);
            if (carte && getComputedStyle(carte).display !== "none") carte.querySelector("button").click();
          }
        }).catch(() => {});
        await sleep(500);
      }
    })();

    // ── Nuits et jours ─────────────────────────────────────────
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
      check(`aube ${num} : la carte du matin nomme ${victime}`, await tous(vivants, p => attendre(p, v => document.getElementById("dayDeathCard").className === "show" && document.getElementById("dayDeathCard").innerText.includes(v), victime, 30000)));
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
      check(`jour ${num} : la carte du vote nomme ${condamne}`, await tous(vivants.filter(n => n !== condamne).map(n => tel[n]), p => attendre(p, v => document.getElementById("dayDeathCard").className === "show" && document.getElementById("dayDeathCard").innerText.includes(v), condamne, 15000)));
    };

    const morts = [];
    await nuit(1, [L1, L2], V1);
    await vote(1, L1, V3);
    await nuit(2, [L2], V2);
    await vote(2, L2, V3);

    console.log("\n▶ Fin de partie");
    check("l'écran de fin s'affiche sur les 6 téléphones", await tous(pages, p => affiche(p, "#endCard", 30000)));
    const titre = await tel[V3].evaluate(() => document.getElementById("endTitle").innerText);
    check("il annonce la victoire du village", /village/i.test(titre), titre);
    piloteActif = false;
  } catch (e) {
    fail++; erreurs.push("crash : " + e.message); console.log("  ❌ crash :", e.message);
  }

  check("aucune erreur JavaScript dans les 7 pages", erreursJS.length === 0, erreursJS.slice(0, 5).join(" ‖ "));
  await navigateur.close();
  serveur.kill();
  try { fs.rmSync(SNAP, { recursive: true, force: true }); } catch (_) {}
  console.log("\n" + "═".repeat(62) + `\nBILAN : ${pass}/${pass + fail} vérifications passées`);
  if (erreurs.length) erreurs.forEach(e => console.log("  •", e));
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error("Erreur fatale :", e.message); process.exit(2); });
