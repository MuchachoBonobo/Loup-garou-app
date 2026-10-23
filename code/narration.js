// narration.js — Dictionnaire de variantes par transition de phase + narrate()
// La narration est jouée en TTS côté MJ.
const { state } = require('./state');

let narrationEnabled = false;  // OFF par défaut — peut être activé via socket "setNarration"

const NARRATIONS = {
  // === Début de partie ===
  "lobby_to_mayorVote": [
    "Le village est rassemblé. Élisez votre maire — sa voix tranchera en cas d'égalité.",
    "Bienvenue, villageois. Avant que la nuit ne tombe, désignez celui ou celle qui vous représentera.",
    "Une nouvelle aventure commence. Choisissez votre maire pour guider le village."
  ],

  // === Maire élu ===
  "mayorVote_to_mission": [
    "Le maire est élu. Une mission secrète l'attend : il doit choisir trois envoyés.",
    "Le village a son maire. L'heure d'une mission délicate a sonné. Trois noms vont être désignés."
  ],
  "mayorVote_to_cupid": [
    "Le maire prend ses fonctions. La nuit tombe sur le village. Que tout le monde ferme les yeux. Cupidon, lève-toi.",
    "Le maire est en place. La nuit s'installe. Cupidon, à toi de tisser le fil de l'amour.",
    "Notre maire est désigné. Que le village s'endorme. Cupidon, ouvre les yeux."
  ],
  "mayorVote_to_wolves": [
    "Le maire est élu. La nuit s'abat sur le village. Loups-garous, réveillez-vous.",
    "Le maire prend l'écharpe. Les ténèbres tombent. La meute s'éveille.",
    "Notre maire est en place. La nuit règne. Que les loups ouvrent les yeux."
  ],

  // === Mission ===
  "mission_to_missionVote": [
    "L'équipe est désignée. Que les trois envoyés choisissent secrètement leur carte.",
    "Trois envoyés sont nommés. À eux de jouer leur carte dans l'ombre."
  ],
  "missionVote_to_cupid": [
    "Les cartes sont jouées. Le résultat sera révélé à l'aube. Cupidon, à toi maintenant.",
    "Les envoyés ont parlé. Leur secret se révélera demain. Cupidon, lève-toi."
  ],

  // Mission terminée, pas de Cupidon dans la partie : la nuit enchaîne sur les loups.
  "missionVote_to_wolves": [
    "Les cartes sont jouées. Le résultat sera révélé à l'aube. La nuit tombe : loups-garous, réveillez-vous.",
    "Les envoyés ont parlé. Leur secret se révélera demain. Que la meute ouvre les yeux."
  ],

  // === Cupidon → loups ===
  "cupid_to_wolves": [
    "Cupidon a tissé le fil de l'amour. Il referme les yeux. Loups-garous, réveillez-vous.",
    "Les amoureux sont liés à jamais. Cupidon dort à nouveau. La meute s'éveille.",
    "Cupidon retourne au silence. Loups-garous, ouvrez les yeux et désignez votre proie."
  ],

  // === Sœurs jumelles ===
  "*_to_sisters": [
    "Sœurs jumelles, réveillez-vous. Cherchez-vous du regard, sans un mot.",
    "Que les Sœurs jumelles ouvrent les yeux. Reconnaissez-vous dans la nuit.",
    "Sœurs jumelles, levez-vous. Faites-vous signe en silence."
  ],
  "sisters_to_salvateur": [
    "Les Sœurs referment les yeux. Salvateur, à toi : qui protèges-tu cette nuit ?",
    "Les jumelles retournent au sommeil. Salvateur, lève-toi et choisis ton protégé.",
    "Le lien des Sœurs se referme. Salvateur, ouvre les yeux."
  ],
  "sisters_to_wolves": [
    "Les Sœurs referment les yeux. Loups-garous, réveillez-vous.",
    "Les jumelles retournent au silence. La meute s'éveille.",
    "Le lien des Sœurs se referme. Loups, ouvrez les yeux et désignez votre proie."
  ],

  // === Salvateur — transitions vers et depuis ===
  // Avant ce fix, *_to_salvateur n'existait pas → la nuit 2+ passait silencieusement
  // au Salvateur. Ces variantes couvrent l'arrivée sur la phase depuis day/cupid/sisters.
  "*_to_salvateur": [
    "Salvateur, lève-toi. Désigne celui ou celle que tu protégeras cette nuit.",
    "Que le Salvateur ouvre les yeux et choisisse son protégé.",
    "Salvateur, ton bouclier s'éveille. Qui sauveras-tu de la meute ?"
  ],
  "salvateur_to_wolves": [
    "Le Salvateur a posé son bouclier. Il referme les yeux. Loups-garous, réveillez-vous.",
    "La protection est en place. La nuit s'épaissit. La meute s'éveille.",
    "Le Salvateur dort à nouveau. Loups, ouvrez les yeux et désignez votre proie."
  ],

  // === Loups → suite de la nuit ===
  "wolves_to_seer": [
    "Les loups ont choisi leur proie. Ils referment les yeux. Voyante, lève-toi : qui vas-tu observer cette nuit ?",
    "La meute a parlé. Les loups dorment. Voyante, à toi : qui souhaites-tu sonder ?",
    "Une victime est désignée par les loups. Ils s'endorment. Voyante, ouvre les yeux."
  ],
  "wolves_to_corbeau": [
    "Les loups ont choisi. Ils ferment les yeux. Corbeau, à toi : sur qui jetteras-tu ta marque ?",
    "La meute s'endort. Corbeau, lève-toi et désigne ta cible pour le vote de demain."
  ],
  "wolves_to_witch": [
    "Les loups ont choisi leur victime. Ils dorment à nouveau. Sorcière, lève-toi face à tes potions.",
    "La meute referme ses yeux. Sorcière, à toi : sauveras-tu, ou frapperas-tu ?",
    "Les loups ont parlé. Sorcière, ouvre les yeux et choisis ton geste."
  ],
  "wolves_to_day": [
    "Les loups ont fait leur œuvre. La nuit s'achève dans le silence. Que le village se réveille.",
    "La meute s'endort. L'aube se lève. Villageois, ouvrez les yeux."
  ],

  // === Petite Fille (après la Voyante) ===
  "*_to_petiteFille": [
    "Petite Fille, ouvre les yeux. Désigne trois joueurs : tu sauras si un loup se cache parmi eux.",
    "Que la Petite Fille s'éveille. Trois noms, une seule question : la meute est-elle parmi eux ?"
  ],
  "petiteFille_to_corbeau": [
    "La Petite Fille garde son secret. Elle referme les yeux. Corbeau, à toi.",
    "La Petite Fille retourne au sommeil. Corbeau, lève-toi et marque ta cible."
  ],
  "petiteFille_to_witch": [
    "La Petite Fille referme les yeux. Sorcière, c'est ton tour.",
    "La Petite Fille dort à nouveau. Sorcière, ouvre les yeux."
  ],
  "petiteFille_to_day": [
    "La Petite Fille garde son secret. La nuit s'achève. Que le village se réveille.",
    "La Petite Fille se rendort. L'aube se lève."
  ],

  // === Voyante → suite ===
  "seer_to_corbeau": [
    "La voyante a vu ce qu'elle devait voir. Elle referme les yeux. Corbeau, à toi.",
    "Les visions s'estompent. La voyante dort. Corbeau, lève-toi et marque ta cible."
  ],
  "seer_to_witch": [
    "La voyante a percé un secret. Elle referme les yeux. Sorcière, c'est ton tour.",
    "La voyante retourne au sommeil. Sorcière, ouvre les yeux : potion de vie, potion de mort, ton choix.",
    "Les visions s'effacent. Sorcière, à toi de jouer."
  ],
  "seer_to_day": [
    "La voyante a vu. La nuit s'achève. Que le village se réveille.",
    "Les visions s'éteignent. L'aube approche. Ouvrez les yeux."
  ],

  // === Corbeau → suite ===
  "corbeau_to_witch": [
    "Le corbeau a posé sa marque. Il replie ses ailes. Sorcière, à toi.",
    "Le messager noir a parlé. Sorcière, lève-toi maintenant.",
    "Le corbeau retourne dans l'ombre. Sorcière, ouvre les yeux."
  ],
  "corbeau_to_day": [
    "Le corbeau a marqué sa cible. La nuit s'achève. Le village se réveille.",
    "Le messager noir replie ses ailes. L'aube se lève."
  ],

  // === Sorcière / fin de nuit ===
  "witch_to_day": [
    "La sorcière range ses fioles. La nuit s'achève. Le village se réveille pour découvrir ce qu'il en reste.",
    "Les potions sont scellées. L'aube se lève sur le village. Ouvrez les yeux.",
    "La sorcière dort à nouveau. Le jour pointe. Que les villageois s'éveillent."
  ],
  // === Nuit rythmée par le MJ : pause entre deux étapes (nightPause) ===
  // En entrant dans la pause, on endort le rôle précédent ; en sortant, on réveille le suivant.
  "*_to_nightPause": [
    "La nuit tombe sur le village. Que chacun ferme les yeux.",
    "Le village s'endort. Fermez tous les yeux."
  ],
  "cupid_to_nightPause":     ["Cupidon, ferme les yeux."],
  "sisters_to_nightPause":   ["Sœurs jumelles, fermez les yeux."],
  "salvateur_to_nightPause": ["Salvateur, ferme les yeux."],
  "wolves_to_nightPause":    ["Loups-garous, fermez les yeux.", "La meute se rendort. Loups, fermez les yeux."],
  "seer_to_nightPause":      ["Voyante, ferme les yeux."],
  "petiteFille_to_nightPause": ["Petite Fille, ferme les yeux."],
  "corbeau_to_nightPause":   ["Corbeau, ferme les yeux."],
  "witch_to_nightPause":     ["Sorcière, ferme les yeux."],
  "nightPause_to_cupid":     ["Cupidon, ouvre les yeux. Désigne les deux amoureux."],
  "nightPause_to_wolves":    ["Loups-garous, ouvrez les yeux. Choisissez votre victime.", "Que la meute s'éveille et désigne sa proie."],
  "nightPause_to_seer":      ["Voyante, ouvre les yeux. Désigne celui dont tu veux connaître le rôle."],
  "nightPause_to_petiteFille": ["Petite Fille, ouvre les yeux. Désigne trois joueurs : tu sauras si un loup se cache parmi eux."],
  "nightPause_to_corbeau":   ["Corbeau, ouvre les yeux. Qui accuseras-tu demain ?"],
  "nightPause_to_witch":     ["Sorcière, ouvre les yeux. Voici la victime des loups."],
  "nightPause_to_day":       ["Le jour se lève sur le village. Ouvrez les yeux.", "L'aube pointe. Villageois, réveillez-vous."],
  "nightPause_to_missionBonus": ["Le jour se lève sur une mission réussie. Maire, l'information est à toi."],

  "witch_to_missionBonus": [
    "La sorcière range ses fioles. Le jour se lève sur une mission réussie. Maire, l'information est à toi.",
    "La nuit s'achève. La mission a réussi. Maire, choisis trois personnes à inspecter."
  ],
  "missionBonus_to_day": [
    "L'inspection est faite. Le maire garde son secret. Le village peut désormais débattre.",
    "Le maire a inspecté. Les villageois ouvrent les yeux."
  ],

  // === Jour → nuit suivante ===
  "day_to_wolves": [
    "Le village a rendu son verdict. La nuit reprend ses droits. Que tout le monde ferme les yeux. Loups-garous, à vous.",
    "Le débat s'achève. La nuit recouvre le village. Loups, réveillez-vous.",
    "Le verdict est tombé. La nuit s'installe. La meute s'éveille."
  ],

  // === Chasseur ===
  "*_to_chasseur": [
    "Le chasseur, dans un dernier souffle, lève son arme. Choisis ta cible.",
    "La balle du chasseur est encore chargée. Désigne celui ou celle qui partira avec toi.",
    "Le chasseur tombe, mais pas sans riposter. Une dernière balle, une dernière cible."
  ],
  "chasseur_to_day": [
    "Le coup est parti. Le chasseur s'éteint. Le village reprend ses esprits.",
    "Une dernière balle dans le silence. Le chasseur n'est plus."
  ],
  "chasseur_to_wolves": [
    "Le chasseur a tiré. Le silence revient. La nuit s'installe à nouveau. Loups, à vous.",
    "Le coup résonne, puis s'efface. La nuit reprend ses droits."
  ],

  // === Transfert maire ===
  "*_to_mayorTransfer": [
    "Le maire mourant désigne son successeur avant de s'éteindre.",
    "Avant de partir, le maire choisit qui prendra l'écharpe.",
    "Une dernière décision pour le maire : à qui confier le village ?"
  ],
  "mayorTransfer_to_day": [
    "Le nouveau maire prend l'écharpe. Le village peut continuer.",
    "L'écharpe change d'épaules. Le débat reprend."
  ],
  "mayorTransfer_to_wolves": [
    "Le nouveau maire est en place. La nuit reprend ses droits.",
    "L'écharpe est transmise. La nuit s'installe à nouveau."
  ],
  "mayorTransfer_to_missionBonus": [
    "Le nouveau maire prend ses fonctions et hérite de l'inspection. À toi de choisir trois cibles.",
    "L'écharpe a été transmise. Maire, lance ton inspection."
  ]
};

function pickNarrationVariant(fromPhase, toPhase) {
  const key = `${fromPhase}_to_${toPhase}`;
  if (NARRATIONS[key]) return NARRATIONS[key];
  const wildKey = `*_to_${toPhase}`;
  if (NARRATIONS[wildKey]) return NARRATIONS[wildKey];
  return null;
}

function narrate(fromPhase, toPhase) {
  if (!narrationEnabled) return;
  if (!state.mjSocketId) return;          // pas de MJ = pas de speaker = pas de narration
  if (fromPhase === toPhase) return;
  const variants = pickNarrationVariant(fromPhase, toPhase);
  if (!variants || !variants.length) return;
  const text = variants[Math.floor(Math.random() * variants.length)];
  // Petit délai pour laisser les sons de rôle (loup, voyante, etc.) finir.
  // BUG FIX : si la phase a changé entre-temps (par ex. victoire qui setPhase("lobby")),
  // on n'émet plus la narration de la phase qu'on a quittée.
  setTimeout(() => {
    if (state.mjSocketId && state.phase === toPhase) {
      state.io.to(state.mjSocketId).emit("narrate", { text });
    }
  }, 900);
}

function setNarrationEnabled(enabled) {
  narrationEnabled = !!enabled;
}

module.exports = { narrate, setNarrationEnabled, NARRATIONS };
