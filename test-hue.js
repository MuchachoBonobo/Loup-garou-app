/**
 * test-hue.js — Diagnostic direct de la connexion Philips Hue.
 * Lance :  node test-hue.js
 * Lit le .env tout seul, envoie UNE commande au Bridge, affiche le resultat.
 */
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// --- Lecture manuelle du .env (independante des variables d'environnement) ---
const env = {};
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2];
  });
} catch (e) {
  console.log('X Impossible de lire le fichier .env :', e.message);
  process.exit(1);
}

console.log('=== Configuration lue depuis .env ===');
console.log('  LIGHTS_ENABLED :', env.LIGHTS_ENABLED);
console.log('  HUE_BRIDGE_IP  :', env.HUE_BRIDGE_IP || '(VIDE)');
console.log('  HUE_API_KEY    :', env.HUE_API_KEY ? env.HUE_API_KEY.slice(0, 8) + '...(' + env.HUE_API_KEY.length + ' caracteres)' : '(VIDE)');
console.log('  HUE_GROUP_ID   :', env.HUE_GROUP_ID || '(VIDE)');
console.log('');

if (!env.HUE_BRIDGE_IP || !env.HUE_API_KEY || !env.HUE_GROUP_ID) {
  console.log('X Une valeur est vide dans le .env — corrige-la avant de relancer.');
  process.exit(1);
}

// --- Commande de test : passe le groupe en ROUGE VIF ---
const body = JSON.stringify({
  on:      { on: true },
  color:   { xy: { x: 0.68, y: 0.31 } },
  dimming: { brightness: 80 }
});

console.log('-> Envoi d une commande "rouge" au groupe ' + env.HUE_GROUP_ID + ' ...');
console.log('');

const req = https.request({
  hostname: env.HUE_BRIDGE_IP,
  port:     443,
  path:     '/clip/v2/resource/grouped_light/' + env.HUE_GROUP_ID,
  method:   'PUT',
  agent:    new https.Agent({ rejectUnauthorized: false }),
  headers: {
    'hue-application-key': env.HUE_API_KEY,
    'Content-Type':        'application/json',
    'Content-Length':      Buffer.byteLength(body)
  },
  timeout: 5000
}, res => {
  let buf = '';
  res.on('data', c => buf += c);
  res.on('end', () => {
    console.log('=== Reponse du Bridge ===');
    console.log('  HTTP ' + res.statusCode);
    console.log('  ' + buf);
    console.log('');
    if (res.statusCode === 200) {
      console.log('OK ! Le bandeau devrait etre ROUGE maintenant.');
      console.log('   -> Si oui : la connexion Hue marche, le souci venait du chargement du .env.');
      console.log('   -> Relance le jeu avec  .\\start.ps1  (et PAS  node server.js  tout seul).');
    } else {
      console.log('X Le Bridge a refuse la commande. Le message ci-dessus indique pourquoi');
      console.log('  (souvent : mauvais HUE_GROUP_ID ou cle invalide).');
    }
  });
});
req.on('error',   e => console.log('X ERREUR RESEAU : ' + e.message + '\n  -> Verifie HUE_BRIDGE_IP et que le PC est sur le meme reseau que le Bridge.'));
req.on('timeout', () => { console.log('X TIMEOUT : le Bridge ne repond pas a ' + env.HUE_BRIDGE_IP); req.destroy(); });
req.write(body);
req.end();
