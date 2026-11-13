// essai-evenements.js — OUTIL D'ESSAI TEMPORAIRE (2026-11-08 ; mode essai le 2026-11-11) de la tablette
// du MJ. À RETIRER après les essais : supprimer ce fichier et ../../essai-evenements.js, puis les deux
// lignes qui les branchent (cherche « essai-evenements » dans server.js et mj.html).
//
// Au salon et en plein jour : un panneau repliable « 🧪 Essai des évènements ». Au salon, un toucher
// lance une journée d'essai (robots, rôles, maire, matin avec l'évènement à annoncer) ; en plein jour,
// il change d'évènement sur place. Le soir d'une journée d'essai, à la place de « Lancer la nuit », une
// carte propose l'évènement suivant, ou de quitter l'essai. La musique du jour repart quand un
// évènement en remplace un autre (l'ambiance de l'évènement arrêté ne reste pas).
/* global socket, currentPhaseForBar, stopAmbiance, playAmbiance, audioEnabled, ambianceAudio, ambianceName, retourAuSalon */
(function () {
  if (typeof socket === "undefined") return;
  const grille = "display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px;";
  const panneau = document.createElement("div");
  panneau.className = "section";
  panneau.style.cssText = "display:none;border-color:rgb(var(--ame-base));";
  panneau.innerHTML = `<details>
      <summary style="cursor:pointer;font-size:13px;color:rgb(var(--ame-clair));">🧪 Essai des évènements (temporaire)</summary>
      <div id="essaiAide" style="font-size:12px;color:rgb(var(--n6));margin-top:8px;"></div>
      <div class="essai-boutons" style="${grille}margin-top:10px;"></div>
    </details>`;
  const bandeau = document.getElementById("councilActiveBanner");
  if (bandeau) bandeau.after(panneau); else document.body.appendChild(panneau);

  // Le soir d'une journée d'essai : l'évènement suivant, par-dessus la carte « Lancer la nuit »
  const carte = document.createElement("div");
  carte.className = "plein-ecran";
  carte.style.cssText = "display:none;z-index:9996;overflow-y:auto;background:radial-gradient(ellipse at center,rgb(var(--ame-fond)) 0%,rgb(var(--n0)) 100%);";
  carte.innerHTML = `<div style="font-size:48px;margin-bottom:8px;">🧪</div>
    <div style="font-size:22px;font-weight:bold;color:rgb(var(--ame-clair));margin-bottom:6px;">Évènement suivant</div>
    <div style="font-size:13px;color:rgb(var(--n6));margin-bottom:14px;">Une nouvelle journée d'essai, tout le monde en vie.</div>
    <div class="essai-boutons" style="${grille}width:100%;max-width:640px;"></div>
    <button class="btn" id="essaiQuitter" style="margin-top:18px;padding:12px 28px;">🏠 Quitter l'essai</button>`;
  document.body.appendChild(carte);
  carte.querySelector("#essaiQuitter").onclick = () => retourAuSalon();

  let essaiActif = false, musiqueARelancer = false;
  const majAffichage = () => {
    const p = typeof currentPhaseForBar !== "undefined" ? currentPhaseForBar : null;
    panneau.style.display = (p === "lobby" || p === "day") ? "" : "none";
    document.getElementById("essaiAide").textContent = p === "day"
      ? "Change l'évènement du jour (hors vote)."
      : "Lance une journée d'essai : 8 joueurs avec des robots, un maire tiré au sort, le matin avec l'évènement à annoncer.";
    carte.style.display = (essaiActif && p === "crepuscule") ? "flex" : "none";
  };
  socket.on("essaiListe", liste => {
    const html = (liste || []).map(e =>
      `<button class="btn" data-id="${e.id}" style="padding:10px 6px;font-size:13px;">${e.title}</button>`).join("");
    document.querySelectorAll(".essai-boutons").forEach(z => { z.innerHTML = html; });
  });
  document.querySelectorAll(".essai-boutons").forEach(z => z.addEventListener("click", ev => {
    const b = ev.target.closest("button[data-id]");
    if (!b) return;
    musiqueARelancer = currentPhaseForBar === "day";
    socket.emit("essaiEvenement", b.dataset.id);
  }));
  socket.on("essaiEtat", d => { essaiActif = !!(d && d.actif); majAffichage(); });
  // L'évènement arrêté : sa musique (orage, nuit de l'Éclipse, musique adoucie) laisse la place à celle du jour
  socket.on("councilEventEnd", () => {
    if (!musiqueARelancer) return;
    musiqueARelancer = false;
    const intacte = ambianceName === "day" && ambianceAudio && !ambianceAudio.paused && !ambianceAudio._feutre;
    if (audioEnabled && !intacte && currentPhaseForBar === "day") { stopAmbiance(); playAmbiance("day"); }
  });
  socket.on("phase", p => { if (p === "lobby") essaiActif = false; setTimeout(majAffichage, 0); });
  socket.on("connect", () => socket.emit("essaiListe"));
  socket.emit("essaiListe");
  majAffichage();
})();
