// outils/mesurer-sons.js — mesure la sonie perçue de chaque son (EBU R128 / ITU BS.1770 : filtre K,
// fenêtres de 400 ms, intégrée avec portes), décodé par Chrome : aucun autre logiciel à installer.
// Usage : node outils/mesurer-sons.js   (port 3121, ~4 min : les deux musiques font une heure)
// Rend les valeurs à recopier dans MESURES (public/mj.html) et ce que chaque son donne à la lecture.
// Pourquoi pas le niveau moyen : il compte les silences et les graves que l'oreille n'entend pas.
/* global OfflineAudioContext, fetch, SOUNDS */
"use strict";
const puppeteer = require("puppeteer-core");
const { demarrerServeur, arreterServeur } = require("../tests/outils");

const PORT = 3121, CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

// S'exécute dans la page. `url` : un fichier, ou "test" pour un signal de référence (sinus de 1 kHz à
// pleine échelle sur un seul canal : la norme annonce −3,01 LUFS)
async function mesurer(url) {
  const sr = 48000;
  let canaux;
  if (url === "test") {
    const x = new Float32Array(sr * 5);
    for (let i = 0; i < x.length; i++) x[i] = Math.sin(2 * Math.PI * 997 * i / sr);
    canaux = [x];
  } else {
    const brut = await (await fetch(url)).arrayBuffer();
    const buf = await new OfflineAudioContext(2, sr * 2, sr).decodeAudioData(brut);   // rééchantillonné à 48 kHz
    canaux = [];
    for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) canaux.push(buf.getChannelData(c));
  }
  const biquad = (x, b0, b1, b2, a1, a2) => {
    const y = new Float64Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) { const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
    return y;
  };
  // Filtre K (coefficients à 48 kHz) ; le 2e étage coupe les graves que l'oreille n'entend pas
  const coupeBas = x => biquad(x, 1.0, -2.0, 1.0, -1.99004745483398, 0.99007225036621);
  const filtreK = x => coupeBas(biquad(x, 1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585));
  let crete = 0, somme = 0, creteSansGraves = 0;
  const filtres = canaux.map(x => {
    for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > crete) crete = a; somme += x[i] * x[i]; }
    for (const v of coupeBas(x)) { const a = Math.abs(v); if (a > creteSansGraves) creteSansGraves = a; }
    return filtreK(x);
  });
  const n = filtres[0].length;
  const cumul = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) { let e = 0; for (const f of filtres) e += f[i] * f[i]; cumul[i + 1] = cumul[i] + e; }
  // Un son mono sort sur les deux enceintes : compté comme deux canaux identiques (sauf le signal de référence)
  const lufs = e => e > 0 ? -0.691 + 10 * Math.log10(e * (canaux.length === 1 && url !== "test" ? 2 : 1)) : -Infinity;
  const l = Math.round(0.4 * sr), p = Math.round(0.1 * sr), m = [];
  if (n < l) m.push(cumul[n] / l);
  else for (let i = 0; i + l <= n; i += p) m.push((cumul[i + l] - cumul[i]) / l);
  let eMax = 0;
  for (const e of m) if (e > eMax) eMax = e;
  const g1 = m.filter(e => lufs(e) > -70);
  const moy1 = g1.reduce((a, b) => a + b, 0) / (g1.length || 1);
  const g2 = g1.filter(e => lufs(e) > lufs(moy1) - 10);
  const db = v => +(20 * Math.log10(v || 1e-6)).toFixed(1);
  return {
    canaux: canaux.length, duree: +(n / sr).toFixed(1),
    moyen: +(10 * Math.log10(somme / (n * canaux.length) || 1e-12)).toFixed(1),
    crete: db(crete), creteSansGraves: db(creteSansGraves),
    moment: +lufs(eMax).toFixed(1),
    integree: +lufs(g2.reduce((a, b) => a + b, 0) / (g2.length || 1)).toFixed(1),
  };
}

(async () => {
  const serveur = await demarrerServeur(PORT);
  const nav = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await nav.newPage();
  page.on("pageerror", e => console.log("ERREUR dans la page :", e.message));
  await page.goto(`http://localhost:${PORT}/mj`, { waitUntil: "domcontentloaded" });
  const ref = await page.evaluate(mesurer, "test");
  console.log(`Contrôle : sinus de référence ${ref.moment} LUFS (la norme annonce −3,0)\n`);
  const sons = await page.evaluate(() => SOUNDS);
  const res = {};
  for (const [k, f] of Object.entries(sons)) { res[k] = await page.evaluate(mesurer, "/" + f); console.log(k.padEnd(17), JSON.stringify(res[k])); }
  console.log("\n// À recopier dans MESURES (mj.html) : [sonie, crête]");
  const fins = k => k.startsWith("endgame"), musiques = ["lobby", "night", "day", "rainynight", "murmures"];
  console.log(Object.entries(res).map(([k, r]) => `  ${k}:[${(fins(k) || musiques.includes(k)) ? r.integree : r.moment},${r.crete}]`).join(",\n"));
  await nav.close();
  await arreterServeur(serveur);
  process.exit(0);
})().catch(e => { console.error("ÉCHEC :", e); process.exit(1); });
