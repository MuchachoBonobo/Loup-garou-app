/**
 * lights.js — Pilote Philips Hue pour Loup-Garou.
 *
 * Mode "fire-and-forget" : aucun appel ne bloque le moteur de jeu, aucune
 * erreur réseau ne fait crasher quoi que ce soit. Si LIGHTS_ENABLED != "true"
 * (défaut), le module est totalement dormant — pratique tant que tu n'as pas
 * de Bridge / pas envie d'allumer les lumières.
 *
 * Configuration via variables d'environnement (cf. .env.example) :
 *   LIGHTS_ENABLED  = "true" pour activer (défaut: "false")
 *   HUE_BRIDGE_IP   = ip locale du Bridge (ex: 192.168.1.42)
 *   HUE_API_KEY     = clé d'application générée via le bouton du Bridge
 *   HUE_GROUP_ID    = UUID v2 du groupe "Loup-Garou" (grouped_light)
 *   LIGHTS_DEBUG    = "true" pour logguer les appels (sinon silencieux)
 *
 * Génération de la clé (à exécuter dans les 30s après pression du bouton physique du Bridge) :
 *   curl -k -X POST https://<bridge-ip>/api \
 *        -d '{"devicetype":"loupgarou#serveur","generateclientkey":true}'
 *
 * Récupération de l'UUID du groupe :
 *   curl -k -H "hue-application-key: <clé>" https://<bridge-ip>/clip/v2/resource/grouped_light
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const CONFIG = {
  enabled:   process.env.LIGHTS_ENABLED === "true",
  bridgeIp:  process.env.HUE_BRIDGE_IP  || "",
  apiKey:    process.env.HUE_API_KEY    || "",
  groupId:   process.env.HUE_GROUP_ID   || "",
  debug:     process.env.LIGHTS_DEBUG === "true"
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
let lastCallAt      = 0;
const MIN_GAP_MS    = 100; // anti rate-limit Hue (~10 cmd/sec/groupe)

function _log(...args) { if (CONFIG.debug) console.log("[lights]", ...args); }

function _ready() {
  return CONFIG.enabled && CONFIG.bridgeIp && CONFIG.apiKey && CONFIG.groupId;
}

/**
 * Appel HTTPS PUT au Bridge. Fire-and-forget : timeout 1.5s, jamais d'await,
 * jamais de throw. Si ça plante, on log en mode debug et c'est tout.
 */
function callHue(payload) {
  if (!_ready()) return;

  // Throttle minimal pour respecter le rate-limit du Bridge
  const now = Date.now();
  const gap = now - lastCallAt;
  if (gap < MIN_GAP_MS) {
    setTimeout(() => callHue(payload), MIN_GAP_MS - gap);
    return;
  }
  lastCallAt = now;

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
    if (CONFIG.debug && res.statusCode >= 400) {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end',  () => _log("HTTP", res.statusCode, buf.slice(0, 200)));
    } else {
      res.resume();
    }
  });
  req.on('error',   e => _log("err:", e.message));
  req.on('timeout', () => { _log("timeout"); req.destroy(); });
  req.write(body);
  req.end();
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
          callHue({ on: {on:true}, color:{xy:{x:0.32,y:0.34}}, dimming:{brightness:100}, dynamics:{duration:0} });
          effectTimeouts.push(setTimeout(() => {
            callHue(_sceneBody(scene, { duration: 600 }));
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
        callHue(_sceneBody(flicker, { duration: 200 }));
      }, 350);
      break;
    }
    case "fast_pulse": {
      // Pulsation rapide pour Panique
      let high = true;
      effectInterval = setInterval(() => {
        callHue(_sceneBody({ xy: scene.xy, bri: high ? scene.bri : Math.max(20, Math.floor(scene.bri*0.35)) }, { duration: 250 }));
        high = !high;
      }, 350);
      break;
    }
    case "slow_pulse": {
      // Pulsation lente : Émeute, Chasseur
      let high = true;
      effectInterval = setInterval(() => {
        callHue(_sceneBody({ xy: scene.xy, bri: high ? scene.bri : Math.max(30, Math.floor(scene.bri*0.55)) }, { duration: 900 }));
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
function applyScene(key) {
  const scene = SCENES[key];
  if (!scene) { _log("scène absente:", key); return; }
  stopEffect();
  currentSceneKey = key;
  callHue(_sceneBody(scene));
  if (scene.effect) {
    // Petit délai pour laisser la transition s'établir avant l'effet
    setTimeout(() => { if (currentSceneKey === key) startEffect(scene.effect, scene); }, scene.transition || 800);
  }
  _log("scène →", key);
}

/**
 * Flash ponctuel (mort, victoire). Sauvegarde la scène courante, lance N pulses
 * vers la couleur du flash, puis restaure la scène.
 */
function flash(key) {
  const f = SCENES[key];
  if (!f) { _log("flash absent:", key); return; }
  const restore = currentSceneKey;
  const repeat  = f.repeat   || 2;
  const dur     = f.duration || 250;

  // Coupe les effets pendant le flash
  stopEffect();

  for (let i = 0; i < repeat; i++) {
    effectTimeouts.push(setTimeout(() => {
      callHue(_sceneBody({ xy: f.xy, bri: f.bri }, { duration: 0 }));
    }, i * dur));
    effectTimeouts.push(setTimeout(() => {
      callHue(_sceneBody({ xy: f.xy, bri: Math.max(5, Math.floor(f.bri*0.1)) }, { duration: 0 }));
    }, i * dur + Math.floor(dur/2)));
  }
  // Restaure la scène précédente
  effectTimeouts.push(setTimeout(() => {
    if (restore && SCENES[restore]) {
      applyScene(restore);
    }
  }, repeat * dur + 150));

  _log("flash →", key, "(" + repeat + "x)");
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
  const restore = currentSceneKey;
  const dur  = f.duration || 250;
  const gap  = 400; // silence entre deux morts
  stopEffect();
  for (let d = 0; d < count; d++) {
    const base = d * (dur + gap);
    effectTimeouts.push(setTimeout(() => {
      callHue(_sceneBody({ xy: f.xy, bri: f.bri }, { duration: 0 }));
    }, base));
    effectTimeouts.push(setTimeout(() => {
      callHue(_sceneBody({ xy: f.xy, bri: Math.max(5, Math.floor(f.bri * 0.1)) }, { duration: 0 }));
    }, base + Math.floor(dur / 2)));
  }
  effectTimeouts.push(setTimeout(() => {
    if (restore && SCENES[restore]) applyScene(restore);
  }, count * (dur + gap) + 150));
  _log("flashSequence →", key, "×" + count);
}

/**
 * Reset complet (sur reset de partie).
 */
function reset() {
  stopEffect();
  currentSceneKey = null;
  if (_ready()) applyScene("lobby");
}

/**
 * Ping de santé — utile pour un futur indicateur côté MJ.
 */
function status() {
  return {
    enabled: CONFIG.enabled,
    configured: _ready(),
    currentScene: currentSceneKey,
    scenesLoaded: Object.keys(SCENES).filter(k => !k.startsWith("_")).length
  };
}

// Au démarrage, si on est prêt, on initialise en lobby (mais on ne crashe
// jamais si le Bridge n'est pas joignable — fire-and-forget).
if (_ready()) {
  _log("activé — Bridge", CONFIG.bridgeIp, "groupe", CONFIG.groupId);
  applyScene("lobby");
} else if (CONFIG.enabled) {
  console.warn("[lights] LIGHTS_ENABLED=true mais HUE_BRIDGE_IP/HUE_API_KEY/HUE_GROUP_ID manquant — dormant.");
}

module.exports = { applyScene, flash, flashSequence, reset, status, SCENES };
