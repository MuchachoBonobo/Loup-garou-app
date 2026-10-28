// badges.js — Médailles automatiques distribuées en fin de partie.
//
// Entrée : gameStats, state.roles, state.lovers, state.deadPlayers, state.players, winner.
// Sortie : { playerName: [ { emoji, label, desc } ] } — UNE médaille par joueur, exactement
// (depuis le 2026-10-26, une médaille simple pour qui n'a pas d'exploit).
//
// Règle d'Alexandre (2026-10-23) : trop de médailles casse le bonheur d'en avoir une.
// Chaque médaille récompense un vrai exploit (plus de « Survivant » donné à tous les
// vivants) et chaque joueur ne garde que la plus prestigieuse des siennes (`rang` le
// plus petit). Le but est ludique, pas exhaustif.

// Ordre de prestige (du plus rare au plus courant) : sert à ne garder qu'une médaille.
const RANGS = {
  ange: 1, tireur: 2, flair: 3, insoupconnable: 4, bluff: 5, couple: 6, apothicaire: 7,
  limiere: 8, devineresse: 9, bouclier: 10, soeurs: 11, bouffon: 12, plume: 13,
  etoile: 14, meute: 15, coeur: 16, premiere: 17
};

function buildBadges({ players, roles, deadPlayers, lovers, gameStats, winner, idiotRevealed }) {
  const candidats = {};   // name → array of {emoji, label, desc, rang}
  const give = (name, cle, badge) => {
    if (!name) return;
    if (!candidats[name]) candidats[name] = [];
    candidats[name].push({ ...badge, rang: RANGS[cle] });
  };

  const isDead = id => (deadPlayers || []).includes(id);
  const isAlive = id => !isDead(id);
  const deathLog = gameStats?.deathLog || [];
  const voteLog  = gameStats?.voteLog  || [];   // un tableau de bulletins par vote du jour

  // ⚰️ Première victime
  if (gameStats?.firstDead?.name) {
    give(gameStats.firstDead.name, "premiere", {
      emoji: "⚰️",
      label: "Première victime",
      desc: "A inauguré le cimetière du village."
    });
  }

  // 👼 Ange gardien — l'Ange qui a gagné seul
  if (winner === "ange") {
    players.forEach(p => {
      if (roles[p.id] === "Ange") give(p.name, "ange", {
        emoji: "👼",
        label: "Ange gardien",
        desc: "S'est fait chasser dès le premier vote… exactement comme prévu."
      });
    });
  }

  // 🐺 Chef de meute — loup qui a survécu le plus longtemps
  const wolves = players.filter(p => roles[p.id] === "Loup");
  if (wolves.length > 0) {
    // Loup le plus longtemps en vie : index de mort le plus haut dans deathLog,
    // ou alive en fin de partie.
    let topWolf = null;
    let topScore = -1;
    wolves.forEach(w => {
      const deathIdx = deathLog.findIndex(d => d.name === w.name);
      // Score : alive=∞ équivalent à max+1, sinon index = ancienneté
      const score = deathIdx === -1 ? deathLog.length + 1 : deathIdx;
      if (score > topScore) { topScore = score; topWolf = w; }
    });
    if (topWolf) {
      give(topWolf.name, "meute", {
        emoji: "🐺",
        label: "Chef de meute",
        desc: "Le loup qui a survécu le plus longtemps."
      });
    }
  }

  // 🎭 Roi du Bluff — loup qui survit à la victoire des loups
  if (winner === "wolves") {
    players.forEach(p => {
      if (roles[p.id] === "Loup" && isAlive(p.id)) {
        give(p.name, "bluff", {
          emoji: "🎭",
          label: "Roi du Bluff",
          desc: "Loup démasqué… jamais. Bravo."
        });
      }
    });
  }

  // 🦊 Insoupçonnable — loup qui n'a reçu aucune voix sur au moins 2 votes du village
  if (voteLog.length >= 2) {
    wolves.forEach(w => {
      const vise = voteLog.some(bulletins => bulletins.some(b => b.cible === w.name));
      if (!vise) give(w.name, "insoupconnable", {
        emoji: "🦊",
        label: "Insoupçonnable",
        desc: `Aucune voix contre soi en ${voteLog.length} votes.`
      });
    });
  }

  // 🎯 Flair — joueur du village qui n'a voté que contre des loups (au moins 2 votes)
  players.forEach(p => {
    if (roles[p.id] === "Loup") return;
    const sesVotes = voteLog.map(bulletins => bulletins.find(b => b.votant === p.name)).filter(Boolean);
    if (sesVotes.length >= 2 && sesVotes.every(b => b.cibleRole === "Loup")) {
      give(p.name, "flair", {
        emoji: "🎯",
        label: "Flair",
        desc: `A voté ${sesVotes.length} fois, toujours contre un loup.`
      });
    }
  });

  // 💔 Cœur brisé — amoureux mort par chagrin
  deathLog.forEach(d => {
    if (d.cause === "amour" && d.name) {
      give(d.name, "coeur", {
        emoji: "💔",
        label: "Cœur brisé",
        desc: "A suivi son amour dans la mort."
      });
    }
  });

  // 💘 Couple éternel — les deux amoureux ont survécu
  if (Array.isArray(lovers) && lovers.length === 2 && lovers.every(id => isAlive(id))) {
    lovers.forEach(id => {
      const p = players.find(pl => pl.id === id);
      if (p) give(p.name, "couple", {
        emoji: "💘",
        label: "Couple éternel",
        desc: "A survécu jusqu'à la fin avec son amour."
      });
    });
  }

  // 🔮 Devineresse — la Voyante qui a survécu
  players.forEach(p => {
    if (roles[p.id] === "Voyante" && isAlive(p.id)) {
      const visions = (gameStats?.seerLog || []).length;
      give(p.name, "devineresse", {
        emoji: "🔮",
        label: "Devineresse",
        desc: visions > 0 ? `A percé ${visions} secret${visions>1?"s":""} et survécu.` : "A survécu en tant que Voyante."
      });
    }
  });

  // 👧 Fine limière — la Petite Fille qui a repéré la meute au moins une fois
  const reperages = (gameStats?.petiteFilleLog || []).filter(e => e.auMoinsUnLoup).length;
  if (reperages > 0) {
    players.forEach(p => {
      if (roles[p.id] === "PetiteFille") give(p.name, "limiere", {
        emoji: "👧",
        label: "Fine limière",
        desc: `A flairé la meute ${reperages} fois.`
      });
    });
  }

  // 🛡️ Bouclier inébranlable — le Salvateur vivant en fin de partie (au moins une nuit jouée)
  players.forEach(p => {
    if (roles[p.id] === "Salvateur" && isAlive(p.id) && (gameStats?.nightCount || 0) > 0) {
      give(p.name, "bouclier", {
        emoji: "🛡️",
        label: "Bouclier inébranlable",
        desc: "A protégé le village et survécu."
      });
    }
  });

  // 🧪 Apothicaire émérite — la Sorcière qui a utilisé ses deux potions
  if (gameStats?.witchSaved && gameStats?.witchKilled) {
    const witch = players.find(p => roles[p.id] === "Sorcière");
    if (witch) give(witch.name, "apothicaire", {
      emoji: "🧪",
      label: "Apothicaire émérite",
      desc: "A vidé ses deux fioles pendant la partie."
    });
  }

  // 🔫 Tireur d'élite — Chasseur qui a tué un loup en mourant
  // Détection : le chasseur est mort, et la victime suivante dans deathLog avec cause=chasseur est un Loup.
  deathLog.forEach((d, i) => {
    if (d.role === "Chasseur") {
      const next = deathLog[i + 1];
      if (next && next.cause === "chasseur" && next.role === "Loup") {
        give(d.name, "tireur", {
          emoji: "🔫",
          label: "Tireur d'élite",
          desc: "A descendu un loup en mourant."
        });
      }
    }
  });

  // 👯‍♀️ Sœurs inséparables — les deux Sœurs ont survécu
  const aliveSisters = players.filter(p => roles[p.id] === "Sœurs" && isAlive(p.id));
  if (aliveSisters.length === 2) {
    aliveSisters.forEach(s => give(s.name, "soeurs", {
      emoji: "👯‍♀️",
      label: "Sœurs inséparables",
      desc: "Les jumelles ont traversé toutes les nuits, ensemble."
    }));
  }

  // 🏛️ Étoile du village — le Maire élu qui a survécu
  if (gameStats?.mayorName) {
    const mayor = players.find(p => p.name === gameStats.mayorName);
    if (mayor && isAlive(mayor.id)) {
      give(gameStats.mayorName, "etoile", {
        emoji: "🏛️",
        label: "Étoile du village",
        desc: "Maire jusqu'au bout, et toujours debout."
      });
    }
  }

  // 🤡 Bouffon impardonnable — Idiot démasqué (et épargné) au vote, vivant à la fin
  if (idiotRevealed) {
    players.forEach(p => {
      if (roles[p.id] === "Idiot" && isAlive(p.id)) {
        give(p.name, "bouffon", {
          emoji: "🤡",
          label: "Bouffon impardonnable",
          desc: "Son rôle a été révélé, mais le village l'a épargné."
        });
      }
    });
  }

  // 🪶 Plume noire — Corbeau survivant
  players.forEach(p => {
    if (roles[p.id] === "Corbeau" && isAlive(p.id)) {
      give(p.name, "plume", {
        emoji: "🪶",
        label: "Plume noire",
        desc: "Le Corbeau a survécu à tous ses présages."
      });
    }
  });

  // Une seule médaille par joueur : la plus prestigieuse
  const badges = {};
  Object.entries(candidats).forEach(([name, liste]) => {
    const meilleure = liste.slice().sort((a, b) => a.rang - b.rang)[0];
    const { rang, ...badge } = meilleure;
    badges[name] = [badge];
  });

  // Chacun repart avec une médaille (demande d'Alexandre, 2026-10-26) : qui n'a pas d'exploit
  // reçoit une médaille simple selon sa fin de partie. Les exploits restent rares.
  const aGagne = id => winner === "wolves" ? roles[id] === "Loup"
    : winner === "villagers" ? roles[id] !== "Loup"
    : winner === "lovers" ? (lovers || []).includes(id)
    : winner === "ange" ? roles[id] === "Ange" : false;
  players.forEach(p => {
    if (!p.name || badges[p.name]) return;
    badges[p.name] = [isDead(p.id)
      ? { emoji: "🕯️", label: "Au champ d'honneur", desc: "N'a pas vu la fin, mais a joué jusqu'au bout." }
      : aGagne(p.id)
        ? { emoji: "🏆", label: "Victoire", desc: "Debout à la fin, dans le camp gagnant." }
        : { emoji: "🛡️", label: "Survie", desc: "A survécu jusqu'au bout de la partie." }];
  });
  return badges;
}

module.exports = { buildBadges, RANGS };
