// reseau.js — l'adresse du jeu sur le Wi-Fi : celle du QR code et de la fenêtre noire.
// L'ordinateur a souvent plusieurs adresses (Wi-Fi et Ethernet, machine virtuelle, VPN) : la
// première venue pouvait être celle d'une machine virtuelle, et aucun téléphone n'entrait. On
// prend la plus probable (celle du routeur « La nuit du village » d'abord) ; ADRESSE_DU_JEU
// (.env) la fixe à la main. Sur une tablette Android (Termux), le système refuse de donner ses
// adresses : seule ADRESSE_DU_JEU donne alors la bonne.

const os  = require("os");
const log = require("./logger");

// Adaptateurs qui ne mènent pas aux téléphones : machines virtuelles, VPN, Bluetooth…
const VIRTUEL = /virtual|vmware|vbox|hyper-v|vethernet|wsl|docker|bluetooth|tailscale|zerotier|hamachi|radmin|openvpn|wireguard|nordlynx|tap-|tun\d|npcap/i;
const WIFI    = /wi-?fi|wlan|wireless|sans fil/i;

// Plus le rang est haut, plus l'adresse a de chances d'être celle que voient les téléphones
function rang(nom, adresse) {
  if (adresse.startsWith("169.254.")) return -100;   // adresse de secours de Windows : aucun réseau derrière
  let r = 1;
  if (adresse.startsWith("192.168.8.")) r = 5;        // le routeur « La nuit du village » (GL.iNet)
  else if (adresse.startsWith("192.168.")) r = 4;
  else if (adresse.startsWith("10.") || /^172\.(1[6-9]|2\d|3[01])\./.test(adresse)) r = 3;
  if (WIFI.test(nom)) r += 0.5;                        // les téléphones sont sur le Wi-Fi
  if (VIRTUEL.test(nom)) r -= 50;
  return r;
}

// Choisit l'adresse parmi les interfaces réseau (format de os.networkInterfaces(), ou null si le
// système les refuse) ; `reglee` : ADRESSE_DU_JEU. Rend { adresse, avertissement }.
function choisirAdresse(interfaces, reglee) {
  if (!interfaces) {
    return reglee ? { adresse: reglee, avertissement: null }
      : { adresse: "127.0.0.1", avertissement: "adresses réseau illisibles : écris l'adresse du jeu dans .env (ADRESSE_DU_JEU)" };
  }
  const candidates = [];
  for (const [nom, liste] of Object.entries(interfaces)) {
    for (const i of liste || []) if (i.family === "IPv4" && !i.internal) candidates.push({ nom, adresse: i.address });
  }
  let avertissement = null;
  if (reglee) {
    if (candidates.some(c => c.adresse === reglee)) return { adresse: reglee, avertissement: null };
    avertissement = `ADRESSE_DU_JEU (${reglee}) n'est pas une adresse de l'ordinateur en ce moment : adresse trouvée à la place`;
  }
  // À rang égal, l'ordre du système départage (tri stable)
  candidates.sort((a, b) => rang(b.nom, b.adresse) - rang(a.nom, a.adresse));
  const meilleure = candidates.find(c => rang(c.nom, c.adresse) > 0);
  if (!meilleure) avertissement = avertissement || "aucune adresse Wi-Fi ou Ethernet trouvée";
  return { adresse: meilleure ? meilleure.adresse : "127.0.0.1", avertissement };
}

// L'adresse du jeu, recalculée à chaque appel (l'ordinateur peut changer de Wi-Fi après le
// lancement) ; chaque avertissement n'est écrit qu'une fois au journal
const dejaDit = new Set();
function adresseDuJeu() {
  let interfaces = null;
  try { interfaces = os.networkInterfaces(); } catch { /* Android : accès refusé */ }
  const { adresse, avertissement } = choisirAdresse(interfaces, (process.env.ADRESSE_DU_JEU || "").trim() || null);
  if (avertissement && !dejaDit.has(avertissement)) { dejaDit.add(avertissement); log.warn("adresse du jeu", avertissement); }
  return adresse;
}

module.exports = { adresseDuJeu, choisirAdresse };
