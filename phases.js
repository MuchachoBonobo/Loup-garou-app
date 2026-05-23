// phases.js — Orchestration des phases : setPhase, timeouts, bots, victoire, pause, reset.
// Dépendances circulaires (roles, votes) résolues via require('./module').fn() à l'usage.

const {
  state, alivePlayers, playerName, fisherYates, computeCounts, isMJ, resetActivity,
  WITCH_TIMEOUT_MS, CUPID_TIMEOUT_MS, CORBEAU_TIMEOUT_MS, SEER_TIMEOUT_MS, SALVATEUR_TIMEOUT_MS,
  SISTERS_TIMEOUT_MS,
  CHASSEUR_TIMEOUT_MS, MAYOR_TRANSFER_TIMEOUT_MS,
  MISSION_TEAM_TIMEOUT_MS, MISSION_CARD_TIMEOUT_MS, MISSION_BONUS_TIMEOUT_MS,
  MAYOR_AUTO_TIMEOUT_MS, WOLVES_AUTO_TIMEOUT_MS,
  DAY_AUTO_START_DELAY_MS, STUCK_TIMEOUT_MS,
  BOT_MIN_DELAY_MS, BOT_MAX_DELAY_MS, FAST_RESOLVE_MS,
} = require('./state');

const lights    = require('./lights');
const narration = require('./narration');
const council   = require('./council');
const roles     = require('./roles');
const votes     = require('./votes');
const log       = require('./logger');
const badges    = require('./badges');

// ===== STUCK TIMER =====
function startStuckTimer() {
  resetActivity();
  function scheduleAlert() {
    state.stuckGameTimer = setTimeout(() => {
      if (state.mjSocketId && ['wolves','seer','witch','cupid'].includes(state.phase)) {
        state.io.to(state.mjSocketId).emit('stuckGame', {
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
    try { callback(); } catch (e) { console.error("[bot] action error:", e); }
  }, delay);
}

// ===== SETPHASE =====
function setPhase(p) {
  const previousPhase = state.phase;
  state.phase = p;
  log.info('setPhase', previousPhase, '->', p);
  state.io.emit("phase", state.phase);
  // Narration IA : annonce la transition (jouée sur le MJ via TTS)
  narration.narrate(previousPhase, p);

  if (p === "day") {
    state.gameStats.dayCount++;
    state.nightMusicPlayed = false;
    state.io.emit("gameCycle", { day: state.gameStats.dayCount, night: state.gameStats.nightCount });

    // === Carte narrative MJ ===
    if (state.mjSocketId && state.pendingDayRecap) {
      state.io.to(state.mjSocketId).emit("mjDayRecap", {
        dayNum: state.gameStats.dayCount,
        ...state.pendingDayRecap
      });
      state.pendingDayRecap = null;
    }

    // Réémet la cible corbeau dès le début du jour
    if (state.corbeauTarget && state.corbeauTarget !== "skip" && !state.deadPlayers.includes(state.corbeauTarget)) {
      state.io.emit("corbeauVotesPublic", { targetId: state.corbeauTarget, targetName: playerName(state.corbeauTarget) });
    }

    // ===== CONSEIL DES MORTS =====
    council.clearCouncilEffects();
    if (state.pendingCouncilEvent) {
      state.activeCouncilEvent = state.pendingCouncilEvent;
      state.pendingCouncilEvent = null;
      setTimeout(() => {
        if (state.phase === "day" && state.activeCouncilEvent) council.applyCouncilEvent(state.activeCouncilEvent);
      }, 3000);
    } else {
      state.activeCouncilEvent = null;
    }
    // Conseil des morts : se déclenche chaque début de journée dès qu'au moins
    // 2 joueurs sont morts. Un nouveau vote est proposé à chaque jour suivant.
    // Les événements déjà proposés (choisis ou non) ne réapparaissent pas.
    if (state.deadPlayers.length >= 2) {
      setTimeout(() => {
        if (state.phase === "day") council.startCouncil();
      }, 4000);
    }
  }
  // Quand on QUITTE le jour : on résout le conseil en cours
  if (previousPhase === "day" && p !== "day") {
    if (state.councilOptions) council.resolveCouncil();
    state.activeCouncilEvent = null;
    council.clearCouncilEffects();
    state.io.emit("councilEventEnd");
  }

  if (p === "mayorVote" && !state.gameStats.startTime) state.gameStats.startTime = Date.now();
  if (p === "wolves") {
    state.io.emit("gameCycle", { day: state.gameStats.dayCount, night: state.gameStats.nightCount });
    if (!state.skipWolvesSoundOnce) {
      if (state.mjSocketId) state.io.to(state.mjSocketId).emit("soundPlay", "wolves");
    }
    state.skipWolvesSoundOnce = false;
    // AMÉLIORATION 2 : reset des validations + émet un statut initial 0/N aux loups
    if (state.wolfConfirmed) state.wolfConfirmed.clear();
    const wolfIds = Object.keys(state.roles).filter(wid => state.roles[wid] === "Loup" && !state.deadPlayers.includes(wid));
    wolfIds.forEach(wid => state.io.to(wid).emit("wolfConfirmStatus", { confirmed: [], total: wolfIds.length }));
  }

  // Nettoie tous les timeouts de phase
  clearPhaseTimeouts();
  installPhaseTimeouts(p);

  if (['wolves','seer','corbeau','witch','cupid'].includes(p)) {
    startStuckTimer();
  } else {
    resetActivity();
    if (state.stuckGameTimer) { clearTimeout(state.stuckGameTimer); state.stuckGameTimer = null; }
  }

  // ===== MODE AUTONOME =====
  if (state.autoMode) {
    if (p === "mayorVote") {
      state.mayorAutoLockTimer = setTimeout(() => {
        if (state.phase === "mayorVote") {
          state.io.emit("autoResolve", "⏱ Délai dépassé — élection avec les votes en cours.");
          votes.performLockMayorVote();
        }
      }, MAYOR_AUTO_TIMEOUT_MS);
    }
    if (p === "wolves") {
      state.wolvesAutoLockTimer = setTimeout(() => {
        if (state.phase === "wolves") {
          state.io.emit("autoResolve", "⏱ Loups indécis — résolution par majorité.");
          votes.performLockWolfVotes();
        }
      }, WOLVES_AUTO_TIMEOUT_MS);
    }
  }

  // Jour : auto-démarre le vote dès que la phase de jour commence.
  // Refonte épuration jour (mai 2026) : si `state.mjPilotedDay` est vrai, on saute
  // l'auto-démarrage — c'est le MJ qui lance le vote manuellement via le bouton
  // « Lancer le vote » (handler `handleStartVote` dans votes.js). Le mode autonome
  // continue de fonctionner comme avant (auto-vote) car il vise une partie sans MJ.
  if (p === "day" && (state.autoMode || !state.mjPilotedDay)) {
    state.dayAutoStartTimer = setTimeout(() => {
      if (state.phase === "day" && state.voteTimer == null) {
        votes.startDayVote(state.autoMode ? state.autoVoteMode : 1);
      }
    }, DAY_AUTO_START_DELAY_MS);
  }

  // Mode entraînement : déclenche les actions automatiques des bots
  runBotsForPhase(p);

  // === Lumières connectées ===
  try { lights.applyScene(p); } catch (_) {}
}

// ===== INSTALLATION DES TIMEOUTS PAR PHASE =====
// ┌──────────────────────────────────────────────────────────────────────────────┐
// │ ⚠ ZONE NUIT — NE PAS TOUCHER DANS LE CADRE DE LA REFONTE JOUR (mai 2026)    │
// │ Les timeouts witch/corbeau/cupid/salvateur/sisters/chasseur/mayorTransfer    │
// │ sont volontairement gelés. Seuls les blocs jour (mission*/day) peuvent être  │
// │ touchés par la refonte d'épuration de la phase jour.                          │
// └──────────────────────────────────────────────────────────────────────────────┘
function installPhaseTimeouts(p) {
  if (p === "witch") {
    state.witchTimeout = setTimeout(() => {
      if (state.phase === "witch") {
        state.io.emit("autoResolve", "⏱ La Sorcière a trop tardé — passage automatique à l'aube.");
        roles.doResolveNight();
      }
    }, WITCH_TIMEOUT_MS);
  }

  if (p === "seer") {
    state.seerTimeout = setTimeout(() => {
      if (state.phase !== "seer") return;
      state.io.emit("autoResolve", "⏱ La Voyante a tardé — passage automatique.");
      const next = roles.nextNightPhase("seer");
      if (next === "corbeau") {
        const corbeauId = Object.keys(state.roles).find(id => state.roles[id] === "Corbeau" && !state.deadPlayers.includes(id));
        if (corbeauId) state.io.to(corbeauId).emit("corbeauTurn");
        setPhase("corbeau");
      } else if (next === "witch") {
        const witchId = Object.keys(state.roles).find(id => state.roles[id] === "Sorcière" && !state.deadPlayers.includes(id));
        if (witchId) state.io.to(witchId).emit("nightVictim", state.nightTarget);
        setPhase("witch");
      } else { roles.doResolveNight(); }
    }, SEER_TIMEOUT_MS);
  }

  if (p === "corbeau") {
    state.corbeauTimeout = setTimeout(() => {
      if (state.phase === "corbeau") {
        state.io.emit("autoResolve", "⏱ Le Corbeau a tardé — passage automatique.");
        state.corbeauTarget = "skip";
        const next = roles.nextNightPhase("corbeau");
        if (next === "witch") {
          const witchId = Object.keys(state.roles).find(id => state.roles[id] === "Sorcière" && !state.deadPlayers.includes(id));
          if (witchId) state.io.to(witchId).emit("nightVictim", state.nightTarget);
          setPhase("witch");
        } else { roles.doResolveNight(); }
      }
    }, CORBEAU_TIMEOUT_MS);
  }

  if (p === "cupid") {
    state.cupidTimeout = setTimeout(() => {
      if (state.phase === "cupid") {
        state.io.emit("autoResolve", "⏱ Cupidon n'a pas choisi — passage automatique à la nuit.");
        roles.startNightSequence();
      }
    }, CUPID_TIMEOUT_MS);
  }

  if (p === "salvateur") {
    state.salvateurTimeout = setTimeout(() => {
      if (state.phase === "salvateur") {
        state.io.emit("autoResolve", "⏱ Le Salvateur a tardé — la nuit avance sans protection.");
        state.protectedTarget = null;
        setPhase("wolves");
      }
    }, SALVATEUR_TIMEOUT_MS);
  }

  // Sœurs jumelles : le timer 20s N'EST PAS auto-démarré à l'entrée en phase.
  // C'est le MJ qui le lance via `mjStartSistersTimer` (carte narrative + bouton)
  // quand il voit que tout le monde dort et que les sœurs ont ouvert les yeux.
  // On installe juste un fail-safe de 5 min au cas où le MJ se déconnecterait.
  if (p === "sisters") {
    state.sistersTimeout = setTimeout(() => {
      if (state.phase === "sisters") {
        state.io.emit("autoResolve", "⏱ Phase Sœurs bloquée depuis 5 min — passage automatique.");
        roles.startNightAfterSisters();
      }
    }, 5 * 60 * 1000);
  }

  if (p === "mission") {
    state.mission.teamTimeout = setTimeout(() => {
      if (state.phase === "mission") {
        state.io.emit("autoResolve", "⏱ Le Maire n'a pas sélectionné son équipe — mission annulée.");
        state.mission.active = false;
        setPhase("cupid");
      }
    }, MISSION_TEAM_TIMEOUT_MS);
  }

  if (p === "missionVote") {
    state.mission.cardTimeout = setTimeout(() => {
      if (state.phase === "missionVote") {
        state.mission.team.forEach(id => {
          if (!state.mission.cards[id]) state.mission.cards[id] = "success";
        });
        state.io.emit("autoResolve", "⏱ Temps écoulé — cartes manquantes comptées comme Réussite.");
        roles.resolveMissionCards();
      }
    }, MISSION_CARD_TIMEOUT_MS);
  }

  if (p === "missionBonus") {
    state.mission.bonusTimeout = setTimeout(() => {
      if (state.phase === "missionBonus") {
        state.io.emit("autoResolve", "⏱ Le Maire n'a pas utilisé son bonus — passage au jour.");
        state.mission.bonusDone = true;
        setPhase("day");
      }
    }, MISSION_BONUS_TIMEOUT_MS);
  }

  // Chasseur : tir aléatoire si inactif
  if (p === "chasseur") {
    state.chasseurTimeout = setTimeout(() => {
      if (state.phase !== "chasseur" || !state.currentChasseurShooter) return;
      const shooterId = state.currentChasseurShooter;
      const aliveTargets = alivePlayers().filter(pl => pl.id !== shooterId);
      if (aliveTargets.length > 0) {
        const target = aliveTargets[Math.floor(Math.random() * aliveTargets.length)];
        state.io.emit("autoResolve", `⏱ Le Chasseur a tardé — tir aléatoire sur ${target.name}.`);
        roles.performChasseurShot(shooterId, target.id);
      } else {
        state.currentChasseurShooter = null;
        const postCtx = state.chasseurPostContext;
        state.chasseurPostContext = null;
        if (checkVictory()) return;
        if (state.mayorTransferPending && state.dyingMayorId) setPhase("mayorTransfer");
        // BUG FIX : startNightSequence pour Sœurs/Salvateur
        else if (postCtx === "day") roles.startNightSequence();
        else setPhase("day");
      }
    }, CHASSEUR_TIMEOUT_MS);
  }

  // Transfert maire : successeur aléatoire si inactif
  if (p === "mayorTransfer") {
    state.mayorTransferTimeout = setTimeout(() => {
      if (state.phase !== "mayorTransfer" || !state.dyingMayorId) return;
      const validTargets = state.players.filter(pl =>
        !state.deadPlayers.includes(pl.id) && pl.id !== state.dyingMayorId);
      if (validTargets.length > 0) {
        const target = validTargets[Math.floor(Math.random() * validTargets.length)];
        state.io.emit("autoResolve", `⏱ Maire mourant inactif — successeur aléatoire : ${target.name}.`);
        roles.performMayorTransfer(target.id);
      } else {
        state.io.emit("autoResolve", `⏱ Aucun successeur disponible — transfert annulé.`);
        state.mayorTransferPending = false;
        state.dyingMayorId = null;
        state.mayorTransferContext = "";
        state.dyingMayorWasChasseur = false;
        if (!checkVictory()) setPhase("day");
      }
    }, MAYOR_TRANSFER_TIMEOUT_MS);
  }
}

function clearPhaseTimeouts() {
  clearTimeout(state.seerTimeout);          state.seerTimeout          = null;
  clearTimeout(state.witchTimeout);         state.witchTimeout         = null;
  clearTimeout(state.cupidTimeout);         state.cupidTimeout         = null;
  clearTimeout(state.salvateurTimeout);     state.salvateurTimeout     = null;
  clearTimeout(state.sistersTimeout);       state.sistersTimeout       = null;
  state.sistersTimerEnd = null;
  clearTimeout(state.corbeauTimeout);       state.corbeauTimeout       = null;
  clearTimeout(state.chasseurTimeout);      state.chasseurTimeout      = null;
  clearTimeout(state.mayorTransferTimeout); state.mayorTransferTimeout = null;
  roles.clearMissionTimeouts();
  // Mode autonome
  if (state.mayorAutoLockTimer)  { clearTimeout(state.mayorAutoLockTimer);  state.mayorAutoLockTimer  = null; }
  if (state.wolfConsensusTimer)  { clearTimeout(state.wolfConsensusTimer);  state.wolfConsensusTimer  = null; }
  if (state.wolvesAutoLockTimer) { clearTimeout(state.wolvesAutoLockTimer); state.wolvesAutoLockTimer = null; }
  if (state.dayAutoStartTimer)   { clearTimeout(state.dayAutoStartTimer);   state.dayAutoStartTimer   = null; }
}

// ===== ACTIONS DES BOTS PAR PHASE =====
// ┌──────────────────────────────────────────────────────────────────────────────┐
// │ ⚠ ZONE NUIT — les blocs mayorVote/cupid/wolves/salvateur/seer/corbeau/witch  │
// │ /chasseur/mayorTransfer/mission*/missionVote/missionBonus sont gelés dans   │
// │ le cadre de la refonte jour. Seul le bloc `if (p === "day")` est concerné.   │
// └──────────────────────────────────────────────────────────────────────────────┘
function runBotsForPhase(p) {
  const aliveBots = state.players.filter(pl => pl.isBot && !state.deadPlayers.includes(pl.id));
  if (aliveBots.length === 0) return;

  // Vote du Maire
  if (p === "mayorVote") {
    aliveBots.forEach(bot => {
      scheduleBot(() => {
        if (state.phase !== "mayorVote" || state.deadPlayers.includes(bot.id)) return;
        if (state.mayorVote[bot.id]) return;
        const targets = alivePlayers().filter(pl => pl.id !== bot.id);
        if (targets.length === 0) return;
        const target = targets[Math.floor(Math.random() * targets.length)];
        state.mayorVote[bot.id] = target.id;
        state.io.emit("mayorVotesMJ", state.mayorVote);
        state.io.emit("mayorCountsPublic", computeCounts(state.mayorVote));
        state.io.emit("mayorVoted", bot.id);
        votes.checkMayorAutoLock();
      });
    });
  }

  // Cupidon
  if (p === "cupid") {
    const cupidBot = aliveBots.find(bot => state.roles[bot.id] === "Cupidon");
    if (cupidBot && !state.cupidDone) {
      scheduleBot(() => {
        if (state.phase !== "cupid" || state.cupidDone) return;
        const candidates = alivePlayers();
        if (candidates.length < 2) return;
        const shuffled = fisherYates(candidates);
        const choice = [shuffled[0].id, shuffled[1].id];
        clearTimeout(state.cupidTimeout); state.cupidTimeout = null;
        state.lovers = choice;
        state.cupidDone = true;
        [...new Set([cupidBot.id, ...state.lovers])].forEach(id => state.io.to(id).emit("loversInfo", state.lovers));
        if (state.mjSocketId) state.io.to(state.mjSocketId).emit("loversInfo", state.lovers);
        if (state.mjSocketId) {
          state.io.to(state.mjSocketId).emit("soundPlay", "cupid");
          state.skipWolvesSoundOnce = true;
          // Idem handleCupidChoice : on ne joue le son loups différé que si la
          // phase est bien wolves à 4s (pas sisters/salvateur en cours).
          setTimeout(() => {
            if (state.mjSocketId && state.phase === "wolves") {
              state.io.to(state.mjSocketId).emit("soundPlay", "wolves");
            }
            state.skipWolvesSoundOnce = false;
          }, 4000);
        }
        roles.startNightSequence();
      });
    }
  }

  // Loups
  if (p === "wolves") {
    aliveBots.filter(b => state.roles[b.id] === "Loup").forEach(bot => {
      scheduleBot(() => {
        if (state.phase !== "wolves") return;
        if (state.votesWolf[bot.id]) return;
        const targets = alivePlayers().filter(pl => state.roles[pl.id] !== "Loup" && pl.id !== bot.id);
        if (targets.length === 0) return;
        const target = targets[Math.floor(Math.random() * targets.length)];
        state.votesWolf[bot.id] = target.id;
        state.io.emit("wolfVotesMJ", state.votesWolf);
        const wolfIds = Object.keys(state.roles).filter(wid => state.roles[wid] === "Loup" && !state.deadPlayers.includes(wid));
        wolfIds.forEach(wid => state.io.to(wid).emit("wolfVotesUpdate", state.votesWolf));
        state.deadPlayers.forEach(did => state.io.to(did).emit("wolfVotesUpdate", state.votesWolf));
        votes.checkWolfConsensus();
      });
    });
  }

  // Salvateur
  if (p === "salvateur") {
    const salvateurBot = aliveBots.find(b => state.roles[b.id] === "Salvateur");
    if (salvateurBot) {
      scheduleBot(() => {
        if (state.phase !== "salvateur") return;
        const candidates = alivePlayers().filter(pl => pl.id !== state.lastProtectedTarget);
        if (candidates.length === 0) return;
        const target = candidates[Math.floor(Math.random() * candidates.length)];
        if (state.salvateurTimeout) { clearTimeout(state.salvateurTimeout); state.salvateurTimeout = null; }
        state.protectedTarget = target.id;
        state.io.to(salvateurBot.id).emit("salvateurConfirm", { targetId: target.id, targetName: playerName(target.id) });
        if (state.mjSocketId) state.io.to(state.mjSocketId).emit("soundPlay", "shield");
        setPhase("wolves");
      });
    }
  }

  // Voyante
  if (p === "seer") {
    const seerBot = aliveBots.find(b => state.roles[b.id] === "Voyante");
    if (seerBot) {
      scheduleBot(() => {
        if (state.phase !== "seer") return;
        const targets = alivePlayers().filter(pl => pl.id !== seerBot.id);
        if (targets.length === 0) return;
        const target = targets[Math.floor(Math.random() * targets.length)];
        clearTimeout(state.seerTimeout); state.seerTimeout = null;
        state.io.to(seerBot.id).emit("seerResult", { role: state.roles[target.id], name: playerName(target.id) });
        state.gameStats.seerLog.push({ name: playerName(target.id), role: state.roles[target.id] });
        if (state.mjSocketId) state.io.to(state.mjSocketId).emit("soundPlay", "seer");
        const next = roles.nextNightPhase("seer");
        if (next === "corbeau") {
          const corbeauId = Object.keys(state.roles).find(id => state.roles[id] === "Corbeau" && !state.deadPlayers.includes(id));
          if (corbeauId) state.io.to(corbeauId).emit("corbeauTurn");
          setPhase("corbeau");
        } else if (next === "witch") {
          const witchId = Object.keys(state.roles).find(wid => state.roles[wid] === "Sorcière" && !state.deadPlayers.includes(wid));
          if (witchId) state.io.to(witchId).emit("nightVictim", state.nightTarget);
          setPhase("witch");
        } else { roles.doResolveNight(); }
      });
    }
  }

  // Corbeau
  if (p === "corbeau") {
    const corbeauBot = aliveBots.find(b => state.roles[b.id] === "Corbeau");
    if (corbeauBot) {
      scheduleBot(() => {
        if (state.phase !== "corbeau") return;
        clearTimeout(state.corbeauTimeout); state.corbeauTimeout = null;
        const willSkip = Math.random() < 0.5;
        if (willSkip) {
          state.corbeauTarget = "skip";
          if (state.mjSocketId) state.io.to(state.mjSocketId).emit("corbeauMJInfo", { name: null, id: null });
        } else {
          const targets = alivePlayers();
          const target = targets[Math.floor(Math.random() * targets.length)];
          state.corbeauTarget = target.id;
          state.io.emit("corbeauVotesPublic", { targetId: state.corbeauTarget, targetName: playerName(state.corbeauTarget) });
          if (state.mjSocketId) state.io.to(state.mjSocketId).emit("corbeauMJInfo", { name: playerName(state.corbeauTarget), id: state.corbeauTarget });
        }
        if (state.mjSocketId) state.io.to(state.mjSocketId).emit("soundPlay", "crow");
        const next = roles.nextNightPhase("corbeau");
        if (next === "witch") {
          const witchId = Object.keys(state.roles).find(id => state.roles[id] === "Sorcière" && !state.deadPlayers.includes(id));
          if (witchId) state.io.to(witchId).emit("nightVictim", state.nightTarget);
          setPhase("witch");
        } else { roles.doResolveNight(); }
      });
    }
  }

  // Sorcière
  if (p === "witch") {
    const witchBot = aliveBots.find(b => state.roles[b.id] === "Sorcière");
    if (witchBot) {
      scheduleBot(() => {
        if (state.phase !== "witch") return;
        const r = Math.random();
        // 30% sauver
        if (r < 0.3 && !state.witchSaveUsed && state.nightTarget) {
          state.witchSaveUsed = true;
          state.witchSaveActive = true;
          state.io.to(witchBot.id).emit("witchSaveConfirm");
          if (state.mjSocketId) state.io.to(state.mjSocketId).emit("soundPlay", "witch");
        }
        // 30-60% tuer
        else if (r < 0.6 && !state.witchKillUsed) {
          const targets = alivePlayers().filter(pl =>
            pl.id !== witchBot.id && pl.id !== state.nightTarget);
          if (targets.length > 0) {
            const target = targets[Math.floor(Math.random() * targets.length)];
            state.witchKillUsed = true;
            state.witchKillTarget = target.id;
            state.io.to(witchBot.id).emit("witchKillConfirm");
            if (state.mjSocketId) state.io.to(state.mjSocketId).emit("soundPlay", "witch");
          }
        }
        clearTimeout(state.witchTimeout); state.witchTimeout = null;
        roles.doResolveNight();
      });
    }
  }

  // Vote du Jour
  if (p === "day") {
    aliveBots.forEach(bot => {
      if (state.idiotRevealed && state.roles[bot.id] === "Idiot") return;
      scheduleBot(() => {
        if (state.phase !== "day" || state.deadPlayers.includes(bot.id)) return;
        if (state.votesDay[bot.id] && state.voteMode !== 1) return;
        if (state.voteMode === 2 && state.lockedVoters.has(bot.id)) return;
        const targets = alivePlayers().filter(pl => pl.id !== bot.id);
        if (targets.length === 0) return;
        const target = targets[Math.floor(Math.random() * targets.length)];
        state.votesDay[bot.id] = target.id;
        if (state.voteMode === 2) state.lockedVoters.add(bot.id);
        state.io.emit("votesDayMJ", state.votesDay);
        if (state.voteMode === 5) {
          state.io.to(bot.id).emit("hasVotedConfirm", { targetName: playerName(target.id) });
        } else {
          state.io.emit("dayCountsPublic", computeCounts(state.votesDay));
          const publicDetail = {};
          Object.entries(state.votesDay).forEach(([voter, t]) => {
            if (!voter.startsWith("__corbeau")) publicDetail[voter] = t;
          });
          state.io.emit("votesDayPublic", publicDetail);
        }
        // Sprint final 30s quand tous ont voté.
        // Refonte épuration jour (mai 2026) : désactivé en mode piloté MJ (cf. votes.js).
        if (state.voteMode === 1 && !state.fastResolveTriggered && !state.mjPilotedDay) {
          const alive = alivePlayers();
          const allVoted = alive.every(pl => state.votesDay[pl.id] !== undefined);
          if (allVoted && state.voteTimer) {
            const remainingMs = state.voteTimerEnd ? Math.max(0, state.voteTimerEnd - Date.now()) : Infinity;
            if (remainingMs > FAST_RESOLVE_MS) {
              state.fastResolveTriggered = true;
              votes.clearVoteTimer();
              state.voteTimerEnd = Date.now() + FAST_RESOLVE_MS;
              state.voteTimer = setTimeout(() => { votes.resolveDayVote(); }, FAST_RESOLVE_MS);
              state.io.emit("autoResolve", "✅ Tout le village a voté — vote rapide 30s !");
              state.io.emit("voteResumed", { endsAt: state.voteTimerEnd, durationMs: FAST_RESOLVE_MS, serverNow: Date.now() });
              if (state.mjSocketId) state.io.to(state.mjSocketId).emit("voteStartedMJ", { mode: state.voteMode, duration: FAST_RESOLVE_MS, endsAt: state.voteTimerEnd, serverNow: Date.now() });
            }
          }
        }
      });
    });
  }

  // Chasseur
  if (p === "chasseur") {
    if (state.currentChasseurShooter) {
      const shooter = state.players.find(pl => pl.id === state.currentChasseurShooter);
      if (shooter && shooter.isBot) {
        scheduleBot(() => {
          if (state.phase !== "chasseur" || state.currentChasseurShooter !== shooter.id) return;
          const targets = alivePlayers().filter(pl => pl.id !== shooter.id);
          if (targets.length === 0) return;
          const target = targets[Math.floor(Math.random() * targets.length)];
          roles.performChasseurShot(shooter.id, target.id);
        });
      }
    }
  }

  // Transfert maire
  if (p === "mayorTransfer") {
    if (state.dyingMayorId) {
      const dyingPlayer = state.players.find(pl => pl.id === state.dyingMayorId);
      if (dyingPlayer && dyingPlayer.isBot) {
        scheduleBot(() => {
          if (state.phase !== "mayorTransfer" || state.dyingMayorId !== dyingPlayer.id) return;
          const candidates = state.players.filter(pl => !state.deadPlayers.includes(pl.id) && pl.id !== state.dyingMayorId);
          if (candidates.length === 0) return;
          const target = candidates[Math.floor(Math.random() * candidates.length)];
          roles.performMayorTransfer(target.id);
        });
      }
    }
  }

  // Mission — sélection équipe
  if (p === "mission") {
    if (state.mayor) {
      const mayorPlayer = state.players.find(pl => pl.id === state.mayor);
      if (mayorPlayer && mayorPlayer.isBot) {
        scheduleBot(() => {
          if (state.phase !== "mission") return;
          const candidates = alivePlayers().filter(pl => pl.id !== state.mayor);
          if (candidates.length < 3) return;
          const shuffled = fisherYates(candidates);
          const teamIds = [shuffled[0].id, shuffled[1].id, shuffled[2].id];
          roles.clearMissionTimeouts();
          state.mission.team = teamIds;
          state.io.emit("missionTeamSelected", {
            team: teamIds.map(id => ({ id, name: playerName(id) })),
            mayorName: playerName(state.mayor)
          });
          teamIds.forEach(id => {
            state.io.to(id).emit("missionCardChoice", {
              mayorName: playerName(state.mayor),
              teamNames: teamIds.map(tid => playerName(tid))
            });
          });
          if (state.mjSocketId) state.io.to(state.mjSocketId).emit("missionMJInfo", {
            step: "cardVote",
            team: teamIds.map(id => ({ id, name: playerName(id) }))
          });
          setPhase("missionVote");
        });
      }
    }
  }

  // Mission — vote secret de chaque bot dans l'équipe
  if (p === "missionVote") {
    aliveBots.filter(b => state.mission.team.includes(b.id)).forEach(bot => {
      scheduleBot(() => {
        if (state.phase !== "missionVote") return;
        if (state.mission.cards[bot.id]) return;
        const isWolf = state.roles[bot.id] === "Loup";
        const card = isWolf
          ? (Math.random() < 0.7 ? "fail" : "success")
          : (Math.random() < 0.8 ? "success" : "fail");
        state.mission.cards[bot.id] = card;
        state.io.to(bot.id).emit("missionCardConfirm", { card });
        if (state.mjSocketId) {
          state.io.to(state.mjSocketId).emit("missionMJInfo", {
            step: "cardReceived",
            received: Object.keys(state.mission.cards).length,
            total: state.mission.team.length
          });
        }
        state.io.emit("missionCardPlayed", {
          count: Object.keys(state.mission.cards).length,
          total: state.mission.team.length
        });
        if (Object.keys(state.mission.cards).length === state.mission.team.length) {
          roles.resolveMissionCards();
        }
      });
    });
  }

  // Mission — bonus du maire
  if (p === "missionBonus") {
    if (state.mayor) {
      const mayorPlayer = state.players.find(pl => pl.id === state.mayor);
      if (mayorPlayer && mayorPlayer.isBot) {
        scheduleBot(() => {
          if (state.phase !== "missionBonus") return;
          // Le maire ne peut pas s'inspecter lui-même
          const candidates = alivePlayers().filter(pl => pl.id !== state.mayor);
          if (candidates.length < 3) return;
          const shuffled = fisherYates(candidates);
          const teamIds = [shuffled[0].id, shuffled[1].id, shuffled[2].id];
          roles.clearMissionTimeouts();
          state.mission.bonusDone = true;
          const hasWolf = teamIds.some(id => state.roles[id] === "Loup");
          state.io.to(state.mayor).emit("missionBonusResult", {
            team: teamIds.map(id => ({ id, name: playerName(id) })),
            hasWolf
          });
          if (state.mjSocketId) {
            state.io.to(state.mjSocketId).emit("missionMJBonusResult", {
              team: teamIds.map(id => ({ id, name: playerName(id) })),
              hasWolf,
              wolves: teamIds.filter(id => state.roles[id] === "Loup").map(id => playerName(id))
            });
          }
          state.io.emit("missionBonusUsed", {
            mayorName: playerName(state.mayor),
            team: teamIds.map(id => ({ id, name: playerName(id) }))
          });
          setPhase("day");
        });
      }
    }
  }
}

// ===== VICTOIRE =====
function checkVictory() {
  const alive          = alivePlayers();
  const aliveWolves    = alive.filter(p => state.roles[p.id] === "Loup");
  const aliveVillagers = alive.filter(p => state.roles[p.id] !== "Loup");
  // log uniquement quand on est sur le point de gagner (sinon trop verbeux)
  if (aliveWolves.length === 0 || aliveWolves.length >= aliveVillagers.length || (state.lovers.length === 2 && alive.length === 2)) {
    log.info('checkVictory', { alive: alive.length, wolves: aliveWolves.length, villagers: aliveVillagers.length });
  }

  const buildSummary = (winner) => ({
    winner,
    dayCount: state.gameStats.dayCount,
    nightCount: state.gameStats.nightCount,
    firstDead: state.gameStats.firstDead,
    mayorName: state.gameStats.mayorName,
    witchSaved: state.gameStats.witchSaved,
    witchKilled: state.gameStats.witchKilled,
    deathLog: state.gameStats.deathLog,
    seerLog: state.gameStats.seerLog,
    durationMs: state.gameStats.startTime ? Date.now() - state.gameStats.startTime : null,
    survivors: alive.map(p => ({ name: p.name, role: state.roles[p.id] })),
    totalPlayers: state.players.length,
    // Médailles ludiques distribuées aux joueurs (par nom)
    badges: badges.buildBadges({
      players: state.players,
      roles: state.roles,
      deadPlayers: state.deadPlayers,
      lovers: state.lovers,
      gameStats: state.gameStats,
      winner,
      idiotRevealed: state.idiotRevealed,  // BUG FIX 8
    }),
  });

  const endGame = (winner, msg) => {
    const fullVision = {
      roles: state.roles,
      wolves: Object.keys(state.roles).filter(id => state.roles[id] === "Loup"),
      lovers: state.lovers,
      mayor: state.mayor,
      votesDay: state.votesDay,
      votesWolf: state.votesWolf,
      mayorVote: state.mayorVote,
    };
    const doEnd = () => {
      state.players.forEach(p => state.io.to(p.id).emit("deadVision", fullVision));
      state.io.emit("gameSummary", buildSummary(winner));
      state.io.emit("gameEnd", msg);
      try { lights.flash("flash.victory"); } catch (_) {}
      setPhase("lobby");
    };
    // BUG 5 : si on est au milieu d'une résolution de nuit, on diffère l'émission
    // de fin de partie. doResolveNight déclenchera la fonction après avoir émis
    // dawnResult et mjDayRecap (carte chronique de nuit + récap MJ).
    if (state.inNightResolution) {
      state.pendingEndGame = doEnd;
    } else {
      doEnd();
    }
  };

  if (aliveWolves.length === 0) {
    if (state.lovers.length === 2 && alive.length === 2 && alive.every(p => state.lovers.includes(p.id))) {
      endGame("lovers", "💘 Les Amoureux ont gagné ! Ils sont les derniers survivants."); return true;
    }
    endGame("villagers", "🏆 Les Villageois ont gagné ! Tous les loups sont morts."); return true;
  }
  if (state.lovers.length === 2 && alive.length === 2 && alive.every(p => state.lovers.includes(p.id))) {
    endGame("lovers", "💘 Les Amoureux ont gagné !"); return true;
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

  clearPhaseTimeouts();
  if (state.stuckGameTimer) { clearTimeout(state.stuckGameTimer); state.stuckGameTimer = null; }

  state.io.emit("gamePaused", { phase: state.phase, voteRemainingMs: state.pausedVoteRemainingMs });
  try { lights.applyScene("pause"); } catch (_) {}
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

  if (['wolves','seer','corbeau','witch','cupid'].includes(state.phase)) {
    startStuckTimer();
  }

  state.io.emit("gameResumed", { phase: state.phase });
  try { lights.applyScene(state.phase); } catch (_) {}
}

// ===== RESET =====
function resetGameState(keepPlayers) {
  state.roles = {};
  state.deadPlayers = [];
  state.lovers = [];
  state.mayor = null;
  state.votesDay = {};
  state.votesWolf = {};
  state.mayorVote = {};
  if (state.wolfConfirmed) state.wolfConfirmed.clear();
  state.cupidDone = false;
  state.witchSaveUsed = false;
  state.witchKillUsed = false;
  state.witchSaveActive = false;
  state.witchKillTarget = null;
  state.nightTarget = null;
  state.idiotRevealed = false;
  state.nightMusicPlayed = false;
  state.corbeauTarget = null;
  votes.clearVoteTimer();
  state.lockedVoters.clear();
  state.voteMode = 1;
  state.dayResolutionPending = false;
  state.fastResolveTriggered = false;
  state.lastDayVoteDeath = null;
  state.pendingDayRecap = null;
  state.inNightResolution = false;
  state.pendingEndGame = null;
  // Salvateur
  state.protectedTarget = null;
  state.lastProtectedTarget = null;
  if (state.salvateurTimeout) { clearTimeout(state.salvateurTimeout); state.salvateurTimeout = null; }
  // Sœurs jumelles
  if (state.sistersTimeout)   { clearTimeout(state.sistersTimeout);   state.sistersTimeout   = null; }
  state.sistersTimerEnd = null;
  // Lumières : retour en scène lobby
  try { lights.reset(); } catch (_) {}
  clearTimeout(state.seerTimeout); state.seerTimeout = null;
  clearTimeout(state.witchTimeout); state.witchTimeout = null;
  clearTimeout(state.cupidTimeout); state.cupidTimeout = null;
  clearTimeout(state.corbeauTimeout); state.corbeauTimeout = null;
  clearTimeout(state.chasseurTimeout); state.chasseurTimeout = null;
  clearTimeout(state.mayorTransferTimeout); state.mayorTransferTimeout = null;
  state.currentChasseurShooter = null;
  // Pause
  state.gamePaused = false;
  state.pausedVoteRemainingMs = null;
  // Reset du compteur de bots si on vide les joueurs
  if (!keepPlayers) state.botCounter = 0;
  // Mode autonome
  state.autoMode = false;
  state.autoVoteMode = 1;
  // Conseil des morts
  state.councilOptions = null;
  state.councilVotes = {};
  state.pendingCouncilEvent = null;
  state.activeCouncilEvent = null;
  state.councilUsedEvents = [];
  state.silentDayChatHistory = [];
  council.clearCouncilEffects();
  if (state.mayorAutoLockTimer)  { clearTimeout(state.mayorAutoLockTimer);  state.mayorAutoLockTimer  = null; }
  if (state.wolfConsensusTimer)  { clearTimeout(state.wolfConsensusTimer);  state.wolfConsensusTimer  = null; }
  if (state.wolvesAutoLockTimer) { clearTimeout(state.wolvesAutoLockTimer); state.wolvesAutoLockTimer = null; }
  if (state.dayAutoStartTimer)   { clearTimeout(state.dayAutoStartTimer);   state.dayAutoStartTimer   = null; }
  votes.clearTiebreakTimeout();
  state.mayorTransferPending = false;
  state.dyingMayorId = null;
  state.mayorTransferContext = "";
  state.dyingMayorWasChasseur = false;
  state.chasseurPostContext = null;
  state.pendingChasseurAfterTransfer = null;
  state.skipWolvesSoundOnce = false;
  state.deadChatHistory = [];
  state.voteRateLimit.clear();
  resetActivity();
  if (state.stuckGameTimer) { clearTimeout(state.stuckGameTimer); state.stuckGameTimer = null; }
  roles.resetMissionState();
  state.gameStats = {
    dayCount: 0, nightCount: 0,
    firstDead: null, mayorName: null,
    witchSaved: false, witchKilled: false,
    deathLog: [], survivors: [], seerLog: [],
    startTime: null
  };

  if (keepPlayers) {
    const survivingRegistry = {};
    state.players.forEach(p => {
      const key = p.name.toLowerCase();
      survivingRegistry[key] = { id: p.id, oldId: p.id, name: p.name, role: null, isDead: false };
    });
    state.playerRegistry = survivingRegistry;
  } else {
    state.players = [];
    state.playerRegistry = {};
  }
}

// ===== HANDLERS SOCKETS =====
function handleSetPhase(socket, p) {
  if (!isMJ(socket.id)) return;
  if (p === "salvateur" && !Object.keys(state.roles).some(id => state.roles[id] === "Salvateur" && !state.deadPlayers.includes(id))) {
    setPhase("wolves"); return;
  }
  if (p === "seer" && !Object.keys(state.roles).some(id => state.roles[id] === "Voyante" && !state.deadPlayers.includes(id))) {
    setPhase("witch"); return;
  }
  if (p === "witch") {
    // AMÉLIORATION 4 : on saute la phase si la sorcière est morte OU si elle a déjà
    // utilisé ses deux potions (plus rien à faire pour elle).
    const witchAlive = Object.keys(state.roles).some(id => state.roles[id] === "Sorcière" && !state.deadPlayers.includes(id));
    if (!witchAlive || (state.witchSaveUsed && state.witchKillUsed)) {
      roles.doResolveNight(); return;
    }
  }
  if (p === "petiteFille") return;
  setPhase(p);
}

function handlePauseGame(socket) {
  if (isMJ(socket.id)) pauseGame();
}

function handleResumeGame(socket) {
  if (isMJ(socket.id)) resumeGame();
}

function handleReset(socket) {
  if (!isMJ(socket.id)) return;
  resetGameState(true);
  state.io.emit("gameReset", { players: state.players });
  setPhase("lobby");
  state.io.emit("players", state.players);
}

function handleReplayGame(socket, config) {
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
  setPhase, installPhaseTimeouts, clearPhaseTimeouts,
  runBotsForPhase, scheduleBot,
  checkVictory,
  pauseGame, resumeGame, resetGameState,
  startStuckTimer,
  // Handlers
  handleSetPhase, handlePauseGame, handleResumeGame, handleReset, handleReplayGame,
});
