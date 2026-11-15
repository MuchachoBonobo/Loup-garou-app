/**
 * lights.js — Pilote Philips Hue pour Loup-Garou.
 *
 * Mode "fire-and-forget" : aucun appel ne bloque le moteur de jeu, aucune
 * erreur ne remonte au jeu (les fonctions publiques et l'appel réseau l'arrêtent ici :
 * les modules du jeu appellent les lumières sans précaution). Si LIGHTS_ENABLED != "true"
 * (défaut), le module est totalement dormant — pratique tant que tu n'as pas
 * de Bridge / pas envie d'allumer les lumières.
 *
 * Configuration : LIGHTS_ENABLED, HUE_BRIDGE_IP, HUE_API_KEY, HUE_GROUP_ID, LIGHTS_DEBUG,
 * HUE_CLIENT_KEY, HUE_ZONE_ID, LIGHTS_MODE, LIGHTS_DECALAGE_SON, lues dans .env — chacune expliquée
 * dans .env.example (avec la façon d'obtenir la clé et l'identifiant du groupe).
 *
 * Deux façons de parler au Bridge (2026-11-15) :
 *  - le FLUX (mode « Entertainment », hue-flux.js), dès qu'il y a une HUE_CLIENT_KEY : 60 images par
 *    seconde, fondus calculés ici, plus de commande perdue ni en retard, et chaque lampe à sa couleur ;
 *  - les COMMANDES ordinaires (callHue), une par changement, la même couleur pour toute la pièce :
 *    avant que le flux soit établi, s'il tombe, ou avec LIGHTS_MODE=classique.
 * Les scènes passent toutes par `envoyer`. Les effets qui ont besoin du flux (lampes séparées, 25
 * images par seconde : l'orage, les bougies, les respirations, les Amoureux, les corbeaux, la Lune
 * Rousse, la victoire qui tourne, la cloche qui résonne) ont leur version « flux » ; sans flux, ils
 * reprennent exactement leur version d'avant le 2026-11-15 (suite 4).
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const CONFIG = {
  enabled:   process.env.LIGHTS_ENABLED === "true",
  bridgeIp:  process.env.HUE_BRIDGE_IP  || "",
  apiKey:    process.env.HUE_API_KEY    || "",
  groupId:   process.env.HUE_GROUP_ID   || "",
  debug:     process.env.LIGHTS_DEBUG === "true",
  clientKey: process.env.HUE_CLIENT_KEY || "",   // pour le flux (outils/appairer-hue.js)
  zoneId:    process.env.HUE_ZONE_ID    || "",   // zone de divertissement (sinon trouvée seule)
  // « classique » : jamais de flux, même avec une clientkey (secours si le flux déçoit)
  flux:      (process.env.LIGHTS_MODE || "flux").trim().toLowerCase() !== "classique",
};

let SCENES = {};
try {
  SCENES = JSON.parse(fs.readFileSync(path.join(__dirname, 'lights-scenes.json'), 'utf8'));
} catch (e) {
  console.warn("[lights] lights-scenes.json absent ou invalide — module dormant.", e.message);
}

// ===== LA LUMIÈRE CALÉE SUR LE SON (2026-11-15, suite 4) =====
// Le moment fort de chaque son qu'une lumière accompagne, en ms depuis son début, mesuré sur son
// enveloppe (niveau toutes les 20 ms, décodé par Chrome) :
const COUPS = {
  death:       [2880],                   // le glas : un murmure, puis le coup, à 2,88 s
  thunder:     [560, 3280],              // le craquement, puis une reprise du grondement
  church_bell: [60, 3980],               // deux coups de cloche, le second plus doux
  crow:        [520, 1820, 3540, 4620],  // quatre cris
  hurlement:   [60, 7900],               // deux hurlements ; la tablette l'éteint en fondu de 9 à 11,5 s
};
const FONDU_HURLEMENT = [9000, 2500];    // le fondu de sortie de hurlementAuLoin (public/mj.html)
// Le son part de la tablette, la lumière du Bridge : le temps que la tablette lance le son, à régler
// dans la pièce si la lumière arrive avant ou après (LIGHTS_DECALAGE_SON, en ms, dans .env)
const DECALAGE_SON_MS = Number.isFinite(+process.env.LIGHTS_DECALAGE_SON) && process.env.LIGHTS_DECALAGE_SON !== ""
  ? +process.env.LIGHTS_DECALAGE_SON : 100;
const coupDuSon = (son, n = 0) => (COUPS[son] && COUPS[son][n] != null ? COUPS[son][n] + DECALAGE_SON_MS : null);

// Bridge Hue : certificat autosigné, on n'a pas le choix sur LAN.
const agent = new https.Agent({ rejectUnauthorized: false });

// État runtime
let currentSceneKey = null;
let effectInterval  = null;
let effectTimeouts  = [];
let finEclair       = 0;  // fin de l'éclair en cours (horodatage) : jusque-là, applyScene retient la scène
let lastCallAt      = 0;
const MIN_GAP_MS    = 100; // anti rate-limit Hue (~10 cmd/sec/groupe)

function _log(...args) { if (CONFIG.debug) console.log("[lights]", ...args); }

function _ready() {
  return CONFIG.enabled && CONFIG.bridgeIp && CONFIG.apiKey && CONFIG.groupId;
}

/**
 * Envoi au Bridge, UNE commande à la fois, dans l'ordre (2026-11-14). Envoyées en parallèle, chacune
 * par sa propre connexion, une commande partie juste avant (une pulsation rose des Amoureux) pouvait
 * arriver au Bridge APRÈS la suivante (le bleu de la nuit) et rester : la pièce restait rose. La
 * suivante part quand la précédente a répondu (ou échoué) ; si plusieurs attendent, seule la plus
 * récente part, c'est l'état voulu. Une commande perdue (Wi-Fi) est renvoyée une fois si rien ne l'a
 * remplacée. Jamais d'await, jamais de throw : au pire, on le note en mode debug.
 */
let occupe = false, prochaine = null;
function callHue(payload, essai = 1) {
  if (!_ready()) return;
  if (occupe) { prochaine = { payload, essai }; return; }
  occupe = true;
  const attente = Math.max(0, MIN_GAP_MS - (Date.now() - lastCallAt));   // anti rate-limit Hue
  setTimeout(() => {
    lastCallAt = Date.now();
    let fini = false;
    const suite = ok => {
      if (fini) return;
      fini = true;
      occupe = false;
      if (!ok && !prochaine && essai < 2) prochaine = { payload, essai: essai + 1 };
      const p = prochaine;
      prochaine = null;
      if (p) callHue(p.payload, p.essai);
    };
    // Souvent appelé depuis un minuteur : une erreur (réglage du .env illisible…) y arrêterait le serveur
    try { envoyerAuBridge(payload, suite); } catch (e) { _log("err:", e.message); suite(true); }
  }, attente);
}

// `fin(ok)` est appelée une fois, à la réponse du Bridge ou à l'échec (erreur, 1,5 s sans réponse)
function envoyerAuBridge(payload, fin) {
  const body = JSON.stringify(payload);
  const req = https.request({
    hostname: CONFIG.bridgeIp,
    port:     443,
    path:     `/clip/v2/resource/grouped_light/${CONFIG.groupId}`,
    method:   'PUT',
    agent,
    headers: {
      'hue-application-key': CONFIG.apiKey,
      'Content-Type':        'application/json',
      'Content-Length':      Buffer.byteLength(body)
    },
    timeout: 1500
  }, res => {
    let buf = '';
    res.on('data', c => { if (CONFIG.debug) buf += c; });
    res.on('end', () => {
      if (CONFIG.debug && res.statusCode >= 400) _log("HTTP", res.statusCode, buf.slice(0, 200));
      fin(res.statusCode < 500);   // 4xx : la commande est refusée, la renvoyer n'y changerait rien
    });
    res.on('error', () => fin(false));
  });
  req.on('error',   e => { _log("err:", e.message); fin(false); });
  req.on('timeout', () => { _log("timeout"); req.destroy(); fin(false); });
  req.on('close',   () => fin(false));   // sans réponse complète ; sans effet si `fin` est déjà passée
  req.write(body);
  req.end();
}

/**
 * Le point de passage de toutes les couleurs communes : aller vers `etat` ({ xy, bri }) en `duree`
 * ms, toutes les lampes ensemble. Par le flux s'il est établi (avec la forme de fondu `courbe`), sinon
 * par une commande ordinaire. La dernière couleur demandée est retenue : le flux part d'elle en
 * s'établissant, et les commandes ordinaires la reposent s'il tombe.
 */
let flux = null, dernierEtat = null;
function envoyer(etat, duree, courbe) {
  dernierEtat = etat;
  if (flux && flux.actif()) poserFlux(etat, duree, courbe);
  else callHue(_sceneBody(etat, { duration: duree }));
}

// Le flux est-il là, avec ses lampes ? Les effets « flux » ne servent qu'alors.
const enFlux = () => !!(flux && flux.actif() && flux.lampes() > 0);

// ===== LES AMPOULES ET LA BANDE (2026-11-15, suite 4) =====
// La pièce d'Alexandre : une ampoule à chaque bout, et une bande lumineuse (Lightstrip) derrière un
// canapé, « plus superficielle ». Les effets se jouent sur les AMPOULES, rangées de gauche à droite ;
// la BANDE les accompagne en retrait, à BANDE_PART de leur luminosité (celle de leur moyenne), sauf
// quand un effet lui donne un rôle (les braises de la Veillée, le lien des Amoureux). Le genre de
// chaque lampe vient du Bridge (hue-flux.js) ; sans bande, toutes les lampes jouent.
const BANDE_PART = 0.6;
function disposition() {
  const genres = flux.genres ? flux.genres() : [];
  const ampoules = [], bandes = [];
  for (let i = 0; i < flux.lampes(); i++) (genres[i] === "bande" ? bandes : ampoules).push(i);
  return ampoules.length ? { ampoules, bandes } : { ampoules: bandes, bandes: [] };   // que des bandes : elles jouent
}
const enRetrait = etat => ({ xy: etat.xy, bri: Math.round(etat.bri * BANDE_PART) });
function moyenne(couleurs) {
  const v = couleurs.filter(Boolean);
  if (!v.length) return null;
  const m = f => v.reduce((s, c) => s + f(c), 0) / v.length;
  return { xy: [m(c => c.xy[0]), m(c => c.xy[1])], bri: Math.round(m(c => c.bri)) };
}
// Par le flux : `etat` à toutes les ampoules et la bande en retrait, ou aux seules ampoules de rang
// `rangs` (un numéro ou une liste : 0 = la plus à gauche)
function poserFlux(etat, duree, courbe, rangs) {
  const { ampoules, bandes } = disposition();
  if (rangs == null) {
    flux.poser(etat, duree, { lampe: ampoules, courbe });
    if (bandes.length) flux.poser(enRetrait(etat), duree, { lampe: bandes, courbe });
    return;
  }
  const quelles = [].concat(rangs).map(k => ampoules[k]).filter(i => i != null);
  if (quelles.length) flux.poser(etat, duree, { lampe: quelles, courbe });
}
const nbAmpoules = () => disposition().ampoules.length;
// Une ou des ampoules (rang, de gauche à droite ; `null` : toute la pièce) vers `etat` : le flux seulement
function lampe(rangs, etat, duree, courbe) { if (enFlux()) poserFlux(etat, duree, courbe, rangs); }
// Une étape d'effet dans `ms` : annulée par stopEffect (changement de scène, autre éclair)
function plusTard(ms, f) { effectTimeouts.push(setTimeout(f, Math.max(0, ms))); }
// Un écho d'un éclair (la lueur au loin du grondement) : il survit au redémarrage de l'effet de la
// scène (l'orage de fond, que stopEffect arrêterait avec lui), mais pas à une autre scène ou un autre
// éclair (`epoque` change alors)
let epoque = 0;
function echo(ms, f) {
  const e = epoque;
  setTimeout(() => { if (e === epoque && Date.now() >= finEclair) f(); }, Math.max(0, ms));
}
const borne = p => Math.max(0, Math.min(1, p));
const melange = (a, b, p) => ({ xy: [a.xy[0] + (b.xy[0] - a.xy[0]) * p, a.xy[1] + (b.xy[1] - a.xy[1]) * p], bri: Math.round(a.bri + (b.bri - a.bri) * p) });
const auHasard = n => Math.floor(Math.random() * n);

/**
 * Une animation (le flux seulement) : `image(t, k, m)` donne la couleur de l'ampoule de rang `k` (sur
 * `m`, de gauche à droite) au temps `t` (ms depuis le début), ou rien pour la laisser où elle va ;
 * `bande(t, couleurs)`, celle de la bande (par défaut : la moyenne des ampoules, en retrait). 25 images
 * par seconde, que le flux fond l'une dans l'autre. Elle s'arrête avec l'effet (stopEffect), ou dès
 * que le flux tombe.
 */
const IMAGE_MS = 40;
function animer(image, bande) {
  const t0 = Date.now();
  const pas = () => {
    if (!enFlux()) return;   // flux tombé : surPerte reprend la scène en commandes ordinaires
    const t = Date.now() - t0, { ampoules, bandes } = disposition();
    const couleurs = ampoules.map((_, k) => image(t, k, ampoules.length));
    couleurs.forEach((c, k) => { if (c) flux.poser(c, IMAGE_MS + 10, { lampe: ampoules[k] }); });
    if (bandes.length) {
      const moy = moyenne(couleurs);
      const c = bande ? bande(t, couleurs) : moy && enRetrait(moy);
      if (c) flux.poser(c, IMAGE_MS + 10, { lampe: bandes });
    }
  };
  pas();
  effectInterval = setInterval(pas, IMAGE_MS);
}

/**
 * Convertit notre format scène vers le body CLIP v2 du Bridge.
 */
// Le volume des lumières (2026-11-15, suite 5) : le curseur 💡 de la tablette, de 10 % à 150 % de la
// lumière de chaque scène (plafonnée à la pleine lumière : une scène déjà très claire, le jour, ne
// monte plus). Par le flux, à l'image suivante, partout, même au milieu d'un effet ; sans flux, la
// couleur en cours est renvoyée. Il n'appartient pas à la partie : une nouvelle partie le garde.
let volume = 1;
function luminosite(v) {
  const n = Math.max(0.1, Math.min(1.5, Number(v) || 1));
  if (Math.abs(n - volume) < 0.001) return;
  volume = n;
  if (flux && flux.volume) flux.volume(n);
  if (!(flux && flux.actif()) && dernierEtat) callHue(_sceneBody(dernierEtat, { duration: 300 }));
  _log("volume des lumières →", Math.round(n * 100) + " %");
}

function _sceneBody(scene, opts = {}) {
  const dur = (opts.duration != null) ? opts.duration : (scene.transition || 800);
  const body = {
    on: { on: true },
    dynamics: { duration: dur }
  };
  if (Array.isArray(scene.xy) && scene.xy.length === 2) {
    body.color = { xy: { x: scene.xy[0], y: scene.xy[1] } };
  }
  if (typeof scene.bri === "number") {
    // Hue v2 attend brightness en pourcentage 0..100
    body.dimming = { brightness: Math.max(1, Math.min(100, Math.round(scene.bri * volume / 254 * 100))) };
  }
  return body;
}

/**
 * Stoppe l'effet courant (lightning, fire_flicker, pulse, etc.).
 */
function stopEffect() {
  if (effectInterval) { clearInterval(effectInterval); effectInterval = null; }
  effectTimeouts.forEach(t => clearTimeout(t));
  effectTimeouts = [];
}

// ===== L'ORAGE =====
// Un éclair d'orage, par le flux : jamais plus de 3 éclats par seconde (les personnes sensibles aux
// flashs), puis au moins 5 s de calme. « proche » : un coup sur une ampoule, un autre sur l'autre,
// parfois toute la pièce à la fin (la bande comprise) ; « lointain » : une seule ampoule, à demi.
const BLANC_ECLAIR = [0.32, 0.34];
function eclairOrage(fond, genre, depart = 0) {
  const n = nbAmpoules();
  const eclat = (t, rangs, bri, tenue) => {
    plusTard(depart + t, () => lampe(rangs, { xy: BLANC_ECLAIR, bri }, 0));
    plusTard(depart + t + tenue, () => lampe(rangs, { xy: fond.xy, bri: Math.round(fond.bri * 0.55) }, 70));
  };
  if (genre === "lointain") {
    const k = auHasard(n);
    plusTard(depart, () => lampe(k, { xy: [0.3, 0.32], bri: Math.min(254, fond.bri + 70) }, 40));
    plusTard(depart + 140, () => lampe(k, fond, 450, "sortie"));
    return depart + 600;
  }
  const a = auHasard(n), b = n > 1 ? (a + 1 + auHasard(n - 1)) % n : a;
  eclat(0, a, 254, 70);
  eclat(300, b, 254, 90);
  const final = Math.random() < 0.6;
  if (final) eclat(640, null, 254, 110);
  const fin = final ? 760 : 400;
  plusTard(depart + fin, () => lampe(null, fond, 900, "sortie"));
  return depart + fin + 900;
}

/**
 * Démarre un effet récurrent sur la scène courante. Sans flux, chaque effet garde sa version
 * d'avant (une commande ordinaire à la fois, ~10 Hz au plus pour ne pas saturer le Bridge).
 */
function startEffect(name, scene) {
  stopEffect();
  const riche = enFlux();
  switch (name) {
    case "lightning": {
      if (riche) {
        // Par le flux : des coups qui sautent d'une lampe à l'autre, ou un éclair au loin
        const tick = () => {
          effectInterval = setTimeout(() => {
            const fin = eclairOrage(scene, Math.random() < 0.35 ? "lointain" : "proche");
            plusTard(fin, tick);
          }, 5000 + Math.random() * 18000);   // 5-23 s entre éclairs
        };
        tick();
        break;
      }
      // Flashs blancs aléatoires sur fond gris orageux
      const tick = () => {
        const delay = 5000 + Math.random() * 18000; // 5-23s entre éclairs
        effectInterval = setTimeout(() => {
          envoyer({ xy: [0.32, 0.34], bri: 254 }, 0);
          effectTimeouts.push(setTimeout(() => {
            envoyer(scene, 600);
            tick();
          }, 250));
        }, delay);
      };
      tick();
      break;
    }
    case "fire_flicker": {
      // Vacillement chaud orange/rouge en continu
      effectInterval = setInterval(() => {
        const flicker = {
          xy: [0.60 + Math.random()*0.08, 0.32 + Math.random()*0.04],
          bri: 140 + Math.floor(Math.random()*100)
        };
        envoyer(flicker, 200);
      }, 350);
      break;
    }
    case "candle_flicker": {
      if (riche) {
        // Par le flux : une flamme par ampoule, chacune à son rythme (trois ondulations mêlées, la plus
        // rapide à peine marquée), et de temps en temps un courant d'air qui la fait plier. Plus
        // basse, la flamme rougit un peu, comme une vraie. La bande : des braises, rouges et lentes.
        const flammes = [], braise = Math.random() * 6.28;
        animer((t, i) => {
          // Chaque flamme a ses propres phases et un rythme un peu à elle (± 15 %) : elles ne se ressemblent jamais longtemps
          const f = flammes[i] || (flammes[i] = { p: [0, 0, 0].map(() => Math.random() * 6.28), v: [0.9, 2.3, 4.1].map(h => h * (0.85 + 0.3 * Math.random())), air: 4000 + Math.random() * 8000 });
          const s = t / 1000;
          let niveau = 0.5 + 0.24 * Math.sin(6.28 * f.v[0] * s + f.p[0]) + 0.14 * Math.sin(6.28 * f.v[1] * s + f.p[1]) + 0.05 * Math.sin(6.28 * f.v[2] * s + f.p[2]);
          if (t >= f.air) {
            const u = (t - f.air) / 900;   // le courant d'air : 150 ms pour plier, le reste pour se redresser
            if (u >= 1) f.air = t + 4000 + Math.random() * 8000;
            else niveau -= 0.35 * (u < 0.17 ? u / 0.17 : (1 - u) / 0.83);
          }
          niveau = borne(niveau);
          return { xy: [0.545 + 0.03 * (1 - niveau), 0.405 - 0.008 * (1 - niveau)], bri: Math.max(12, Math.round(scene.bri * (0.55 + 0.9 * niveau))) };
        }, t => ({ xy: [0.6, 0.38], bri: Math.max(8, Math.round(scene.bri * BANDE_PART * (0.75 + 0.15 * Math.sin(6.28 * 0.25 * t / 1000 + braise)))) }));
        break;
      }
      // Bougies : lumière chaude et basse qui vacille doucement (La Veillée)
      effectInterval = setInterval(() => {
        const flamme = { xy: [0.55 + Math.random() * 0.03, 0.40 + Math.random() * 0.02], bri: Math.max(15, scene.bri - 15 + Math.floor(Math.random() * 30)) };
        envoyer(flamme, 450);
      }, 700);
      break;
    }
    case "fast_pulse": {
      // Pulsation rapide pour Panique
      let high = true;
      effectInterval = setInterval(() => {
        envoyer({ xy: scene.xy, bri: high ? scene.bri : Math.max(20, Math.floor(scene.bri*0.35)) }, 250);
        high = !high;
      }, 350);
      break;
    }
    case "amants": {
      // Les Amoureux se regardent (2026-11-15, suite 4) : les ampoules des deux bouts de la pièce sont
      // les deux amants. Elles respirent d'abord l'une après l'autre, puis se rapprochent, et au bout de
      // quatre souffles respirent ensemble ; la bande, entre elles, est le lien : une lueur rose qui
      // grandit à mesure qu'ils se rapprochent (une ampoule du milieu, s'il y en a, reste basse).
      if (riche && nbAmpoules() >= 2) {
        const bas = Math.max(30, Math.floor(scene.bri * 0.45)), periode = 2400, rapprochement = 9600;
        const ensemble = t => (1 - Math.cos(Math.PI * borne(t / rapprochement))) / 2;
        animer((t, k, m) => {
          if (k !== 0 && k !== m - 1) return { xy: scene.xy, bri: Math.round(scene.bri * 0.22) };
          const ecart = k === 0 ? 0 : Math.PI * (1 - ensemble(t));
          return { xy: scene.xy, bri: Math.round(bas + (scene.bri - bas) * (1 + Math.cos(2 * Math.PI * t / periode + ecart)) / 2) };
        }, t => {
          // Le lien part de la bande en retrait (la scène posée), descend en douceur la première seconde, puis grandit
          const lien = 0.2 + 0.6 * ensemble(t), depart = (1 - Math.cos(Math.PI * borne(t / 1000))) / 2;
          return { xy: scene.xy, bri: Math.round(scene.bri * BANDE_PART * (1 - (1 - lien) * depart)) };
        });
        break;
      }
      startEffect("slow_pulse", scene);   // une seule lampe, ou sans flux : la respiration ordinaire
      break;
    }
    case "slow_pulse": {
      if (riche) {
        // Par le flux : une vraie respiration (montée et descente douces), au même rythme qu'avant
        const bas = Math.max(30, Math.floor(scene.bri * 0.55));
        animer(t => ({ xy: scene.xy, bri: Math.round(bas + (scene.bri - bas) * (1 + Math.cos(2 * Math.PI * t / 2000)) / 2) }));
        break;
      }
      // Pulsation lente : Chasseur, Sœurs, Amoureux, et quelques évènements du Conseil
      let high = true;
      effectInterval = setInterval(() => {
        envoyer({ xy: scene.xy, bri: high ? scene.bri : Math.max(30, Math.floor(scene.bri*0.55)) }, 900);
        high = !high;
      }, 1000);
      break;
    }
    default:
      _log("effet inconnu:", name);
  }
}

// La teinte du Dépouillement : la scène `cle`, poussée vers la scène `vers` d'une part `part` (0 à 1).
// Elle tient tant que la scène en cours est `cle` (un éclair qui la traverse y revient).
let teinte = null, teinteEnAttente = null;
function couleurDe(key) {
  const s = SCENES[key];
  if (!s) return null;
  if (teinte && teinte.cle === key && SCENES[teinte.vers]) return Object.assign({}, s, melange(s, SCENES[teinte.vers], teinte.part));
  return s;
}

/**
 * Applique une scène (clé du JSON). Restaure l'éclairage en transition fluide
 * et démarre l'éventuel effet associé. `courbe` : la forme du fondu, par le flux (voir hue-flux.js).
 */
function applyScene(key, transitionForcee, courbe) {
  const scene = SCENES[key];
  if (!scene) { _log("scène absente:", key); return; }
  if (!teinte || teinte.cle !== key) { teinte = null; clearTimeout(teinteEnAttente); teinteEnAttente = null; }
  if (key !== currentSceneKey) epoque++;
  currentSceneKey = key;
  // La pause coupe tout, même un éclair qui attend le coup de son son (le glas : près de 3 s)
  if (key === "pause") finEclair = 0;
  // Un éclair en cours va jusqu'au bout : c'est lui qui posera cette scène en finissant. Sinon le
  // changement de phase qui le suit aussitôt l'annulait (les morts de l'aube, la proie des loups).
  if (Date.now() < finEclair) { _log("scène après l'éclair →", key); return; }
  stopEffect();
  const couleur = couleurDe(key);
  envoyer(couleur, transitionForcee != null ? transitionForcee : (scene.transition || 800), courbe);
  if (scene.effect) {
    // Petit délai pour laisser la transition s'établir avant l'effet
    setTimeout(() => { if (currentSceneKey === key && Date.now() >= finEclair) startEffect(scene.effect, couleurDe(key)); }, scene.transition || 800);
  }
  _log("scène →", key);
}

// Éclair qui finit dans `delai` ms : il posera alors la scène retenue entre-temps (applyScene), vite —
// avec la lente transition du vote (5 s), le rouge de la mort traînait dans la pièce (Alexandre, 2026-11-10).
// `o.retour`, `o.courbe` : un retour plus lent (la cloche qui résonne) ; `o.suite` : ce qui vient après.
const RETOUR_APRES_ECLAIR_MS = 800;
function apresEclair(delai, o = {}) {
  finEclair = Date.now() + delai;
  plusTard(delai, () => {
    finEclair = 0;
    const s = currentSceneKey && SCENES[currentSceneKey];
    if (s) applyScene(currentSceneKey, o.retour != null ? o.retour : Math.min(s.transition || RETOUR_APRES_ECLAIR_MS, RETOUR_APRES_ECLAIR_MS), o.courbe);
    if (o.suite) o.suite();
  });
}

// ===== LES ÉCLAIRS « FLUX » =====
// Chacun reçoit le flash (du JSON) et l'attente avant son coup ; il pose lui-même son retour (apresEclair).
const ECLAIRS_FLUX = {
  // Le tonnerre : l'éclair juste avant le craquement (la lumière va plus vite que le son), puis, à la
  // reprise du grondement, une lueur au loin
  orage(f, attente, son) {
    const fond = dernierEtat || SCENES["council.storm"] || f;
    const fin = eclairOrage(fond, "proche", attente);
    const reprise = son === "thunder" ? coupDuSon("thunder", 1) : null;
    if (reprise != null) echo(reprise, () => { if (enFlux()) eclairOrage(couleurDe(currentSceneKey) || fond, "lointain"); });
    apresEclair(fin - 900);
  },
  // La cloche : la pièce s'embrase d'or au coup, puis retombe lentement, comme le son qui résonne ;
  // au second coup de la cloche, une lueur plus douce
  cloche(f, attente, son) {
    coupDeCloche(f, attente, son === "church_bell" ? coupDuSon("church_bell", 1) : null);
  },
  // La victoire tourne dans la pièce : la couleur du camp passe de lampe en lampe (`duration` ms par
  // tour, `repeat` tours), puis toute la pièce s'allume ensemble
  tour(f, attente) {
    const tours = f.repeat || 3, tourMs = f.duration || 1400, total = tours * tourMs;
    const creux = f.creux != null ? f.creux : 0.3, final = 700;
    plusTard(attente, () => animer((t, i, n) => {
      if (t >= total - final) return { xy: f.xy, bri: f.bri };
      // Une seule lampe : les vagues d'avant, en douceur
      if (n < 2) return { xy: f.xy, bri: Math.round(f.bri * (creux + (1 - creux) * (1 - Math.cos(2 * Math.PI * t / tourMs)) / 2)) };
      const passe = (((t / tourMs) * n - i) % n + n) % n;   // de combien de lampes la tête l'a dépassée
      const eclat = passe > n - 0.4 ? (passe - (n - 0.4)) / 0.4 : Math.exp(-1.4 * passe);
      return { xy: f.xy, bri: Math.round(f.bri * (creux + (1 - creux) * eclat)) };
    }));
    apresEclair(attente + total + 150);
  },
};

// Le coup de cloche, par le flux : or vif au coup (`attente` ms), puis retour lent (« sortie », `retour`
// ms) à la scène en cours ; `second` : le second coup, plus doux (pas sur une scène animée, qui
// l'effacerait aussitôt)
const OR_CLOCHE = [0.5, 0.415];
function coupDeCloche(f, attente, second, retour) {
  const base = couleurDe(currentSceneKey) || dernierEtat || f;
  const or = p => ({ xy: OR_CLOCHE, bri: Math.min(254, Math.round(Math.max(f.bri, (base.bri || 0) + 70) * p + (base.bri || 0) * (1 - p))) });
  plusTard(attente, () => envoyer(or(1), 60));
  apresEclair(attente + 250, {
    retour: retour || 2600, courbe: "sortie",
    suite: second == null ? null : () => plusTard(second - attente - 250, () => {
      const s = currentSceneKey && SCENES[currentSceneKey];
      if (!s || s.effect || !enFlux() || Date.now() < finEclair) return;
      envoyer(or(0.55), 80);
      plusTard(250, () => applyScene(currentSceneKey, 2000, "sortie"));
    }),
  });
}

/**
 * Flash ponctuel (mort, victoire). Lance N pulses vers la couleur du flash, puis pose la scène
 * en cours : celle d'avant, ou celle qu'un changement de phase a demandée pendant l'éclair.
 * `son` : le son qui l'accompagne (COUPS) ; l'éclair attend son coup (le glas : 2,88 s ; le tonnerre :
 * juste avant le craquement, `avance` ms). `apres` : la scène à poser ensuite, au lieu de celle en
 * cours (la pièce reste telle quelle jusqu'à l'éclair : le noir avant le verdict du Dépouillement).
 */
function flash(key, son, apres) {
  const f = SCENES[key];
  if (!f) { _log("flash absent:", key); return; }
  const repeat  = f.repeat   || 2;
  const dur     = f.duration || 250;
  // `montee` : fondu de chaque montée et descente (0 : éclair sec) ; `creux` : intensité entre deux,
  // en part de `bri`. La victoire monte en vagues lentes, une mort reste un éclair sec (2026-11-14).
  const montee  = f.montee || 0;
  const creux   = f.creux != null ? f.creux : 0.1;
  const coup    = coupDuSon(son);
  const attente = coup == null ? 0 : Math.max(0, coup - (f.avance || 0));

  // Coupe les effets pendant le flash
  stopEffect();
  epoque++;
  if (apres && SCENES[apres]) { currentSceneKey = apres; teinte = null; }

  if (enFlux() && ECLAIRS_FLUX[f.flux]) {
    ECLAIRS_FLUX[f.flux](f, attente, son);
    _log("flash (flux) →", key);
    return;
  }
  for (let i = 0; i < repeat; i++) {
    plusTard(attente + i * dur, () => {
      envoyer({ xy: f.xy, bri: f.bri }, montee);
    });
    plusTard(attente + i * dur + Math.floor(dur/2), () => {
      envoyer({ xy: f.xy, bri: Math.max(5, Math.floor(f.bri * creux)) }, montee);
    });
  }
  apresEclair(attente + repeat * dur + 150);
  _log("flash →", key, "(" + repeat + "x)");
}

/**
 * Vague : la lumière glisse vers une couleur (montée en fondu, `montee` ms), y reste, puis revient
 * à la scène en cours au bout de `duree` ms. Le hurlement de la Lune Rousse (un rouge qui monte),
 * l'ombre des corbeaux (une pénombre soudaine). Comme un flash, sans clignoter. Par le flux, elle
 * traverse la pièce au rythme de son son (`son` : voir COUPS).
 */
function vague(key, son) {
  const v = SCENES[key];
  if (!v) { _log("vague absente:", key); return; }
  stopEffect();   // coupe aussi un éclair en cours : la vague reposera la scène en finissant
  finEclair = 0;
  epoque++;
  if (enFlux() && VAGUES_FLUX[v.flux]) {
    const fin = VAGUES_FLUX[v.flux](v, couleurDe(currentSceneKey) || dernierEtat || v, son);
    plusTard(fin, () => { if (currentSceneKey && SCENES[currentSceneKey]) applyScene(currentSceneKey, 600); });
    _log("vague (flux) →", key);
    return;
  }
  envoyer(v, v.montee || 1500);
  plusTard(v.duree || 5000, () => {
    if (currentSceneKey && SCENES[currentSceneKey]) applyScene(currentSceneKey);
  });
  _log("vague →", key);
}

// Les vagues « flux » : chacune anime la pièce à partir de `base` (la scène en cours) et rend sa durée
const VAGUES_FLUX = {
  // Les corbeaux : à chaque cri, une ombre passe d'une lampe à l'autre — la première profonde, les
  // suivantes plus légères —, toujours dans le même sens (la nuée traverse la pièce)
  ombre(v, base, son) {
    const cris = (son === "crow" ? COUPS.crow : [0]).map((t, k) => ({ t: t + (son ? DECALAGE_SON_MS : 0), prof: k === 0 ? 0.95 : 0.5 }));
    // Entre les deux ampoules des bouts de la pièce, l'ombre met 420 ms (260 d'une lampe à la suivante, au-delà)
    const sens = Math.random() < 0.5, PASSAGE = nbAmpoules() <= 2 ? 420 : 260, LARGEUR = 700;
    animer((t, i, n) => {
      const rang = sens ? i : n - 1 - i;
      let g = 0;
      for (const c of cris) {
        const u = (t - c.t - rang * PASSAGE) / LARGEUR;
        if (u > 0 && u < 1) g = Math.max(g, c.prof * Math.sin(Math.PI * u));
      }
      return { xy: melange(base, v, g).xy, bri: Math.max(3, Math.round(base.bri + (v.bri - base.bri) * g)) };
    });
    return cris[cris.length - 1].t + nbAmpoules() * PASSAGE + LARGEUR + 100;
  },
  // La Lune Rousse : au premier hurlement, le rouge monte d'un bout de la pièce à l'autre ; au second,
  // un sursaut repart dans l'autre sens ; puis la lumière retombe avec le son (fondu de la tablette)
  hurlement(v, base, son) {
    const d = son ? DECALAGE_SON_MS : 0, h1 = COUPS.hurlement[0] + d, h2 = COUPS.hurlement[1] + d;
    const sortie = FONDU_HURLEMENT[0] + d, MONTEE = 1800, ECART = nbAmpoules() <= 2 ? 700 : 450, SURSAUT = 1600;
    const sens = Math.random() < 0.5;
    animer((t, i, n) => {
      const r1 = sens ? i : n - 1 - i, r2 = n - 1 - r1;
      let g = (1 - Math.cos(Math.PI * borne((t - h1 - r1 * ECART) / MONTEE))) / 2;
      g *= 1 - borne((t - sortie) / FONDU_HURLEMENT[1]);
      const u = (t - h2 - r2 * ECART) / SURSAUT;
      const sursaut = u > 0 && u < 1 ? 0.3 * Math.sin(Math.PI * u) : 0;
      return { xy: melange(base, v, g).xy, bri: Math.min(254, Math.round(base.bri + (v.bri * (1 + sursaut) - base.bri) * g)) };
    });
    return sortie + FONDU_HURLEMENT[1] + 100;
  },
};

/**
 * Séquence de N flashs de mort espacés — pour plusieurs morts la même nuit.
 * Contrairement à `flash`, n'est appelé qu'une fois avec le compte total,
 * ce qui évite que chaque flash annule le précédent via stopEffect().
 * `son` : le premier éclair attend le coup du son (le glas de l'aube).
 */
function flashSequence(key, count, son) {
  const f = SCENES[key];
  if (!f) { _log("flash absent:", key); return; }
  if (count <= 0) return;
  if (count === 1) { flash(key, son); return; }
  const dur  = f.duration || 250;
  const gap  = 400; // silence entre deux morts
  const coup = coupDuSon(son);
  const attente = coup == null ? 0 : coup;
  stopEffect();
  epoque++;
  for (let d = 0; d < count; d++) {
    const base = attente + d * (dur + gap);
    plusTard(base, () => {
      envoyer({ xy: f.xy, bri: f.bri }, 0);
    });
    plusTard(base + Math.floor(dur / 2), () => {
      envoyer({ xy: f.xy, bri: Math.max(5, Math.floor(f.bri * 0.1)) }, 0);
    });
  }
  apresEclair(attente + count * (dur + gap) + 150);
  _log("flashSequence →", key, "×" + count);
}

/**
 * La cloche du vote (2026-11-15, suite 4) : par le flux, la pièce s'embrase d'or au coup de cloche
 * que la tablette sonne, puis glisse vers la scène `key` sur sa transition (le vote : 5 s) ; sans
 * flux, la scène seule, comme avant.
 */
function sonner(key) {
  const scene = SCENES[key];
  if (!scene) { _log("scène absente:", key); return; }
  if (!enFlux() || Date.now() < finEclair) { applyScene(key); return; }
  stopEffect();
  epoque++;
  if (!teinte || teinte.cle !== key) { teinte = null; clearTimeout(teinteEnAttente); teinteEnAttente = null; }
  currentSceneKey = key;
  // La pièce part de sa couleur d'avant (le jour) vers l'or, puis glisse vers la scène du vote
  coupDeCloche(SCENES["flash.bell"] || { bri: 220 }, coupDuSon("church_bell"), coupDuSon("church_bell", 1), scene.transition || 800);
  _log("cloche →", key);
}

/**
 * Le Dépouillement (2026-11-15, suite 4). Sans `ouvertureMs` : la scène du dépouillement, rougie
 * d'autant que la voix la plus forte pèse (`part`, de 0 à 1). Avec : une enveloppe s'ouvre, la pièce
 * baisse un peu (on retient son souffle), puis, une fois le bulletin posé (`ouvertureMs`), rougit.
 * Une commande à chaque fois : la même chose sans flux.
 */
function depouillement(part, ouvertureMs) {
  const cle = "depouillement";
  if (!SCENES[cle]) return;
  const premiere = currentSceneKey !== cle;
  const teinter = () => { teinteEnAttente = null; teinte = { cle, vers: "depouillement.tension", part: borne(part || 0) }; applyScene(cle, premiere ? undefined : 1200); };
  clearTimeout(teinteEnAttente); teinteEnAttente = null;
  if (!ouvertureMs || premiere) { teinter(); return; }
  if (Date.now() >= finEclair) {
    stopEffect();
    const c = couleurDe(cle);
    envoyer({ xy: c.xy, bri: Math.round(c.bri * 0.6) }, 700);
  }
  teinteEnAttente = setTimeout(teinter, ouvertureMs);
}

/**
 * Reset complet (sur reset de partie).
 */
function reset() {
  stopEffect();
  epoque++;
  finEclair = 0;
  currentSceneKey = null;
  teinte = null; clearTimeout(teinteEnAttente); teinteEnAttente = null;
  if (_ready()) applyScene("lobby");
}

/**
 * Ping de santé — utile pour un futur indicateur côté MJ.
 */
// Cette scène existe-t-elle ? (un évènement du Conseil sans lumière à lui laisse celle du vote)
function aLaScene(key) { return !!SCENES[key]; }

function status() {
  return {
    enabled: CONFIG.enabled,
    configured: _ready(),
    luminosite: volume,
    currentScene: currentSceneKey,
    mode: flux && flux.actif() ? "flux" : "commandes",
    scenesLoaded: Object.keys(SCENES).filter(k => !k.startsWith("_")).length
  };
}

// Établi : le flux part de la couleur actuelle, sans saut, et l'effet de la scène en cours reprend
// dans sa version « flux » (un éclair en cours finira de lui-même et la reposera)
function surFluxActif() {
  if (dernierEtat) poserFlux(dernierEtat, 0);
  const s = currentSceneKey && SCENES[currentSceneKey];
  if (s && s.effect && Date.now() >= finEclair) startEffect(s.effect, couleurDe(currentSceneKey));
}

// Le flux d'un essai (outils, vérifications) : un objet qui se comporte comme celui de hue-flux.js
function brancherFlux(f) { flux = f; if (f && f.volume) f.volume(volume); if (f && f.actif()) surFluxActif(); }

// Au démarrage, si on est prêt, on initialise en lobby (mais on ne crashe
// jamais si le Bridge n'est pas joignable — fire-and-forget).
if (_ready()) {
  _log("activé — Bridge", CONFIG.bridgeIp, "groupe", CONFIG.groupId);
  applyScene("lobby");
  if (CONFIG.flux && CONFIG.clientKey) {
    try {
      flux = require('./hue-flux').creerFlux({
        bridgeIp: CONFIG.bridgeIp, apiKey: CONFIG.apiKey, clientKey: CONFIG.clientKey, zoneId: CONFIG.zoneId,
        // Toujours affichés (sans clé) : c'est la seule façon de savoir, sur la tablette, quel mode tourne
        log: (...a) => console.log("[lumières]", ...a),
        surActif: () => surFluxActif(),
        // Tombé : les commandes ordinaires reposent la scène en cours, avec son effet (un éclair
        // interrompu ne laisse pas sa couleur dans la pièce) ; à défaut, la dernière couleur
        surPerte: () => {
          if (currentSceneKey && SCENES[currentSceneKey]) { finEclair = 0; applyScene(currentSceneKey, 400); }
          else if (dernierEtat) callHue(_sceneBody(dernierEtat, { duration: 400 }));
        },
      });
      // Laisse la commande du salon allumer les lampes avant que le flux ne prenne la main
      setTimeout(() => flux.demarrer(), 1500);
    } catch (e) { console.warn("[lumières] flux impossible, commandes ordinaires :", e.message); flux = null; }
  }
} else if (CONFIG.enabled) {
  console.warn("[lights] LIGHTS_ENABLED=true mais HUE_BRIDGE_IP/HUE_API_KEY/HUE_GROUP_ID manquant — dormant.");
}

// Une erreur des lumières ne doit jamais interrompre le jeu : elle s'arrête ici
const sansErreur = f => (...args) => { try { return f(...args); } catch (e) { _log("err:", e.message); } };
module.exports = {
  applyScene: sansErreur(applyScene), flash: sansErreur(flash), flashSequence: sansErreur(flashSequence), vague: sansErreur(vague),
  sonner: sansErreur(sonner), depouillement: sansErreur(depouillement), luminosite: sansErreur(luminosite),
  reset: sansErreur(reset), status, aLaScene,
  // Pour les vérifications seulement
  _essai: { brancherFlux, COUPS, DECALAGE_SON_MS },
};
