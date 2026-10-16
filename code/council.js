// council.js — Conseil des Morts : événements, vote, résolution, effets sonores.
// L'état partagé (councilOptions, councilVotes, pendingCouncilEvent, activeCouncilEvent,
// councilEverTriggered) vit dans state.js pour que votes.js puisse lire activeCouncilEvent.
// Seuls les timers d'ambiance (cloche, murmures, tonnerre) restent privés ici.

const { state, isMJ, alivePlayers, playerName, fisherYates } = require('./state');
const lights = require('./lights');
const log    = require('./logger');

// Timeout du choix d'abdication (filet de sécurité si le maire ne tranche pas)
const ABDICATION_TIMEOUT_MS = 60000;
let abdicationTimeout = null;

const COUNCIL_TRIGGER_THRESHOLD = 6;

const COUNCIL_EVENTS = {
  riot: {
    id: "riot",
    title: "⚖ Émeute",
    narrative: "Un grondement traverse la place du village. La méfiance brouille les regards, les voix se confondent. Personne ne saura qui aura voté pour qui : ce vote sera entièrement anonyme.",
    technical: { forceVoteMode: 5 }
  },
  judgment: {
    id: "judgment",
    title: "⚖ Le Jugement",
    narrative: "Une fois prononcé, un vote ne peut plus être changé. Que chacun pèse ses mots — la sentence est définitive dès qu'elle tombe.",
    technical: { forceVoteMode: 2 }
  },
  panic: {
    id: "panic",
    title: "⚡ La Panique",
    narrative: "Le village sombre dans la précipitation. Plus le temps de réfléchir : il faut trancher, et vite.",
    technical: { forceVoteMode: 4 }
  },
  paranoia: {
    id: "paranoia",
    title: "😰 La Paranoïa",
    narrative: "Une étrange angoisse étreint les villageois. Les mots se coincent dans la gorge. Aucun discours ne pourra durer plus de 20 secondes — au-delà, le silence reprend ses droits.",
    technical: null
  },
  madness: {
    id: "madness",
    title: "🌀 La Folie",
    narrative: "Un voile étrange descend sur les esprits. Plus personne ne sait ce qu'il croit vraiment. Toute parole devra commencer par « Je pense que… » ou « Je jure que… »",
    technical: null
  },
  eclipse: {
    id: "eclipse",
    title: "🌑 L'Éclipse",
    narrative: "Le soleil se voile. Un crépuscule étrange recouvre la place du village en plein jour. La nuit semble refuser de s'effacer.",
    technical: { dayMusic: "night" }
  },
  storm: {
    id: "storm",
    title: "⛈ Tempête",
    narrative: "Le ciel s'assombrit. Au loin, le tonnerre gronde. Une pluie froide commence à fouetter les visages. Le village vivra cette journée sous l'orage.",
    technical: { stormSound: true }
  },
  fog: {
    id: "fog",
    title: "🌫 Brouillard",
    narrative: "Une brume épaisse enveloppe les ruelles. Les silhouettes se confondent. Interdiction de pointer quiconque du doigt — qui pourrait reconnaître l'autre dans cette purée de pois ?",
    technical: null
  },
  fire: {
    id: "fire",
    title: "🔥 Incendie",
    narrative: "Une fumée âcre monte de la grange du maire. Son écharpe brûle avec ses derniers privilèges. Aujourd'hui, en cas d'égalité, c'est le hasard — et non lui — qui tranchera.",
    technical: { mayorPowerless: true }
  },
  whispers: {
    id: "whispers",
    title: "🤫 Les Chuchotements",
    narrative: "Une étrange retenue s'installe. Les villageois n'osent plus élever la voix. Toute la journée, ils ne pourront parler qu'à voix basse.",
    technical: null
  },
  tribunal: {
    id: "tribunal",
    title: "⚖ Le Tribunal",
    narrative: "Une vieille tradition refait surface. Les anciens insistent : pour parler, il faut se lever. Quiconque souhaite s'exprimer devra se mettre debout face à l'assemblée.",
    technical: null
  },
  bell: {
    id: "bell",
    title: "⛪ La Cloche du Village",
    narrative: "La vieille cloche de l'église s'est mise à sonner sans raison. Toutes les 45 secondes, elle retentira — et chacun devra se taire quelques instants pour l'écouter.",
    technical: { bellInterval: true }
  },
  last_words: {
    id: "last_words",
    title: "🕯 Les Dernières Volontés",
    narrative: "Une coutume oubliée resurgit : avant le vote, chaque villageois doit lever la main et déclarer ce qu'il souhaite, au cas où il mourrait aujourd'hui : « Si je meurs aujourd'hui… »",
    technical: null
  },
  wind: {
    id: "wind",
    title: "🌬 Le Vent",
    narrative: "Un vent persistant traverse la place. Il pousse les regards vers le sol. Aujourd'hui, plus personne ne pourra fixer un autre dans les yeux en parlant.",
    technical: null
  },
  murmurs: {
    id: "murmurs",
    title: "👻 Les Morts Murmurent",
    narrative: "Un souffle étrange traverse la foule. Par moments, on jurerait entendre des voix… des plaintes… des mots imperceptibles. Les morts ne sont peut-être pas si loin.",
    technical: { murmurSound: true }
  },
  voteMute: {
    id: "voteMute",
    title: "🤐 Le Vote Muet",
    narrative: "Le village se tait. Plus aucun mot ne sera prononcé — ni accusation, ni plaidoyer, ni murmure. Que chacun médite, juge en silence, et trace son verdict. 90 secondes pour voter, sans débat.",
    technical: { voteDurationMs: 90000 }
  },
  silencedVoices: {
    id: "silencedVoices",
    title: "💬 Les Voix Étouffées",
    narrative: "Une étrange paralysie saisit les gorges. Plus personne ne pourra parler à voix haute aujourd'hui. Mais sur la place du village, un parchemin s'est déroulé : les vivants pourront y inscrire leurs pensées, et tous — vivants comme morts — pourront les lire.",
    technical: { dayChat: true }
  },
  abdication: {
    id: "abdication",
    title: "👑 L'Abdication",
    narrative: "L'écharpe pèse trop lourd. Le maire renonce à ses insignes et désigne, ici et maintenant, celui ou celle qui portera la responsabilité pour ce jour et les suivants.",
    technical: { abdication: true }
  }
};

// Timers d'ambiance privés au module
let councilBellTimer    = null;
let councilMurmursTimer = null;
let councilThunderTimer = null;

function pickRandomCouncilOptions(count = 3) {
  let available = Object.keys(COUNCIL_EVENTS).filter(id => !state.councilUsedEvents.includes(id));
  // Second cycle : tous les événements ont déjà été proposés — on repart de zéro.
  // Possible dans les longues parties (19 events × 3/session = ~7 sessions avant épuisement).
  if (available.length === 0) {
    state.councilUsedEvents = [];
    available = Object.keys(COUNCIL_EVENTS);
    log.info('council', 'pool épuisé — second cycle, réinitialisation de councilUsedEvents');
    if (state.mjSocketId) state.io.to(state.mjSocketId).emit("autoResolve",
      "👻 Le Conseil reprend — les esprits ont épuisé leurs requêtes et reviennent de plus loin.");
  }
  return fisherYates(available).slice(0, count);
}

function startCouncil() {
  const options = pickRandomCouncilOptions(3);
  // Plus aucun événement disponible : le conseil ne s'ouvre pas ce jour
  if (options.length === 0) return;
  // Marque TOUTES les options proposées comme utilisées — même les non-choisies
  options.forEach(id => {
    if (!state.councilUsedEvents.includes(id)) state.councilUsedEvents.push(id);
  });
  state.councilOptions = options;
  state.councilVotes = {};
  const optionPayload = state.councilOptions.map(id => ({
    id, title: COUNCIL_EVENTS[id].title
  }));
  state.deadPlayers.forEach(did => {
    state.io.to(did).emit("councilStart", { options: optionPayload });
  });
  if (state.mjSocketId) state.io.to(state.mjSocketId).emit("councilStartMJ", { options: optionPayload });
}

function resolveCouncil() {
  if (!state.councilOptions) return;
  const counts = {};
  state.councilOptions.forEach(id => { counts[id] = 0; });
  Object.values(state.councilVotes).forEach(voteId => {
    if (counts.hasOwnProperty(voteId)) counts[voteId]++;
  });
  const totalVotes = Object.values(counts).reduce((a, b) => a + b, 0);
  let winner = null;
  if (totalVotes === 0) {
    winner = state.councilOptions[Math.floor(Math.random() * state.councilOptions.length)];
  } else {
    const max = Math.max(...Object.values(counts));
    const tied = Object.entries(counts).filter(([, v]) => v === max).map(([k]) => k);
    winner = tied[Math.floor(Math.random() * tied.length)];
  }
  state.pendingCouncilEvent = winner;
  // AMÉLIORATION 3 : on inclut le narratif complet pour que le MJ ait toute
  // l'explication de ce qui va se passer demain (pas juste le titre).
  if (state.mjSocketId) state.io.to(state.mjSocketId).emit("councilResolvedMJ", {
    winner,
    title:     COUNCIL_EVENTS[winner].title,
    narrative: COUNCIL_EVENTS[winner].narrative,
    counts
  });
  state.councilOptions = null;
  state.councilVotes = {};
  state.io.emit("councilResolved", { winner });
}

function clearCouncilEffects() {
  if (councilBellTimer)    { clearInterval(councilBellTimer);    councilBellTimer    = null; }
  if (councilMurmursTimer) { clearTimeout(councilMurmursTimer);  councilMurmursTimer = null; }
  if (councilThunderTimer) { clearTimeout(councilThunderTimer);  councilThunderTimer = null; }
  if (abdicationTimeout)   { clearTimeout(abdicationTimeout);    abdicationTimeout   = null; }
}

function applyCouncilEvent(eventId) {
  if (!eventId || !COUNCIL_EVENTS[eventId]) return;
  const ev = COUNCIL_EVENTS[eventId];
  log.info('applyCouncilEvent', eventId, '-', ev.title);
  state.io.emit("councilEventActive", {
    id: ev.id, title: ev.title, narrative: ev.narrative
  });
  // Scène lumineuse spécifique à l'évènement (recouvre la scène "day")
  try { lights.applyScene("council." + ev.id); } catch (_) {}
  if (ev.technical) {
    if (ev.technical.dayMusic === "night" && state.mjSocketId) {
      state.io.to(state.mjSocketId).emit("councilMusicOverride", "night");
    }
    if (ev.technical.stormSound && state.mjSocketId) {
      state.io.to(state.mjSocketId).emit("councilStormStart");
      // Tonnerre toutes les 40 secondes pendant le jour
      const tickThunder = () => {
        councilThunderTimer = setTimeout(() => {
          if (state.mjSocketId && state.phase === "day") {
            state.io.to(state.mjSocketId).emit("soundPlay", "thunder");
            try { lights.flash("flash.lightning"); } catch (_) {}
            tickThunder();
          } else {
            councilThunderTimer = null;
          }
        }, 40000);
      };
      tickThunder();
    }
    if (ev.technical.bellInterval && state.mjSocketId) {
      // La cloche sonne immédiatement à l'apparition de l'événement
      state.io.to(state.mjSocketId).emit("soundPlay", "church_bell");
      try { lights.flash("flash.bell"); } catch (_) {}
      councilBellTimer = setInterval(() => {
        if (state.mjSocketId && state.phase === "day") {
          state.io.to(state.mjSocketId).emit("soundPlay", "church_bell");
          try { lights.flash("flash.bell"); } catch (_) {}
        } else {
          clearInterval(councilBellTimer); councilBellTimer = null;
        }
      }, 45000);
    }
    if (ev.technical.murmurSound && state.mjSocketId) {
      // Murmures : remplace la musique du jour par "Murmures.mp3" en boucle
      state.io.to(state.mjSocketId).emit("councilMurmursStart");
    }
    if (ev.technical.abdication) {
      triggerAbdicationPrompt();
    }
    if (ev.technical.dayChat) {
      // Les Voix Étouffées : on (re)initialise l'historique pour la séance et
      // on notifie tous les clients qu'ils doivent afficher le panneau de chat.
      state.silentDayChatHistory = [];
      state.io.emit("silentDayChatStart");
    }
  }
}

// ===== ABDICATION =====
// Envoie au maire (s'il est vivant) la liste des successeurs possibles. Si pas de
// pick dans le délai imparti, on tire au hasard pour ne pas bloquer la partie.
function triggerAbdicationPrompt() {
  if (!state.mayor || state.deadPlayers.includes(state.mayor)) return;
  const candidates = alivePlayers()
    .filter(p => p.id !== state.mayor)
    .map(p => ({ id: p.id, name: p.name }));
  if (candidates.length === 0) return;

  state.io.to(state.mayor).emit("mayorMustAbdicate", { candidates });
  if (state.mjSocketId) state.io.to(state.mjSocketId).emit("autoResolve",
    "👑 L'Abdication — le maire désigne son successeur.");

  if (abdicationTimeout) clearTimeout(abdicationTimeout);
  abdicationTimeout = setTimeout(() => {
    abdicationTimeout = null;
    // Filet : si toujours pas tranché et l'event est encore actif, choix random.
    if (state.activeCouncilEvent !== "abdication") return;
    if (!state.mayor || state.deadPlayers.includes(state.mayor)) return;
    const stillAlive = alivePlayers().filter(p => p.id !== state.mayor);
    if (stillAlive.length === 0) return;
    const pick = stillAlive[Math.floor(Math.random() * stillAlive.length)];
    applyAbdication(pick.id, /*forced=*/true);
  }, ABDICATION_TIMEOUT_MS);
}

function applyAbdication(newMayorId, forced) {
  // Garde : doit toujours être l'event actif et le maire courant doit être vivant
  if (!state.mayor || state.deadPlayers.includes(state.mayor)) return;
  if (state.deadPlayers.includes(newMayorId)) return;
  if (newMayorId === state.mayor) return;

  if (abdicationTimeout) { clearTimeout(abdicationTimeout); abdicationTimeout = null; }

  const oldMayor = state.mayor;
  state.mayor = newMayorId;
  state.gameStats.mayorName = playerName(newMayorId);

  // Empêche un nouveau prompt (l'abdication est consommée pour cette journée)
  // en désactivant le flag technique : on garde activeCouncilEvent="abdication"
  // pour la cohérence visuelle, mais on marque la consommation.
  state.io.emit("newMayor", state.mayor);
  try { lights.flash("flash.bell"); } catch (_) {}
  state.io.emit("mayorAbdicated", {
    oldMayorId: oldMayor, oldMayorName: playerName(oldMayor),
    newMayorId: newMayorId, newMayorName: playerName(newMayorId),
    forced: !!forced,
  });
  if (state.mjSocketId) {
    state.io.to(state.mjSocketId).emit("autoResolve",
      `👑 ${playerName(oldMayor)} a abdiqué en faveur de ${playerName(newMayorId)}${forced ? " (choix par défaut)" : ""}.`);
  }
}

function handleAbdicationChoice(socket, targetId) {
  if (state.phase !== "day") return;
  if (state.activeCouncilEvent !== "abdication") return;
  if (socket.id !== state.mayor) return;
  if (state.deadPlayers.includes(socket.id)) return;
  if (!targetId || state.deadPlayers.includes(targetId)) return;
  if (targetId === state.mayor) return;
  applyAbdication(targetId, /*forced=*/false);
}

// ===== Handlers socket =====
function handleCouncilVote(socket, eventId) {
  if (!state.deadPlayers.includes(socket.id)) return;
  if (!state.councilOptions || !state.councilOptions.includes(eventId)) return;
  state.councilVotes[socket.id] = eventId;
  if (state.mjSocketId) state.io.to(state.mjSocketId).emit("councilVoteUpdateMJ", { councilVotes: state.councilVotes });
  socket.emit("councilVoteConfirm", { eventId });
}

// ===== LES VOIX ÉTOUFFÉES — chat écrit du jour =====
// Seuls les vivants peuvent écrire. Tous (vivants + morts + MJ) reçoivent les messages.
// L'historique vit dans state.silentDayChatHistory et est purgé entre parties.
function handleSilentDayChat(socket, payload) {
  if (state.phase !== "day") return;
  if (state.activeCouncilEvent !== "silencedVoices") return;
  if (state.deadPlayers.includes(socket.id)) return;   // les morts lisent mais n'écrivent pas
  if (isMJ(socket.id)) return;                          // le MJ ne participe pas au débat
  const text = (payload && typeof payload.text === "string") ? payload.text : "";
  const clean = text.trim().slice(0, 200).replace(/[<>]/g, '');
  if (!clean) return;
  const msg = { name: playerName(socket.id), text: clean, ts: Date.now() };
  if (!state.silentDayChatHistory) state.silentDayChatHistory = [];
  state.silentDayChatHistory.push(msg);
  if (state.silentDayChatHistory.length > 200) state.silentDayChatHistory.shift();
  state.io.emit("silentDayChatMsg", msg);
}

function handleSilentDayChatHistory(socket) {
  if (state.activeCouncilEvent !== "silencedVoices") return;
  socket.emit("silentDayChatHistory", state.silentDayChatHistory || []);
}

module.exports = {
  COUNCIL_EVENTS,
  COUNCIL_TRIGGER_THRESHOLD,
  startCouncil,
  resolveCouncil,
  clearCouncilEffects,
  applyCouncilEvent,
  handleCouncilVote,
  handleAbdicationChoice,
  handleSilentDayChat,
  handleSilentDayChatHistory,
};
