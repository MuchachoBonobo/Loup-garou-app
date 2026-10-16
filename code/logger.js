// logger.js — Logger minimal : console + fichier journalier dans logs/YYYY-MM-DD.log.
// Aucune dépendance externe. 4 niveaux : info, warn, error, debug (debug uniquement si LOG_DEBUG=1).
// Usage : const log = require('./logger'); log.info('setPhase', from, '->', to);

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs');
try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}

function pad(n) { return n < 10 ? '0' + n : '' + n; }
function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function logFilePath() {
  const d = new Date();
  return path.join(LOG_DIR, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.log`);
}

let stream = null;
let streamPath = null;
function getStream() {
  const p = logFilePath();
  if (!stream || streamPath !== p) {
    if (stream) { try { stream.end(); } catch (_) {} }
    try {
      stream = fs.createWriteStream(p, { flags: 'a' });
      streamPath = p;
    } catch (_) { stream = null; streamPath = null; }
  }
  return stream;
}

function stringify(arg) {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack || arg.message;
  try { return JSON.stringify(arg); } catch (_) { return String(arg); }
}

function log(level, args) {
  const line = `[${timestamp()}] [${level}] ${args.map(stringify).join(' ')}`;
  // Console
  if (level === 'ERROR' || level === 'WARN') console.error(line);
  else console.log(line);
  // Fichier (best effort, n'échoue jamais)
  const s = getStream();
  if (s) { try { s.write(line + '\n'); } catch (_) {} }
}

module.exports = {
  info:  (...a) => log('INFO',  a),
  warn:  (...a) => log('WARN',  a),
  error: (...a) => log('ERROR', a),
  debug: (...a) => { if (process.env.LOG_DEBUG === '1') log('DEBUG', a); },
};
