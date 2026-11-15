// outils/appairer-hue.js — prépare les lumières en flux continu (mode « Entertainment », 2026-11-15).
//
// Usage (sur l'ordinateur ET sur la tablette, chacun le sien) :
//   1. lancer : node outils/appairer-hue.js        (sur la tablette : raccourci « Appairer les lumières »)
//   2. quand il le demande, appuyer sur le gros bouton rond du Bridge Hue (on a 40 secondes).
//
// Il obtient du Bridge une nouvelle clé d'application avec sa « clientkey » (indispensable au flux),
// trouve la pièce des lampes (HUE_GROUP_ID, ou la pièce dont le nom contient « loup »), puis trouve
// ou crée la zone de divertissement qui les regroupe. Il écrit HUE_API_KEY, HUE_CLIENT_KEY,
// HUE_ZONE_ID (et HUE_GROUP_ID s'il manquait) dans le .env, sans jamais afficher les clés.
// L'ancienne clé reste valable sur le Bridge : rien ne casse si on s'arrête en route.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");

const ENV = path.join(__dirname, "..", ".env");
const agent = new https.Agent({ rejectUnauthorized: false });   // certificat autosigné du Bridge
const attendre = ms => new Promise(r => setTimeout(r, ms));

function lireEnv() {
  const valeurs = {};
  let lignes = [];
  try { lignes = fs.readFileSync(ENV, "utf8").split(/\r?\n/); } catch { /* pas encore de .env */ }
  for (const l of lignes) { const m = l.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/); if (m) valeurs[m[1]] = m[2]; }
  return { lignes, valeurs };
}
// Remplace (ou ajoute) des réglages du .env, sans toucher aux autres lignes
function ecrireEnv(nouveaux) {
  const { lignes } = lireEnv();
  const restants = { ...nouveaux };
  const sortie = lignes.map(l => {
    const m = l.match(/^\s*#?\s*([A-Z_]+)\s*=/);
    if (m && restants[m[1]] !== undefined) { const v = restants[m[1]]; delete restants[m[1]]; return `${m[1]}=${v}`; }
    return l;
  });
  while (sortie.length && sortie[sortie.length - 1] === "") sortie.pop();
  for (const [k, v] of Object.entries(restants)) sortie.push(`${k}=${v}`);
  fs.writeFileSync(ENV, sortie.join("\n") + "\n");
}

// Toujours une réponse : sur un délai dépassé, `destroy` ne lève pas toujours d'erreur, seule la fermeture est sûre
function requete(ip, methode, chemin, corps, cle) {
  return new Promise(promesse => {
    let fini = false, repondu = false;
    const resolve = r => { if (!fini) { fini = true; promesse(r); } };
    const texte = corps ? JSON.stringify(corps) : null;
    const req = https.request({
      hostname: ip, port: 443, path: chemin, method: methode, agent, timeout: 5000,
      headers: Object.assign({}, cle ? { "hue-application-key": cle } : {}, texte ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(texte) } : {}),
    }, res => {
      repondu = true;
      let buf = "";
      res.on("data", c => { buf += c; });
      res.on("end", () => { let json = null; try { json = JSON.parse(buf); } catch { /* illisible */ } resolve({ statut: res.statusCode, json }); });
      res.on("close", () => resolve({ statut: 0, json: null }));
    });
    req.on("error", e => resolve({ statut: 0, json: null, erreur: e.message }));
    req.on("timeout", () => req.destroy());
    req.on("close", () => { if (!repondu) resolve({ statut: 0, json: null }); });
    if (texte) req.write(texte);
    req.end();
  });
}

(async () => {
  const { valeurs } = lireEnv();
  const ip = process.argv[2] || valeurs.HUE_BRIDGE_IP;
  if (!ip) { console.log("Il manque l'adresse du Bridge : HUE_BRIDGE_IP dans le .env (ex. 192.168.8.147)."); process.exit(1); }
  const essai = await requete(ip, "GET", "/api/0/config");
  if (!essai.json) { console.log(`Le Bridge ne répond pas à l'adresse ${ip}. Vérifie qu'il est branché et que tu es sur le Wi-Fi « La nuit du village ».`); process.exit(1); }

  // 1. La clé, au bouton du Bridge
  console.log("\n👉 Appuie maintenant sur le gros bouton rond du Bridge Hue (tu as 40 secondes)…");
  const appareil = "loupgarou#" + (os.hostname().replace(/[^A-Za-z0-9-]/g, "").slice(0, 19) || "serveur");
  let cle = null, clientKey = null;
  for (let i = 0; i < 40 && !cle; i++) {
    const r = await requete(ip, "POST", "/api", { devicetype: appareil, generateclientkey: true });
    const ok = Array.isArray(r.json) && r.json[0] && r.json[0].success;
    if (ok && ok.username && ok.clientkey) { cle = ok.username; clientKey = ok.clientkey; break; }
    await attendre(1000);
  }
  if (!cle) { console.log("Pas de bouton dans les 40 secondes : relance l'outil et appuie quand il le demande."); process.exit(1); }
  ecrireEnv({ HUE_API_KEY: cle, HUE_CLIENT_KEY: clientKey, LIGHTS_ENABLED: "true" });
  console.log("✅ Nouvelle clé reçue et enregistrée dans le .env (elle n'est pas affichée).");

  // 2. La pièce des lampes, et ses lampes
  const get = async chemin => ((await requete(ip, "GET", chemin, null, cle)).json || {}).data || [];
  const [pieces, zonesHue, lampes, divertissements] = await Promise.all([
    get("/clip/v2/resource/room"), get("/clip/v2/resource/zone"), get("/clip/v2/resource/light"), get("/clip/v2/resource/entertainment")]);
  const groupes = [...pieces, ...zonesHue];
  const groupeId = valeurs.HUE_GROUP_ID;
  const piece = groupes.find(g => (g.services || []).some(s => s.rtype === "grouped_light" && s.rid === groupeId))
    || groupes.find(g => /loup/i.test((g.metadata && g.metadata.name) || ""));
  if (!piece) { console.log("Je ne trouve pas la pièce des lampes (une pièce dont le nom contient « Loup » dans l'appli Hue)."); process.exit(1); }
  const nouveaux = {};
  const groupeDeLaPiece = (piece.services || []).find(s => s.rtype === "grouped_light");
  if (!groupeId && groupeDeLaPiece) nouveaux.HUE_GROUP_ID = groupeDeLaPiece.rid;
  // Les appareils de la pièce (une pièce liste des appareils, une zone des lampes)
  const proprietaire = Object.fromEntries(lampes.map(l => [l.id, l.owner && l.owner.rid]));
  const appareils = new Set((piece.children || []).map(c => c.rtype === "light" ? proprietaire[c.rid] : c.rid));
  const services = divertissements.filter(e => e.renderer && e.owner && appareils.has(e.owner.rid));
  console.log(`💡 Pièce « ${piece.metadata.name} » : ${services.length} lampe(s) compatible(s) avec le flux.`);
  if (!services.length) { console.log("Aucune lampe de cette pièce n'accepte le flux : le jeu restera en commandes ordinaires."); process.exit(1); }

  // 3. La zone de divertissement : celle qui existe déjà avec ces lampes, sinon on la crée
  const zones = await get("/clip/v2/resource/entertainment_configuration");
  const ids = new Set(services.map(s => s.id));
  const contient = z => ((z.locations && z.locations.service_locations) || []).map(l => l.service && l.service.rid);
  let zone = zones.find(z => z.id === valeurs.HUE_ZONE_ID)
    || zones.find(z => { const r = contient(z); return r.length === ids.size && r.every(x => ids.has(x)); })
    || zones.find(z => /loup/i.test((z.metadata && z.metadata.name) || ""));
  if (zone) console.log(`🎭 Zone de divertissement trouvée : « ${zone.metadata.name} ».`);
  else {
    const r = await requete(ip, "POST", "/clip/v2/resource/entertainment_configuration", {
      type: "entertainment_configuration",
      metadata: { name: "Loup-Garou" },
      configuration_type: "other",
      locations: { service_locations: services.map((s, i) => ({
        service: { rid: s.id, rtype: "entertainment" },
        positions: [{ x: services.length > 1 ? -0.8 + 1.6 * i / (services.length - 1) : 0, y: 0.8, z: 0 }],
      })) },
    }, cle);
    const cree = r.json && r.json.data && r.json.data[0];
    if (!cree) {
      console.log("Je n'ai pas pu créer la zone de divertissement (réponse du Bridge : HTTP " + r.statut + ").");
      console.log("Crée-la dans l'appli Hue : Paramètres > Zones de divertissement > Créer, nomme-la « Loup-Garou »,");
      console.log("coche les lampes de la pièce, puis relance cet outil.");
      ecrireEnv(nouveaux);
      process.exit(1);
    }
    zone = { id: cree.rid, metadata: { name: "Loup-Garou" } };
    console.log("🎭 Zone de divertissement « Loup-Garou » créée.");
  }
  nouveaux.HUE_ZONE_ID = zone.id;
  ecrireEnv(nouveaux);
  console.log("\nTerminé. Relance le jeu : au démarrage, il écrit « [lumières] flux : établi ».");
  console.log("(Pour revenir aux commandes ordinaires : LIGHTS_MODE=classique dans le .env.)");
})().catch(e => { console.log("Erreur :", e.message); process.exit(1); });
