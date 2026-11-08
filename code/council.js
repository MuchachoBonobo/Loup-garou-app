// council.js — Conseil des Morts : événements, vote, résolution, effets sonores.
// L'état partagé (councilOptions, councilVotes, pendingCouncilEvent, activeCouncilEvent,
// councilUsedEvents) vit dans state.js pour que votes.js puisse lire activeCouncilEvent.
// Seuls l'annonce en cours et les sons d'ambiance qui reviennent (tonnerre, cloche, loups,
// corbeaux) restent privés ici.
// Chaque évènement porte ses effets (`technical`) : votes.js lit le mode et la durée du vote, le
// Sablier, le Tour de parole et la Main levée par effetDuJour(). Sa `regle` est ce que le MJ applique
// et annonce ; son `resume`, ce que les morts lisent en votant (une ligne).
// Principe (Alexandre, 2026-11-08) : les morts choisissent la couleur de la journée, jamais son
// issue. Un évènement est neutre pour les deux camps, visible, appliqué par le jeu de préférence, et
// ne désigne jamais un joueur (le choix des morts, qui savent tout, trahirait un innocent).

const { state, isMJ, alivePlayers, vivantsSauf, playerName, fisherYates, auHasard, versMJ } = require('./state');
const lights = require('./lights');
const log    = require('./logger');

// Timeout du choix d'abdication (filet de sécurité si le maire ne tranche pas)
const ABDICATION_TIMEOUT_MS = 60000;
let abdicationTimeout = null;

// Nombre minimum de morts pour que le Conseil se réunisse en début de journée.
const COUNCIL_TRIGGER_THRESHOLD = 1;

const COUNCIL_EVENTS = {
  judgment: {
    id: "judgment",
    resume: "Une fois donné, un vote ne peut plus changer.",
    title: "⚖️ Le Jugement",
    narrative: "Une fois prononcé, un vote ne peut plus être changé. Que chacun pèse ses mots — la sentence est définitive dès qu'elle tombe.",
    regle: "Vote VERROUILLÉ : une fois qu'un joueur a voté, il ne peut plus changer son choix. Durée 60 s.",
    technical: { forceVoteMode: 2 }
  },
  panic: {
    id: "panic",
    resume: "Le vote ne dure que 30 secondes.",
    title: "⚡ La Panique",
    narrative: "Le village sombre dans la précipitation. Plus le temps de réfléchir : il faut trancher, et vite.",
    regle: "Vote EXPRESS : durée réduite à 30 s — les joueurs doivent trancher très vite.",
    technical: { forceVoteMode: 4 }
  },
  madness: {
    id: "madness",
    resume: "Chaque phrase commence par « Je pense que… » ou « Je jure que… ».",
    title: "🌀 La Folie",
    narrative: "Un voile étrange descend sur les esprits. Plus personne ne sait ce qu'il croit vraiment. Toute parole devra commencer par « Je pense que… » ou « Je jure que… »",
    regle: "Toute phrase d'un joueur doit commencer par « Je pense que… » ou « Je jure que… ». (À faire respecter.)",
    technical: null
  },
  eclipse: {
    id: "eclipse",
    resume: "La musique et la pénombre de la nuit en plein jour.",
    title: "🌑 L'Éclipse",
    narrative: "Le soleil se voile. Un crépuscule étrange recouvre la place du village en plein jour. La nuit semble refuser de s'effacer.",
    regle: "Ambiance seulement : la musique de nuit joue en plein jour. Aucun effet de règle — annonce l'atmosphère.",
    technical: { dayMusic: "night" }
  },
  storm: {
    id: "storm",
    resume: "L'orage gronde toute la journée.",
    title: "⛈️ La Tempête",
    narrative: "Le ciel s'assombrit. Au loin, le tonnerre gronde. Une pluie froide commence à fouetter les visages. Le village vivra cette journée sous l'orage.",
    regle: "Ambiance seulement : un orage gronde toute la journée. Aucun effet de règle.",
    technical: { stormSound: true }
  },
  // Identifiant interne « fog » conservé (scène de lumière council.fog, sauvegardes) :
  // l'évènement s'appelait « Le Brouillard » avant de devenir « La Paralysie ».
  fog: {
    id: "fog",
    resume: "Interdit de bouger les bras pour parler.",
    title: "🧊 La Paralysie",
    narrative: "Un froid étrange engourdit les villageois. Leurs bras pèsent comme de la pierre. Aujourd'hui, personne ne pourra bouger les bras pour s'exprimer : seuls les mots pourront convaincre.",
    regle: "Interdit de bouger les bras pour s'exprimer : pas de gestes, pas de doigt pointé, les bras restent immobiles. (À faire respecter.)",
    technical: null
  },
  whispers: {
    id: "whispers",
    resume: "Tout le monde parle à voix basse.",
    title: "🤫 Les Chuchotements",
    narrative: "Une étrange retenue s'installe. Les villageois n'osent plus élever la voix. Toute la journée, ils ne pourront parler qu'à voix basse.",
    regle: "Les joueurs ne peuvent parler qu'à VOIX BASSE toute la journée. (À faire respecter.)",
    technical: null
  },
  tribunal: {
    id: "tribunal",
    resume: "Pour parler, il faut se lever.",
    title: "🧍 Le Tribunal",
    narrative: "Une vieille tradition refait surface. Les anciens insistent : pour parler, il faut se lever. Quiconque souhaite s'exprimer devra se mettre debout face à l'assemblée.",
    regle: "Pour parler, un joueur doit se LEVER face à l'assemblée. Assis = pas de parole. (À faire respecter.)",
    technical: null
  },
  bell: {
    id: "bell",
    resume: "Toutes les 45 s, la cloche impose le silence.",
    title: "⛪ La Cloche du village",
    narrative: "La vieille cloche de l'église s'est mise à sonner sans raison. Toutes les 45 secondes, elle retentira — et chacun devra se taire quelques instants pour l'écouter.",
    regle: "Une cloche sonne automatiquement toutes les 45 s. À chaque sonnerie, tout le monde se tait quelques instants.",
    technical: { bellInterval: true }
  },
  last_words: {
    id: "last_words",
    resume: "Avant le vote, chacun dit « Si je meurs aujourd'hui… ».",
    title: "🕯️ Les Dernières Volontés",
    narrative: "Une coutume oubliée resurgit : avant le vote, chaque villageois doit lever la main et déclarer ce qu'il souhaite, au cas où il mourrait aujourd'hui : « Si je meurs aujourd'hui… »",
    regle: "Avant de lancer le vote, chaque joueur lève la main et déclare « Si je meurs aujourd'hui… » suivi de son souhait.",
    technical: null
  },
  murmurs: {
    id: "murmurs",
    resume: "Des murmures de morts toute la journée.",
    title: "👻 Les Morts Murmurent",
    narrative: "Un souffle étrange traverse la foule. Par moments, on jurerait entendre des voix… des plaintes… des mots imperceptibles. Les morts ne sont peut-être pas si loin.",
    regle: "Ambiance seulement : des murmures de morts se font entendre. Aucun effet de règle.",
    technical: { murmurSound: true }
  },
  voteMute: {
    id: "voteMute",
    resume: "Le vote se fait en silence, en 90 secondes.",
    title: "🤐 Le Vote Muet",
    narrative: "Le village se tait. Plus aucun mot ne sera prononcé — ni accusation, ni plaidoyer, ni murmure. Que chacun médite, juge en silence, et trace son verdict. 90 secondes pour voter, sans débat.",
    regle: "VOTE MUET : aucune parole pendant le vote — ni débat, ni accusation, ni plaidoyer. 90 s pour voter en silence.",
    technical: { voteDurationMs: 90000 }
  },
  silencedVoices: {
    id: "silencedVoices",
    resume: "Personne ne parle : on s'écrit sur les téléphones.",
    title: "💬 Les Voix Étouffées",
    narrative: "Une étrange paralysie saisit les gorges. Plus personne ne pourra parler à voix haute aujourd'hui. Mais sur la place du village, un parchemin s'est déroulé : les vivants pourront y inscrire leurs pensées, et tous — vivants comme morts — pourront les lire.",
    regle: "Interdit de parler à voix haute. Un chat écrit s'ouvre : les vivants y écrivent, tous (vivants et morts) peuvent lire.",
    technical: { dayChat: true }
  },
  abdication: {
    id: "abdication",
    resume: "Le maire choisit lui-même son successeur.",
    title: "👑 L'Abdication",
    narrative: "L'écharpe pèse trop lourd. Le Maire renonce à ses insignes et désigne, ici et maintenant, celui ou celle qui portera la responsabilité pour ce jour et les suivants.",
    regle: "Le maire ABDIQUE : il désigne lui-même son successeur, sans vote du village. Une carte de choix apparaît au maire.",
    technical: { abdication: true }
  },
  // Nouveaux (2026-11-08). `avecMJ` : seulement quand le MJ mène le jour (il lance le tour de
  // parole, désigne le condamné ; sans lui le vote démarre seul à l'aube)
  mainLevee: {
    id: "mainLevee",
    resume: "Pas de téléphone : le village vote à main levée.",
    title: "🙋 La Main Levée",
    narrative: "Les anciens se méfient des écrans et des messes basses. Aujourd'hui, le village votera comme autrefois : à main levée, sous le regard de tous.",
    regle: "Pas de vote sur les téléphones : au signal, chacun lève la main contre un joueur. Compte les mains (et les 2 voix du Corbeau), puis touche le condamné sur ta tablette. Une égalité : le maire tranche à voix haute.",
    technical: { mainLevee: true },
    avecMJ: true
  },
  sablier: {
    id: "sablier",
    resume: "Le débat dure 3 minutes, puis le vote s'ouvre tout seul.",
    title: "⏳ Le Sablier",
    narrative: "Le sablier est retourné. Quand le dernier grain tombera, le village devra voter, prêt ou pas.",
    regle: "Le débat dure 3 minutes à partir de « Lancer le débat » ; le vote s'ouvre alors tout seul. Tu peux le lancer plus tôt.",
    technical: { sablier: true },
    avecMJ: true
  },
  tourParole: {
    id: "tourParole",
    resume: "Deux tours de parole de 15 s chacun, puis le vote.",
    title: "🔄 Le Tour de Parole",
    narrative: "Les anciens imposent l'ordre : chacun parlera à son tour, deux fois, et pas plus longtemps que la flamme d'une allumette.",
    regle: "Deux tours de table : chaque vivant parle 15 s à son tour, un son marque le passage. Désigne qui commence, puis « Commencer le tour de parole ». Le vote s'ouvre tout seul à la fin du 2ᵉ tour.",
    technical: { tourDeParole: true },
    avecMJ: true
  },
  veillee: {
    id: "veillee",
    resume: "Lumières basses et vacillantes, musique feutrée.",
    title: "🕯️ La Veillée",
    narrative: "Le village s'est rassemblé à la lueur des bougies. Les flammes vacillent, les visages se creusent, et chacun baisse la voix sans y penser.",
    regle: "Ambiance seulement : lumières basses et vacillantes, musique du jour plus douce. Aucun effet de règle.",
    technical: { musiqueFeutree: true }
  },
  masques: {
    id: "masques",
    resume: "Chacun parle de lui à la troisième personne.",
    title: "🎭 Les Masques",
    narrative: "Un bal masqué a laissé ses traces : plus personne ne dit « je ». Chacun parle de lui comme d'un autre.",
    regle: "Chaque joueur parle de lui à la troisième personne (« Bob pense que… »). (À faire respecter.)",
    technical: null
  },
  // Nouveaux (2026-11-08, choix d'Alexandre) : trois ambiances menées par la tablette et les
  // lumières, un jeu de table, un tirage au sort
  luneRousse: {
    id: "luneRousse",
    resume: "Lumière rousse ; des loups hurlent au loin.",
    title: "🐺 La Lune Rousse",
    narrative: "Cette nuit, la lune s'est levée rousse, couleur de braise. Les anciens disent que les loups ne dorment pas sous une telle lune : toute la journée, on les entendra hurler quelque part au-delà des bois.",
    regle: "Ambiance seulement : lumière rousse, et des loups hurlent au loin de temps en temps. Aucun effet de règle.",
    technical: { hurlements: true }
  },
  nuee: {
    id: "nuee",
    resume: "Des corbeaux passent ; la lumière s'assombrit.",
    title: "🐦‍⬛ La Nuée de Corbeaux",
    narrative: "Une nuée de corbeaux s'est abattue sur le village. Ils tournent au-dessus des toits en croassant, et chaque fois qu'ils passent, leur ombre glace la place.",
    regle: "Ambiance seulement : des corbeaux passent en croassant, et la lumière s'assombrit un instant à chaque passage. Aucun effet de règle.",
    technical: { corbeaux: true }
  },
  coeur: {
    id: "coeur",
    resume: "Un cœur bat de plus en plus vite pendant le débat.",
    title: "💓 Le Cœur du Village",
    narrative: "Le village retient son souffle. Dans le silence, on entend battre un cœur, le cœur du village. Plus le débat dure, plus il s'affole.",
    regle: "Ambiance seulement : un cœur bat pendant le débat, de plus en plus vite, jusqu'au verdict ; la musique du jour se fait plus douce. Aucun effet de règle.",
    technical: { coeur: true }
  },
  motMaudit: {
    id: "motMaudit",
    resume: "Qui dit « loup » se tait jusqu'au suivant.",
    title: "🙊 Le Mot Maudit",
    narrative: "Un mot est maudit aujourd'hui : « loup ». Quiconque le prononce perd la parole, jusqu'à ce qu'un autre villageois le prononce à son tour.",
    regle: "Le mot « loup » est maudit (« loup-garou » compris) : qui le dit se tait jusqu'à ce qu'un autre joueur le dise à son tour. Se taire n'empêche pas de voter. (À faire respecter : les joueurs se surveillent entre eux.)",
    technical: null
  },
  // Tiré par le hasard, jamais par les morts (ils trahiraient un innocent). Le nom remplace la
  // phrase générale dès l'annonce (apresTirage), sur la carte et le bandeau du MJ.
  sort: {
    id: "sort",
    resume: "Le hasard désigne qui ouvre le débat.",
    title: "🎲 Le Sort",
    narrative: "Les anciens ont jeté les osselets sur la place du village. Le sort désignera qui ouvre le débat.",
    regle: "La tablette tire au sort un vivant, qui ouvre le débat : annonce son nom au village.",
    apresTirage: nom => ({
      narrative: `Les anciens ont jeté les osselets sur la place du village. Le sort a parlé : ${nom} ouvrira le débat.`,
      regle: `Le sort désigne ${nom}, qui ouvre le débat.`
    }),
    technical: { tirage: true },
    avecMJ: true
  }
};

// Évènements proposés en premier, pour les tests (CONSEIL_OPTIONS=mainLevee,sablier…)
const OPTIONS_IMPOSEES = (process.env.CONSEIL_OPTIONS || "").split(",").filter(id => COUNCIL_EVENTS[id]);

// L'annonce d'un évènement (« 📜 Annoncer l'évènement ») : un éclair violet, puis la lumière de
// l'annonce (council.annonce, un violet sombre qui respire) et les murmures sur la tablette, le
// temps que le MJ lise. L'évènement ne prend ses lumières et ses sons qu'à la fin de l'annonce :
// « Lancer le débat » ou le vote lancé (finAnnonceMatin) ; sans MJ, ANNONCE_SANS_MJ_MS plus tard.
const ANNONCE_SANS_MJ_MS = 8000;
let annonceEnCours = null;   // l'évènement annoncé, qui attend la fin de l'annonce
let annonceTimer   = null;

// Les sons qui reviennent pendant le jour (tonnerre, cloche, loups, corbeaux) : chacun à un
// intervalle tiré entre deux bornes, muet pendant la pause, arrêté en quittant le jour.
// CONSEIL_RYTHME les accélère pour les tests (0,05 : vingt fois plus souvent).
const RYTHME = parseFloat(process.env.CONSEIL_RYTHME) || 1;
let ambiancesDuJour = [];
function revenirPendantLeJour([premierMin, premierMax], [ensuiteMin, ensuiteMax], f) {
  const a = { t: null };
  const attendre = (min, max) => {
    a.t = setTimeout(() => {
      if (state.phase !== "day") return;
      if (!state.gamePaused) f();
      attendre(ensuiteMin, ensuiteMax);
    }, (min + Math.random() * (max - min)) * RYTHME);
  };
  ambiancesDuJour.push(a);
  attendre(premierMin, premierMax);
}

function pickRandomCouncilOptions(count = 3) {
  // Sans MJ qui mène le jour, les évènements qui ont besoin de lui ne sont pas proposés
  const jouables = Object.keys(COUNCIL_EVENTS).filter(id => !COUNCIL_EVENTS[id].avecMJ || annonceMatinParMJ());
  let available = jouables.filter(id => !state.councilUsedEvents.includes(id));
  // Second cycle : tous les événements ont déjà été proposés — on repart de zéro.
  // Possible dans les longues parties (24 évènements, 3 proposés par séance : 8 séances avant épuisement).
  if (available.length === 0) {
    state.councilUsedEvents = [];
    available = jouables;
    log.info('council', 'pool épuisé — second cycle, réinitialisation de councilUsedEvents');
    versMJ("autoResolve",
      "👻 Le Conseil reprend — les esprits ont épuisé leurs requêtes et reviennent de plus loin.");
  }
  const imposees = OPTIONS_IMPOSEES.filter(id => available.includes(id));
  return [...imposees, ...fisherYates(available.filter(id => !imposees.includes(id)))].slice(0, count);
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
  state.deadPlayers.forEach(did => state.io.to(did).emit("councilStart", optionsDuConseil()));
  versMJ("councilStartMJ", optionsDuConseil());
}

// Les évènements soumis au vote des morts, tels que les écrans les reçoivent (ouverture, reconnexion)
function optionsDuConseil() {
  return { options: state.councilOptions.map(id => ({ id, title: COUNCIL_EVENTS[id].title, resume: COUNCIL_EVENTS[id].resume })) };
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
    winner = auHasard(state.councilOptions);
  } else {
    const max = Math.max(...Object.values(counts));
    winner = auHasard(Object.entries(counts).filter(([, v]) => v === max).map(([k]) => k));
  }
  state.pendingCouncilEvent = winner;
  // Le MJ reçoit le récit complet de ce qui se passera demain, pas seulement le titre
  versMJ("councilResolvedMJ", {
    winner,
    title:     COUNCIL_EVENTS[winner].title,
    narrative: COUNCIL_EVENTS[winner].narrative,
    regle:     COUNCIL_EVENTS[winner].regle,
    counts
  });
  state.councilOptions = null;
  state.councilVotes = {};
  state.io.emit("councilResolved", { winner });
}

// L'évènement tel que les écrans le reçoivent ({ id, title, narrative, regle }), ou null. Le Sort,
// une fois annoncé : avec le nom tiré
function evenementPublic(id) {
  const ev = id && COUNCIL_EVENTS[id];
  if (!ev) return null;
  const tire = ev.apresTirage && state.tirageDuSort ? ev.apresTirage(playerName(state.tirageDuSort)) : {};
  return { id: ev.id, title: ev.title, narrative: ev.narrative, regle: ev.regle, ...tire };
}

// Effets de l'évènement du jour (`technical`), ou aucun
function effetDuJour() {
  const ev = state.activeCouncilEvent && COUNCIL_EVENTS[state.activeCouncilEvent];
  return (ev && ev.technical) || {};
}

// Les rendez-vous de l'aube (réunion du Conseil, annonce sans MJ) : si le jour s'achève avant, ou si
// la partie est relancée, ils sont annulés — sans quoi celui d'une partie à peine quittée ouvrait un
// second Conseil dans la suivante, qui effaçait le vote des morts (trouvé le 2026-11-08)
let rendezVous = [];
function dansLaJournee(ms, f) {
  rendezVous.push(setTimeout(() => { if (state.phase === "day") f(); }, ms));
}

// À l'aube et en quittant le jour : plus d'annonce, de rendez-vous, de sons qui reviennent, ni de
// nom tiré
function clearCouncilEffects() {
  rendezVous.forEach(t => clearTimeout(t));
  rendezVous = [];
  ambiancesDuJour.forEach(a => clearTimeout(a.t));
  ambiancesDuJour = [];
  if (annonceTimer)      { clearTimeout(annonceTimer);      annonceTimer      = null; }
  if (abdicationTimeout) { clearTimeout(abdicationTimeout); abdicationTimeout = null; }
  annonceEnCours = null;
  state.tirageDuSort = null;
}

// La scène à rétablir en plein jour (fin de pause) : le vote s'il est ouvert, l'annonce en cours,
// l'évènement du jour, ou le jour
function sceneDuJour() {
  if (state.voteTimer) return "dayVote";
  if (annonceEnCours) return "council.annonce";
  if (state.activeCouncilEvent && state.evenementAnnonce) return "council." + state.activeCouncilEvent;
  return "day";
}

function applyCouncilEvent(eventId) {
  if (!eventId || !COUNCIL_EVENTS[eventId]) return;
  const ev = COUNCIL_EVENTS[eventId];
  const effet = ev.technical || {};
  log.info('applyCouncilEvent', eventId, '-', ev.title);
  // Le Sort : un vivant tiré au hasard, que le MJ annonce
  state.tirageDuSort = effet.tirage ? ((auHasard(alivePlayers()) || {}).id || null) : null;
  state.io.emit("councilEventActive", {
    ...evenementPublic(eventId),
    // Annoncé par le MJ : les téléphones referment la carte des morts et l'affichent tout de suite
    parMJ: annonceMatinParMJ()
  });
  // L'annonce : l'éclair violet, puis sa lumière et les murmures jusqu'à la fin de l'annonce
  annonceEnCours = eventId;
  if (!state.gamePaused) { lights.applyScene("council.annonce"); lights.flash("flash.conseil"); }
  versMJ("annonceConseil");
  if (!state.annonceMatinEnCours) annonceTimer = setTimeout(debutEvenement, ANNONCE_SANS_MJ_MS);
  // La musique propre à l'évènement : la tablette l'attend elle aussi jusqu'à la fin de l'annonce
  if (effet.dayMusic === "night") versMJ("councilMusicOverride", "night");
  if (effet.musiqueFeutree) versMJ("councilMusicOverride", "feutree");
  if (effet.stormSound) versMJ("councilStormStart");      // la pluie à la place de la musique du jour
  if (effet.murmurSound) versMJ("councilMurmursStart");   // les murmures à la place de la musique du jour
  if (effet.coeur) versMJ("councilCoeurStart");           // le cœur par-dessus la musique, plus douce
  if (effet.abdication) triggerAbdicationPrompt();
  if (effet.dayChat) {
    // Les Voix Étouffées : on (re)initialise l'historique pour la séance et
    // on notifie tous les clients qu'ils doivent afficher le panneau de chat.
    state.silentDayChatHistory = [];
    state.io.emit("silentDayChatStart");
  }
}

// Fin de l'annonce : l'évènement prend sa lumière, et ses sons qui reviennent commencent. Ils
// continuent toute la journée, même si la tablette du MJ se recharge entre-temps.
function debutEvenement() {
  if (annonceTimer) { clearTimeout(annonceTimer); annonceTimer = null; }
  const id = annonceEnCours;
  annonceEnCours = null;
  if (!id || state.phase !== "day" || state.activeCouncilEvent !== id) return;
  versMJ("finAnnonceConseil");
  if (!state.gamePaused) lights.applyScene("council." + id);
  const effet = COUNCIL_EVENTS[id].technical || {};
  if (effet.stormSound) revenirPendantLeJour([30000, 30000], [30000, 30000], () => { versMJ("soundPlay", "thunder"); lights.flash("flash.lightning"); });
  if (effet.bellInterval) {
    // La cloche sonne tout de suite, puis toutes les 45 s
    const sonner = () => { versMJ("soundPlay", "church_bell"); lights.flash("flash.bell"); };
    if (!state.gamePaused) sonner();
    revenirPendantLeJour([45000, 45000], [45000, 45000], sonner);
  }
  // La Lune Rousse : un hurlement au loin, la lumière rougit puis revient
  if (effet.hurlements) revenirPendantLeJour([15000, 35000], [45000, 90000], () => { versMJ("soundPlay", "hurlement"); lights.vague("vague.hurlement"); });
  // La Nuée de Corbeaux : des croassements, et leur ombre passe sur la pièce
  if (effet.corbeaux) revenirPendantLeJour([8000, 20000], [25000, 60000], () => { versMJ("soundPlay", "crow"); lights.vague("vague.ombre"); });
}

// ===== ANNONCE DU MATIN (rythme du MJ) =====
// Avec un MJ (hors mode autonome, jour piloté), c'est lui qui annonce l'évènement du jour et
// qui ferme la carte des morts : tous les joueurs avancent au même rythme.
function annonceMatinParMJ() { return !state.autoMode && !!state.mjPilotedDay; }

// Annonce l'évènement du jour s'il ne l'a pas encore été (bouton du MJ, ou filet au lancement du vote)
function annoncerEvenement() {
  if (state.phase !== "day" || !state.activeCouncilEvent || state.evenementAnnonce) return false;
  state.evenementAnnonce = true;
  applyCouncilEvent(state.activeCouncilEvent);
  return true;
}

// Fin de l'annonce du matin : les téléphones referment la carte des morts (et celle de
// l'évènement si fermerEvenement : bouton « Lancer le débat » du MJ)
function finAnnonceMatin(fermerEvenement) {
  if (!state.annonceMatinEnCours) return;
  state.annonceMatinEnCours = false;
  state.io.emit("finAnnonceMatin", { fermerEvenement: !!fermerEvenement });
  debutEvenement();   // l'évènement annoncé prend ses lumières et ses sons
}

// ===== ABDICATION =====
// Envoie au maire (s'il est vivant) la liste des successeurs possibles. Si pas de
// pick dans le délai imparti, on tire au hasard pour ne pas bloquer la partie.
function triggerAbdicationPrompt() {
  if (!state.mayor || state.deadPlayers.includes(state.mayor)) return;
  const candidates = vivantsSauf(state.mayor).map(p => ({ id: p.id, name: p.name }));
  if (candidates.length === 0) return;

  state.io.to(state.mayor).emit("mayorMustAbdicate", { candidates });
  versMJ("autoResolve",
    "👑 L'Abdication — le maire désigne son successeur.");

  if (abdicationTimeout) clearTimeout(abdicationTimeout);
  abdicationTimeout = setTimeout(() => {
    abdicationTimeout = null;
    // Filet : si toujours pas tranché et l'event est encore actif, choix random.
    if (state.activeCouncilEvent !== "abdication") return;
    if (!state.mayor || state.deadPlayers.includes(state.mayor)) return;
    const pick = auHasard(vivantsSauf(state.mayor));
    if (pick) applyAbdication(pick.id, /*forced=*/true);
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

  state.io.emit("newMayor", state.mayor);
  lights.flash("flash.bell");
  state.io.emit("mayorAbdicated", {
    oldMayorId: oldMayor, oldMayorName: playerName(oldMayor),
    newMayorId: newMayorId, newMayorName: playerName(newMayorId),
    forced: !!forced,
  });
  versMJ("autoResolve",
    `👑 ${playerName(oldMayor)} a abdiqué en faveur de ${playerName(newMayorId)}${forced ? " (choix par défaut)" : ""}.`);
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
  versMJ("councilVoteUpdateMJ", { councilVotes: state.councilVotes });
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
  state.silentDayChatHistory.push(msg);
  if (state.silentDayChatHistory.length > 200) state.silentDayChatHistory.shift();
  state.io.emit("silentDayChatMsg", msg);
}

function handleSilentDayChatHistory(socket) {
  if (state.activeCouncilEvent !== "silencedVoices") return;
  socket.emit("silentDayChatHistory", state.silentDayChatHistory);
}

module.exports = {
  evenementPublic, effetDuJour, optionsDuConseil,
  COUNCIL_EVENTS, COUNCIL_TRIGGER_THRESHOLD,
  startCouncil,
  resolveCouncil,
  clearCouncilEffects, sceneDuJour, dansLaJournee,
  annonceMatinParMJ, annoncerEvenement, finAnnonceMatin,
  handleCouncilVote,
  handleAbdicationChoice,
  handleSilentDayChat,
  handleSilentDayChatHistory,
};
