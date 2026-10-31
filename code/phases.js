// phases.js — Orchestration des phases : setPhase, timeouts, bots, victoire, pause, reset.
// Dépendances circulaires (roles, votes) résolues via require('./module').fn() à l'usage.

const {
  state, partieNeuve, alivePlayers, vivantsSauf, playerName, fisherYates, auHasard, isMJ, resetActivity, versMJ,
  vivantsAvecRole, oublierTransfert, visionComplete, entreeRegistre,
  WITCH_TIMEOUT_MS, CUPID_TIMEOUT_MS, CORBEAU_TIMEOUT_MS, SEER_TIMEOUT_MS, SALVATEUR_TIMEOUT_MS, NIGHT_PAUSE_TIMEOUT_MS,
  PETITE_FILLE_TIMEOUT_MS, AMOUREUX_TIMEOUT_MS,
  CHASSEUR_TIMEOUT_MS, MAYOR_TRANSFER_TIMEOUT_MS,
  MISSION_TEAM_TIMEOUT_MS, MISSION_CARD_TIMEOUT_MS, MISSION_BONUS_TIMEOUT_MS,
  MAYOR_AUTO_TIMEOUT_MS, WOLVES_AUTO_TIMEOUT_MS,
  DAY_AUTO_START_DELAY_MS, STUCK_TIMEOUT_MS,
  BOT_MIN_DELAY_MS, BOT_MAX_DELAY_MS,
} = require('./state');

const lights    = require('./lights');
const narration = require('./narration');
const council   = require('./council');
const roles     = require('./roles');
const votes     = require('./votes');
const log       = require('./logger');
const badges    = require('./badges');
const soiree    = require('./soiree');

// ===== PARTIE BLOQUÉE =====
// Étapes où l'on attend un joueur : sans activité pendant STUCK_TIMEOUT_MS, le MJ est prévenu
const PHASES_SURVEILLEES = ['wolves', 'seer', 'petiteFille', 'corbeau', 'witch', 'cupid'];
function startStuckTimer() {
  resetActivity();
  function scheduleAlert() {
    state.stuckGameTimer = setTimeout(() => {
      if (PHASES_SURVEILLEES.includes(state.phase)) {
        versMJ('stuckGame', {
          phase: state.phase,
          idleMinutes: Math.round((Date.now() - state.lastActivityTime) / 60000)
        });
      }
      scheduleAlert();
    }, STUCK_TIMEOUT_MS);
  }
  scheduleAlert();
}

// ===== BOTS =====
function scheduleBot(callback) {
  const delay = BOT_MIN_DELAY_MS + Math.random() * (BOT_MAX_DELAY_MS - BOT_MIN_DELAY_MS);
  setTimeout(() => {
    if (state.gamePaused) return;  // les bots se taisent en pause
    try { callback(); } catch (e) { log.error("action de robot impossible", e); }
  }, delay);
}

// ===== SETPHASE =====
function setPhase(p) {
  const previousPhase = state.phase;
  state.phase = p;
  // Toute nouvelle phase clôt la résolution du vote du jour (votes.resolveDayVote)
  state.resolutionJourEnCours = false;
  log.info('setPhase', previousPhase, '->', p);
  state.io.emit("phase", state.phase);
  // Narration IA : annonce la transition (jouée sur le MJ via TTS)
  narration.narrate(previousPhase, p);

  if (p === "day") {
    // Récap de la nuit pour le MJ, s'il n'est pas déjà parti à l'aube
    roles.envoyerRecapMJ();
    state.gameStats.dayCount++;
    state.nightMusicPlayed = false;
    // La désignation du Corbeau est rappelée dès le début du jour
    roles.annoncerCorbeau();

    // ===== CONSEIL DES MORTS =====
    council.clearCouncilEffects();
    state.evenementAnnonce = false;
    if (state.pendingCouncilEvent) {
      state.activeCouncilEvent = state.pendingCouncilEvent;
      state.pendingCouncilEvent = null;
      // Avec un MJ, l'évènement attend son « 📜 Annoncer l'évènement » ; sinon, 3 s après l'aube
      if (!council.annonceMatinParMJ()) {
        setTimeout(() => { if (state.phase === "day" && state.activeCouncilEvent) council.annoncerEvenement(); }, 3000);
      }
    } else {
      state.activeCouncilEvent = null;
    }
    // Annonce du matin menée par le MJ : il voit l'évènement à lire et les boutons pour enchaîner
    state.annonceMatinEnCours = council.annonceMatinParMJ();
    if (state.annonceMatinEnCours) versMJ("matinEnAttente", { evenement: council.evenementPublic(state.activeCouncilEvent) });
    // Conseil des morts : se déclenche chaque début de journée dès qu'il y a au moins
    // COUNCIL_TRIGGER_THRESHOLD mort(s) (1 aujourd'hui). Un nouveau vote est proposé à chaque
    // jour suivant. Les événements déjà proposés (choisis ou non) ne réapparaissent pas.
    if (state.conseilActif && state.deadPlayers.length >= council.COUNCIL_TRIGGER_THRESHOLD) {
      setTimeout(() => {
        if (state.phase === "day") council.startCouncil();
      }, 4000);
    }
  }
  // Quand on QUITTE le jour : on résout le conseil en cours
  if (previousPhase === "day" && p !== "day") {
    state.annonceMatinEnCours = false;
    if (state.councilOptions) council.resolveCouncil();
    state.activeCouncilEvent = null;
    council.clearCouncilEffects();
    state.io.emit("councilEventEnd");
  }

  if (p === "wolves") versMJ("soundPlay", "wolves");

  // Chasseur, transmission d'écharpe : avec un MJ, l'action attend son clic (ouvrirActionMJ) —
  // l'annonce du mort reste sur les téléphones pendant qu'il raconte (demande d'Alexandre, 2026-10-26)
  state.actionMJ = (["chasseur", "mayorTransfer"].includes(p) && !state.autoMode) ? p : null;
  if (state.actionMJ) {
    versMJ("actionMJEnAttente", { type: p, nom: playerName(p === "chasseur" ? state.currentChasseurShooter : state.dyingMayorId) });
  }

  // Nettoie tous les timeouts de phase
  clearPhaseTimeouts();
  installPhaseTimeouts(p);

  if (PHASES_SURVEILLEES.includes(p)) startStuckTimer();
  else resetActivity();

  armerMinuteriesAutomatiques(p);

  // Mode entraînement : déclenche les actions automatiques des bots
  runBotsForPhase(p);

  // === Lumières connectées ===
  lights.applyScene(p);
}

// ===== ACTION LANCÉE PAR LE MJ (Chasseur, transmission d'écharpe) =====
// Clic « 🔫 Le Chasseur tire » ou « 🏛️ Transmettre l'écharpe » (ou filet si la tablette ne répond plus) : l'appel part
// vers les téléphones, la minuterie de l'action démarre, les robots concernés jouent.
function ouvrirActionMJ() {
  const p = state.actionMJ;
  if (!p || state.phase !== p) return;
  state.actionMJ = null;
  clearTimeout(state.chasseurTimeout); state.chasseurTimeout = null;
  clearTimeout(state.mayorTransferTimeout); state.mayorTransferTimeout = null;
  if (p === "chasseur" && state.currentChasseurShooter) state.io.emit("chasseurMustShoot", state.currentChasseurShooter);
  if (p === "mayorTransfer" && state.dyingMayorId) state.io.emit("mayorMustTransfer", state.dyingMayorId);
  installPhaseTimeouts(p);
  runBotsForPhase(p);
}

// Le tir du Chasseur ou la transmission d'écharpe attend le clic du MJ sans limite tant que sa
// tablette est connectée (il raconte) ; l'action ne démarre seule que si la tablette ne répond
// plus, à deux contrôles de suite (30 s d'écart : un simple rechargement ne la déclenche pas).
function filetActionMJ(champ, p, mjAbsent = false) {
  state[champ] = setTimeout(() => {
    if (state.phase !== p || state.actionMJ !== p) return;
    if (state.mjSocketId) return filetActionMJ(champ, p);
    if (!mjAbsent) return filetActionMJ(champ, p, true);
    ouvrirActionMJ();
  }, mjAbsent ? 30 * 1000 : NIGHT_PAUSE_TIMEOUT_MS);
}

// ===== MINUTERIES DU MODE AUTONOME ET DU JOUR NON PILOTÉ =====
// Appelée à l'entrée d'une phase ET à la reprise après une pause (pauseGame les efface :
// sans ce réarmement, les loups, l'élection du maire ou le lancement du vote du jour
// restaient bloqués après une pause en mode autonome).
function armerMinuteriesAutomatiques(p) {
  if (state.autoMode) {
    if (p === "mayorVote") {
      state.mayorAutoLockTimer = setTimeout(() => {
        if (state.phase === "mayorVote") {
          state.io.emit("autoResolve", "⏱️ Délai dépassé — élection avec les votes en cours.");
          votes.performLockMayorVote();
        }
      }, MAYOR_AUTO_TIMEOUT_MS);
    }
    if (p === "wolves") {
      state.wolvesAutoLockTimer = setTimeout(() => {
        if (state.phase === "wolves") {
          state.io.emit("autoResolve", "⏱️ Loups indécis — résolution par majorité.");
          votes.performLockWolfVotes();
        }
      }, WOLVES_AUTO_TIMEOUT_MS);
    }
  }

  // Jour : en mode autonome (ou jour non piloté), le vote démarre seul ; sinon le MJ le
  // lance (« Lancer le vote », votes.handleStartVote)
  if (p === "day" && (state.autoMode || !state.mjPilotedDay)) {
    state.dayAutoStartTimer = setTimeout(() => {
      if (state.phase === "day" && state.voteTimer == null) {
        votes.startDayVote(state.autoMode ? state.autoVoteMode : 1);
      }
    }, DAY_AUTO_START_DELAY_MS);
  }
}

// ===== INSTALLATION DES TIMEOUTS PAR PHASE =====
function installPhaseTimeouts(p) {
  if (p === "witch") {
    state.witchTimeout = setTimeout(() => {
      if (state.phase === "witch") {
        versMJ("autoResolve", "⏱️ La Sorcière a trop tardé — passage automatique à l'aube.");
        roles.doResolveNight();
      }
    }, WITCH_TIMEOUT_MS);
  }

  if (p === "seer") {
    state.seerTimeout = setTimeout(() => {
      if (state.phase !== "seer") return;
      versMJ("autoResolve", "⏱️ La Voyante a tardé — passage automatique.");
      roles.advanceAfterSeer();
    }, SEER_TIMEOUT_MS);
  }

  if (p === "petiteFille") {
    state.petiteFilleTimeout = setTimeout(() => {
      if (state.phase !== "petiteFille") return;
      versMJ("autoResolve", "⏱️ La Petite Fille a tardé — passage automatique.");
      roles.advanceAfterPetiteFille();
    }, PETITE_FILLE_TIMEOUT_MS);
  }

  if (p === "corbeau") {
    state.corbeauTimeout = setTimeout(() => {
      if (state.phase === "corbeau") {
        versMJ("autoResolve", "⏱️ Le Corbeau a tardé — passage automatique.");
        state.corbeauTarget = "skip";
        roles.allerEtapeNuit(roles.etapeApres("corbeau"));
      }
    }, CORBEAU_TIMEOUT_MS);
  }

  if (p === "cupid") {
    state.cupidTimeout = setTimeout(() => {
      if (state.phase === "cupid") {
        versMJ("autoResolve", "⏱️ Cupidon n'a pas choisi — passage automatique à la nuit.");
        roles.startNightSequence();
      }
    }, CUPID_TIMEOUT_MS);
  }

  if (p === "salvateur") {
    state.salvateurTimeout = setTimeout(() => {
      if (state.phase === "salvateur") {
        versMJ("autoResolve", "⏱️ Le Salvateur a tardé — la nuit avance sans protection.");
        state.protectedTarget = null;
        roles.allerEtapeNuit("wolves");
      }
    }, SALVATEUR_TIMEOUT_MS);
  }

  // Sœurs jumelles : les 20 s démarrent dès leur réveil. Le MJ a déjà vérifié, juste
  // avant, que tout le monde avait les yeux fermés (pause « Passer à l'étape suivante »).
  if (p === "sisters") roles.demarrerTimerSoeurs();

  // Amoureux : 15 s pour se regarder, puis la nuit continue
  if (p === "amoureux") {
    state.amoureuxTimeout = setTimeout(() => roles.finAmoureux(), AMOUREUX_TIMEOUT_MS);
  }

  // Crépuscule : si le MJ ne lance pas la nuit (tablette déconnectée…), elle démarre seule
  if (p === "crepuscule") {
    state.nightPauseTimeout = setTimeout(() => {
      if (state.phase !== "crepuscule") return;
      versMJ("autoResolve", "⏱️ Pas de clic du MJ depuis 3 min — la nuit commence.");
      roles.lancerNuitAttendue();
    }, NIGHT_PAUSE_TIMEOUT_MS);
  }

  // Pause entre deux étapes de nuit : si le MJ ne clique pas (tablette déconnectée…),
  // la nuit continue d'elle-même au bout de NIGHT_PAUSE_TIMEOUT_MS.
  if (p === "nightPause") {
    state.nightPauseTimeout = setTimeout(() => {
      if (state.phase !== "nightPause" || !state.etapeNuitSuivante) return;
      versMJ("autoResolve", "⏱️ Pas de clic du MJ depuis 3 min — la nuit continue.");
      roles.allerEtapeNuit(state.etapeNuitSuivante, { sansPause: true });
    }, NIGHT_PAUSE_TIMEOUT_MS);
  }

  if (p === "mission") {
    state.mission.teamTimeout = setTimeout(() => {
      if (state.phase === "mission") {
        state.io.emit("autoResolve", "⏱️ Le Maire n'a pas sélectionné son équipe — mission annulée.");
        state.mission.active = false;
        roles.ouvrirNuit(true);
      }
    }, MISSION_TEAM_TIMEOUT_MS);
  }

  if (p === "missionVote") {
    state.mission.cardTimeout = setTimeout(() => {
      if (state.phase === "missionVote") {
        state.mission.team.forEach(id => {
          if (!state.mission.cards[id]) state.mission.cards[id] = "success";
        });
        state.io.emit("autoResolve", "⏱️ Temps écoulé — cartes manquantes comptées comme Réussite.");
        roles.resolveMissionCards();
      }
    }, MISSION_CARD_TIMEOUT_MS);
  }

  if (p === "missionBonus") {
    state.mission.bonusTimeout = setTimeout(() => {
      if (state.phase === "missionBonus") {
        state.io.emit("autoResolve", "⏱️ Le Maire n'a pas utilisé son bonus — passage au jour.");
        state.mission.bonusDone = true;
        setPhase("day");
      }
    }, MISSION_BONUS_TIMEOUT_MS);
  }

  // Chasseur : tir aléatoire si inactif
  if (p === "chasseur" && state.actionMJ === "chasseur") {
    filetActionMJ("chasseurTimeout", "chasseur");
  } else if (p === "chasseur") {
    state.chasseurTimeout = setTimeout(() => {
      if (state.phase !== "chasseur" || !state.currentChasseurShooter) return;
      const cible = roles.cibleAuHasard();
      if (cible) {
        state.io.emit("autoResolve", `⏱️ Le Chasseur a tardé — tir aléatoire sur ${cible.name}.`);
        roles.performChasseurShot(state.currentChasseurShooter, cible.id);
      } else {
        // Personne à abattre : la partie reprend comme après un tir
        const postCtx = state.chasseurPostContext;
        state.currentChasseurShooter = null;
        state.chasseurPostContext = null;
        roles.apresLeTir(postCtx);
      }
    }, CHASSEUR_TIMEOUT_MS);
  }

  // Transfert maire : successeur aléatoire si inactif
  if (p === "mayorTransfer" && state.actionMJ === "mayorTransfer") {
    filetActionMJ("mayorTransferTimeout", "mayorTransfer");
  } else if (p === "mayorTransfer") {
    state.mayorTransferTimeout = setTimeout(() => {
      if (state.phase !== "mayorTransfer" || !state.dyingMayorId) return;
      const successeur = roles.successeurAuHasard();
      if (successeur) {
        state.io.emit("autoResolve", `⏱️ Maire mourant inactif — successeur aléatoire : ${successeur.name}.`);
        roles.performMayorTransfer(successeur.id);
      } else {
        state.io.emit("autoResolve", `⏱️ Aucun successeur disponible — transfert annulé.`);
        oublierTransfert();
        if (!checkVictory()) setPhase("day");
      }
    }, MAYOR_TRANSFER_TIMEOUT_MS);
  }
}

// Minuteries des phases, et filets du mode autonome
const MINUTERIES_DE_PHASE = ["seerTimeout", "petiteFilleTimeout", "nightPauseTimeout", "witchTimeout", "cupidTimeout",
  "salvateurTimeout", "sistersTimeout", "amoureuxTimeout", "corbeauTimeout", "chasseurTimeout", "mayorTransferTimeout"];
const FILETS_AUTONOMES = ["mayorAutoLockTimer", "wolfConsensusTimer", "wolvesAutoLockTimer", "dayAutoStartTimer"];
function arreterMinuteries(noms) { noms.forEach(k => { clearTimeout(state[k]); state[k] = null; }); }
function arreterFiletsAutonomes() { arreterMinuteries(FILETS_AUTONOMES); state.mayorAllVotedNotified = false; }

function clearPhaseTimeouts() {
  arreterMinuteries(MINUTERIES_DE_PHASE);
  state.seerPendingResult = null;
  state.petiteFillePendingResult = null;
  state.sistersTimerEnd = null;
  roles.clearMissionTimeouts();
  arreterFiletsAutonomes();
}

// ===== ACTIONS DES BOTS PAR PHASE =====
// Un robot agit par les mêmes portes qu'un joueur : un faux socket qui porte son identifiant
const commeJoueur = bot => ({ id: bot.id, emit: (evt, data) => state.io.to(bot.id).emit(evt, data) });

function runBotsForPhase(p) {
  const aliveBots = state.players.filter(pl => pl.isBot && !state.deadPlayers.includes(pl.id));
  if (aliveBots.length === 0) return;
  const robotAvecRole = r => aliveBots.find(b => state.roles[b.id] === r);

  // Vote du Maire
  if (p === "mayorVote") {
    aliveBots.forEach(bot => {
      scheduleBot(() => {
        if (state.phase !== "mayorVote" || state.deadPlayers.includes(bot.id) || state.mayorVote[bot.id]) return;
        const cible = auHasard(vivantsSauf(bot.id));
        if (cible) votes.handleVoteMayor(commeJoueur(bot), cible.id);
      });
    });
  }

  // Cupidon
  if (p === "cupid") {
    const cupidBot = robotAvecRole("Cupidon");
    if (cupidBot && !state.cupidDone) {
      scheduleBot(() => {
        const candidates = fisherYates(alivePlayers());
        if (candidates.length >= 2) roles.handleCupidChoice(commeJoueur(cupidBot), [candidates[0].id, candidates[1].id]);
      });
    }
  }

  // Loups
  if (p === "wolves") {
    aliveBots.filter(b => state.roles[b.id] === "Loup").forEach(bot => {
      scheduleBot(() => {
        if (state.phase !== "wolves" || state.votesWolf[bot.id]) return;
        const cible = auHasard(alivePlayers().filter(pl => state.roles[pl.id] !== "Loup"));
        if (cible) votes.handleVoteWolf(commeJoueur(bot), cible.id);
      });
    });
  }

  // Salvateur (jamais la même personne deux nuits de suite)
  if (p === "salvateur") {
    const salvateurBot = robotAvecRole("Salvateur");
    if (salvateurBot) {
      scheduleBot(() => {
        const cible = auHasard(vivantsSauf(state.lastProtectedTarget));
        if (cible) roles.handleSalvateurAction(commeJoueur(salvateurBot), cible.id);
      });
    }
  }

  // Voyante : elle « lit » sa vision quelques secondes puis confirme, comme un humain
  if (p === "seer") {
    const seerBot = robotAvecRole("Voyante");
    if (seerBot) {
      scheduleBot(() => {
        const cible = auHasard(vivantsSauf(seerBot.id));
        if (!cible) return;
        roles.handleSeerChoice(commeJoueur(seerBot), cible.id);
        scheduleBot(() => roles.handleSeerDone(commeJoueur(seerBot)));
      });
    }
  }

  // Petite Fille : 3 joueurs vivants au hasard (jamais elle-même), puis « OK » comme un humain
  if (p === "petiteFille") {
    const pfBot = robotAvecRole("PetiteFille");
    if (pfBot) {
      scheduleBot(() => {
        const candidats = fisherYates(vivantsSauf(pfBot.id));
        if (candidats.length < 3) return;
        roles.handlePetiteFilleChoice(commeJoueur(pfBot), candidats.slice(0, 3).map(pl => pl.id));
        scheduleBot(() => roles.handlePetiteFilleDone(commeJoueur(pfBot)));
      });
    }
  }

  // Corbeau : une fois sur deux, il passe son tour
  if (p === "corbeau") {
    const corbeauBot = robotAvecRole("Corbeau");
    if (corbeauBot) {
      scheduleBot(() => {
        roles.handleCorbeauAction(commeJoueur(corbeauBot), Math.random() < 0.5 ? "skip" : auHasard(alivePlayers()).id);
      });
    }
  }

  // Sorcière : 30 % sauver, 30 % empoisonner, sinon rien ; puis elle termine son tour
  if (p === "witch") {
    const witchBot = robotAvecRole("Sorcière");
    if (witchBot) {
      scheduleBot(() => {
        if (state.phase !== "witch") return;
        const sorciere = commeJoueur(witchBot), r = Math.random();
        if (r < 0.3 && !state.witchSaveUsed && state.nightTarget) roles.handleWitchSave(sorciere);
        else if (r < 0.6 && !state.witchKillUsed) {
          const cible = auHasard(vivantsSauf(witchBot.id).filter(pl => pl.id !== state.nightTarget));
          if (cible) roles.handleWitchKill(sorciere, cible.id);
        }
        roles.handleWitchDone(sorciere);
      });
    }
  }

  // Vote du Jour : un robot ne revote qu'en vote libre (mode 1) ; le reste (vote lancé par le
  // MJ, jour clos, vote verrouillé, sprint final) est vérifié comme pour un humain
  if (p === "day") {
    aliveBots.forEach(bot => {
      if (state.idiotRevealed && state.roles[bot.id] === "Idiot") return;
      scheduleBot(() => {
        if (state.votesDay[bot.id] && state.voteMode !== 1) return;
        const cible = auHasard(vivantsSauf(bot.id));
        if (cible) votes.handleVoteDay(commeJoueur(bot), cible.id);
      });
    });
  }

  // Chasseur (une fois l'action ouverte par le MJ, ou tout de suite en mode autonome)
  if (p === "chasseur" && state.currentChasseurShooter && !state.actionMJ) {
    const tireur = state.players.find(pl => pl.id === state.currentChasseurShooter);
    if (tireur && tireur.isBot) {
      scheduleBot(() => {
        const cible = roles.cibleAuHasard();
        if (cible && state.currentChasseurShooter === tireur.id) roles.handleChasseurAction(commeJoueur(tireur), cible.id);
      });
    }
  }

  // Transfert maire (même chose)
  if (p === "mayorTransfer" && state.dyingMayorId && !state.actionMJ) {
    const mourant = state.players.find(pl => pl.id === state.dyingMayorId);
    if (mourant && mourant.isBot) {
      scheduleBot(() => {
        const successeur = roles.successeurAuHasard();
        if (successeur) roles.handleMayorTransferChoice(commeJoueur(mourant), successeur.id);
      });
    }
  }

  // Mission — sélection équipe
  if (p === "mission" && mayorBot()) {
    scheduleBot(() => {
      if (state.phase !== "mission") return;
      const candidates = vivantsSauf(state.mayor);
      if (candidates.length >= 3) roles.envoyerEnMission(fisherYates(candidates).slice(0, 3).map(pl => pl.id));
    });
  }

  // Mission — carte secrète de chaque robot de l'équipe : un loup sabote 7 fois sur 10,
  // un villageois réussit 8 fois sur 10
  if (p === "missionVote") {
    aliveBots.filter(b => state.mission.team.includes(b.id)).forEach(bot => {
      scheduleBot(() => {
        if (state.phase !== "missionVote" || state.mission.cards[bot.id]) return;
        const card = state.roles[bot.id] === "Loup"
          ? (Math.random() < 0.7 ? "fail" : "success")
          : (Math.random() < 0.8 ? "success" : "fail");
        roles.jouerCarteMission(bot.id, card);
      });
    });
  }

  // Mission — bonus du maire (il ne s'inspecte pas lui-même)
  if (p === "missionBonus" && mayorBot()) {
    scheduleBot(() => {
      if (state.phase !== "missionBonus") return;
      const candidates = vivantsSauf(state.mayor);
      if (candidates.length >= 3) roles.inspecterBonus(fisherYates(candidates).slice(0, 3).map(pl => pl.id));
    });
  }
}

// Le maire actuel est-il un robot ?
function mayorBot() {
  const maire = state.mayor && state.players.find(pl => pl.id === state.mayor);
  return !!(maire && maire.isBot);
}

// ===== VICTOIRE =====
function checkVictory() {
  const alive          = alivePlayers();
  const aliveWolves    = alive.filter(p => state.roles[p.id] === "Loup");
  const aliveVillagers = alive.filter(p => state.roles[p.id] !== "Loup");
  // Les deux amoureux sont les derniers survivants (quel que soit leur camp)
  const amoureuxSeuls  = state.lovers.length === 2 && alive.length === 2 && alive.every(p => state.lovers.includes(p.id));
  // log uniquement quand on est sur le point de gagner (sinon trop verbeux)
  if (aliveWolves.length === 0 || aliveWolves.length >= aliveVillagers.length || amoureuxSeuls) {
    log.info('checkVictory', { alive: alive.length, wolves: aliveWolves.length, villagers: aliveVillagers.length });
  }

  // Résumé de fin : journal des morts, survivants, médailles et classement de la soirée.
  // Appelé une seule fois par partie (doEnd) : la partie n'est comptée qu'une fois au classement.
  const buildSummary = (winner) => ({
    winner,
    deathLog: state.gameStats.deathLog,
    survivors: alive.map(p => ({ name: p.name, role: state.roles[p.id] })),
    badges: badges.buildBadges({
      players: state.players,
      roles: state.roles,
      deadPlayers: state.deadPlayers,
      lovers: state.lovers,
      gameStats: state.gameStats,
      winner,
      idiotRevealed: state.idiotRevealed,
    }),
    classement: soiree.enregistrerPartie({ players: state.players, roles: state.roles, lovers: state.lovers, winner }),
  });

  const endGame = (winner, msg) => {
    const fullVision = visionComplete();
    const doEnd = () => {
      state.players.forEach(p => state.io.to(p.id).emit("deadVision", fullVision));
      state.io.emit("gameSummary", buildSummary(winner));
      versMJ("soireeMJ", soiree.resume());
      state.io.emit("gameEnd", msg);
      // La couleur du camp gagnant, comme sa musique et son écran de fin
      lights.flash({ wolves: "flash.victoire.loups", lovers: "flash.victoire.amoureux", ange: "flash.victoire.ange" }[winner] || "flash.victoire.village");
      setPhase("lobby");
    };
    // En pleine résolution de nuit, la fin de partie attend : doResolveNight la déclenche
    // après l'annonce de l'aube et le récap du MJ
    if (state.inNightResolution) {
      state.pendingEndGame = doEnd;
    } else {
      doEnd();
    }
  };

  // L'Ange désigné au premier vote du village gagne seul (votes.handleAngeVictoire)
  if (state.angeVainqueur) {
    endGame("ange", "👼 L'Ange a gagné ! Désigné dès le premier vote, il s'envole seul vers la victoire."); return true;
  }
  if (amoureuxSeuls) {
    endGame("lovers", "💘 Les Amoureux ont gagné ! Ils sont les derniers survivants."); return true;
  }
  if (aliveWolves.length === 0) {
    endGame("villagers", "🏆 Les Villageois ont gagné ! Tous les loups sont morts."); return true;
  }
  if (aliveWolves.length >= aliveVillagers.length) {
    endGame("wolves", "🐺 Les Loups ont gagné ! Ils dominent le village."); return true;
  }
  return false;
}

// ===== PAUSE / REPRISE =====
function pauseGame() {
  if (state.gamePaused) return;
  state.gamePaused = true;

  // Sauvegarde le temps restant du vote du jour, puis l'arrête
  if (state.voteTimer && state.voteTimerEnd) {
    state.pausedVoteRemainingMs = Math.max(0, state.voteTimerEnd - Date.now());
    clearTimeout(state.voteTimer); state.voteTimer = null;
  } else {
    state.pausedVoteRemainingMs = null;
  }

  // Une réponse de nuit déjà affichée (Voyante, Petite Fille) survit à la pause : le joueur
  // pourra confirmer après la reprise (clearPhaseTimeouts l'effaçait).
  const visionEnAttente = state.seerPendingResult, reponsePetiteFille = state.petiteFillePendingResult;
  clearPhaseTimeouts();
  state.seerPendingResult = visionEnAttente;
  state.petiteFillePendingResult = reponsePetiteFille;
  if (state.stuckGameTimer) { clearTimeout(state.stuckGameTimer); state.stuckGameTimer = null; }

  state.io.emit("gamePaused", { phase: state.phase, voteRemainingMs: state.pausedVoteRemainingMs });
  lights.applyScene("pause");
}

function resumeGame() {
  if (!state.gamePaused) return;
  state.gamePaused = false;

  if (state.phase === "day" && state.pausedVoteRemainingMs && state.pausedVoteRemainingMs > 200) {
    const ms = state.pausedVoteRemainingMs;
    state.voteTimerEnd = Date.now() + ms;
    state.voteTimer = setTimeout(() => { votes.resolveDayVote(); }, ms);
    state.io.emit("voteResumed", { endsAt: state.voteTimerEnd, durationMs: ms, serverNow: Date.now() });
  }
  state.pausedVoteRemainingMs = null;

  installPhaseTimeouts(state.phase);
  armerMinuteriesAutomatiques(state.phase);

  // Réponse de nuit en attente de « OK » : renvoyée au joueur (un « OK » tapé pendant la
  // pause a été ignoré, sa carte s'était fermée)
  const vivantAvecRole = r => vivantsAvecRole(r)[0];
  if (state.phase === "seer" && state.seerPendingResult && vivantAvecRole("Voyante")) {
    state.io.to(vivantAvecRole("Voyante")).emit("seerResult", state.seerPendingResult);
  }
  if (state.phase === "petiteFille" && state.petiteFillePendingResult && vivantAvecRole("PetiteFille")) {
    state.io.to(vivantAvecRole("PetiteFille")).emit("petiteFilleResult", state.petiteFillePendingResult);
  }

  if (PHASES_SURVEILLEES.includes(state.phase)) startStuckTimer();

  state.io.emit("gameResumed", { phase: state.phase });
  lights.applyScene(state.phase);
}

// ===== RESET =====
// Nouvelle partie : toutes les minuteries sont arrêtées, puis chaque champ de la partie reprend
// sa valeur neuve (state.partieNeuve). Les joueurs restent (keepPlayers) ou le salon est vidé.
function resetGameState(keepPlayers) {
  clearPhaseTimeouts();
  votes.clearVoteTimer();
  votes.oublierEgalite();
  council.clearCouncilEffects();
  clearTimeout(state.pendingEndGameTimer);
  Object.assign(state, partieNeuve());
  resetActivity();
  // Lumières : retour en scène lobby
  lights.reset();
  if (keepPlayers) {
    state.playerRegistry = Object.fromEntries(state.players.map(p => [p.name.toLowerCase(), entreeRegistre(p)]));
  } else {
    state.players = [];
    state.playerRegistry = {};
    state.botCounter = 0;
  }
}

// ===== HANDLERS SOCKETS =====
// Contrôles manuels d'urgence du MJ. Une étape de nuit démarre comme dans la nuit normale
// (messages du rôle compris) ; si elle n'a pas lieu (rôle mort, Sorcière sans potion), c'est
// l'étape suivante dans l'ordre de la nuit (roles.ETAPES_NUIT).
function handleSetPhase(socket, p) {
  if (!isMJ(socket.id)) return;
  const etape = roles.ETAPES_NUIT.find(([e]) => e === p);
  if (etape) roles.lancerEtapeNuit(etape[1]() ? p : roles.etapeApres(p));
  else setPhase(p);
}

function handlePauseGame(socket) {
  if (isMJ(socket.id)) pauseGame();
}

function handleResumeGame(socket) {
  if (isMJ(socket.id)) resumeGame();
}

// « Reset » du MJ : retour au salon avec les mêmes joueurs (garderJoueurs = false : salon vidé,
// pour les tests automatisés)
function handleReset(socket, garderJoueurs = true) {
  if (!isMJ(socket.id)) return;
  resetGameState(garderJoueurs);
  state.io.emit("gameReset", { players: state.players });
  setPhase("lobby");
  state.io.emit("players", state.players);
}

// « 🚀 Lancer la partie » et « Relancer » : tout est remis à zéro (sinon, lancée après une partie
// terminée, elle gardait les morts, les amoureux et le maire de la précédente), puis les rôles
// sont distribués
function handleLancerPartie(socket, config) {
  if (!isMJ(socket.id)) return;
  resetGameState(true);
  state.io.emit("gameReset", { players: state.players });
  roles.assignAndStart(config, state.players);
}


// IMPORTANT : on MUTE l'objet module.exports (pas de réassignation) pour ne pas
// invalider les références capturées par roles.js et votes.js pendant la phase
// de chargement circulaire (chacun a fait `const phases = require('./phases')`
// avant que ce fichier n'ait fini d'exécuter).
Object.assign(module.exports, {
  setPhase, ouvrirActionMJ, runBotsForPhase, scheduleBot, checkVictory,
  // Handlers
  handleSetPhase, handlePauseGame, handleResumeGame, handleReset, handleLancerPartie,
});
