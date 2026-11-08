// essai-evenements.js — OUTIL D'ESSAI TEMPORAIRE (2026-11-08) de la tablette du MJ. À RETIRER après
// la partie d'essai des évènements : supprimer ce fichier et ../../essai-evenements.js, puis les deux
// lignes qui les branchent (cherche « essai-evenements » dans server.js et mj.html).
//
// En plein jour : un panneau repliable « 🧪 Essai des évènements » sous le bandeau de l'évènement.
// Un toucher arrête l'évènement en cours et pose le nouveau « à annoncer », comme au matin ; la
// musique du jour repart (l'ambiance de l'évènement arrêté ne reste pas).
/* global socket, currentPhaseForBar, stopAmbiance, playAmbiance, audioEnabled, ambianceAudio, ambianceName */
(function () {
  if (typeof socket === "undefined") return;
  const panneau = document.createElement("div");
  panneau.className = "section";
  panneau.style.cssText = "display:none;border-color:rgb(var(--ame-base));";
  panneau.innerHTML = `<details>
      <summary style="cursor:pointer;font-size:13px;color:rgb(var(--ame-clair));">🧪 Essai des évènements (temporaire)</summary>
      <div id="essaiBoutons" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px;margin-top:10px;"></div>
    </details>`;
  const bandeau = document.getElementById("councilActiveBanner");
  if (bandeau) bandeau.after(panneau); else document.body.appendChild(panneau);

  let musiqueARelancer = false;
  socket.on("essaiListe", liste => {
    document.getElementById("essaiBoutons").innerHTML = (liste || []).map(e =>
      `<button class="btn" data-id="${e.id}" style="padding:8px 6px;font-size:12px;">${e.title}</button>`).join("");
  });
  document.getElementById("essaiBoutons").addEventListener("click", ev => {
    const b = ev.target.closest("button[data-id]");
    if (!b) return;
    musiqueARelancer = true;
    socket.emit("essaiEvenement", b.dataset.id);
  });
  // L'évènement arrêté : sa musique (orage, nuit de l'Éclipse, musique adoucie) laisse la place à celle du jour
  socket.on("councilEventEnd", () => {
    if (!musiqueARelancer) return;
    musiqueARelancer = false;
    const intacte = ambianceName === "day" && ambianceAudio && !ambianceAudio.paused && !ambianceAudio._feutre;
    if (audioEnabled && !intacte && currentPhaseForBar === "day") { stopAmbiance(); playAmbiance("day"); }
  });
  const afficher = p => { panneau.style.display = p === "day" ? "" : "none"; };
  socket.on("phase", afficher);
  socket.on("connect", () => socket.emit("essaiListe"));
  socket.emit("essaiListe");
  afficher(typeof currentPhaseForBar !== "undefined" ? currentPhaseForBar : null);
})();
