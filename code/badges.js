// badges.js — Médailles automatiques distribuées en fin de partie.
//
// Entrée : gameStats, state.roles, state.lovers, state.deadPlayers, state.players, winner.
// Sortie : { playerName: [ { emoji, label, desc } ] }
//
// Une médaille n'est attribuée qu'à 1 seul joueur (le plus éligible). Plusieurs
// médailles peuvent revenir au même joueur. Le but est ludique, pas exhaustif.

function buildBadges({ players, roles, deadPlayers, lovers, gameStats, winner, idiotRevealed }) {
  const badges = {};   // name → array of {emoji, label, desc}
  const give = (name, badge) => {
    if (!name) return;
    if (!badges[name]) badges[name] = [];
    badges[name].push(badge);
  };

  const isDead = id => (deadPlayers || []).includes(id);
  const isAlive = id => !isDead(id);
  const deathLog = gameStats?.deathLog || [];

  // 1) ⚰️ Première victime
  if (gameStats?.firstDead?.name) {
    give(gameStats.firstDead.name, {
      emoji: "⚰️",
      label: "Première victime",
      desc: "A inauguré le cimetière du village."
    });
  }

  // 2) 🏆 Survivant — tous les vivants en fin de partie
  players.forEach(p => {
    if (isAlive(p.id)) {
      give(p.name, {
        emoji: "🏆",
        label: "Survivant",
        desc: "A vu la fin de la partie."
      });
    }
  });

  // 3) 🐺 Chef de meute — loup qui a survécu le plus longtemps (ou tué le plus)
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
      give(topWolf.name, {
        emoji: "🐺",
        label: "Chef de meute",
        desc: "Le loup qui a survécu le plus longtemps."
      });
    }
  }

  // 4) 🤡 Roi du Bluff — loup qui survit à la victoire des loups
  if (winner === "wolves") {
    players.forEach(p => {
      if (roles[p.id] === "Loup" && isAlive(p.id)) {
        give(p.name, {
          emoji: "🤡",
          label: "Roi du Bluff",
          desc: "Loup démasqué… jamais. Bravo."
        });
      }
    });
  }

  // 5) 💔 Cœur brisé — amoureux mort par chagrin
  deathLog.forEach(d => {
    if (d.cause === "amour" && d.name) {
      give(d.name, {
        emoji: "💔",
        label: "Cœur brisé",
        desc: "Est mort de chagrin en suivant son amour."
      });
    }
  });

  // 6) 💘 Couple éternel — les deux amoureux ont survécu
  if (Array.isArray(lovers) && lovers.length === 2 && lovers.every(id => isAlive(id))) {
    lovers.forEach(id => {
      const p = players.find(pl => pl.id === id);
      if (p) give(p.name, {
        emoji: "💘",
        label: "Couple éternel",
        desc: "A survécu jusqu'à la fin avec son amoureux·se."
      });
    });
  }

  // 7) 🔮 Devineresse — la Voyante qui a survécu
  players.forEach(p => {
    if (roles[p.id] === "Voyante" && isAlive(p.id)) {
      const visions = (gameStats?.seerLog || []).length;
      give(p.name, {
        emoji: "🔮",
        label: "Devineresse",
        desc: visions > 0 ? `A percé ${visions} secret${visions>1?"s":""} et survécu.` : "A survécu en tant que Voyante."
      });
    }
  });

  // 8) 🛡 Bouclier — le Salvateur qui a sauvé au moins une fois (savedBySalvateur dans recaps)
  // Plus simple : Salvateur vivant en fin de partie + au moins une nuit jouée
  players.forEach(p => {
    if (roles[p.id] === "Salvateur" && isAlive(p.id) && (gameStats?.nightCount || 0) > 0) {
      give(p.name, {
        emoji: "🛡",
        label: "Bouclier inébranlable",
        desc: "A protégé le village et survécu."
      });
    }
  });

  // 9) 🧪 Apothicaire émérite — la Sorcière qui a utilisé ses deux potions
  if (gameStats?.witchSaved && gameStats?.witchKilled) {
    const witch = players.find(p => roles[p.id] === "Sorcière");
    if (witch) give(witch.name, {
      emoji: "🧪",
      label: "Apothicaire émérite",
      desc: "A vidé ses deux fioles pendant la partie."
    });
  }

  // 10) 🔫 Tireur d'élite — Chasseur qui a tué un loup en mourant
  // Détection : le chasseur est mort, et la victime suivante dans deathLog avec cause=chasseur est un Loup.
  deathLog.forEach((d, i) => {
    if (d.role === "Chasseur") {
      const next = deathLog[i + 1];
      if (next && next.cause === "chasseur" && next.role === "Loup") {
        give(d.name, {
          emoji: "🔫",
          label: "Tireur d'élite",
          desc: "A descendu un loup en mourant."
        });
      }
    }
  });

  // 11) 👯‍♀️ Sœurs inséparables — les deux Sœurs ont survécu
  const aliveSisters = players.filter(p => roles[p.id] === "Sœurs" && isAlive(p.id));
  if (aliveSisters.length === 2) {
    aliveSisters.forEach(s => give(s.name, {
      emoji: "👯‍♀️",
      label: "Sœurs inséparables",
      desc: "Les jumelles ont traversé toutes les nuits, ensemble."
    }));
  }

  // 12) 🏛️ Bonne étoile — le Maire élu qui a survécu
  if (gameStats?.mayorName) {
    const mayor = players.find(p => p.name === gameStats.mayorName);
    if (mayor && isAlive(mayor.id)) {
      give(gameStats.mayorName, {
        emoji: "🏛️",
        label: "Étoile du village",
        desc: "Élu Maire et toujours debout à la fin."
      });
    }
  }

  // 13) 🤡 Bouffon impardonnable — Idiot révélé qui a survécu jusqu'à la fin
  // BUG FIX 8 : on ne donne ce badge que si l'Idiot a effectivement été démasqué
  if (idiotRevealed) {
    players.forEach(p => {
      if (roles[p.id] === "Idiot" && isAlive(p.id)) {
        give(p.name, {
          emoji: "🤡",
          label: "Bouffon impardonnable",
          desc: "A été démasqué, mais le village l'a épargné."
        });
      }
    });
  }

  // 14) 🪶 Plume noire — Corbeau survivant
  players.forEach(p => {
    if (roles[p.id] === "Corbeau" && isAlive(p.id)) {
      give(p.name, {
        emoji: "🪶",
        label: "Plume noire",
        desc: "Le Corbeau a survécu à tous ses présages."
      });
    }
  });

  return badges;
}

module.exports = { buildBadges };
