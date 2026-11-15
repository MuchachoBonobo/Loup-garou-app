// depouillement.js — le Dépouillement (2026-11-15), commun à l'écran des joueurs et à celui du MJ.
// Dès qu'il reste 4 vivants, les bulletins du vote du jour s'ouvrent un par un, au rythme du MJ :
// une enveloppe « Bulletin d'Anna » arrive de l'urne et s'ouvre, le bulletin « vote contre Bob » sort
// et se pose devant elle, puis la voix s'inscrit sur la feuille de pointage. L'annonce de la fin
// (« ⚖️ Le village a tranché ») reste la carte habituelle de chaque écran. Styles : css/depouillement.css.
//
// creerDepouillement(conteneur, photoDe) : `photoDe(prénom)` donne la photo d'un joueur (ou rien).
// Les évènements du serveur : debut({ total, vivants }), bulletin({ index, total, de, vers, voix, corbeau }),
// etat({ total, vivants, ouverts }) pour un écran qui se reconnecte.

/* exported creerDepouillement */
/* global couleurDuJoueur */
const DEPOUILLEMENT_OUVERTURE_MS = 2650;   // fin de la sortie du bulletin (1,15 s d'attente + 1,5 s, depouillement.css)
const DEP_PATTE = `<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="rgba(255,214,196,0.5)">
  <ellipse cx="12" cy="15.5" rx="5" ry="4.2"/><ellipse cx="5.5" cy="9.5" rx="2" ry="2.6"/><ellipse cx="9.5" cy="5.5" rx="2" ry="2.7"/>
  <ellipse cx="14.5" cy="5.5" rx="2" ry="2.7"/><ellipse cx="18.5" cy="9.5" rx="2" ry="2.6"/></g></svg>`;

function creerDepouillement(conteneur, photoDe) {
  let total = 0, vivants = [], ouverts = [], minuterie = null;
  const echapper = t => String(t == null ? "" : t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const mouvementReduit = () => window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  // La photo d'un joueur, ou son initiale sur sa couleur ; `neuf` : elle apparaît à l'instant
  function photo(nom, taille, neuf) {
    const cl = "av" + (neuf ? " neuf" : "");
    const src = photoDe && photoDe(nom);
    if (src) return `<img class="${cl}" src="${echapper(src)}" alt="" style="width:${taille}px;height:${taille}px;">`;
    // Sans photo : son initiale, sur la couleur de la liste des joueurs (couleurDuJoueur, communs.js)
    return `<div class="${cl}" style="width:${taille}px;height:${taille}px;background:${couleurDuJoueur(nom)};font-size:${Math.round(taille * 0.42)}px">${echapper(Array.from(nom || "?")[0].toUpperCase())}</div>`;
  }
  const plume = (taille, neuf) => `<div class="dep-plume${neuf ? " neuf" : ""}" style="width:${taille}px;height:${taille}px;font-size:${Math.round(taille * 0.55)}px">🪶</div>`;
  const cire = (classe = "") => `<div class="dep-cire ${classe}">${DEP_PATTE}</div>`;
  // « d'Anna », « de Bob » (élision devant une voyelle ou un h)
  const elision = nom => (/^[aeiouyhàâäéèêëîïôöùûü]/i.test(nom) ? "d'" : "de ") + nom;

  // Bâtons de pointage : un trait par voix, légèrement penché ; le 5ᵉ barre les quatre premiers.
  // `enOr` : les `enOr` dernières voix viennent du bulletin qu'on vient d'ouvrir ; `neuf` : elles apparaissent
  function batons(k, enOr, neuf) {
    if (!k) return `<span style="color:rgb(var(--n7))">—</span>`;
    const traits = [];
    for (let i = 0; i < k; i++) {
      const or = i >= k - enOr, c = or ? "rgb(var(--or-vif))" : "rgb(var(--sang-vif))", l = or ? 3.4 : 2.6;
      const cl = or && neuf ? ` class="neuf"` : "";
      if (i % 5 === 4) traits.push(`<line${cl} x1="${(i - 4) * 9 + 1}" y1="20" x2="${(i - 4) * 9 + 30}" y2="5" stroke="${c}" stroke-width="${l}" stroke-linecap="round"/>`);
      else { const x = i * 9 + 4 + (i >= 5 ? 6 : 0); traits.push(`<line${cl} x1="${x}" y1="22" x2="${x + 2}" y2="3" stroke="${c}" stroke-width="${l}" stroke-linecap="round"/>`); }
    }
    const w = Math.max(...[...Array(k).keys()].map(i => i * 9 + 12 + (i >= 5 ? 6 : 0)));
    return `<svg width="${w}" height="24" viewBox="0 0 ${w} 24" aria-label="${k} voix">${traits.join("")}</svg>`;
  }

  // La feuille après les `n` premiers bulletins ouverts ; le dernier en or (sauf `sansOr`), `neuf` s'il arrive
  function pointage(n, neuf, sansOr) {
    const compte = {}, votants = {};
    ouverts.slice(0, n).forEach(b => { compte[b.vers] = (compte[b.vers] || 0) + b.voix; (votants[b.vers] = votants[b.vers] || []).push(b); });
    const dernier = n && !sansOr ? ouverts[n - 1] : null;
    return vivants.map(nom => {
      const k = compte[nom] || 0, recu = dernier && dernier.vers === nom;
      const qui = (votants[nom] || []).map((b, i, l) => {
        const estNeuf = neuf && recu && i === l.length - 1;
        return b.corbeau ? plume(18, estNeuf) : photo(b.de, 18, estNeuf);
      }).join("");
      return `<div class="dep-ligne ${k ? "" : "vide"}">${photo(nom, 30)}<div class="n">${echapper(nom)}</div>
        <div class="dep-droite">${batons(k, recu ? dernier.voix : 0, neuf)}${qui ? `<div class="dep-votants">${qui}</div>` : ""}</div></div>`;
    }).join("");
  }

  function urne(reste, pleine) {
    const plis = `<div class="dep-plis">${Array.from({ length: reste }, () => `<div class="dep-mini-env">${cire()}</div>`).join("")}</div>`;
    if (pleine) return `<div class="dep-urne-pleine">${plis}</div>`;
    return `<div class="dep-urne">${reste ? `Dans l'urne ${plis}` : "L'urne est vide"}</div>`;
  }

  // L'enveloppe d'un bulletin et son contenu (déjà ouverte, ou qui s'ouvre si `anime`)
  function scene(b, anime) {
    const surEnv = b.corbeau
      ? `${plume(34)}<div class="mots"><span class="petit">Bulletin</span><span class="qui">du Corbeau</span></div>`
      : `${photo(b.de, 34)}<div class="mots"><span class="petit">Bulletin</span><span class="qui">${echapper(elision(b.de))}</span></div>`;
    return `<div class="dep-scene${anime ? " anime" : ""}"><div class="dep-enveloppe">
      <div class="dep-dos"></div><div class="dep-rabat"></div>
      <div class="dep-lettre"><div class="contre">${b.voix > 1 ? b.voix + " voix contre" : "vote contre"}</div>
        <div class="cible">${photo(b.vers, 100)}</div><div class="nom-cible">${echapper(b.vers)}</div></div>
      <div class="dep-poche"></div><div class="dep-sur-env">${surEnv}</div>
      <div class="dep-sceau">${cire("g")}${cire("d")}</div></div></div>`;
  }

  function afficher(anime) {
    clearTimeout(minuterie);
    const n = ouverts.length;
    anime = anime && n > 0 && !mouvementReduit();
    if (!n) { conteneur.innerHTML = `<div class="depouillement">${urne(total, true)}<div class="dep-pointage">${pointage(0)}</div></div>`; return; }
    conteneur.innerHTML = `<div class="depouillement">${scene(ouverts[n - 1], anime)}${urne(total - n)}
      <div class="dep-pointage">${anime ? pointage(n - 1, false, true) : pointage(n)}</div></div>`;
    // Le bulletin est posé devant : sa voix s'inscrit (avant, la feuille trahirait la surprise)
    if (anime) minuterie = setTimeout(() => {
      const p = conteneur.querySelector(".dep-pointage");
      if (p) p.innerHTML = pointage(n, true);
    }, DEPOUILLEMENT_OUVERTURE_MS);
  }

  return {
    debut(d) { total = d.total; vivants = d.vivants || []; ouverts = []; afficher(false); },
    bulletin(b) {
      total = b.total || total;
      ouverts = ouverts.slice(0, b.index - 1).concat([b]);
      afficher(true);
    },
    etat(d) { total = d.total; vivants = d.vivants || []; ouverts = (d.ouverts || []).slice(); afficher(false); },
    fermer() { clearTimeout(minuterie); conteneur.innerHTML = ""; },
    ouverts: () => ouverts.length,
    total: () => total,
  };
}
