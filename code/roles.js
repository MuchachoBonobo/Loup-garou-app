// roles.js — Logique de tous les rôles : Salvateur, Voyante, Petite Fille, Sorcière, Cupidon,
// Corbeau, Chasseur, Idiot ; mécanique mort, transfert maire, résolution de nuit, attribution
// initiale, mission. Inclut tous les handlers socket des rôles.
//
// Dépendances circulaires (phases, votes) résolues via require('./module').fn() à l'usage.

const {
  state, alivePlayers, vivantsSauf, playerName, hasRole, isMJ, fisherYates, auHasard, resetActivity, versMJ,
  joueursAvecRole, vivantsAvecRole, oublierTransfert, infosSalvateur, infosCorbeau, visionComplete,
  SISTERS_TIMEOUT_MS, AMOUREUX_TIMEOUT_MS, SEER_ACK_TIMEOUT_MS, PETITE_FILLE_ACK_TIMEOUT_MS,
} = require('./state');

const lights = require('./lights');
const phases = require('./phases');
const log    = require('./logger');
const { buildDeathNarrative } = require('./death-narratives');

// Phases où une mort compte comme « de nuit » : après une transmission d'écharpe, la
// partie reprend alors au jour (et non sur une nouvelle nuit). Doit contenir TOUTES les
// étapes de nuit, y compris la pause du MJ (« nightPause ») : c'est pendant cette pause
// que la nuit se résout quand le MJ la rythme. Les phases de la mission sont rangées ici
// depuis toujours (elles précèdent la première nuit).
const PHASES_DE_NUIT = ["cupid", "amoureux", "sisters", "salvateur", "wolves", "seer", "petiteFille", "corbeau", "witch",
  "nightPause", "mission", "missionVote", "missionBonus"];

// Une mort de la nuit telle que l'aube l'annonce (récit compris)
function buildDeath(id, cause) {
  const role = state.roles[id], name = playerName(id);
  return { id, name, role, cause, narrative: buildDeathNarrative({ role, cause, name }) };
}

// ===== MISSION — MINUTERIES =====
function clearMissionTimeouts() {
  ["teamTimeout", "cardTimeout", "bonusTimeout"].forEach(k => { clearTimeout(state.mission[k]); state.mission[k] = null; });
}

// Le bonus d'une mission réussie attend le maire (vivant) après la nuit
function bonusMissionAttendu() {
  return state.mission.active && state.mission.result === "success" && !state.mission.bonusDone
    && !!state.mayor && !state.deadPlayers.includes(state.mayor);
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
// tous les téléphones affichent le voile « Yeux fermés. », la voix demande au
// rôle précédent de fermer les yeux, et le MJ voit un grand bouton « Passer à l'étape
// suivante ». Le rôle suivant ne se réveille (et son écran ne s'allume) qu'à ce clic :
// un joueur qui tarde à fermer les yeux ne voit pas qui se réveille après lui.
const LIBELLES_ETAPES_NUIT = {
  cupid: "💘 Cupidon", amoureux: "💘 Les Amoureux", sisters: "👯‍♀️ Les Sœurs jumelles", salvateur: "🛡️ Le Salvateur",
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
    // 15 s pour se regarder
    state.amoureuxFin = Date.now() + AMOUREUX_TIMEOUT_MS;
    state.lovers.forEach(montrerPartenaire);
  }
  if (etape === "sisters") {
    const aliveSisters = vivantsAvecRole("Sœurs");
    // Pas de prénoms : elles savent depuis la révélation des rôles qui est leur sœur.
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
  if (etape === "witch") informerSorciere();
  phases.setPhase(etape);
}

// Un amoureux voit le prénom (et la photo, côté téléphone) de l'autre, et le temps qu'il
// leur reste (réveil des amoureux, reconnexion)
function montrerPartenaire(moi) {
  const autre = state.lovers.find(l => l !== moi);
  state.io.to(moi).emit("amoureuxTurn", { partenaireId: autre, partenaire: playerName(autre), dureeMs: Math.max(0, state.amoureuxFin - Date.now()) });
}

// La Sorcière apprend ses potions restantes et la victime des loups (réveil, reconnexion)
function informerSorciere() {
  const witchId = vivantsAvecRole("Sorcière")[0];
  if (!witchId) return;
  state.io.to(witchId).emit("etatPotions", { vie: !state.witchSaveUsed, mort: !state.witchKillUsed });
  state.io.to(witchId).emit("nightVictim", state.nightTarget);
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
    killPlayer(d.id, d.cause);
    if (state.phase === "chasseur" || state.phase === "mayorTransfer") break;
  }

  // Les morts d'amour (inscrites par killPlayer) rejoignent la carte de l'aube. Les cas
  // Chasseur / maire ci-dessous en ajoutent encore : on les reprend juste avant d'annoncer
  // l'aube, pour que la carte dise qui est mort d'amour
  const ajouterMortsDAmour = () => state.deadPlayers.filter(id => !deadBeforeNight.has(id) && !deaths.find(d => d.id === id))
    .forEach(id => deaths.push(buildDeath(id, "amour")));
  ajouterMortsDAmour();

  // Boucle interrompue par `mayorTransfer` : les morts restantes (ex. cible de la Sorcière)
  // sont traitées ici, pour ne pas apparaître comme successeurs possibles dans le panneau
  // de transmission (il s'ouvre plusieurs secondes après la carte de l'aube)
  if (state.phase === "mayorTransfer") {
    for (const d of deaths) {
      if (state.deadPlayers.includes(d.id)) continue; // déjà mort (cascade amour ou 1ère itération)
      if (state.roles[d.id] === "Chasseur" && !state.pendingChasseurAfterTransfer) {
        // Le chasseur doit tirer APRÈS le transfert → on le diffère plutôt que de
        // changer de phase immédiatement (mayorTransfer a priorité).
        state.pendingChasseurAfterTransfer = d.id;
        state.chasseurPostContext = "night";
        state.currentChasseurShooter = d.id;
        // Mort tout de suite, pour l'exclure des candidats au titre de maire
        marquerMort(d.id, d.cause);
      } else {
        // Mort ordinaire : killPlayer l'ajoute à deadPlayers et gère les cascades.
        killPlayer(d.id, d.cause);
      }
    }
  }

  // Même chose si la boucle a été interrompue par `chasseur` : sans cela, les morts
  // restantes resteraient « vivantes » sur les téléphones. Le maire qui meurt pendant que le
  // Chasseur attend de tirer transmet l'écharpe après le tir.
  if (state.phase === "chasseur") {
    const maireMeurt = id => { if (id === state.mayor && !state.mayorTransferPending) ouvrirTransfert(id); };
    for (const d of deaths) {
      if (state.deadPlayers.includes(d.id)) continue;
      marquerMort(d.id, d.cause);
      maireMeurt(d.id);
      const partenaire = state.lovers.includes(d.id) && state.lovers.find(l => l !== d.id);
      if (partenaire && !state.deadPlayers.includes(partenaire)) {
        marquerMort(partenaire, "amour");
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
  const bonusMission = bonusMissionAttendu();
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
    state.pendingEndGameTimer = setTimeout(() => {
      state.pendingEndGameTimer = null;
      try { fire(); } catch (e) { log.error("fin de partie impossible", e); }
    }, 7000);
    return;
  }

  // La transmission d'écharpe passe avant le jour : le MJ voit déjà le récap de la nuit
  if (state.phase === "mayorTransfer") envoyerRecapMJ();
  else phases.setPhase(bonusMission ? "missionBonus" : "day");
}

// Récap de la nuit envoyé au MJ : à l'aube s'il ne faut pas attendre le jour (Chasseur,
// transmission d'écharpe, fin de partie), sinon au début du jour (setPhase)
function envoyerRecapMJ() {
  if (!state.pendingDayRecap) return;
  versMJ("mjDayRecap", { dayNum: state.gameStats.dayCount + 1, ...state.pendingDayRecap });
  state.pendingDayRecap = null;
}

// Lumières de l'aube : un éclair par mort puis la couleur de la mission ; l'aube si personne n'est mort
function lumieresAube(nbMorts, mission) {
  const couleurMission = mission === "success" ? "flash.reussite" : "flash.death";
  if (nbMorts > 0) {
    lights.flashSequence("flash.death", nbMorts);
    if (mission !== null) setTimeout(() => lights.flash(couleurMission), nbMorts * 750 + 300);
  } else lights.flash(mission !== null ? couleurMission : "flash.dawn");
}

// ===== MORT =====
// Un joueur meurt : il est inscrit parmi les morts et au journal des morts (cause : « loups »,
// « sorcière », « vote », « chasseur » ou « amour »), et tous les écrans l'apprennent (une mort
// d'amour est annoncée comme telle). Ce que la mort déclenche ensuite reste à l'appelant.
function marquerMort(id, cause) {
  const name = playerName(id), role = state.roles[id];
  state.deadPlayers.push(id);
  if (!state.gameStats.firstDead) state.gameStats.firstDead = { name, role };
  state.gameStats.deathLog.push({ id, name, role, cause });
  state.io.emit("deadPlayers", state.deadPlayers);
  if (cause === "amour") state.io.emit("loversDeathInfo", { id, name, role });
  state.io.emit("playerDied", { id, role, name });
}

// Où reprend la partie après le tir d'un Chasseur qui meurt maintenant : « day » (mort au vote :
// la nuit suit son tir) ou « night » (mort la nuit : le jour suit). Abattu par un autre Chasseur,
// il reprend la suite du premier.
function contexteDuTir() {
  if (state.phase === "chasseur") return state.chasseurPostContext || "night";
  return state.phase === "day" ? "day" : "night";
}
// Même chose pour une transmission d'écharpe (suite : performMayorTransfer) : « night », « day »,
// ou « chasseur » / « chasseurFromDay » pour un maire abattu par un Chasseur mort la nuit / au vote
function contexteDuTransfert() {
  if (state.phase === "chasseur") return state.chasseurPostContext === "day" ? "chasseurFromDay" : "chasseur";
  return PHASES_DE_NUIT.includes(state.phase) ? "night" : "day";
}
// Le maire meurt : son écharpe est à transmettre. L'appelant passe ensuite en phase
// « mayorTransfer » (ou la transmission attend le tir du Chasseur en cours).
function ouvrirTransfert(id, etaitChasseur = false) {
  state.dyingMayorId = id; state.mayorTransferPending = true; state.mayor = null;
  state.dyingMayorWasChasseur = etaitChasseur;
  state.mayorTransferContext = contexteDuTransfert();
  state.io.emit("newMayor", null); annoncerTransfert(id);
}
// Un Chasseur mort va tirer : `contexte` dit ce qui suivra son tir (voir contexteDuTir)
function faireTirer(id, contexte = contexteDuTir()) {
  state.currentChasseurShooter = id;
  state.chasseurPostContext = contexte;
  annoncerTir(id);
  phases.setPhase("chasseur");
}

function killPlayer(id, cause) {
  if (!id || state.deadPlayers.includes(id)) return;
  log.info('killPlayer', playerName(id), `(role=${state.roles[id]})`, 'cause=' + cause, 'phase=' + state.phase);
  marquerMort(id, cause);

  const isMayorDying    = (id === state.mayor);
  const isChasseurDying = (state.roles[id] === "Chasseur");
  if (!isMayorDying && !isChasseurDying) sendDeadVision(id);

  if (state.lovers.includes(id)) {
    const partner = state.lovers.find(l => l !== id);
    if (partner && !state.deadPlayers.includes(partner)) {
      marquerMort(partner, "amour");
      sendDeadVision(partner);
      if (state.roles[partner] === "Chasseur") {
        if (partner === state.mayor) {
          // L'amoureux, maire et Chasseur : l'écharpe d'abord, son tir ensuite (performMayorTransfer)
          ouvrirTransfert(partner, true);
          phases.setPhase("mayorTransfer"); return;
        } else if (isMayorDying) {
          // Le mort est le maire et son amoureux le Chasseur : l'écharpe d'abord, le tir ensuite
          // (passer directement en phase chasseur faisait refuser la transmission) — le Chasseur
          // tirera dans performMayorTransfer
          state.pendingChasseurAfterTransfer = partner;
          state.chasseurPostContext = contexteDuTir();
          ouvrirTransfert(id);
          phases.setPhase("mayorTransfer"); return;
        }
        // L'amoureux est Chasseur, ni maire ni objet d'une transmission : il tire tout de suite
        faireTirer(partner); return;
      }
      if (partner === state.mayor && !state.mayorTransferPending) {
        if (state.phase === "lobby") { phases.checkVictory(); return; }
        if (phases.checkVictory()) return;
        ouvrirTransfert(partner);
        phases.setPhase("mayorTransfer"); return;
      }
    }
  }

  if (isMayorDying && !state.mayorTransferPending) {
    if (state.phase === "lobby") { phases.checkVictory(); return; }
    if (!isChasseurDying && phases.checkVictory()) return;
    ouvrirTransfert(id, isChasseurDying);
    phases.setPhase("mayorTransfer"); return;
  } else if (isMayorDying) {
    return;
  }

  if (isChasseurDying) { faireTirer(id); return; }
  phases.checkVictory();
}

function sendDeadVision(socketId) {
  // Jour piloté par le MJ : pas de vision spectateur pendant la partie, le mort voit
  // « Vous êtes mort » (deadFullScreen) ; tout est révélé en fin de partie (endGame)
  if (state.mjPilotedDay) return;
  state.io.to(socketId).emit("deadVision", visionComplete());
}

// ===== CHASSEUR — TIR =====
function performChasseurShot(shooterId, targetId) {
  if (state.phase !== "chasseur" || state.actionMJ) return;
  if (!(state.roles[shooterId] === "Chasseur" && state.deadPlayers.includes(shooterId))) return;
  if (state.deadPlayers.includes(targetId)) return;

  clearTimeout(state.chasseurTimeout); state.chasseurTimeout = null;
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
  killPlayer(targetId, "chasseur");
  lights.flash("flash.death");
  // Un second Chasseur abattu (ou mort d'amour) tire à son tour : la suite attend son tir
  if (state.phase === "chasseur" && !state.currentChasseurShooter) apresLeTir(postCtx);
}

// Après le tir du Chasseur (ou faute de cible) : victoire, transmission d'écharpe en attente,
// sinon la suite de sa mort — la nuit après un vote du jour, le jour après une mort de nuit
function apresLeTir(postCtx) {
  if (phases.checkVictory()) return;
  if (state.mayorTransferPending && state.dyingMayorId) phases.setPhase("mayorTransfer");
  else if (postCtx === "day") ouvrirNuit(false);
  else phases.setPhase("day");
}

// Cible au hasard du Chasseur (robot, ou filet s'il ne tire pas) et successeur au hasard du
// maire mourant : un vivant, sauf lui
const cibleAuHasard = () => auHasard(vivantsSauf(state.currentChasseurShooter));
const successeurAuHasard = () => auHasard(vivantsSauf(state.dyingMayorId));

// ===== TRANSFERT MAIRE =====
function performMayorTransfer(targetId) {
  if (state.phase !== "mayorTransfer" || state.actionMJ) return;
  if (state.deadPlayers.includes(targetId)) return;
  if (targetId === state.dyingMayorId) return;

  clearTimeout(state.mayorTransferTimeout); state.mayorTransferTimeout = null;

  const oldDyingId = state.dyingMayorId;
  const ctx = state.mayorTransferContext;
  const wasChasseur = state.dyingMayorWasChasseur;
  state.mayor = targetId;
  oublierTransfert();
  state.io.emit("newMayor", state.mayor);
  state.io.emit("mayorTransferred", targetId);
  lights.flash("flash.bell");

  // Le maire était le Chasseur : il tire maintenant ; son tir a la même suite que sa mort
  if (wasChasseur) { faireTirer(oldDyingId, (ctx === "day" || ctx === "chasseurFromDay") ? "day" : "night"); return; }
  sendDeadVision(oldDyingId);

  // Maire et Chasseur, deux amoureux distincts : l'écharpe est transmise, le Chasseur tire
  // (la suite de son tir a été posée dans killPlayer, au moment de la mort)
  if (state.pendingChasseurAfterTransfer) {
    const chasseurId = state.pendingChasseurAfterTransfer;
    state.pendingChasseurAfterTransfer = null;
    if (!phases.checkVictory()) faireTirer(chasseurId, state.chasseurPostContext);
    return;
  }

  if (phases.checkVictory()) return;
  // Maire mort au vote du jour (ou abattu par un Chasseur mort au vote) : la nuit suit
  if (ctx === "day" || ctx === "chasseurFromDay") ouvrirNuit(false);
  else if (ctx === "night") phases.setPhase(bonusMissionAttendu() ? "missionBonus" : "day");
  else {
    // « chasseur » : abattu par un Chasseur mort la nuit, le jour suit
    if (ctx !== "chasseur") log.warn('performMayorTransfer', 'contexte inconnu=' + ctx + ' → retour au jour');
    phases.setPhase("day");
  }
}

// ===== ATTRIBUTION DES RÔLES =====
// Composition envoyée par le MJ : sa clé → le rôle. Un rôle absent compte 0.
const COMPOSITION = [["cupidon", "Cupidon"], ["voyante", "Voyante"], ["sorciere", "Sorcière"], ["chasseur", "Chasseur"],
  ["loup", "Loup"], ["petiteFille", "PetiteFille"], ["idiot", "Idiot"], ["ange", "Ange"], ["corbeau", "Corbeau"],
  ["salvateur", "Salvateur"], ["sisters", "Sœurs"]];

function assignAndStart(config, playerList) {
  log.info('assignAndStart', 'players=' + playerList.length, 'config=', config);
  const numPlayers = playerList.length;
  // Les Sœurs jumelles vont par 2 (0 ou 2) : toute autre valeur est ramenée à 0
  const nombre = cle => cle === "sisters" ? (+config.sisters === 2 ? 2 : 0) : Math.max(0, Math.floor(+config[cle] || 0));
  const numLoups = nombre("loup");
  const numSpecial = COMPOSITION.reduce((total, [cle]) => total + nombre(cle), 0);

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

  // Les joueurs mélangés reçoivent les rôles de la composition dans l'ordre, les autres sont Villageois
  const shuffled = fisherYates(playerList);
  const distribution = COMPOSITION.flatMap(([cle, role]) => Array(nombre(cle)).fill(role));
  shuffled.forEach((p, i) => { state.roles[p.id] = distribution[i] || "Villageois"; });

  playerList.forEach(p => {
    const k = p.name.toLowerCase();
    if (state.playerRegistry[k]) state.playerRegistry[k].role = state.roles[p.id];
  });

  const wolves = joueursAvecRole("Loup"), soeurs = joueursAvecRole("Sœurs");

  playerList.forEach(p => {
    const isWolf = state.roles[p.id] === "Loup";
    state.io.to(p.id).emit("yourRole", {
      role: state.roles[p.id],
      // Loups et Sœurs savent dès le début avec qui ils sont
      wolves: isWolf ? wolves : [],
      soeurs: state.roles[p.id] === "Sœurs" ? soeurs : [],
      // Le téléphone en a besoin pour choisir l'écran de mort épuré plutôt que la vision complète
      mjPilotedDay: !!state.mjPilotedDay,
      nuitParMJ: !state.autoMode
    });
  });

  versMJ("rolesMJ", { roles: state.roles, players: state.players });

  state.mission.active = !!config.mission;
  phases.setPhase("mayorVote");
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
  versMJ("soundPlay", "cupid");
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
    if (state.phase === "sisters") allerEtapeNuit(etapeApres("sisters"));
  }, SISTERS_TIMEOUT_MS);
  log.info('demarrerTimerSoeurs', 'durationMs=' + SISTERS_TIMEOUT_MS);
  // Notifie tous les clients (les Sœurs démarrent leur décompte, le MJ est prévenu)
  state.io.emit("sistersTimerStart", { durationMs: SISTERS_TIMEOUT_MS });
}

function handleSalvateurAction(socket, targetId) {
  if (state.phase !== "salvateur" || !hasRole(socket.id, "Salvateur")) return;
  if (!targetId) return;
  if (state.deadPlayers.includes(targetId)) return;
  if (targetId === state.lastProtectedTarget) {
    socket.emit("salvateurReject", { reason: "Tu ne peux pas protéger la même personne deux nuits de suite." });
    return;
  }
  if (state.salvateurTimeout) { clearTimeout(state.salvateurTimeout); state.salvateurTimeout = null; }
  resetActivity();
  state.protectedTarget = targetId;
  socket.emit("salvateurConfirm", { targetId, targetName: playerName(targetId) });
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
    versMJ("autoResolve", "⏱️ La Voyante n'a pas confirmé sa vision — la nuit continue.");
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
    return "Désigne 3 joueurs vivants, autres que toi.";
  }
  clearTimeout(state.petiteFilleTimeout); state.petiteFilleTimeout = null;
  const auMoinsUnLoup = ids.some(id => state.roles[id] === "Loup");
  const result = { names: ids.map(playerName), auMoinsUnLoup };
  state.petiteFillePendingResult = result;
  state.io.to(pfId).emit("petiteFilleResult", result);
  state.gameStats.petiteFilleLog.push({ names: result.names, auMoinsUnLoup });
  versMJ("petiteFilleMJInfo", {
    names: result.names, auMoinsUnLoup,
    loups: ids.filter(id => state.roles[id] === "Loup").map(playerName)
  });
  versMJ("soundPlay", "petite_fille");
  state.petiteFilleTimeout = setTimeout(() => {
    if (state.phase !== "petiteFille") return;
    versMJ("autoResolve", "⏱️ La Petite Fille n'a pas confirmé sa réponse — la nuit continue.");
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
  annoncerCorbeau();
  const corbeau = infosCorbeau();
  versMJ("corbeauMJInfo", corbeau ? { name: corbeau.targetName, id: corbeau.targetId } : { name: null, id: null });
  allerEtapeNuit(etapeApres("corbeau"));
}

// Tous les écrans apprennent qui le Corbeau a désigné (+2 voix au vote), tant que la cible vit
function annoncerCorbeau() {
  const corbeau = infosCorbeau();
  if (corbeau) state.io.emit("corbeauVotesPublic", corbeau);
}

function handleWitchSave(socket) {
  if (state.phase !== "witch" || !hasRole(socket.id, "Sorcière") || state.witchSaveUsed) return;
  if (!state.nightTarget) return;
  clearTimeout(state.witchTimeout); state.witchTimeout = null;
  state.witchSaveUsed = true;
  state.witchSaveActive = true;
  socket.emit("witchSaveConfirm");
  versMJ("soundPlay", "witch");
}

function handleWitchKill(socket, id) {
  if (state.phase !== "witch" || !hasRole(socket.id, "Sorcière") || state.witchKillUsed || state.deadPlayers.includes(id)) return;
  if (id === socket.id) return;
  if (id === state.nightTarget) {
    socket.emit("witchKillRefused", "Tu ne peux pas utiliser ta potion de mort sur la victime des loups.");
    return;
  }
  clearTimeout(state.witchTimeout); state.witchTimeout = null;
  state.witchKillUsed = true;
  state.witchKillTarget = id;
  socket.emit("witchKillConfirm");
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
  teamIds.forEach(demanderCarteMission);
  versMJ("missionMJInfo", { step: "cardVote", team: equipe });
  phases.setPhase("missionVote");
}

// Un membre de l'équipe est invité à jouer sa carte secrète (envoi en mission, reconnexion)
function demanderCarteMission(id) {
  state.io.to(id).emit("missionCardChoice", { mayorName: playerName(state.mayor), teamNames: state.mission.team.map(playerName) });
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
  if (!equipeValide(teamIds)) return socket.emit("missionError", "Sélection invalide — 3 joueurs vivants autres que toi.");
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
  if (!equipeValide(bonusTeamIds)) return socket.emit("missionError", "Sélection bonus invalide — 3 joueurs vivants autres que toi.");
  inspecterBonus(bonusTeamIds);
}

// IMPORTANT : on MUTE l'objet module.exports (pas de réassignation) pour ne pas
// invalider les références capturées par phases.js et votes.js pendant la phase
// de chargement circulaire.
Object.assign(module.exports, {
  // Mission
  clearMissionTimeouts, resolveMissionCards, envoyerEnMission, jouerCarteMission, inspecterBonus, demanderCarteMission,
  // Nuit
  ETAPES_NUIT, LIBELLES_ETAPES_NUIT, startNightSequence, doResolveNight, allerEtapeNuit, lancerEtapeNuit, etapeApres,
  ouvrirNuit, lancerNuitAttendue, finAmoureux, demarrerTimerSoeurs, advanceAfterSeer, advanceAfterPetiteFille,
  montrerPartenaire, informerSorciere, annoncerCorbeau, envoyerRecapMJ,
  // Morts, tir du Chasseur, transmission d'écharpe
  killPlayer, performChasseurShot, performMayorTransfer, apresLeTir, cibleAuHasard, successeurAuHasard,
  // Attribution
  assignAndStart,
  // Handlers (joueurs, MJ, robots)
  handleMJEtapeSuivante, handleMJLancerNuit,
  handleCupidChoice, handleSalvateurAction, handleSeerChoice, handleSeerDone, handleCorbeauAction,
  handlePetiteFilleChoice, handlePetiteFilleDone,
  handleWitchSave, handleWitchKill, handleWitchDone, handleResolveNight,
  handleChasseurAction, handleMayorTransferChoice,
  handleMissionTeamChoice, handleMissionCard, handleMissionBonusChoice,
});
