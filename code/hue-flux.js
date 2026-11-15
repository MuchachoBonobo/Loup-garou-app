/**
 * hue-flux.js — Les lumières en flux continu : le mode « Entertainment » de Philips Hue (2026-11-15).
 *
 * Au lieu d'envoyer au Bridge une commande à chaque changement (au plus une par seconde conseillée
 * pour un groupe : des éclairs se perdaient ou arrivaient en retard), le jeu lui envoie 60 fois par
 * seconde la couleur de chaque lampe de la « zone de divertissement ». Une image perdue est
 * remplacée 15 ms plus tard ; les fondus sont calculés ici, image par image.
 *
 * Ce module ne décide d'aucune couleur : lights.js (scènes, effets, éclairs) lui dit seulement
 * « va vers cette couleur en tant de millisecondes » (`poser`), pour toutes les lampes ou pour l'une
 * d'elles (2026-11-15, suite 4) : les lampes sont numérotées de gauche à droite, d'après leur place
 * dans la zone de divertissement (appli Hue), pour les effets qui traversent la pièce. Tant que le flux n'est pas établi
 * (ou s'il tombe), lights.js envoie ses commandes à l'ancienne : la pièce n'est jamais livrée à elle-même.
 *
 * Il faut au Bridge : une clé avec sa « clientkey » (outils/appairer-hue.js, bouton du Bridge) et une
 * zone de divertissement contenant les lampes (le même outil la trouve ou la crée).
 *
 * Protocole (documentation Philips, « Hue Entertainment API », HueStream v2) :
 *   1. PUT /clip/v2/resource/entertainment_configuration/<id>  { "action": "start" }
 *   2. connexion DTLS 1.2 (UDP chiffré) au port 2100, clé partagée : identité = clé d'application,
 *      secret = clientkey (hexadécimal), suite TLS_PSK_WITH_AES_128_GCM_SHA256 ;
 *   3. des messages « HueStream » : en-tête de 16 octets, identifiant de la zone (36 caractères),
 *      puis 7 octets par canal (numéro, x, y, luminosité sur 16 bits chacun) ;
 *   4. sans message pendant 10 s, le Bridge clôt la session de lui-même (serveur arrêté net).
 */

"use strict";
const https = require("https");

const PORT_FLUX      = 2100;
// Environ 60 images par seconde (Philips conseille 50 à 60 : le Bridge en transmet 25 aux lampes, le
// reste couvre les pertes). 15 ms et non 20 : Windows arrondit ses minuteurs à 15,6 ms, et 20 y donnait 32.
const CADENCE_MS     = 15;
const RELANCE_MIN_MS = 5000;    // flux tombé ou refusé : nouvel essai, de plus en plus espacé…
const RELANCE_MAX_MS = 60000;   // …jusqu'à une minute
// Au repos (aucun fondu en cours) : une image toutes les 40 ms, la cadence du Bridge vers les lampes,
// suffit à garder le flux ouvert ; la pleine cadence ne sert que pendant un fondu ou un éclair
const REPOS_MS       = 40;
const DELAI_HTTP_MS  = 4000;
const DELAI_DTLS_MS  = 5000;

// Une image HueStream v2, en couleurs xy + luminosité : `couleurs[i]` pour `canaux[i]` (ou une seule
// couleur pour tous)
function paquet(zoneId, canaux, couleurs, sequence) {
  const tete = Buffer.alloc(16);
  tete.write("HueStream", 0, "ascii");
  tete[9] = 2; tete[10] = 0;        // version 2.0
  tete[11] = sequence & 0xff;       // numéro d'image (le Bridge l'ignore)
  tete[14] = 1;                     // espace de couleur : xy + luminosité (12, 13 et 15 : réservés, à 0)
  const corps = Buffer.alloc(7 * canaux.length);
  const v = n => Math.max(0, Math.min(0xffff, Math.round(n * 0xffff)));
  canaux.forEach((c, i) => {
    const couleur = Array.isArray(couleurs) ? couleurs[i] : couleurs;
    corps[i * 7] = c;
    corps.writeUInt16BE(v(couleur.x), i * 7 + 1);
    corps.writeUInt16BE(v(couleur.y), i * 7 + 3);
    corps.writeUInt16BE(v(couleur.b), i * 7 + 5);
  });
  return Buffer.concat([tete, Buffer.from(zoneId, "ascii"), corps]);
}

// La forme d'un fondu (p : de 0 à 1) : régulier, doux aux deux bouts (une respiration), ou vif puis
// lent (une cloche qui résonne, une lumière qui retombe)
const COURBES = {
  lineaire: p => p,
  douce:    p => (1 - Math.cos(Math.PI * p)) / 2,
  sortie:   p => 1 - Math.pow(1 - p, 3),
};

// Les canaux de la zone, rangés de gauche à droite (puis d'avant en arrière) d'après leur place
function rangerCanaux(channels) {
  const place = c => (c.position && typeof c.position.x === "number") ? c.position : { x: 0, y: 0 };
  return (channels || []).filter(c => Number.isInteger(c.channel_id))
    .sort((a, b) => (place(a).x - place(b).x) || (place(a).y - place(b).y) || (a.channel_id - b.channel_id))
    .map(c => c.channel_id);
}

// Le genre de chaque canal, dans l'ordre de `rangerCanaux` : « bande » (une Lightstrip, qui éclaire le
// mur derrière un meuble : en retrait dans les effets, demande d'Alexandre du 2026-11-15) ou « ampoule ».
// D'après l'appareil derrière chaque canal (canal → service de divertissement → appareil → produit).
function genresDesCanaux(channels, divertissements, appareils) {
  const proprietaire = new Map((divertissements || []).map(e => [e.id, e.owner && e.owner.rid]));
  const produit = new Map((appareils || []).map(d => [d.id, d.product_data || {}]));
  const parCanal = new Map((channels || []).map(c => {
    const rid = c.members && c.members[0] && c.members[0].service && c.members[0].service.rid;
    const p = produit.get(proprietaire.get(rid)) || {};
    return [c.channel_id, /strip/i.test((p.product_archetype || "") + " " + (p.product_name || "")) ? "bande" : "ampoule"];
  }));
  return rangerCanaux(channels).map(id => parCanal.get(id) || "ampoule");
}

// Couleur du jeu ({ xy: [x, y], bri: 0..254 }) → couleur du flux ({ x, y, b : 0..1 })
function versFlux(etat, avant) {
  const xy = Array.isArray(etat.xy) && etat.xy.length === 2 ? etat.xy : [avant.x, avant.y];
  const b  = typeof etat.bri === "number" ? Math.max(0, Math.min(254, etat.bri)) / 254 : avant.b;
  return { x: xy[0], y: xy[1], b };
}

/**
 * Le flux d'une zone. `surActif` : le flux vient de s'établir ; `surPerte` : il est tombé (lights.js
 * reprend alors la main avec ses commandes ordinaires). Aucune fonction ne lève d'erreur.
 * `dtls` : pour les tests seulement, une fausse connexion chiffrée (sinon node-dtls-client).
 */
function creerFlux({ bridgeIp, apiKey, clientKey, zoneId, log, surActif, surPerte, dtls: dtlsFactice }) {
  const agent = new https.Agent({ rejectUnauthorized: false });   // certificat autosigné du Bridge
  let etat = "arrete";              // arrete | demarrage | actif | attente
  let socket = null, minuterie = null, relance = null, delaiRelance = RELANCE_MIN_MS;
  let zone = zoneId || "", canaux = [], genres = [], sequence = 0, dernierEnvoi = 0;
  // Couleur affichée de chaque lampe : un fondu de `depart` vers `cible`, commencé à `t0`, sur
  // `duree` ms, de forme `courbe`. Une seule tant que la zone n'est pas connue (copiée ensuite).
  const SALON = { x: 0.42, y: 0.4, b: 0.5 };
  let fondus = [{ depart: SALON, cible: SALON, t0: 0, duree: 0, courbe: COURBES.lineaire }];
  let finDesFondus = 0;
  // Le volume des lumières (curseur 💡 de la tablette) : multiplie la luminosité de chaque image
  let volume = 1;
  // Un message répété (Bridge éteint : un essai par minute) ne s'écrit qu'une fois de suite
  let dernierMessage = "";
  const dire = (...a) => { const m = a.join(" "); if (m !== dernierMessage) { dernierMessage = m; log(...a); } };

  function couleurA(i, t) {
    const f = fondus[i] || fondus[0];
    if (f.duree <= 0 || t >= f.t0 + f.duree) return f.cible;
    const p = f.courbe(Math.max(0, (t - f.t0) / f.duree));
    const { depart: d, cible: c } = f;
    return { x: d.x + (c.x - d.x) * p, y: d.y + (c.y - d.y) * p, b: d.b + (c.b - d.b) * p };
  }

  // Requête au Bridge (API v2) → { statut, json } ; jamais d'exception, et toujours une réponse : sur un
  // délai dépassé, `destroy` ne lève pas toujours d'erreur, seule la fermeture est sûre (`close`)
  function requete(methode, chemin, corps) {
    return new Promise(promesse => {
      let fini = false, repondu = false;
      const resolve = r => { if (!fini) { fini = true; promesse(r); } };
      const texte = corps ? JSON.stringify(corps) : null;
      const req = https.request({
        hostname: bridgeIp, port: 443, path: chemin, method: methode, agent, timeout: DELAI_HTTP_MS,
        headers: Object.assign({ "hue-application-key": apiKey }, texte ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(texte) } : {}),
      }, res => {
        repondu = true;
        let buf = "";
        res.on("data", c => { buf += c; });
        res.on("end", () => { let json = null; try { json = JSON.parse(buf); } catch { /* réponse illisible */ } resolve({ statut: res.statusCode, json }); });
        res.on("error", () => resolve({ statut: 0, json: null }));
        res.on("close", () => resolve({ statut: 0, json: null }));   // coupée avant la fin (sans effet après « end »)
      });
      req.on("error", e => { dire("flux : Bridge injoignable :", e.message); resolve({ statut: 0, json: null }); });
      req.on("timeout", () => { dire("flux : le Bridge ne répond pas."); req.destroy(); });
      req.on("close", () => { if (!repondu) resolve({ statut: 0, json: null }); });   // fermée sans réponse
      if (texte) req.write(texte);
      req.end();
    });
  }

  // La zone de divertissement : celle du .env (HUE_ZONE_ID), sinon celle dont le nom contient
  // « loup », sinon la seule qui existe. Retient ses canaux (un par lampe).
  async function trouverZone() {
    const r = await requete("GET", "/clip/v2/resource/entertainment_configuration");
    const zones = (r.json && r.json.data) || [];
    const choisie = zones.find(z => z.id === zone)
      || (!zone && (zones.find(z => /loup/i.test((z.metadata && z.metadata.name) || "")) || (zones.length === 1 ? zones[0] : null)));
    if (!choisie) {
      dire(zones.length ? "flux : zone de divertissement introuvable (HUE_ZONE_ID ?) — mode ordinaire."
                       : "flux : aucune zone de divertissement sur le Bridge (outils/appairer-hue.js la crée) — mode ordinaire.");
      return false;
    }
    zone = choisie.id;
    canaux = rangerCanaux(choisie.channels);
    if (!canaux.length) { dire("flux : la zone n'a aucune lampe — mode ordinaire."); return false; }
    // Ampoules et bandes : sans réponse du Bridge, toutes des ampoules (les effets marchent, sans retrait)
    const [ent, dev] = await Promise.all([requete("GET", "/clip/v2/resource/entertainment"), requete("GET", "/clip/v2/resource/device")]);
    genres = genresDesCanaux(choisie.channels, ent.json && ent.json.data, dev.json && dev.json.data);
    // Chaque lampe part de la couleur commune d'avant
    const t = Date.now();
    fondus = canaux.map((_, i) => Object.assign({}, fondus[i] || fondus[0], { depart: couleurA(i, t) }));
    return true;
  }

  async function demarrer() {
    if (etat !== "arrete" && etat !== "attente") return;
    etat = "demarrage";
    clearTimeout(relance); relance = null;
    try {
      if (!(await trouverZone())) return attendre();
      if (etat !== "demarrage") return;   // arrêté entre-temps
      const r = await requete("PUT", `/clip/v2/resource/entertainment_configuration/${zone}`, { action: "start" });
      if (etat !== "demarrage") return;
      if (r.statut !== 200) { dire("flux : le Bridge refuse de démarrer la zone (HTTP " + r.statut + ")."); return attendre(); }
      const { dtls } = dtlsFactice ? { dtls: dtlsFactice } : await import("node-dtls-client");
      if (etat !== "demarrage") return;   // arrêté entre-temps
      socket = dtls.createSocket({
        type: "udp4", address: bridgeIp, port: PORT_FLUX, timeout: DELAI_DTLS_MS,
        psk: { [apiKey]: Buffer.from(clientKey, "hex") },
        ciphers: ["TLS_PSK_WITH_AES_128_GCM_SHA256"],
      });
      socket.on("connected", () => {
        if (etat !== "demarrage") return;
        etat = "actif";
        delaiRelance = RELANCE_MIN_MS;
        const bandes = genres.filter(g => g === "bande").length;
        dire("flux : établi —", canaux.length - bandes, "ampoule(s)" + (bandes ? " et " + bandes + " bande(s)" : "") + ", zone", zone);
        try { if (surActif) surActif(); } catch (e) { dire("flux :", e.message); }
        minuterie = setInterval(envoyerImage, CADENCE_MS);
      });
      socket.on("error", e => { dire("flux : erreur de connexion :", e && e.message); perdu(); });
      socket.on("close", () => perdu());
    } catch (e) {
      dire("flux : démarrage impossible :", e.message);
      if (etat === "demarrage") attendre();
    }
  }

  function envoyerImage() {
    if (etat !== "actif" || !socket) return;
    const t = Date.now();
    if (t >= finDesFondus + CADENCE_MS && t - dernierEnvoi < REPOS_MS) return;   // au repos : moins souvent
    dernierEnvoi = t;
    const avecVolume = c => (volume === 1 ? c : { x: c.x, y: c.y, b: Math.min(1, c.b * volume) });
    try { socket.send(paquet(zone, canaux, canaux.map((_, i) => avecVolume(couleurA(i, t))), sequence++)); }
    catch (e) { dire("flux : envoi impossible :", e.message); perdu(); }
  }

  // Le flux est tombé (Wi-Fi, Bridge redémarré…) : on rend la main au mode ordinaire, on libère la
  // zone, et on réessaie plus tard
  function perdu() {
    if (etat === "arrete" || etat === "attente") return;
    const etaitActif = etat === "actif";
    fermerSocket();
    requete("PUT", `/clip/v2/resource/entertainment_configuration/${zone}`, { action: "stop" });
    attendre();
    if (etaitActif) { dire("flux : perdu — mode ordinaire en attendant."); try { if (surPerte) surPerte(); } catch (e) { dire("flux :", e.message); } }
  }

  function attendre() {
    fermerSocket();
    etat = "attente";
    clearTimeout(relance);
    relance = setTimeout(demarrer, delaiRelance);
    delaiRelance = Math.min(RELANCE_MAX_MS, delaiRelance * 2);
  }

  function fermerSocket() {
    clearInterval(minuterie); minuterie = null;
    const s = socket; socket = null;
    if (s) { try { s.removeAllListeners(); s.on("error", () => {}); s.close(); } catch { /* déjà fermé */ } }
  }

  return {
    demarrer,
    actif: () => etat === "actif",
    // Nombre de lampes du flux (0 tant que la zone n'est pas connue)
    lampes: () => canaux.length,
    // Le genre de chaque lampe (« ampoule » ou « bande »), dans l'ordre des numéros
    genres: () => canaux.map((_, i) => genres[i] || "ampoule"),
    // Va vers `couleur` ({ xy, bri }) en `ms` millisecondes, depuis la couleur affichée à l'instant.
    // `options.lampe` : un numéro (0 = la plus à gauche) ou une liste ; sans lui, toutes les lampes.
    // `options.courbe` : "lineaire" (défaut), "douce" ou "sortie".
    poser(couleur, ms, options) {
      const t = Date.now();
      const o = options || {};
      const toutes = fondus.map((_, i) => i);
      const quelles = o.lampe == null ? toutes : [].concat(o.lampe).filter(i => Number.isInteger(i) && i >= 0 && i < fondus.length);
      const duree = Math.max(0, ms || 0);
      for (const i of quelles) {
        const depart = couleurA(i, t);
        fondus[i] = { depart, cible: versFlux(couleur, depart), t0: t, duree, courbe: COURBES[o.courbe] || COURBES.lineaire };
      }
      finDesFondus = Math.max(finDesFondus, t + duree);
    },
    // Le volume des lumières (1 = les scènes telles quelles), pris en compte à l'image suivante
    volume(v) { volume = v; },
    // La couleur affichée par une lampe (pour les vérifications)
    couleur: i => couleurA(i || 0, Date.now()),
    arreter() {
      clearTimeout(relance); relance = null;
      const etaitLa = etat !== "arrete";
      fermerSocket();
      etat = "arrete";
      if (etaitLa && zone) requete("PUT", `/clip/v2/resource/entertainment_configuration/${zone}`, { action: "stop" });
    },
    etat: () => etat,
  };
}

module.exports = { creerFlux, paquet, rangerCanaux, genresDesCanaux, COURBES };
