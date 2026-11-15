// votes.js — Tous les mécanismes de vote : maire, jour, loups, tiebreak, sprint final.
// Dépendances circulaires (phases, roles) résolues via require('./module').fn() à l'usage.

const {
  state, alivePlayers, computeCounts, playerName, isMJ, hasRole, auHasard, versMJ, vivantsAvecRole, infosCorbeau,
  VOTE_RATE_MS, FAST_RESOLVE_MS, WOLF_CONSENSUS_GRACE_MS, resetActivity,
} = require('./state');

const phases  = require('./phases');
const roles   = require('./roles');
const log     = require('./logger');
const lights  = require('./lights');
const { buildDeathNarrative } = require('./death-narratives');
const council = require('./council');

// Garde-fou : si le Maire ne tranche jamais une égalité (mort, déconnecté,
// absent), on départage automatiquement au hasard après ce délai.
let tiebreakTimeout = null;
const TIEBREAK_TIMEOUT_MS = 30000;

// ===== TIMER VOTE =====
function clearVoteTimer() {
  if (state.voteTimer) { clearTimeout(state.voteTimer); state.voteTimer = null; }
  state.voteTimerEnd = null;
}

// ===== ÉGALITÉ =====
// Plus d'égalité en attente : le garde-fou des 30 s (variable de ce module) est arrêté aussi,
// pour qu'il ne se déclenche pas dans la partie suivante (appelé aussi par resetGameState)
function oublierEgalite() {
  if (tiebreakTimeout) { clearTimeout(tiebreakTimeout); tiebreakTimeout = null; }
  state.tiebreakPending    = false;
  state.tiebreakCandidates = [];
  state.tiebreakContext    = "";
  state.tiebreakSansVote   = false;
}

// L'égalité en attente telle que les écrans la reçoivent (téléphones, maire, MJ ; reconnexion).
// `sansVote` : personne n'a voté, l'égalité est entre tous les vivants
function egaliteEnCours() {
  return {
    candidates: state.tiebreakCandidates.map(id => ({ id, name: playerName(id) })),
    mayorName: playerName(state.mayor), context: state.tiebreakContext, sansVote: !!state.tiebreakSansVote
  };
}

// `counts` vide : personne n'a voté (le vote du jour, lui, en fait une égalité entre tous les vivants)
function resolveVoteWithTiebreak(counts, context, onResolved, sansVote = false) {
  if (!Object.keys(counts).length) return onResolved(null);
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const maxVotes = sorted[0][1];
  const tied = sorted.filter(e => e[1] === maxVotes).map(e => e[0]);

  if (tied.length === 1) return onResolved(tied[0]);

  if (context === "mayor" || !state.mayor || state.deadPlayers.includes(state.mayor)) {
    return onResolved(auHasard(tied));
  }
  state.tiebreakPending    = true;
  state.tiebreakCandidates = tied;
  state.tiebreakContext    = context;
  state.tiebreakSansVote   = sansVote;
  const egalite = egaliteEnCours();
  state.io.emit("tiebreakNeeded", egalite);
  state.io.to(state.mayor).emit("tiebreakMayor", egalite);
  versMJ("tiebreakMJ", egalite);
  // Mode entraînement : si le maire est un bot, il tranche automatiquement
  maybeRunBotForTiebreak();

  // GARDE-FOU : si le Maire ne tranche pas (mort, déconnecté, AFK), on
  // départage automatiquement au hasard — sinon la partie reste bloquée
  // pour toujours sur « le Maire doit trancher ».
  if (tiebreakTimeout) clearTimeout(tiebreakTimeout);
  tiebreakTimeout = setTimeout(() => {
    if (!state.tiebreakPending || !state.tiebreakCandidates.length) return;
    state.io.emit("autoResolve", "⏱️ Le Maire n'a pas tranché — l'égalité est départagée au hasard.");
    trancherEgalite(auHasard(state.tiebreakCandidates));
  }, TIEBREAK_TIMEOUT_MS);
}

// ===== LOCK MAIRE / LOUPS =====
function performLockMayorVote() {
  // Maire déjà élu (5 s d'annonce avant la nuit) : un second clic relançait l'élection, urne vide
  if (state.phase !== "mayorVote" || state.mayor) return;
  state.mayorAllVotedNotified = false;
  if (state.mayorAutoLockTimer) { clearTimeout(state.mayorAutoLockTimer); state.mayorAutoLockTimer = null; }
  const count = computeCounts(state.mayorVote);
  resolveVoteWithTiebreak(count, "mayor", (winnerId) => {
    state.mayor = winnerId;
    state.gameStats.mayorName = playerName(state.mayor);
    state.io.emit("newMayor", state.mayor);
    lights.flash("flash.bell");
    if (state.lovers.length === 2) versMJ("loversInfo", state.lovers);
    state.mayorVote = {};
    // Délai 5 s : laisse le temps à la lumière et au MJ d'annoncer le nouveau maire. Minuterie de
    // phase (arrêtée par tout changement de phase) : une partie relancée dans ces 5 s voyait son
    // propre vote du maire coupé par la nuit de la précédente.
    state.annonceMaireTimeout = setTimeout(() => {
      state.annonceMaireTimeout = null;
      if (state.phase === "mayorVote") roles.ouvrirNuit(true);
    }, 5000);
  });
}

function performLockWolfVotes() {
  if (state.phase !== "wolves") return;
  if (state.wolfConsensusTimer)  { clearTimeout(state.wolfConsensusTimer);  state.wolfConsensusTimer  = null; }
  if (state.wolvesAutoLockTimer) { clearTimeout(state.wolvesAutoLockTimer); state.wolvesAutoLockTimer = null; }
  const count = computeCounts(state.votesWolf);
  state.nightTarget = Object.keys(count).sort((a, b) => count[b] - count[a])[0] || null;
  state.votesWolf = {};
  // Flash : les loups ont désigné leur proie
  lights.flash("flash.wolves");
  roles.allerEtapeNuit(roles.etapeApres("wolves"));
}

// ===== VOTE DU MAIRE : TOUT LE MONDE A VOTÉ =====
// Mode autonome : verrouillage automatique. Avec un MJ, il est seulement prévenu
// (c'est lui qui valide le maire).
function checkMayorAutoLock() {
  if (state.phase !== "mayorVote") return;
  const alive = alivePlayers();
  if (alive.length === 0) return;
  const allVoted = alive.every(p => state.mayorVote[p.id] !== undefined);
  if (!allVoted) return;
  if (state.autoMode) { performLockMayorVote(); return; }
  if (state.mjSocketId && !state.mayorAllVotedNotified) {
    state.mayorAllVotedNotified = true;
    versMJ("autoResolve", "🏛️ Tout le monde a voté pour le maire — cliquez sur « Valider le Maire ».");
  }
}

// Mode autonome : les loups vivants sont tous d'accord → l'attaque est verrouillée après un
// court délai de grâce (le temps de changer d'avis)
function cibleCommuneDesLoups() {
  const cibles = vivantsAvecRole("Loup").map(id => state.votesWolf[id]);
  return cibles.length && cibles.every(c => c && c === cibles[0]) ? cibles[0] : null;
}
function checkWolfConsensus() {
  if (!state.autoMode || state.phase !== "wolves") return;
  if (!cibleCommuneDesLoups()) { clearTimeout(state.wolfConsensusTimer); state.wolfConsensusTimer = null; return; }
  if (state.wolfConsensusTimer) return;
  state.wolfConsensusTimer = setTimeout(() => {
    state.wolfConsensusTimer = null;
    if (state.phase === "wolves" && cibleCommuneDesLoups()) performLockWolfVotes();
  }, WOLF_CONSENSUS_GRACE_MS);
}

// ===== BOT TIEBREAK =====
function maybeRunBotForTiebreak() {
  if (!state.tiebreakPending || !state.mayor) return;
  const mayorPlayer = state.players.find(pl => pl.id === state.mayor);
  if (!mayorPlayer || !mayorPlayer.isBot) return;
  phases.scheduleBot(() => {
    if (!state.tiebreakPending) return;
    if (state.deadPlayers.includes(state.mayor)) return;
    const choice = auHasard(state.tiebreakCandidates);
    if (choice) trancherEgalite(choice);
  });
}

// ===== FIN D'UNE ÉGALITÉ =====
// Le maire, le maire-bot ou le hasard (garde-fou des 30 s) a désigné le perdant. Seul
// le vote du jour passe par là : une égalité à l'élection du maire est tirée au sort.
// Quelle que soit la façon dont il est désigné au premier vote — voix, maire, hasard, même
// quand personne n'a voté —, l'Ange gagne (Alexandre, 2026-11-15).
function trancherEgalite(choix) {
  oublierEgalite();
  state.io.emit("tiebreakResolved", { winner: choix, name: playerName(choix) });
  executerVerdict(choix);
}

// ===== VERDICT DU VOTE DU JOUR =====
// Suspense chez le MJ : un battement de cœur avant le verdict
function suspenseVerdict() {
  versMJ("soundPlay", "heartbeat");
  setTimeout(() => versMJ("stopHeartbeat"), 1200);
}

// Urne vidée et vote clos sur tous les écrans
function viderVoteDuJour() {
  state.votesDay = {};
  versMJ("votesDayMJ", state.votesDay);
  state.io.emit("dayCountsPublic", {});
  state.io.emit("voteTimerEnd");
}

// Le village a désigné `cible` (vote, égalité tranchée, ou tirage au sort quand personne n'a
// voté) : l'Ange gagne seul au premier vote, l'Idiot survit ; sinon suspense, annonce, mort,
// puis la victoire ou la nuit.
function executerVerdict(cible) {
  if (handleAngeVictoire(cible)) return;
  if (handleIdiotDayVoteSurvival(cible)) return;
  const nom = playerName(cible), role = state.roles[cible];
  // Les deux minuteries ci-dessous ne sont arrêtées par rien : elles vérifient en partant que c'est
  // toujours CE verdict (une partie relancée entre-temps remet `verdictEnCours` à zéro). Le seul
  // « vote clos » ne suffisait pas : la mort d'une partie précédente tombait dans le vote clos de la
  // suivante, sur un joueur disparu (relecture du 2026-11-15, révélé par le dépouillement)
  const jeton = state.verdictEnCours = { cible };
  const toujoursLa = () => state.resolutionJourEnCours && state.verdictEnCours === jeton;
  suspenseVerdict();
  setTimeout(() => {
    if (!toujoursLa()) return;  // jour quitté ou partie relancée entre-temps
    versMJ("soundPlay", "death");
    lights.flash("flash.death");
    state.io.emit("dayVoteResult", { id: cible, name: nom, role, narrative: buildDeathNarrative({ role, cause: "vote", name: nom }) });
    // Son amoureux mourra de chagrin avec lui : le MJ l'annonce dans la foulée, sur la même carte
    const partenaire = state.lovers.includes(cible) && state.lovers.find(l => l !== cible);
    if (partenaire && !state.deadPlayers.includes(partenaire)) {
      versMJ("verdictChagrinMJ", { name: playerName(partenaire), role: state.roles[partenaire] });
    }
  }, 2700);
  setTimeout(() => {
    if (!toujoursLa()) return;
    state.verdictEnCours = null;
    roles.killPlayer(cible, "vote");
    viderVoteDuJour();
    // Victoire vérifiée avant toute transition ; la nuit passe par ouvrirNuit (Sœurs, Salvateur)
    if (state.phase !== "lobby" && state.phase !== "chasseur" && state.phase !== "mayorTransfer") {
      if (phases.checkVictory()) return;
      roles.ouvrirNuit(false);
    }
  }, 8200);
}

// ===== IDIOT DU VILLAGE =====
// L'Idiot survit s'il est désigné par le VOTE DU VILLAGE (une seule fois) : il est
// démasqué mais reste en vie. Il meurt normalement de toute autre cause (loups,
// sorcière, chasseur, chagrin d'amour) — ces causes passent par killPlayer sans
// exception. Appelé par executerVerdict : la survie vaut aussi quand l'élimination
// résulte d'une égalité tranchée.
// Renvoie true si l'Idiot a été épargné (l'appelant doit alors s'arrêter).
function handleIdiotDayVoteSurvival(victimId) {
  if (state.roles[victimId] !== "Idiot" || state.idiotRevealed) return false;
  state.idiotRevealed = true;
  state.io.emit("idiotRevealed", { id: victimId, name: playerName(victimId) });
  lights.flash("flash.idiot");
  viderVoteDuJour();
  if (state.phase !== "chasseur" && state.phase !== "mayorTransfer") roles.ouvrirNuit(false);
  return true;
}

// ===== ANGE =====
// L'Ange gagne SEUL s'il est désigné par le PREMIER vote du village (celui du
// lendemain de la 1re nuit), y compris quand une égalité est tranchée en sa
// défaveur (maire, maire-bot, hasard). Tué de toute autre façon (loups,
// sorcière, chasseur, chagrin d'amour) ou désigné à un vote suivant, c'est un
// simple villageois. `nbVotesJour` compte les votes résolus ET les votes passés
// par le MJ : un premier vote passé lui fait perdre sa chance (choix du
// 2026-10-23). Appelé par executerVerdict, comme l'Idiot.
// Renvoie true si l'Ange a gagné (l'appelant doit alors s'arrêter).
function handleAngeVictoire(victimId) {
  if (state.roles[victimId] !== "Ange" || state.nbVotesJour !== 1) return false;
  state.angeVainqueur = victimId;
  // Même suspense qu'une élimination, puis la révélation à la place de la mort. Le vote
  // n'est clos côté écrans qu'à la fin (comme une élimination) : sinon les téléphones
  // repassaient sur « Discutez » pendant le roulement de tambour.
  suspenseVerdict();
  setTimeout(() => {
    if (state.angeVainqueur !== victimId) return;  // partie réinitialisée entre-temps
    lights.flash("flash.ange");
    state.io.emit("angeRevele", { id: victimId, name: playerName(victimId) });
  }, 2700);
  setTimeout(() => {
    if (state.angeVainqueur !== victimId || state.phase === "lobby") return;
    viderVoteDuJour();
    phases.checkVictory();
  }, 8200);
  return true;
}

// ===== VOTE JOUR — RÉSOLUTION =====
function resolveDayVote() {
  // Un seul dépouillement par jour : un 2e appui sur « Terminer », ou la fin du minuteur
  // pendant le suspense, est ignoré.
  if (state.phase !== "day" || state.resolutionJourEnCours) return;
  state.resolutionJourEnCours = true;
  // Écran MJ : boutons du vote grisés jusqu'à la fin du jour
  versMJ("voteClosMJ");
  log.info('resolveDayVote', 'votes=', state.votesDay);
  clearVoteTimer(); state.lockedVoters.clear();
  state.nbVotesJour++;  // le 1er vote est celui où l'Ange peut gagner

  // Mémoire des bulletins (par prénom : stable malgré les reconnexions) pour les médailles
  // « Flair » et « Insoupçonnable » de fin de partie
  state.gameStats.voteLog.push(Object.entries(votesDuVillage())
    .map(([votant, cible]) => ({ votant: playerName(votant), cible: playerName(cible), cibleRole: state.roles[cible] })));

  // Les deux voix du Corbeau s'ajoutent au dépouillement
  const corbeau = infosCorbeau();
  if (corbeau) {
    state.votesDay["__corbeau_1__"] = corbeau.targetId;
    state.votesDay["__corbeau_2__"] = corbeau.targetId;
  }
  state.corbeauTarget = null;

  const count = computeCounts(state.votesDay);
  // Vote secret avec au moins un bulletin : ils s'ouvrent d'abord un par un (le Dépouillement),
  // le verdict vient ensuite, au dernier appui du MJ
  if (state.voteSecret && Object.keys(count).length) { lancerDepouillement(corbeau); return; }
  conclureVoteDuJour(count);
}

// Le verdict d'un vote du jour clos (après son dépouillement, s'il y en a eu un)
function conclureVoteDuJour(count) {
  // Personne n'a voté : égalité entre tous les vivants, maire compris, et le maire tranche
  // (Alexandre, 2026-11-15 ; avant, un vivant était tiré au sort)
  const sansVote = !Object.keys(count).length;
  if (sansVote) alivePlayers().forEach(p => { count[p.id] = 0; });

  resolveVoteWithTiebreak(count, "day", (target) => {
    // Sans vote, une décision immédiate est un tirage au sort (pas de maire pour trancher). L'Ange
    // tiré au sort au premier vote gagne quand même (Alexandre, 2026-11-15 ; avant, il perdait)
    if (sansVote) state.io.emit("randomElim");
    executerVerdict(target);
  }, sansVote);
}

// ===== LE DÉPOUILLEMENT (2026-11-15) =====
// Dès qu'il reste SEUIL_DEPOUILLEMENT vivants, le vote du jour est secret : chacun ne voit que qui a
// voté (pas même le MJ, la surprise est pour lui aussi). Une fois clos, les bulletins s'ouvrent un
// par un sur tous les écrans (MJ, vivants, morts) : une enveloppe « Bulletin d'Anna », le bulletin
// « vote contre Bob ». Le MJ ouvre chacun (« ✉️ Ouvrir le bulletin suivant »), puis, après le dernier,
// lance l'annonce habituelle (« ⚖️ L'annonce »). Les 2 voix du Corbeau sont le dernier bulletin.
// Sans MJ (mode autonome), les bulletins s'ouvrent seuls ; un MJ qui ne répond plus a son filet.
const SEUIL_DEPOUILLEMENT    = 4;
const DEPOUILLEMENT_AUTO_MS  = 4000;
const DEPOUILLEMENT_FILET_MS = parseInt(process.env.DEPOUILLEMENT_FILET_MS) || 3 * 60 * 1000;
const DEPOUILLEMENT_ECART_MS = 500;   // deux appuis plus rapprochés : un double toucher, ignoré

function melanger(liste) {
  const l = liste.slice();
  for (let i = l.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [l[i], l[j]] = [l[j], l[i]]; }
  return l;
}

// Ce que les écrans reçoivent : des prénoms (stables malgré les reconnexions ; les photos se
// retrouvent par le prénom)
function lancerDepouillement(corbeau) {
  const bulletins = melanger(Object.entries(votesDuVillage()).map(([de, vers]) => ({ de: playerName(de), vers: playerName(vers), voix: 1 })));
  if (corbeau) bulletins.push({ de: null, corbeau: true, vers: corbeau.targetName, voix: 2 });
  state.depouillement = { bulletins, revele: 0, vivants: alivePlayers().map(p => p.name), dernierAt: 0 };
  log.info('depouillement', bulletins.length + ' bulletin(s)');
  versMJ("stopHeartbeat");   // le cœur du vote se tait : place aux enveloppes
  state.io.emit("depouillementDebut", { total: bulletins.length, vivants: state.depouillement.vivants });
  programmerDepouillement();
}

// L'état d'un dépouillement en cours, pour un écran qui se reconnecte
function etatDepouillement() {
  const d = state.depouillement;
  return d ? { total: d.bulletins.length, vivants: d.vivants, ouverts: d.bulletins.slice(0, d.revele) } : null;
}

// Prochaine étape sans appui du MJ : vite en mode autonome, au bout du filet sinon
function programmerDepouillement() {
  clearTimeout(state.depouillementTimeout);
  const auto = state.autoMode || !state.mjPilotedDay;
  state.depouillementTimeout = setTimeout(() => { state.depouillementTimeout = null; bulletinSuivant(); },
    auto ? DEPOUILLEMENT_AUTO_MS : DEPOUILLEMENT_FILET_MS);
}

// Ouvre le bulletin suivant ; après le dernier, conclut le vote (l'annonce habituelle)
function bulletinSuivant() {
  const d = state.depouillement;
  if (!d || state.phase !== "day" || state.gamePaused) return;
  d.dernierAt = Date.now();
  if (d.revele < d.bulletins.length) {
    const b = d.bulletins[d.revele++];
    state.io.emit("depouillementBulletin", { index: d.revele, total: d.bulletins.length, ...b });
    programmerDepouillement();
    return;
  }
  clearTimeout(state.depouillementTimeout); state.depouillementTimeout = null;
  state.depouillement = null;
  state.io.emit("depouillementFin");
  // Recompté sur l'urne, et non sur un relevé fait à la clôture : un joueur qui s'est reconnecté
  // pendant le dépouillement a changé d'identifiant, et l'urne suit (remplacerIdentifiant)
  conclureVoteDuJour(computeCounts(state.votesDay));
}

// « ✉️ Ouvrir le bulletin suivant » / « ⚖️ L'annonce » de la tablette
function handleBulletinSuivant(socket) {
  if (!isMJ(socket.id) || !state.depouillement || state.gamePaused) return;
  if (Date.now() - state.depouillement.dernierAt < DEPOUILLEMENT_ECART_MS) return;
  bulletinSuivant();
}

function startDayVote(mode) {
  if (state.phase !== "day" || state.resolutionJourEnCours) return;
  // Vote lancé avant la fin de l'annonce du matin : l'évènement est annoncé d'abord, la carte
  // des morts se ferme sur les téléphones ; l'évènement tout juste annoncé reste à lire
  const vientDEtreAnnonce = council.annoncerEvenement();
  council.finAnnonceMatin(!vientDEtreAnnonce);
  log.info('startDayVote', 'mode=' + mode, 'event=' + (state.activeCouncilEvent || 'none'));
  // Conseil des Morts : l'évènement du jour peut imposer son mode de vote (Jugement, Panique) et
  // sa durée (Vote Muet) ; sinon, le mode passé en argument (autoVoteMode en mode autonome)
  const effet = council.effetDuJour();
  if (effet.forceVoteMode) mode = effet.forceVoteMode;

  arreterDebat();   // Tour de parole en cours : le vote le remplace
  voteRaccourci = false;
  state.voteSecret = alivePlayers().length <= SEUIL_DEPOUILLEMENT && !effet.mainLevee;
  clearVoteTimer(); state.lockedVoters.clear(); state.voteMode = mode;
  state.fastResolveTriggered = false;
  // Modes de vote :
  //   1 = libre 40 s (défaut ; 60 s avant le 2026-11-14)
  //   2 = Jugement verrouillé 40 s (vote définitif dès qu'il tombe)
  //   4 = Panique express 30 s
  //   5 = anonyme 40 s (mode autonome, choix « Anonyme »)
  const durations = { 1: 40000, 2: 40000, 4: 30000, 5: 40000 };
  const duration = effet.voteDurationMs || durations[mode] || 40000;
  const endsAt = Date.now() + duration + 800;
  state.voteTimerEnd = endsAt;
  state.voteDureeMs = duration;

  const realVotes = votesDuVillage();
  const corbeauInfo = infosCorbeau();
  const secret = state.voteSecret;
  state.io.emit("voteStarted", { mode, duration, endsAt, serverNow: Date.now(), existingVotes: secret ? {} : computeCounts(realVotes), corbeauInfo, secret });
  versMJ("voteStartedMJ", { mode, duration, endsAt, serverNow: Date.now() });
  if (secret) publierVotesDuJour();   // qui a déjà voté (jamais pour qui)
  else if (mode !== 5) state.io.emit("votesDayPublic", realVotes);
  roles.annoncerCorbeau();
  state.voteTimer = setTimeout(() => { resolveDayVote(); }, duration + 800);
  // Lumières : le vote tamise doucement la pièce (la nuit approche), sauf un évènement qui a sa lumière
  lights.applyScene(council.sceneDuJour());
  // Jour piloté : les bots attendaient le lancement officiel du vote pour voter.
  if (state.mjPilotedDay) phases.runBotsForPhase("day");
}

// ===== PUBLICATION DES VOTES =====
// Bulletins du vote du jour, sans les deux voix du Corbeau (ajoutées au seul dépouillement)
function votesDuVillage() {
  return Object.fromEntries(Object.entries(state.votesDay).filter(([votant]) => !votant.startsWith("__corbeau")));
}
// Le détail (qui vote pour qui) va au seul MJ ; les téléphones voient les voix, sauf pendant
// le vote anonyme. Vote secret (le Dépouillement) : qui a voté, jamais pour qui, MJ compris.
function publierVotesDuJour() {
  if (state.voteSecret) {
    const votants = Object.keys(votesDuVillage());
    versMJ("votantsJourMJ", votants);
    state.io.emit("votantsJour", votants);
    return;
  }
  versMJ("votesDayMJ", state.votesDay);
  if (state.voteMode === 5) return;
  state.io.emit("dayCountsPublic", computeCounts(state.votesDay));
  state.io.emit("votesDayPublic", votesDuVillage());
}
function publierVotesDuMaire() {
  versMJ("mayorVotesMJ", state.mayorVote);
  state.io.emit("mayorCountsPublic", computeCounts(state.mayorVote));
}
// Votes des loups : au MJ, aux loups vivants, et aux morts quand ils voient tout (jour non piloté)
function publierVotesDesLoups() {
  versMJ("wolfVotesMJ", state.votesWolf);
  const destinataires = vivantsAvecRole("Loup").concat(state.mjPilotedDay ? [] : state.deadPlayers);
  destinataires.forEach(id => state.io.to(id).emit("wolfVotesUpdate", state.votesWolf));
}

// ===== HANDLERS SOCKETS =====
// Un vote par seconde au plus et par joueur (double toucher)
function voteTropRapide(id) {
  const maintenant = Date.now();
  if (maintenant - (state.voteRateLimit.get(id) || 0) < VOTE_RATE_MS) return true;
  state.voteRateLimit.set(id, maintenant);
  return false;
}

function handleVoteMayor(socket, target) {
  if (state.phase !== "mayorVote" || state.deadPlayers.includes(socket.id)) return;
  if (target === socket.id) return;  // pas d'auto-vote au maire
  if (voteTropRapide(socket.id)) return;
  state.mayorVote[socket.id] = target;
  publierVotesDuMaire();
  state.io.emit("mayorVoted", socket.id);
  checkMayorAutoLock();
}

function handleLockMayorVote(socket) {
  if (!isMJ(socket.id)) return;
  performLockMayorVote();
}

// Le MJ a appuyé sur un bouton du vote alors que le vote est déjà clos : on le lui dit.
function voteDejaClos() {
  versMJ("autoResolve", "⏳ Le vote est déjà clos — le résultat est en cours d'annonce.");
}

function handleStartVote(socket) {
  if (!isMJ(socket.id) || state.phase !== "day") return;
  if (state.resolutionJourEnCours) { voteDejaClos(); return; }
  // Déjà lancé (double appui) : on ne relance pas le compte à rebours
  if (state.voteTimer) {
    versMJ("autoResolve", "🗳️ Le vote est déjà en cours.");
    return;
  }
  startDayVote(1);
}

function handleVoteDay(socket, id) {
  if (state.phase !== "day" || state.deadPlayers.includes(socket.id) || state.deadPlayers.includes(id)) return;
  if (id === socket.id) return;
  if (state.resolutionJourEnCours) return;  // vote clos : plus de changement
  // Jour piloté par le MJ : vote accepté seulement une fois lancé
  if (state.mjPilotedDay && state.voteTimer === null) return;
  if (state.idiotRevealed && state.roles[socket.id] === "Idiot") return;
  if (state.voteMode === 2 && state.lockedVoters.has(socket.id)) return;
  if (voteTropRapide(socket.id)) return;
  state.votesDay[socket.id] = id;
  if (state.voteMode === 2) state.lockedVoters.add(socket.id);
  publierVotesDuJour();
  // Vote anonyme : seul le votant apprend pour qui il a voté
  if (state.voteMode === 5) socket.emit("hasVotedConfirm", { targetName: playerName(id) });
  // Vote secret : de même, mais il peut changer d'avis jusqu'à la fin, comme dans un vote ordinaire
  else if (state.voteSecret) socket.emit("monVoteJour", { cible: id });
  // Sprint final de 30 s quand tout le monde a voté — mode autonome seulement : avec un
  // MJ, le vote dure 40 s et le battement de cœur final doit aller au bout
  if (state.voteMode === 1 && !state.fastResolveTriggered && state.voteTimer && !state.mjPilotedDay) {
    const alive = alivePlayers();
    const allVoted = alive.every(p => state.votesDay[p.id] !== undefined);
    if (allVoted) {
      const remainingMs = state.voteTimerEnd ? Math.max(0, state.voteTimerEnd - Date.now()) : Infinity;
      // Ne raccourcit que si plus de 30s restantes
      if (remainingMs > FAST_RESOLVE_MS) {
        state.fastResolveTriggered = true;
        clearVoteTimer();
        state.voteTimerEnd = Date.now() + FAST_RESOLVE_MS;
        state.voteDureeMs = FAST_RESOLVE_MS;
        state.voteTimer = setTimeout(() => { resolveDayVote(); }, FAST_RESOLVE_MS);
        state.io.emit("autoResolve", "✅ Tout le village a voté — vote rapide 30s !");
        state.io.emit("voteResumed", { endsAt: state.voteTimerEnd, durationMs: FAST_RESOLVE_MS, serverNow: Date.now() });
        versMJ("voteStartedMJ", { mode: state.voteMode, duration: FAST_RESOLVE_MS, endsAt: state.voteTimerEnd, serverNow: Date.now() });
      }
    }
  }
}

// « Terminer le vote » du MJ (Alexandre, 2026-11-08) : il reste DERNIERES_SECONDES_MS pour voter, sur
// tous les écrans (le cœur bat, on peut encore changer son vote), puis le vote se ferme comme à la
// fin normale. Un 2ᵉ appui pendant ces secondes est ignoré.
const DERNIERES_SECONDES_MS = parseInt(process.env.DERNIERES_SECONDES_MS) || 5000;
let voteRaccourci = false;
function handleLockDayVotes(socket) {
  if (!isMJ(socket.id) || state.phase !== "day") return;
  if (state.resolutionJourEnCours) { voteDejaClos(); return; }
  if (state.dayResolutionPending) return;
  if (voteRaccourci) { versMJ("autoResolve", "⏳ Le vote se ferme dans quelques secondes."); return; }
  if (state.voteTimer && state.voteTimerEnd && state.voteTimerEnd - Date.now() > DERNIERES_SECONDES_MS) {
    voteRaccourci = true;
    clearVoteTimer();
    state.voteTimerEnd = Date.now() + DERNIERES_SECONDES_MS;
    state.voteTimer = setTimeout(() => { resolveDayVote(); }, DERNIERES_SECONDES_MS);
    state.io.emit("voteResumed", { endsAt: state.voteTimerEnd, durationMs: state.voteDureeMs, serverNow: Date.now() });
    return;
  }
  // Pas de vote en cours, ou déjà dans ses dernières secondes : il se ferme tout de suite
  state.dayResolutionPending = true;
  clearVoteTimer();
  setTimeout(() => {
    state.dayResolutionPending = false;
    resolveDayVote();
  }, 800);
}

function handleSkipDayVote(socket) {
  if (!isMJ(socket.id) || state.phase !== "day") return;
  if (state.resolutionJourEnCours || state.dayResolutionPending) { voteDejaClos(); return; }
  clearVoteTimer();
  state.lockedVoters.clear();
  state.nbVotesJour++;  // un 1er vote passé fait perdre sa chance à l'Ange
  state.corbeauTarget = null;
  viderVoteDuJour();
  state.io.emit("daySkipped");
  roles.ouvrirNuit(false);
}

function handleVoteWolf(socket, id) {
  if (state.phase !== "wolves" || !hasRole(socket.id, "Loup") || state.deadPlayers.includes(id)) return;
  if (state.roles[id] === "Loup") return;
  resetActivity();
  state.votesWolf[socket.id] = id;
  publierVotesDesLoups();
  checkWolfConsensus();
}

function handleLockWolfVotes(socket) {
  if (!isMJ(socket.id)) return;
  performLockWolfVotes();
}

function handleTiebreakChoice(socket, targetId) {
  // Un maire mort ne tranche plus : le garde-fou des 30 s tire alors au sort
  if (!state.tiebreakPending || socket.id !== state.mayor || state.deadPlayers.includes(state.mayor)) return;
  if (state.tiebreakCandidates.includes(targetId)) trancherEgalite(targetId);
}

// ===== DÉBAT RYTHMÉ PAR LE CONSEIL : Tour de parole, Main levée =====
// Une seule minuterie à la fois (la fin d'une prise de parole). `debat` : { tour, rang, total, fin } ;
// `restant` : le temps gelé par la pause. Hors de l'état sauvegardé : après un plantage, le MJ relance
// simplement le vote. (Le Sablier n'a plus de débat depuis le 2026-11-14 : c'est un vote de 3 minutes.)
const PAROLE_MS  = parseInt(process.env.TOUR_PAROLE_MS) || 15000;
const TOURS_DE_PAROLE = 2;
let minuterieDebat = null, debat = null;

function etatDebat() { return debat ? { ...debat, serverNow: Date.now() } : null; }
function publierDebat() { versMJ("debatMJ", etatDebat()); }
function armerDebat(ms, suite) { clearTimeout(minuterieDebat); minuterieDebat = setTimeout(suite, ms); }
function arreterDebat() {
  clearTimeout(minuterieDebat); minuterieDebat = null;
  if (debat) { debat = null; publierDebat(); }
}
// Le débat est encore ouvert : jour, pas de vote lancé ni de verdict
function debatOuvert() { return state.phase === "day" && !state.resolutionJourEnCours && !state.voteTimer && !state.dayResolutionPending; }

function finDuDebat() {
  minuterieDebat = null; debat = null; publierDebat();
  if (debatOuvert() && !state.gamePaused) startDayVote(1);
}

// Tour de parole : le MJ désigne à voix haute qui commence, puis clique ; chaque vivant parle
// PAROLE_MS à son tour (le son de la tablette marque le passage), deux fois, puis le vote s'ouvre
function handleCommencerTour(socket) {
  if (!isMJ(socket.id) || state.gamePaused || !council.effetDuJour().tourDeParole || !debatOuvert() || debat) return;
  debat = { tour: 1, rang: 1, total: alivePlayers().length, fin: Date.now() + PAROLE_MS };
  armerDebat(PAROLE_MS, paroleSuivante);
  publierDebat();
}
function paroleSuivante() {
  if (!debat || !debat.tour) return;
  if (debat.rang < debat.total) debat.rang++;
  else if (debat.tour < TOURS_DE_PAROLE) { debat.tour++; debat.rang = 1; }
  else return finDuDebat();
  debat.fin = Date.now() + PAROLE_MS;
  armerDebat(PAROLE_MS, paroleSuivante);
  publierDebat();
}
// « Parole suivante » : un joueur qui n'a rien à dire passe la main
function handleParoleSuivante(socket) {
  if (isMJ(socket.id) && !state.gamePaused && debat && debat.tour && debatOuvert()) paroleSuivante();
}

// Pause : le temps restant est gelé, puis repris
function suspendreDebat() {
  if (!debat || debat.restant != null) return;
  debat.restant = Math.max(0, debat.fin - Date.now());
  clearTimeout(minuterieDebat); minuterieDebat = null;
  publierDebat();
}
function reprendreDebat() {
  if (!debat || debat.restant == null) return;
  const ms = debat.restant;
  delete debat.restant;
  debat.fin = Date.now() + ms;
  armerDebat(ms, paroleSuivante);
  publierDebat();
}

// La Main Levée : le village a voté à main levée, le MJ touche le condamné. Le verdict suit le
// même chemin qu'un vote (Ange au premier vote, Idiot, Chasseur, amoureux, victoire).
function handleMainLevee(socket, cibleId) {
  if (!isMJ(socket.id) || state.gamePaused || !council.effetDuJour().mainLevee || !debatOuvert()) return;
  if (!cibleId || state.deadPlayers.includes(cibleId) || !state.players.some(p => p.id === cibleId)) return;
  const vientDEtreAnnonce = council.annoncerEvenement();
  council.finAnnonceMatin(!vientDEtreAnnonce);
  arreterDebat();
  state.resolutionJourEnCours = true;
  versMJ("voteClosMJ");
  state.nbVotesJour++;
  state.corbeauTarget = null;   // ses 2 voix ont été comptées par le MJ, à main levée
  log.info('mainLevee', 'condamné=', playerName(cibleId));
  executerVerdict(cibleId);
}

// IMPORTANT : on MUTE l'objet module.exports (pas de réassignation) pour ne pas
// invalider les références capturées par phases.js et roles.js pendant la phase
// de chargement circulaire.
Object.assign(module.exports, {
  // Core
  clearVoteTimer, oublierEgalite, egaliteEnCours,
  performLockMayorVote, performLockWolfVotes,
  startDayVote, resolveDayVote, etatDepouillement, programmerDepouillement,
  publierVotesDuJour, publierVotesDuMaire, publierVotesDesLoups,
  // Handlers socket
  handleVoteMayor, handleLockMayorVote,
  handleStartVote, handleVoteDay, handleLockDayVotes, handleSkipDayVote,
  handleVoteWolf, handleLockWolfVotes,
  handleTiebreakChoice, handleBulletinSuivant,
  // Débat rythmé par le Conseil (Tour de parole, Main levée)
  etatDebat, arreterDebat, suspendreDebat, reprendreDebat,
  handleCommencerTour, handleParoleSuivante, handleMainLevee,
});
