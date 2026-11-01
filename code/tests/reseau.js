/**
 * tests/reseau.js — le choix de l'adresse du jeu (reseau.js), celle du QR code : sans serveur,
 * sur des ordinateurs imaginaires (machine virtuelle, VPN, Wi-Fi + Ethernet, tablette Android).
 *
 * Usage : node tests/reseau.js   (lancé aussi par npm test, quelques millisecondes)
 */
"use strict";
const { choisirAdresse } = require("../reseau");

let echecs = 0;
function check(nom, obtenu, attendu) {
  const ok = obtenu === attendu;
  if (!ok) echecs++;
  console.log(`  ${ok ? "✅" : "❌"} ${nom}${ok ? "" : `  — obtenu ${obtenu}, attendu ${attendu}`}`);
}
const v4 = (address, internal = false) => ({ family: "IPv4", address, internal });
const choix = (interfaces, reglee = null) => choisirAdresse(interfaces, reglee).adresse;

console.log("▶ Adresse du jeu");
const local = { "Loopback Pseudo-Interface 1": [v4("127.0.0.1", true)] };
check("le Wi-Fi seul", choix({ ...local, "Wi-Fi": [v4("192.168.1.100"), { family: "IPv6", address: "fe80::1", internal: false }] }), "192.168.1.100");
check("machine virtuelle et WSL listées avant le Wi-Fi", choix({
  "VirtualBox Host-Only Network": [v4("192.168.56.1")], "vEthernet (WSL)": [v4("172.20.48.1")], "Wi-Fi": [v4("192.168.8.231")],
}), "192.168.8.231");
check("Ethernet de la box et Wi-Fi du routeur « La nuit du village »", choix({ "Ethernet": [v4("192.168.1.20")], "Wi-Fi": [v4("192.168.8.231")] }), "192.168.8.231");
check("à réseaux égaux, le Wi-Fi plutôt que l'Ethernet", choix({ "Ethernet": [v4("192.168.1.20")], "Wi-Fi": [v4("192.168.0.12")] }), "192.168.0.12");
check("VPN listé en premier", choix({ "NordLynx": [v4("10.5.0.2")], "Wi-Fi": [v4("192.168.1.100")] }), "192.168.1.100");
check("adresse de secours de Windows (169.254) écartée", choix({ "Ethernet": [v4("169.254.10.3")], "Wi-Fi": [v4("10.0.0.7")] }), "10.0.0.7");
check("aucune adresse utilisable : 127.0.0.1", choix(local), "127.0.0.1");
check("ADRESSE_DU_JEU l'emporte quand c'est une adresse de l'ordinateur", choix({ "Ethernet": [v4("192.168.1.20")], "Wi-Fi": [v4("192.168.8.231")] }, "192.168.1.20"), "192.168.1.20");
const absente = choisirAdresse({ "Wi-Fi": [v4("192.168.1.100")] }, "192.168.8.231");
check("ADRESSE_DU_JEU absente de l'ordinateur : l'adresse trouvée", absente.adresse, "192.168.1.100");
check("… avec un avertissement", !!absente.avertissement, true);
check("tablette Android (adresses illisibles) : ADRESSE_DU_JEU", choix(null, "192.168.8.240"), "192.168.8.240");
const sansReglage = choisirAdresse(null, null);
check("tablette Android sans ADRESSE_DU_JEU : 127.0.0.1 et un avertissement", sansReglage.adresse + " " + !!sansReglage.avertissement, "127.0.0.1 true");

console.log(`\nBILAN : ${12 - echecs}/12 vérifications passées`);
process.exit(echecs ? 1 : 0);
