// Petit serveur statique pour relire le site vitrine avant de le déposer sur Netlify.
// Il imite le comportement de Netlify : URL sans extension, _redirects, page 404.
//
//   node code/outils/serveur-site-vitrine.js      (puis http://localhost:4321)
//
// Le site lui-même vit dans gestion/prive/site/ (dossier non versionné : il contient
// les mentions légales avec les coordonnées personnelles).

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const RACINE = path.join(__dirname, '..', '..', 'gestion', 'prive', 'site');
const PORT = Number(process.env.PORT) || 4321;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
};

// Lit les règles de _redirects (« source  cible  301 »).
function chargerRedirections() {
  const fichier = path.join(RACINE, '_redirects');
  if (!fs.existsSync(fichier)) return [];
  return fs.readFileSync(fichier, 'utf8')
    .split('\n')
    .map((ligne) => ligne.trim())
    .filter((ligne) => ligne && !ligne.startsWith('#'))
    .map((ligne) => ligne.split(/\s+/))
    .filter((parts) => parts.length >= 2)
    .map(([source, cible, code]) => ({ source, cible, code: parseInt(code, 10) || 301 }));
}

// Trouve le fichier correspondant à une URL, en essayant les variantes de Netlify.
function trouverFichier(chemin) {
  const candidats = chemin.endsWith('/')
    ? [path.join(chemin, 'index.html')]
    : [chemin, chemin + '.html', path.join(chemin, 'index.html')];
  for (const candidat of candidats) {
    const absolu = path.join(RACINE, candidat);
    if (!absolu.startsWith(RACINE)) continue; // pas de sortie du dossier
    if (fs.existsSync(absolu) && fs.statSync(absolu).isFile()) return absolu;
  }
  return null;
}

const redirections = chargerRedirections();

http.createServer((req, rep) => {
  const chemin = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);

  const redirection = redirections.find((r) => r.source === chemin);
  if (redirection) {
    rep.writeHead(redirection.code, { Location: redirection.cible });
    return rep.end();
  }

  const fichier = trouverFichier(chemin);
  if (!fichier) {
    const page404 = path.join(RACINE, '404.html');
    rep.writeHead(404, { 'Content-Type': TYPES['.html'] });
    return rep.end(fs.existsSync(page404) ? fs.readFileSync(page404) : 'Introuvable');
  }

  rep.writeHead(200, { 'Content-Type': TYPES[path.extname(fichier).toLowerCase()] || 'application/octet-stream' });
  rep.end(fs.readFileSync(fichier));
}).listen(PORT, () => {
  console.log(`Site vitrine servi depuis ${RACINE}`);
  console.log(`→ http://localhost:${PORT}`);
});
