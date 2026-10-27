// roles.js — Logique de tous les rôles : Salvateur, Voyante, Petite Fille, Sorcière, Cupidon,
// Corbeau, Chasseur, Idiot ; mécanique mort, transfert maire, résolution de nuit, attribution
// initiale, mission. Inclut tous les handlers socket des rôles.
//
// Dépendances circulaires (phases, votes) résolues via require('./module').fn() à l'usage.

const {
  state, alivePlayers, playerName, hasRole, isMJ, fisherYates, resetActivity, versMJ, joueursAvecRole, vivantsAvecRole, oublierTransfert, infosSalvateur,
  CUPID_SOUND_MS, SISTERS_TIMEOUT_MS, AMOUREUX_TIMEOUT_MS, SEER_ACK_TIMEOUT_MS, PETITE_FILLE_ACK_TIMEOUT_MS,
} = require('./state');

const lights = require('./lights');
const phases = require('./phases');
const log    = require('./logger');
const deathNarratives = require('./death-narratives');

// Libellés français des rôles (pour les récits de mort + révélation)
const { ROLE_LABEL } = deathNarratives;

// Phases où une mort compte comme « de nuit » : après une transmission d'écharpe, la
// partie reprend alors au jour (et non sur une nouvelle nuit). Doit contenir TOUTES les
// étapes de nuit, y compris la pause du MJ (« nightPause ») : c'est pendant cette pause
// que la nuit se résout quand le MJ la rythme. Les phases de la mission sont rangées ici
// depuis toujours (elles précèdent la première nuit).
const PHASES_DE_NUIT = ["cupid", "amoureux", "sisters", "salvateur", "wolves", "seer", "petiteFille", "corbeau", "witch",
  "nightPause", "mission", "missionVote", "missionBonus"];

function buildDeath(id, cause) {
  const role = state.roles[id];
  const name = playerName(id);
  const narrative = deathNarratives.buildDeathNarrative({
    role, cause, name, roleLabel: ROLE_LABEL[role] || role
  });
  return { id, name, role, cause, narrative };
}

// ===== MISSION — RESET / TIMEOUTS =====
function clearMissionTimeouts() {
  if (state.mission.teamTimeout)  { clearTimeout(state.mission.teamTimeout);  state.mission.teamTimeout  = null; }
  if (state.mission.cardTimeout)  { clearTimeout(state.mission.cardTimeout);  state.mission.cardTimeout  = null; }
  if (state.mission.bonusTimeout) { clearTimeout(state.mission.bonusTimeout); state.mission.bonusTimeout = null; }
}

function resetMissionState() {
  clearMissionTimeouts();
  state.mission = {
    active: false, team: [], cards: {}, result: null,
    resultRevealed: false, bonusDone: false,
    teamTimeout: null, cardTimeout: null, bonusTimeout: null
  };
}

// ===== MISSION — RÉSOLUTION DES CARTES =====
function resolveMissionCards() {
  clearMissionTimeouts();
  const hasFail = Object.values(state.mission.cards).some(c => c === "fail");
  state.mission.result = hasFail ? "fail" : "success";

  // Informe le MJ discrètement du résultat brut
  versMJ("missionResultMJ", {
    result: state.mission.result,
    cards: state.mission.team.map(id => ({
      id, name: playerName(id), card: state.mission.cards[id]
    }))
  });

  // Enregistre le résultat mais ne le révèle PAS encore au broadcast.
  // → la révélation se fera dans doResolveNight() via missionReveal.
  ouvrirNuit(true);
}

// ===== CHASSEUR ET MAIRE MOURANT : APPEL AUX TÉLÉPHONES =====
// Avec un MJ, l'appel attend son clic (phases.ouvrirActionMJ, qui l'envoie) ; en mode autonome,
// il part tout de suite.
function annoncerTir(id) { if (state.autoMode) state.io.emit("chasseurMustShoot", id); }
function annoncerTransfert(id) { if (state.autoMode) state.io.emit("mayorMustTransfer", id); }

// ===== ENTRÉE DE LA NUIT (rythme du MJ) =====
// Après le jour (vote, vote passé, Idiot, tir du Chasseur, transmission d'écharpe) et après
// l'élection du maire (ou la mission) : avec un MJ, phase « crepuscule » jusqu'à son
// « 🌙 Lancer la nuit » — les téléphones gardent la carte du mort ou du maire jusque-là
// (demande d'Alexandre, 2026-10-26). En mode autonome, la nuit démarre aussitôt.
function ouvrirNuit(premiere) {
  if (state.pendingEndGameTimer) return;
  if (!nuitRythmeeParMJ()) { if (premiere) startFirstNight(); else startNightSequence(); return; }
  state.nuitEnAttente = premiere ? "premiere" : "suivante";
  phases.setPhase("crepuscule");
  versMJ("nuitEnAttente");
}
function lancerNuitAttendue() {
  if (state.phase !== "crepuscule") return;
  const premiere = state.nuitEnAttente === "premiere";
  state.nuitEnAttente = null;
  if (premiere) startFirstNight(); else startNightSequence();
}
function handleMJLancerNuit(socket) {
  if (!isMJ(socket.id)) return;
  lancerNuitAttendue();
}

// ===== NUIT =====
// Première nuit : Cupidon ne se réveille que s'il y en a un. Sans Cupidon, la nuit
// enchaîne directement.
function startFirstNight() {
  const cupidonVivant = vivantsAvecRole("Cupidon").length > 0;
  if (cupidonVivant) allerEtapeNuit("cupid");
  else startNightSequence();
}

// ===== NUIT RYTHMÉE PAR LE MJ =====
// Toute transition d'une étape de nuit à la suivante passe par allerEtapeNuit().
// Hors mode autonome, on s'arrête d'abord en phase « nightPause » : aucun rôle actif,
// tous les téléphones affichent le voile « garde les yeux fermés », la voix demande au
// rôle précédent de fermer les yeux, et le MJ voit un grand bouton « Passer à l'étape
// suivante ». Le rôle suivant ne se réveille (et son écran ne s'allume) qu'à ce clic :
// un joueur qui tarde à fermer les yeux ne voit pas qui se réveille après lui.
const LIBELLES_ETAPES_NUIT = {
  cupid: "💘 Cupidon", amoureux: "💘 Les Amoureux", sisters: "👯‍♀️ Les Sœurs jumelles", salvateur: "🛡 Le Salvateur",
  wolves: "🐺 Les Loups-Garous", seer: "🔮 La Voyante", petiteFille: "👧 La Petite Fille",
  corbeau: "🪶 Le Corbeau", witch: "🧪 La Sorcière", aube: "☀️ Le lever du jour"
};
function nuitRythmeeParMJ() { return !state.autoMode; }

function allerEtapeNuit(etape, options) {
  // Partie gagnée à l'aube, écran de fin dans quelques secondes : la nuit est finie.
  // (Sinon un clic tardif — « Valider l'attaque », « J'ai terminé »… — relançait une aube.)
  if (state.pendingEndGameTimer) return;
  const sansPause = !!(options && options.sansPause);
  if (sansPause || !nuitRythmeeParMJ() || !LIBELLES_ETAPES_NUIT[etape]) { lancerEtapeNuit(etape); return; }
  state.etapeNuitSuivante = etape;
  phases.setPhase("nightPause");
  versMJ("etapeNuitEnAttente", { etape, libelle: LIBELLES_ETAPES_NUIT[etape] });
}

// Démarre réellement l'étape : messages propres au rôle puis changement de phase.
function lancerEtapeNuit(etape) {
  if (state.pendingEndGameTimer) return;  // partie déjà gagnée (voir allerEtapeNuit)
  state.etapeNuitSuivante = null;
  if (etape === "aube") { resoudreNuit(); return; }
  if (etape === "amoureux") {
    // Chaque amoureux voit le prénom (et la photo, côté téléphone) de l'autre ; 15 s pour se regarder
    state.amoureuxFin = Date.now() + AMOUREUX_TIMEOUT_MS;
    const [a, b] = state.lovers;
    [[a, b], [b, a]].forEach(([moi, autre]) => state.io.to(moi).emit("amoureuxTurn", { partenaireId: autre, partenaire: playerName(autre), dureeMs: AMOUREUX_TIMEOUT_MS }));
  }
  if (etape === "sisters") {
    const aliveSisters = vivantsAvecRole("Sœurs");
    // Option B : on n'envoie PAS les noms aux sœurs — elles se reconnaissent IRL.
    aliveSisters.forEach(sid => state.io.to(sid).emit("sistersTurn", { count: aliveSisters.length }));
    // Le MJ reçoit l'info détaillée pour pouvoir rappeler qui doit se réveiller.
    versMJ("sistersInfoMJ", { sisters: aliveSisters.map(id => ({ id, name: playerName(id) })) });
  }
  if (etape === "salvateur") {
    const salvateurId = vivantsAvecRole("Salvateur")[0];
    if (salvateurId) state.io.to(salvateurId).emit("salvateurTurn", infosSalvateur());
  }
  if (etape === "corbeau") {
    const corbeauId = vivantsAvecRole("Corbeau")[0];
    if (corbeauId) state.io.to(corbeauId).emit("corbeauTurn");
  }
  if (etape === "witch") {
    const witchId = vivantsAvecRole("Sorcière")[0];
    if (witchId) {
      state.io.to(witchId).emit("etatPotions", { vie: !state.witchSaveUsed, mort: !state.witchKillUsed });
      state.io.to(witchId).emit("nightVictim", state.nightTarget);
    }
  }
  phases.setPhase(etape);
}

// Le MJ a vérifié que tout le monde a les yeux fermés : l'étape suivante démarre.
function handleMJEtapeSuivante(socket) {
  if (!isMJ(socket.id) || state.phase !== "nightPause" || !state.etapeNuitSuivante) return;
  log.info('handleMJEtapeSuivante', 'étape=' + state.etapeNuitSuivante);
  lancerEtapeNuit(state.etapeNuitSuivante);
}

// ===== ORDRE DE LA NUIT =====
// Le seul endroit qui le définit : chaque étape, et ce qu'il faut pour qu'elle ait lieu.
// Cupidon et les amoureux, propres à la 1re nuit, passent avant (startFirstNight).
const ETAPES_NUIT = [
  ["sisters",     () => vivantsAvecRole("Sœurs").length >= 2],
  ["salvateur",   () => vivantsAvecRole("Salvateur").length > 0],
  ["wolves",      () => true],
  ["seer",        () => vivantsAvecRole("Voyante").length > 0],
  ["petiteFille", () => petiteFillePeutJouer()],
  ["corbeau",     () => vivantsAvecRole("Corbeau").length > 0],
  // La Sorcière ne se réveille que vivante et avec au moins une potion
  ["witch",       () => vivantsAvecRole("Sorcière").length > 0 && !(state.witchSaveUsed && state.witchKillUsed)],
];
// Étape qui suit `courante` ("aube" quand la nuit est finie) ; sans `courante`, la première
function etapeApres(courante) {
  const suivante = ETAPES_NUIT.slice(ETAPES_NUIT.findIndex(([e]) => e === courante) + 1).find(([, aLieu]) => aLieu());
  return suivante ? suivante[0] : "aube";
}

// Entrée d'une nuit : après Cupidon (nuit 1) et après chaque vote du jour
function startNightSequence() { allerEtapeNuit(etapeApres()); }

// Suite de la nuit une fois le tour des Sœurs terminé (ou sauté)
function startNightAfterSisters(options) { allerEtapeNuit(etapeApres("sisters"), options); }

// La Petite Fille joue si elle est vivante ET qu'il reste au moins 3 autres joueurs
// vivants à désigner (en dessous, sa règle « 3 personnes » n'est plus applicable).
function petiteFillePeutJouer() {
  const pfId = vivantsAvecRole("PetiteFille")[0];
  return !!pfId && alivePlayers().filter(p => p.id !== pfId).length >= 3;
}

// Fin de nuit : passe par la pause « nightPause » (clic du MJ) avant le lever du jour.
function doResolveNight(options) { allerEtapeNuit("aube", options); }

function resoudreNuit() {
  // Guard : si deux handlers (ex. witchDone + resolveNight MJ) arrivent dans le même
  // tick, le second est ignoré. inNightResolution est remis à false à la fin.
  if (state.inNightResolution) return;
  // Toute victoire survenue pendant la résolution attend (endGame) que l'aube soit annoncée
  state.inNightResolution = true;
  state.gameStats.nightCount++;
  const protectedBySalvateur = !!(state.nightTarget && state.protectedTarget && state.nightTarget === state.protectedTarget);
  const protectedByWitch     = !!(state.nightTarget && state.witchSaveActive);
  const savedThisNight       = !!(state.nightTarget && (protectedBySalvateur || protectedByWitch));
  const witchKillThisNight   = !!state.witchKillTarget;
  if (witchKillThisNight) state.gameStats.witchKilled = true;
  if (protectedByWitch)   state.gameStats.witchSaved  = true;

  const deaths = [];
  if (state.nightTarget && !protectedByWitch && !protectedBySalvateur) {
    deaths.push(buildDeath(state.nightTarget, "loups"));
  }
  if (state.witchKillTarget) {
    deaths.push(buildDeath(state.witchKillTarget, "sorcière"));
  }

  // Cycle Salvateur : la protection courante devient "celle de la nuit précédente"
  state.lastProtectedTarget = state.protectedTarget;
  state.protectedTarget     = null;

  const deadBeforeNight = new Set(state.deadPlayers);

  // Si killPlayer déclenche un changement de phase (chasseur/mayorTransfer),
  // on doit interrompre la boucle pour ne pas exécuter la 2e mort hors contexte.
  for (const d of deaths) {
    if (!state.gameStats.firstDead) state.gameStats.firstDead = { name: d.name, role: d.role };
    state.gameStats.deathLog.push(d);
    killPlayer(d.id);
    if (state.phase === "chasseur" || state.phase === "mayorTransfer") break;
  }

  // deathLog et firstDead pour les morts d'amour sont déjà écrits par killPlayer
  // (via la mécanique amoureux). On ne fait qu'alimenter le tableau `deaths` pour
  // qu'il soit complet dans l'émission dawnResult.
  // Les cas Chasseur / maire ci-dessous ajoutent encore des morts (cascade d'amour) : on les reprend
  // juste avant d'annoncer l'aube, pour que la carte dise qui est mort d'amour
  const ajouterMortsDAmour = () => state.deadPlayers.filter(id => !deadBeforeNight.has(id) && !deaths.find(d => d.id === id))
    .forEach(id => deaths.push(buildDeath(id, "amour")));
  ajouterMortsDAmour();

  // Boucle interrompue par `mayorTransfer` : les morts restantes (ex. cible de la Sorcière)
  // sont traitées ici, pour ne pas apparaître comme successeurs possibles dans le panneau
  // de transmission (il s'ouvre plusieurs secondes après la carte de l'aube)
  if (state.phase === "mayorTransfer") {
    for (const d of deaths) {
      if (state.deadPlayers.includes(d.id)) continue; // déjà mort (cascade amour ou 1ère itération)
      if (!state.gameStats.firstDead) state.gameStats.firstDead = { name: d.name, role: d.role };
      state.gameStats.deathLog.push(d);
      if (state.roles[d.id] === "Chasseur" && !state.pendingChasseurAfterTransfer) {
        // Le chasseur doit tirer APRÈS le transfert → on le diffère plutôt que de
        // changer de phase immédiatement (mayorTransfer a priorité).
        state.pendingChasseurAfterTransfer = d.id;
        state.chasseurPostContext = "night";
        state.currentChasseurShooter = d.id;
        // Mort tout de suite, pour l'exclure des candidats au titre de maire
        marquerMort(d.id);
      } else {
        // Mort ordinaire : killPlayer l'ajoute à deadPlayers et gère les cascades.
        killPlayer(d.id);
      }
    }
  }

  // Même chose si la boucle a été interrompue par `chasseur` : sans cela, les morts
  // restantes resteraient « vivantes » sur les téléphones
  if (state.phase === "chasseur") {
    // Le maire meurt pendant que le Chasseur attend de tirer : l'écharpe sera transmise après le tir
    const maireMeurt = id => {
      if (id !== state.mayor || state.mayorTransferPending) return;
      state.dyingMayorId = id; state.mayorTransferPending = true;
      state.dyingMayorWasChasseur = false; state.mayorTransferContext = "chasseur";
      state.mayor = null;
      state.io.emit("newMayor", null); annoncerTransfert(id);
    };
    for (const d of deaths) {
      if (state.deadPlayers.includes(d.id)) continue;
      if (!state.gameStats.firstDead) state.gameStats.firstDead = { name: d.name, role: d.role };
      state.gameStats.deathLog.push(d);
      marquerMort(d.id);
      maireMeurt(d.id);
      const partenaire = state.lovers.includes(d.id) && state.lovers.find(l => l !== d.id);
      if (partenaire && !state.deadPlayers.includes(partenaire)) {
        marquerMort(partenaire, true);
        state.gameStats.deathLog.push(buildDeath(partenaire, "amour"));
        maireMeurt(partenaire);
      }
    }
  }

  state.nightTarget = null;
  state.witchKillTarget = null;
  state.witchSaveActive = false;

  const enChasseur = state.phase === "chasseur";
  const missionResultToReveal = (state.mission.active && !state.mission.resultRevealed) ? state.mission.result : null;
  if (missionResultToReveal !== null) state.mission.resultRevealed = true;
  const bonusMission = state.mission.active && state.mission.result === "success" && !state.mission.bonusDone
    && state.mayor && !state.deadPlayers.includes(state.mayor);
  // Avec un MJ, la carte des morts reste jusqu'à son clic : « 🔫 Le Chasseur tire », la
  // transmission d'écharpe qu'il lance, ou le réveil qu'il mène
  const annonceParMJ = enChasseur ? !!state.actionMJ
    : (state.actionMJ === "mayorTransfer" || require('./council').annonceMatinParMJ()) && !state.pendingEndGame && !bonusMission;
  ajouterMortsDAmour();
  state.io.emit("dawnResult", {
    deaths, saved: savedThisNight, witchKilled: witchKillThisNight,
    nightNum: state.gameStats.nightCount,
    missionResult: missionResultToReveal,
    annonceParMJ
  });
  lumieresAube(deaths.length, missionResultToReveal);

  // Récap de la nuit pour le MJ, envoyé au début du jour (setPhase("day")) ou plus tôt ci-dessous
  state.pendingDayRecap = {
    nightNum: state.gameStats.nightCount,
    nightDeaths: deaths.map(d => ({ name: d.name, role: d.role, cause: d.cause })),
    saved: savedThisNight,
    savedByWitch:     protectedByWitch,
    savedBySalvateur: protectedBySalvateur,
    missionResult: missionResultToReveal
  };
  // Fin de la résolution avant tout changement de phase, pour ne pas retarder les transitions
  state.inNightResolution = false;

  if (enChasseur) {
    // Le Chasseur tire avant que le jour ne commence : récap tout de suite. Une victoire
    // constatée cette nuit sera réévaluée après son tir (performChasseurShot) ; sans cet
    // oubli volontaire, cette fin de partie périmée ressurgissait à l'aube suivante.
    envoyerRecapMJ();
    state.pendingEndGame = null;
    return;
  }

  // Victoire pendant la résolution : endGame a mis sa fonction d'émission dans
  // state.pendingEndGame. Récap MJ d'abord, puis la fin de partie ~7 s plus tard, le
  // temps de voir la carte des morts.
  if (state.pendingEndGame) {
    envoyerRecapMJ();
    const fire = state.pendingEndGame;
    state.pendingEndGame = null;
    // Minuteur mémorisé : un reset pendant ces 7 s l'annule (sinon la fin de partie
    // tombait au milieu de la partie suivante).
    state.pendingEndGameTimer = setTimeout(() => { state.pendingEndGameTimer = null; try { fire(); } catch (_) {} }, 7000);
    return;
  }

  // La transmission d'écharpe passe avant le jour : le MJ voit déjà le récap de la nuit
  if (state.phase === "mayorTransfer") envoyerRecapMJ();
  else phases.setPhase(bonusMission ? "missionBonus" : "day");
}

// Récap de la nuit envoyé au MJ sans attendre le début du jour
function envoyerRecapMJ() {
  if (!state.mjSocketId || !state.pendingDayRecap) return;
  versMJ("mjDayRecap", { dayNum: state.gameStats.dayCount + 1, ...state.pendingDayRecap });
  state.pendingDayRecap = null;
}

// Lumières de l'aube : un éclair par mort puis la couleur de la mission ; l'aube si personne n'est mort
function lumieresAube(nbMorts, mission) {
  try {
    const couleurMission = mission === "success" ? "flash.victory" : "flash.death";
    if (nbMorts > 0) {
      lights.flashSequence("flash.death", nbMorts);
      if (mission !== null) setTimeout(() => { try { lights.flash(couleurMission); } catch (_) {} }, nbMorts * 750 + 300);
    } else lights.flash(mission !== null ? couleurMission : "flash.dawn");
  } catch (_) {}
}

// ===== MORT =====
// Un joueur meurt : il est inscrit parmi les morts et tous les écrans l'apprennent (une mort
// d'amour est annoncée comme telle). Ce que la mort déclenche ensuite reste à l'appelant.
function marquerMort(id, amour = false) {
  state.deadPlayers.push(id);
  const cle = playerName(id).toLowerCase();
  if (state.playerRegistry[cle]) state.playerRegistry[cle].isDead = true;
  state.io.emit("deadPlayers", state.deadPlayers);
  if (amour) state.io.emit("loversDeathInfo", { id, name: playerName(id), role: state.roles[id] });
  state.io.emit("playerDied", { id, role: state.roles[id], name: playerName(id) });
}

function killPlayer(id) {
  if (!id || state.deadPlayers.includes(id)) return;
  log.info('killPlayer', playerName(id), `(role=${state.roles[id]})`, 'phase=' + state.phase);
  marquerMort(id);

  const isMayorDying    = (id === state.mayor);
  const isChasseurDying = (state.roles[id] === "Chasseur");
  if (!isMayorDying && !isChasseurDying) sendDeadVision(id);

  if (state.lovers.includes(id)) {
    const partner = state.lovers.find(l => l !== id);
    if (partner && !state.deadPlayers.includes(partner)) {
      marquerMort(partner, true);
      state.gameStats.deathLog.push(buildDeath(partner, "amour"));
      if (!state.gameStats.firstDead) state.gameStats.firstDead = { name: playerName(partner), role: state.roles[partner] };
      sendDeadVision(partner);
      if (state.roles[partner] === "Chasseur") {
        if (partner === state.mayor) {
          state.dyingMayorId = partner; state.mayorTransferPending = true; state.mayor = null;
          state.dyingMayorWasChasseur = true;
          state.mayorTransferContext = state.phase === "chasseur" ? "chasseur" : PHASES_DE_NUIT.includes(state.phase) ? "night" : "day";
          state.io.emit("newMayor", null); annoncerTransfert(partner);
          phases.setPhase("mayorTransfer"); return;
        } else if (isMayorDying) {
          // Le mort est le maire et son amoureux le Chasseur : l'écharpe d'abord, le tir ensuite
          // (passer directement en phase chasseur faisait refuser la transmission)
          state.dyingMayorId = id; state.mayorTransferPending = true; state.mayor = null;
          state.dyingMayorWasChasseur = false;
          // Mémorise le chasseur en attente — il tirera dans performMayorTransfer après le transfert.
          state.pendingChasseurAfterTransfer = partner;
          state.chasseurPostContext = (state.phase === "day") ? "day" : "night";
          state.mayorTransferContext = state.phase === "chasseur" ? "chasseur" : PHASES_DE_NUIT.includes(state.phase) ? "night" : "day";
          state.io.emit("newMayor", null); annoncerTransfert(id);
          phases.setPhase("mayorTransfer");
          return; // ← CRUCIAL : ne pas tomber dans le bloc chasseur ci-dessous
        }
        // Cas simple : l'amoureux (partner) est chasseur, ni maire ni objet d'un transfert.
        // Le chasseur tire immédiatement.
        state.currentChasseurShooter = partner;
        state.chasseurPostContext = (state.phase === "day") ? "day" : "night";
        annoncerTir(partner);
        phases.setPhase("chasseur");
        return;
      }
      if (partner === state.mayor && !state.mayorTransferPending) {
        if (state.phase === "lobby") { phases.checkVictory(); return; }
        if (phases.checkVictory()) return;
        state.dyingMayorId = partner; state.mayorTransferPending = true; state.mayor = null;
        // Phase "chasseur" : le contexte dépend de chasseurPostContext, pas de la phase courante
        state.mayorTransferContext = state.phase === "chasseur"
          ? (state.chasseurPostContext === "day" ? "chasseurFromDay" : "chasseur")
          : PHASES_DE_NUIT.includes(state.phase) ? "night" : "day";
        state.io.emit("newMayor", null); annoncerTransfert(partner);
        phases.setPhase("mayorTransfer"); return;
      }
    }
  }

  if (isMayorDying && !state.mayorTransferPending) {
    if (state.phase === "lobby") { phases.checkVictory(); return; }
    if (!isChasseurDying) {
      if (phases.checkVictory()) return;
    }
    state.dyingMayorId = id; state.mayorTransferPending = true; state.mayor = null;
    state.dyingMayorWasChasseur = isChasseurDying;
    state.mayorTransferContext = state.phase === "chasseur"
      ? (state.chasseurPostContext === "day" ? "chasseurFromDay" : "chasseur")
      : PHASES_DE_NUIT.includes(state.phase) ? "night" : "day";
    state.io.emit("newMayor", null); annoncerTransfert(id);
    phases.setPhase("mayorTransfer"); return;
  } else if (isMayorDying && state.mayorTransferPending) {
    return;
  }

  if (isChasseurDying) {
    state.currentChasseurShooter = id;
    state.chasseurPostContext = (state.phase === "day") ? "day" : "night";
    annoncerTir(id);
    phases.setPhase("chasseur");
    return;
  }
  phases.checkVictory();
}

function sendDeadVision(socketId) {
  // Jour piloté par le MJ : pas de vision spectateur pendant la partie, le mort voit
  // « Vous êtes mort » (deadFullScreen) ; tout est révélé en fin de partie (endGame)
  if (state.mjPilotedDay) return;
  state.io.to(socketId).emit("deadVision", {
    roles:     state.roles,
    wolves:    joueursAvecRole("Loup"),
    lovers:    state.lovers,
    mayor:     state.mayor,
    votesDay:  state.votesDay,
    votesWolf: state.votesWolf,
    mayorVote: state.mayorVote,
  });
}

// ===== CHASSEUR — TIR =====
function performChasseurShot(shooterId, targetId) {
  if (state.phase !== "chasseur" || state.actionMJ) return;
  if (!(state.roles[shooterId] === "Chasseur" && state.deadPlayers.includes(shooterId))) return;
  if (state.deadPlayers.includes(targetId)) return;

  if (state.chasseurTimeout) { clearTimeout(state.chasseurTimeout); state.chasseurTimeout = null; }
  state.currentChasseurShooter = null;

  sendDeadVision(shooterId);
  const postCtx = state.chasseurPostContext;
  // NE PAS remettre chasseurPostContext à null ici : si le tir tue le Maire,
  // killPlayer déclenchera mayorTransfer et doit connaître le contexte (jour/nuit)
  // du Chasseur pour savoir où aller après le transfert du maire.
  // Le MJ apprend qui le Chasseur a emporté (cette mort n'est pas dans le récap)
  versMJ("mjChasseurShot", {
    shooterName: playerName(shooterId),
    targetName:  playerName(targetId),
    targetRole:  state.roles[targetId] || "?"
  });
  // Tout le monde voit qui le Chasseur a emporté (le MJ raconte la suite)
  state.io.emit("chasseurATire", { id: targetId, name: playerName(targetId), nuit: postCtx !== "day" });
  killPlayer(targetId);
  try { lights.flash("flash.death"); } catch (_) {}
  if (state.phase === "chasseur") {
    if (phases.checkVictory()) return;
    if (state.mayorTransferPending && state.dyingMayorId) {
      phases.setPhase("mayorTransfer");
      return;
    }
    if (postCtx === "day") { ouvrirNuit(false); } else { phases.setPhase("day"); }
  }
}

// ===== TRANSFERT MAIRE =====
function performMayorTransfer(targetId) {
  if (state.phase !== "mayorTransfer" || state.actionMJ) return;
  if (state.deadPlayers.includes(targetId)) return;
  if (targetId === state.dyingMayorId) return;

  if (state.mayorTransferTimeout) { clearTimeout(state.mayorTransferTimeout); state.mayorTransferTimeout = null; }

  const oldDyingId = state.dyingMayorId;
  const ctx = state.mayorTransferContext;
  const wasChasseur = state.dyingMayorWasChasseur;
  state.mayor = targetId;
  oublierTransfert();
  state.io.emit("newMayor", state.mayor);
  state.io.emit("mayorTransferred", targetId);
  try { lights.flash("flash.bell"); } catch (_) {}
  if (!wasChasseur) sendDeadVision(oldDyingId);

  if (wasChasseur) {
    state.chasseurPostContext = ctx;
    state.currentChasseurShooter = oldDyingId;
    annoncerTir(oldDyingId);
    phases.setPhase("chasseur");
    return;
  }

  // Maire et Chasseur, deux amoureux distincts : l'écharpe est transmise, le Chasseur tire
  if (state.pendingChasseurAfterTransfer) {
    const chasseurId = state.pendingChasseurAfterTransfer;
    state.pendingChasseurAfterTransfer = null;
    state.currentChasseurShooter = chasseurId;
    // chasseurPostContext a été posé dans killPlayer au moment de la mort
    annoncerTir(chasseurId);
    if (!phases.checkVictory()) phases.setPhase("chasseur");
    return;
  }

  if (ctx === "chasseur") {
    // Chasseur venait d'une mort de NUIT → après le transfert, retour au jour
    if (!phases.checkVictory()) phases.setPhase("day");
  } else if (ctx === "chasseurFromDay") {
    // Chasseur venait d'un VOTE DU JOUR → après le transfert, on enchaîne la nuit
    if (!phases.checkVictory()) ouvrirNuit(false);
  } else if (ctx === "night") {
    if (!phases.checkVictory()) {
      if (state.mission.active && state.mission.result === "success" && !state.mission.bonusDone
          && state.mayor && !state.deadPlayers.includes(state.mayor)) {
        phases.setPhase("missionBonus");
      } else {
        phases.setPhase("day");
      }
    }
  } else if (ctx === "day") {
    // Maire mort pendant le vote du jour → enchaîner la nuit
    if (!phases.checkVictory()) ouvrirNuit(false);
  } else {
    // Contexte inattendu/vide : retour au jour par sécurité
    log.warn('performMayorTransfer', 'ctx inconnu=' + ctx + ' → fallback setPhase(day)');
    if (!phases.checkVictory()) phases.setPhase("day");
  }
}

// ===== ATTRIBUTION DES RÔLES =====
function assignAndStart(config, playerList) {
  log.info('assignAndStart', 'players=' + playerList.length, 'config=', config);
  const numPlayers = playerList.length;
  const numLoups = +(config.loup) || 0;
  // Les Sœurs jumelles vont par 2 (0 ou 2). Toute autre valeur est ramenée à 0.
  const numSisters = (+(config.sisters) === 2) ? 2 : 0;
  const numSpecial =
    (+(config.cupidon)     || 0) +
    (+(config.voyante)     || 0) +
    (+(config.sorciere)    || 0) +
    (+(config.chasseur)    || 0) +
    numLoups +
    (+(config.petiteFille) || 0) +
    (+(config.idiot)       || 0) +
    (+(config.ange)        || 0) +
    (+(config.corbeau)     || 0) +
    (+(config.salvateur)   || 0) +
    numSisters;

  if (numPlayers < 4) {
    versMJ("autoResolve",
      `⚠️ Au moins 4 joueurs requis (${numPlayers} connectés).`);
    return;
  }
  if (numLoups < 1) {
    versMJ("autoResolve",
      "⚠️ Il faut au moins 1 loup.");
    return;
  }
  if (numLoups * 2 >= numPlayers) {
    versMJ("autoResolve",
      `⚠️ Trop de loups : ${numLoups} loups vs ${numPlayers} joueurs — ils gagnent dès la 1ère nuit.`);
    return;
  }
  if (numSpecial > numPlayers) {
    versMJ("autoResolve",
      `⚠️ Total des rôles spéciaux (${numSpecial}) > nombre de joueurs (${numPlayers}).`);
    return;
  }

  // Mode autonome : configuré au start
  state.autoMode = !!config.autoMode;
  state.autoVoteMode = [1, 2, 4, 5].includes(+config.autoVoteMode) ? +config.autoVoteMode : 1;

  // `mjPilotedDay` (case de la préparation du MJ) : appliqué s'il est fourni, sinon on
  // garde la valeur en place (true au démarrage)
  if (typeof config.mjPilotedDay === "boolean") {
    state.mjPilotedDay = config.mjPilotedDay;
  }
  // Conseil des Morts : activé sauf si le MJ a décoché la case (anciens clients : activé)
  state.conseilActif = config.conseil !== false;

  let shuffled = fisherYates(playerList); let i = 0;
  function add(r, count) {
    for (let j = 0; j < (count || 0); j++) {
      if (!shuffled[i]) return;
      state.roles[shuffled[i].id] = r;
      i++;
    }
  }
  add("Cupidon", config.cupidon);
  add("Voyante", config.voyante);
  add("Sorcière", config.sorciere);
  add("Chasseur", config.chasseur);
  add("Loup", config.loup);
  add("PetiteFille", config.petiteFille);
  add("Idiot", config.idiot);
  add("Ange", config.ange);
  add("Corbeau", config.corbeau);
  add("Salvateur", config.salvateur);
  add("Sœurs", numSisters);
  while (i < shuffled.length) { state.roles[shuffled[i].id] = "Villageois"; i++; }

  playerList.forEach(p => {
    const k = p.name.toLowerCase();
    if (state.playerRegistry[k]) state.playerRegistry[k].role = state.roles[p.id];
  });

  const wolves = Object.entries(state.roles).filter(r => r[1] === "Loup").map(r => r[0]);

  playerList.forEach(p => {
    const isWolf = state.roles[p.id] === "Loup";
    state.io.to(p.id).emit("yourRole", {
      role: state.roles[p.id],
      wolves: isWolf ? wolves : [],
      // Le téléphone en a besoin pour choisir l'écran de mort épuré plutôt que la vision complète
      mjPilotedDay: !!state.mjPilotedDay,
      nuitParMJ: !state.autoMode
    });
  });

  versMJ("rolesMJ", { roles: state.roles, players: state.players });

  if (config.mission) {
    state.mission.active = true;
    phases.setPhase("mayorVote");
  } else {
    state.mission.active = false;
    phases.setPhase("mayorVote");
  }
}

// ===== HANDLERS SOCKETS =====
function handleCupidChoice(socket, data) {
  if (state.phase !== "cupid" || !hasRole(socket.id, "Cupidon") || state.cupidDone) return;
  // Exactement deux joueurs vivants distincts
  if (!Array.isArray(data) || data.length !== 2) return;
  if (new Set(data).size !== 2) return;  // pas deux fois le même ID
  const aliveIds = alivePlayers().map(p => p.id);
  if (!data.every(id => aliveIds.includes(id))) return;  // IDs valides et vivants
  clearTimeout(state.cupidTimeout); state.cupidTimeout = null;
  state.lovers = data;
  state.cupidDone = true;
  [...new Set([socket.id, ...state.lovers])].forEach(id => state.io.to(id).emit("loversInfo", state.lovers));
  versMJ("loversInfo", state.lovers);
  if (state.mjSocketId) {
    versMJ("soundPlay", "cupid");
    state.skipWolvesSoundOnce = true;
    // Le son loups est différé de 4s pour laisser cupid.mp3 se terminer. MAIS si
    // entre-temps on est passé par sisters/salvateur (qui durent ≥20s), la phase
    // n'est plus "wolves" à 4s — il ne FAUT PAS jouer le son ici, sinon il sonne
    // au milieu du tour des Sœurs. Dans ce cas le son loups sera joué naturellement
    // par setPhase("wolves") quand on y arrivera (skipWolvesSoundOnce sera repassé
    // à false dans ce setTimeout, et setPhase ne le skippera plus).
    setTimeout(() => {
      if (state.mjSocketId && state.phase === "wolves") {
        versMJ("soundPlay", "wolves");
      }
      state.skipWolvesSoundOnce = false;
    }, CUPID_SOUND_MS);
  }
  reveillerAmoureux();
}

// Après le choix de Cupidon : « Cupidon, ferme les yeux » (pause du MJ), puis les deux amoureux
// se réveillent et se regardent (demande d'Alexandre, 2026-10-26). Sans amoureux, la nuit continue.
function reveillerAmoureux() {
  if (state.lovers.length === 2) allerEtapeNuit("amoureux");
  else startNightSequence();
}

// Fin des 15 s des amoureux : la nuit continue (Sœurs, Salvateur ou Loups, après la pause du MJ)
function finAmoureux() {
  if (state.phase !== "amoureux") return;
  clearTimeout(state.amoureuxTimeout); state.amoureuxTimeout = null;
  state.amoureuxFin = null;
  startNightSequence();
}

// Compte à rebours des Sœurs : démarre automatiquement dès leur réveil (entrée en
// phase « sisters », c'est-à-dire au clic MJ « Passer à l'étape suivante » —
// appelé par phases.installPhaseTimeouts). Émet `sistersTimerStart` pour que les
// Sœurs voient le décompte. Idempotent : un timer en cours est remplacé.
function demarrerTimerSoeurs() {
  if (state.phase !== "sisters") return;
  if (state.sistersTimeout) { clearTimeout(state.sistersTimeout); state.sistersTimeout = null; }
  state.sistersTimerEnd = Date.now() + SISTERS_TIMEOUT_MS;
  // Fin des 20 s : comme pour tous les rôles, la nuit passe par la pause commune
  // (voile pour tous, « Sœurs jumelles, fermez les yeux », bouton MJ « Passer à
  // l'étape suivante ») avant de réveiller le rôle suivant.
  state.sistersTimeout = setTimeout(() => {
    state.sistersTimeout = null;
    state.sistersTimerEnd = null;
    if (state.phase === "sisters") startNightAfterSisters();
  }, SISTERS_TIMEOUT_MS);
  log.info('demarrerTimerSoeurs', 'durationMs=' + SISTERS_TIMEOUT_MS);
  // Notifie tous les clients (les Sœurs démarrent leur décompte, le MJ est prévenu)
  state.io.emit("sistersTimerStart", { durationMs: SISTERS_TIMEOUT_MS, startedAt: Date.now() });
}

function handleSalvateurAction(socket, targetId) {
  if (state.phase !== "salvateur" || !hasRole(socket.id, "Salvateur")) return;
  if (!targetId) return;
  if (state.deadPlayers.includes(targetId)) return;
  if (targetId === state.lastProtectedTarget) {
    state.io.to(socket.id).emit("salvateurReject", { reason: "Vous ne pouvez pas protéger la même personne deux nuits de suite." });
    return;
  }
  if (state.salvateurTimeout) { clearTimeout(state.salvateurTimeout); state.salvateurTimeout = null; }
  resetActivity();
  state.protectedTarget = targetId;
  state.io.to(socket.id).emit("salvateurConfirm", { targetId, targetName: playerName(targetId) });
  // Son shield.mp3 côté MJ pour souligner la confirmation
  versMJ("soundPlay", "shield");
  allerEtapeNuit("wolves");
}

// ===== VOYANTE =====
// La vision est envoyée à la Voyante, puis la nuit attend qu'elle confirme avoir vu
// (« OK, j'ai vu » → seerDone). Filet : SEER_ACK_TIMEOUT_MS si elle ne répond plus.
// Utilisé par la Voyante humaine et par la Voyante bot (phases.js).
function seerReveal(seerId, targetId) {
  if (state.phase !== "seer" || state.seerPendingResult) return;
  clearTimeout(state.seerTimeout); state.seerTimeout = null;
  const result = { role: state.roles[targetId], name: playerName(targetId) };
  state.seerPendingResult = result;
  state.io.to(seerId).emit("seerResult", result);
  state.gameStats.seerLog.push({ name: result.name, role: result.role });
  versMJ("soundPlay", "seer");
  state.seerTimeout = setTimeout(() => {
    if (state.phase !== "seer") return;
    versMJ("autoResolve", "⏱ La Voyante n'a pas confirmé sa vision — la nuit continue.");
    advanceAfterSeer();
  }, SEER_ACK_TIMEOUT_MS);
}

// Fin du tour de la Voyante : passe à l'étape suivante de la nuit.
function advanceAfterSeer() {
  if (state.phase !== "seer") return;
  clearTimeout(state.seerTimeout); state.seerTimeout = null;
  state.seerPendingResult = null;
  allerEtapeNuit(etapeApres("seer"));
}

function handleSeerChoice(socket, id) {
  if (state.phase !== "seer" || !hasRole(socket.id, "Voyante")) return;
  if (id === socket.id) return;  // la voyante ne peut pas se cibler
  resetActivity();
  seerReveal(socket.id, id);
}

function handleSeerDone(socket) {
  if (state.phase !== "seer" || !hasRole(socket.id, "Voyante") || !state.seerPendingResult) return;
  resetActivity();
  advanceAfterSeer();
}

// ===== PETITE FILLE =====
// Elle désigne 3 joueurs vivants (jamais elle-même) et apprend seulement s'il y a AU
// MOINS UN loup parmi eux, ou aucun — pas lequel, ni combien. Comme pour la Voyante,
// la nuit attend ensuite son « OK, j'ai vu » (petiteFilleDone), avec un filet de
// PETITE_FILLE_ACK_TIMEOUT_MS. Utilisé par la Petite Fille humaine et par le bot (phases.js).
// Renvoie un message d'erreur si la sélection est invalide, sinon null.
function petiteFilleReveal(pfId, ids) {
  if (state.phase !== "petiteFille" || state.petiteFillePendingResult) return null;
  const vivants = alivePlayers().map(p => p.id);
  if (!Array.isArray(ids) || ids.length !== 3 || new Set(ids).size !== 3
      || ids.some(id => id === pfId || !vivants.includes(id))) {
    return "Désignez 3 joueurs vivants, autres que vous.";
  }
  clearTimeout(state.petiteFilleTimeout); state.petiteFilleTimeout = null;
  const auMoinsUnLoup = ids.some(id => state.roles[id] === "Loup");
  const result = { names: ids.map(playerName), auMoinsUnLoup };
  state.petiteFillePendingResult = result;
  state.io.to(pfId).emit("petiteFilleResult", result);
  state.gameStats.petiteFilleLog.push({ names: result.names, auMoinsUnLoup });
  if (state.mjSocketId) {
    versMJ("petiteFilleMJInfo", {
      names: result.names, auMoinsUnLoup,
      loups: ids.filter(id => state.roles[id] === "Loup").map(playerName)
    });
    versMJ("soundPlay", "petite_fille");
  }
  state.petiteFilleTimeout = setTimeout(() => {
    if (state.phase !== "petiteFille") return;
    versMJ("autoResolve", "⏱ La Petite Fille n'a pas confirmé sa réponse — la nuit continue.");
    advanceAfterPetiteFille();
  }, PETITE_FILLE_ACK_TIMEOUT_MS);
  return null;
}

// Fin du tour de la Petite Fille : passe à l'étape suivante de la nuit.
function advanceAfterPetiteFille() {
  if (state.phase !== "petiteFille") return;
  clearTimeout(state.petiteFilleTimeout); state.petiteFilleTimeout = null;
  state.petiteFillePendingResult = null;
  allerEtapeNuit(etapeApres("petiteFille"));
}

function handlePetiteFilleChoice(socket, ids) {
  if (state.phase !== "petiteFille" || !hasRole(socket.id, "PetiteFille")) return;
  resetActivity();
  const erreur = petiteFilleReveal(socket.id, ids);
  if (erreur) socket.emit("petiteFilleError", erreur);
}

function handlePetiteFilleDone(socket) {
  if (state.phase !== "petiteFille" || !hasRole(socket.id, "PetiteFille") || !state.petiteFillePendingResult) return;
  resetActivity();
  advanceAfterPetiteFille();
}

function handleCorbeauAction(socket, targetId) {
  if (state.phase !== "corbeau" || !hasRole(socket.id, "Corbeau")) return;
  clearTimeout(state.corbeauTimeout); state.corbeauTimeout = null;
  resetActivity();
  state.corbeauTarget = (targetId === "skip" || !targetId) ? "skip" : targetId;
  socket.emit("corbeauConfirm", { targetId: state.corbeauTarget });
  versMJ("soundPlay", "crow");
  if (state.corbeauTarget !== "skip") {
    state.io.emit("corbeauVotesPublic", { targetId: state.corbeauTarget, targetName: playerName(state.corbeauTarget) });
  }
  if (state.corbeauTarget !== "skip") {
    const name = playerName(state.corbeauTarget);
    versMJ("corbeauMJInfo", { name, id: state.corbeauTarget });
  } else {
    versMJ("corbeauMJInfo", { name: null, id: null });
  }
  allerEtapeNuit(etapeApres("corbeau"));
}

function handleWitchSave(socket) {
  if (state.phase !== "witch" || !hasRole(socket.id, "Sorcière") || state.witchSaveUsed) return;
  if (!state.nightTarget) return;
  clearTimeout(state.witchTimeout); state.witchTimeout = null;
  state.witchSaveUsed = true;
  state.witchSaveActive = true;
  state.io.to(socket.id).emit("witchSaveConfirm");
  versMJ("soundPlay", "witch");
}

function handleWitchKill(socket, id) {
  if (state.phase !== "witch" || !hasRole(socket.id, "Sorcière") || state.witchKillUsed || state.deadPlayers.includes(id)) return;
  if (id === socket.id) return;
  if (id === state.nightTarget) {
    state.io.to(socket.id).emit("witchKillRefused", "Tu ne peux pas utiliser ta potion de mort sur la victime des loups.");
    return;
  }
  clearTimeout(state.witchTimeout); state.witchTimeout = null;
  state.witchKillUsed = true;
  state.witchKillTarget = id;
  state.io.to(socket.id).emit("witchKillConfirm");
  versMJ("soundPlay", "witch");
}

function handleWitchDone(socket) {
  if (state.phase !== "witch" || !hasRole(socket.id, "Sorcière")) return;
  clearTimeout(state.witchTimeout); state.witchTimeout = null;
  doResolveNight();
}

function handleResolveNight(socket) {
  if (!isMJ(socket.id) || state.phase !== "witch") return;
  clearTimeout(state.witchTimeout); state.witchTimeout = null;
  doResolveNight({ sansPause: true });
}

function handleChasseurAction(socket, targetId) {
  performChasseurShot(socket.id, targetId);
}

function handleMayorTransferChoice(socket, targetId) {
  if (socket.id !== state.dyingMayorId) return;
  performMayorTransfer(targetId);
}

// ===== MISSION =====
// 3 joueurs vivants distincts, autres que le maire (il ne s'envoie ni ne s'inspecte lui-même)
function equipeValide(ids) {
  const alive = alivePlayers().map(p => p.id);
  return ids.every(id => alive.includes(id) && id !== state.mayor) && new Set(ids).size === 3;
}

// Le maire (joueur ou robot) a choisi l'équipe : chacun de ses membres reçoit ses cartes
function envoyerEnMission(teamIds) {
  clearMissionTimeouts();
  state.mission.team = teamIds;
  const equipe = teamIds.map(id => ({ id, name: playerName(id) }));
  state.io.emit("missionTeamSelected", { team: equipe, mayorName: playerName(state.mayor) });
  teamIds.forEach(id => state.io.to(id).emit("missionCardChoice", {
    mayorName: playerName(state.mayor),
    teamNames: teamIds.map(tid => playerName(tid))
  }));
  versMJ("missionMJInfo", { step: "cardVote", team: equipe });
  phases.setPhase("missionVote");
}

// Carte jouée par un membre de l'équipe (joueur ou robot) ; la mission se résout à la dernière
function jouerCarteMission(id, card) {
  state.mission.cards[id] = card;
  state.io.to(id).emit("missionCardConfirm", { card });
  const recues = Object.keys(state.mission.cards).length, total = state.mission.team.length;
  versMJ("missionMJInfo", { step: "cardReceived", received: recues, total });
  state.io.emit("missionCardPlayed", { count: recues, total });
  if (recues === total) resolveMissionCards();
}

// Bonus d'une mission réussie : le maire apprend si un loup est parmi les 3 qu'il désigne
function inspecterBonus(teamIds) {
  clearMissionTimeouts();
  state.mission.bonusDone = true;
  const equipe = teamIds.map(id => ({ id, name: playerName(id) }));
  const loups = teamIds.filter(id => state.roles[id] === "Loup");
  state.io.to(state.mayor).emit("missionBonusResult", { team: equipe, hasWolf: loups.length > 0 });
  versMJ("missionMJBonusResult", {
    team: equipe, hasWolf: loups.length > 0, wolves: loups.map(id => playerName(id))
  });
  state.io.emit("missionBonusUsed", { mayorName: playerName(state.mayor), team: equipe });
  phases.setPhase("day");
}

function handleMissionTeamChoice(socket, teamIds) {
  if (state.phase !== "mission" || socket.id !== state.mayor) return;
  if (!Array.isArray(teamIds) || teamIds.length !== 3) return;
  if (!equipeValide(teamIds)) return socket.emit("missionError", "Sélection invalide — 3 joueurs vivants autres que vous.");
  envoyerEnMission(teamIds);
}

function handleMissionCard(socket, card) {
  if (state.phase !== "missionVote") return;
  if (!state.mission.team.includes(socket.id)) return;
  if (state.mission.cards[socket.id]) return;
  if (card !== "success" && card !== "fail") return;
  jouerCarteMission(socket.id, card);
}

function handleMissionBonusChoice(socket, bonusTeamIds) {
  if (state.phase !== "missionBonus" || socket.id !== state.mayor) return;
  if (!Array.isArray(bonusTeamIds) || bonusTeamIds.length !== 3) return;
  if (!equipeValide(bonusTeamIds)) return socket.emit("missionError", "Sélection bonus invalide — 3 joueurs vivants autres que vous.");
  inspecterBonus(bonusTeamIds);
}

// IMPORTANT : on MUTE l'objet module.exports (pas de réassignation) pour ne pas
// invalider les références capturées par phases.js et votes.js pendant la phase
// de chargement circulaire.
Object.assign(module.exports, {
  // Mission
  clearMissionTimeouts, resetMissionState, resolveMissionCards, envoyerEnMission, jouerCarteMission, inspecterBonus,
  // Nuit
  startNightSequence, startNightAfterSisters, doResolveNight, LIBELLES_ETAPES_NUIT,
  allerEtapeNuit, etapeApres, handleMJEtapeSuivante,
  // Morts / transferts
  killPlayer, sendDeadVision,
  performChasseurShot, performMayorTransfer,
  // Attribution
  assignAndStart,
  // Handlers
  handleCupidChoice, handleSalvateurAction, demarrerTimerSoeurs, handleSeerChoice, handleSeerDone, handleCorbeauAction,
  startFirstNight, reveillerAmoureux, finAmoureux,
  ouvrirNuit, lancerNuitAttendue, handleMJLancerNuit,
  seerReveal, advanceAfterSeer,
  petiteFilleReveal, advanceAfterPetiteFille, handlePetiteFilleChoice, handlePetiteFilleDone,
  handleWitchSave, handleWitchKill, handleWitchDone, handleResolveNight,
  handleChasseurAction, handleMayorTransferChoice,
  handleMissionTeamChoice, handleMissionCard, handleMissionBonusChoice,
});
