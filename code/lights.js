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
 * HUE_CLIENT_KEY, HUE_ZONE_ID, LIGHTS_MODE, lues dans .env — chacune expliquée dans .env.example
 * (avec la façon d'obtenir la clé et l'identifiant du groupe).
 *
 * Deux façons de parler au Bridge (2026-11-15) :
 *  - le FLUX (mode « Entertainment », hue-flux.js), dès qu'il y a une HUE_CLIENT_KEY : 60 images par
 *    seconde, fondus calculés ici, plus de commande perdue ni en retard ;
 *  - les COMMANDES ordinaires (callHue), une par changement : avant que le flux soit établi, s'il
 *    tombe, ou avec LIGHTS_MODE=classique.
 * Les scènes, les effets et les éclairs ne savent pas lequel sert : ils passent tous par `envoyer`.
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
 * Le point de passage de toutes les couleurs : aller vers `etat` ({ xy, bri }) en `duree` ms. Par le
 * flux s'il est établi, sinon par une commande ordinaire. La dernière couleur demandée est retenue :
 * le flux part d'elle en s'établissant, et les commandes ordinaires la reposent s'il tombe.
 */
let flux = null, dernierEtat = null;
function envoyer(etat, duree) {
  dernierEtat = etat;
  if (flux && flux.actif()) flux.poser(etat, duree);
  else callHue(_sceneBody(etat, { duration: duree }));
}

/**
 * Convertit notre format scène vers le body CLIP v2 du Bridge.
 */
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
    body.dimming = { brightness: Math.max(1, Math.min(100, Math.round(scene.bri / 254 * 100))) };
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

/**
 * Démarre un effet récurrent sur la scène courante.
 * Tous les effets respectent ~10 Hz max pour ne pas saturer le Bridge.
 */
function startEffect(name, scene) {
  stopEffect();
  switch (name) {
    case "lightning": {
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
    case "slow_pulse": {
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

/**
 * Applique une scène (clé du JSON). Restaure l'éclairage en transition fluide
 * et démarre l'éventuel effet associé.
 */
function applyScene(key, transitionForcee) {
  const scene = SCENES[key];
  if (!scene) { _log("scène absente:", key); return; }
  currentSceneKey = key;
  // Un éclair en cours va jusqu'au bout : c'est lui qui posera cette scène en finissant. Sinon le
  // changement de phase qui le suit aussitôt l'annulait (les morts de l'aube, la proie des loups).
  if (Date.now() < finEclair) { _log("scène après l'éclair →", key); return; }
  stopEffect();
  envoyer(scene, transitionForcee != null ? transitionForcee : (scene.transition || 800));
  if (scene.effect) {
    // Petit délai pour laisser la transition s'établir avant l'effet
    setTimeout(() => { if (currentSceneKey === key && Date.now() >= finEclair) startEffect(scene.effect, scene); }, scene.transition || 800);
  }
  _log("scène →", key);
}

// Éclair qui finit dans `delai` ms : il posera alors la scène retenue entre-temps (applyScene), vite —
// avec la lente transition du vote (5 s), le rouge de la mort traînait dans la pièce (Alexandre, 2026-11-10).
const RETOUR_APRES_ECLAIR_MS = 800;
function apresEclair(delai) {
  finEclair = Date.now() + delai;
  effectTimeouts.push(setTimeout(() => {
    finEclair = 0;
    const s = currentSceneKey && SCENES[currentSceneKey];
    if (s) applyScene(currentSceneKey, Math.min(s.transition || RETOUR_APRES_ECLAIR_MS, RETOUR_APRES_ECLAIR_MS));
  }, delai));
}

/**
 * Flash ponctuel (mort, victoire). Lance N pulses vers la couleur du flash, puis pose la scène
 * en cours : celle d'avant, ou celle qu'un changement de phase a demandée pendant l'éclair.
 */
function flash(key) {
  const f = SCENES[key];
  if (!f) { _log("flash absent:", key); return; }
  const repeat  = f.repeat   || 2;
  const dur     = f.duration || 250;
  // `montee` : fondu de chaque montée et descente (0 : éclair sec) ; `creux` : intensité entre deux,
  // en part de `bri`. La victoire monte en vagues lentes, une mort reste un éclair sec (2026-11-14).
  const montee  = f.montee || 0;
  const creux   = f.creux != null ? f.creux : 0.1;

  // Coupe les effets pendant le flash
  stopEffect();

  for (let i = 0; i < repeat; i++) {
    effectTimeouts.push(setTimeout(() => {
      envoyer({ xy: f.xy, bri: f.bri }, montee);
    }, i * dur));
    effectTimeouts.push(setTimeout(() => {
      envoyer({ xy: f.xy, bri: Math.max(5, Math.floor(f.bri * creux)) }, montee);
    }, i * dur + Math.floor(dur/2)));
  }
  apresEclair(repeat * dur + 150);
  _log("flash →", key, "(" + repeat + "x)");
}

/**
 * Vague : la lumière glisse vers une couleur (montée en fondu, `montee` ms), y reste, puis revient
 * à la scène en cours au bout de `duree` ms. Le hurlement de la Lune Rousse (un rouge qui monte),
 * l'ombre des corbeaux (une pénombre soudaine). Comme un flash, sans clignoter.
 */
function vague(key) {
  const v = SCENES[key];
  if (!v) { _log("vague absente:", key); return; }
  stopEffect();   // coupe aussi un éclair en cours : la vague reposera la scène en finissant
  finEclair = 0;
  envoyer(v, v.montee || 1500);
  effectTimeouts.push(setTimeout(() => {
    if (currentSceneKey && SCENES[currentSceneKey]) applyScene(currentSceneKey);
  }, v.duree || 5000));
  _log("vague →", key);
}

/**
 * Séquence de N flashs de mort espacés — pour plusieurs morts la même nuit.
 * Contrairement à `flash`, n'est appelé qu'une fois avec le compte total,
 * ce qui évite que chaque flash annule le précédent via stopEffect().
 */
function flashSequence(key, count) {
  const f = SCENES[key];
  if (!f) { _log("flash absent:", key); return; }
  if (count <= 0) return;
  if (count === 1) { flash(key); return; }
  const dur  = f.duration || 250;
  const gap  = 400; // silence entre deux morts
  stopEffect();
  for (let d = 0; d < count; d++) {
    const base = d * (dur + gap);
    effectTimeouts.push(setTimeout(() => {
      envoyer({ xy: f.xy, bri: f.bri }, 0);
    }, base));
    effectTimeouts.push(setTimeout(() => {
      envoyer({ xy: f.xy, bri: Math.max(5, Math.floor(f.bri * 0.1)) }, 0);
    }, base + Math.floor(dur / 2)));
  }
  apresEclair(count * (dur + gap) + 150);
  _log("flashSequence →", key, "×" + count);
}

/**
 * Reset complet (sur reset de partie).
 */
function reset() {
  stopEffect();
  finEclair = 0;
  currentSceneKey = null;
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
    currentScene: currentSceneKey,
    mode: flux && flux.actif() ? "flux" : "commandes",
    scenesLoaded: Object.keys(SCENES).filter(k => !k.startsWith("_")).length
  };
}

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
        // Établi : il part de la couleur actuelle, sans saut
        surActif: () => { if (dernierEtat) flux.poser(dernierEtat, 0); },
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
  reset: sansErreur(reset), status, aLaScene,
};
