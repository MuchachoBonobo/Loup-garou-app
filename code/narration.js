// narration.js — Dictionnaire de variantes par transition de phase + narrate()
// La narration est jouée en TTS côté MJ.
const { state, versMJ, auHasard } = require('./state');

let narrationEnabled = false;  // OFF par défaut — peut être activé via socket "setNarration"

const NARRATIONS = {
  // === Début de partie ===
  "lobby_to_mayorVote": [
    "Le village est rassemblé. Élisez votre Maire — sa voix tranchera en cas d'égalité.",
    "Bienvenue, villageois. Avant que la nuit ne tombe, désignez celui ou celle qui vous représentera.",
    "Une nouvelle aventure commence. Choisissez votre Maire pour guider le village."
  ],

  // === Maire élu ===
  "mayorVote_to_mission": [
    "Le Maire est élu. Une mission secrète l'attend : il doit choisir trois envoyés.",
    "Le village a son Maire. L'heure d'une mission délicate a sonné. Trois noms vont être désignés."
  ],
  "mayorVote_to_cupid": [
    "Le Maire prend ses fonctions. La nuit tombe sur le village. Que tout le monde ferme les yeux. Cupidon, lève-toi.",
    "Le Maire est en place. La nuit s'installe. Cupidon, à toi de tisser le fil de l'amour.",
    "Notre Maire est désigné. Que le village s'endorme. Cupidon, ouvre les yeux."
  ],
  "mayorVote_to_wolves": [
    "Le Maire est élu. La nuit s'abat sur le village. Loups-Garous, réveillez-vous.",
    "Le Maire prend l'écharpe. Les ténèbres tombent. La meute s'éveille.",
    "Notre Maire est en place. La nuit règne. Que les Loups ouvrent les yeux."
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

  // Mission terminée, pas de Cupidon dans la partie : la nuit enchaîne sur les Loups.
  "missionVote_to_wolves": [
    "Les cartes sont jouées. Le résultat sera révélé à l'aube. La nuit tombe : Loups-Garous, réveillez-vous.",
    "Les envoyés ont parlé. Leur secret se révélera demain. Que la meute ouvre les yeux."
  ],

  // === Cupidon → Loups ===
  "cupid_to_wolves": [
    "Cupidon a tissé le fil de l'amour. Il referme les yeux. Loups-Garous, réveillez-vous.",
    "Les amoureux sont liés à jamais. Cupidon dort à nouveau. La meute s'éveille.",
    "Cupidon retourne au silence. Loups-Garous, ouvrez les yeux et désignez votre proie."
  ],

  // === Amoureux (après Cupidon) ===
  "*_to_amoureux": [
    "Amoureux, ouvrez les yeux. Regardez-vous : vous êtes liés pour la vie… et pour la mort.",
    "Que les amoureux s'éveillent et se reconnaissent. Si l'un meurt, l'autre le suivra."
  ],
  "amoureux_to_nightPause": ["Amoureux, fermez les yeux."],

  // === Sœurs jumelles ===
  "*_to_sisters": [
    "Sœurs jumelles, réveillez-vous. Cherchez-vous du regard, sans un mot.",
    "Que les Sœurs jumelles ouvrent les yeux. Retrouvez-vous du regard dans la nuit.",
    "Sœurs jumelles, levez-vous. Faites-vous signe en silence."
  ],
  "sisters_to_salvateur": [
    "Les Sœurs referment les yeux. Salvateur, à toi : qui protèges-tu cette nuit ?",
    "Les jumelles retournent au sommeil. Salvateur, lève-toi et choisis ton protégé.",
    "Le lien des Sœurs se referme. Salvateur, ouvre les yeux."
  ],
  "sisters_to_wolves": [
    "Les Sœurs referment les yeux. Loups-Garous, réveillez-vous.",
    "Les jumelles retournent au silence. La meute s'éveille.",
    "Le lien des Sœurs se referme. Loups, ouvrez les yeux et désignez votre proie."
  ],

  // === Salvateur — arrivée sur sa phase depuis day / cupid / sisters ===
  "*_to_salvateur": [
    "Salvateur, lève-toi. Désigne celui ou celle que tu protégeras cette nuit.",
    "Que le Salvateur ouvre les yeux et choisisse son protégé.",
    "Salvateur, ton bouclier s'éveille. Qui sauveras-tu de la meute ?"
  ],
  "salvateur_to_wolves": [
    "Le Salvateur a posé son bouclier. Il referme les yeux. Loups-Garous, réveillez-vous.",
    "La protection est en place. La nuit s'épaissit. La meute s'éveille.",
    "Le Salvateur dort à nouveau. Loups, ouvrez les yeux et désignez votre proie."
  ],

  // === Loups → suite de la nuit ===
  "wolves_to_seer": [
    "Les Loups ont choisi leur proie. Ils referment les yeux. Voyante, lève-toi : qui vas-tu observer cette nuit ?",
    "La meute a parlé. Les Loups dorment. Voyante, à toi : qui souhaites-tu sonder ?",
    "Une victime est désignée par les Loups. Ils s'endorment. Voyante, ouvre les yeux."
  ],
  "wolves_to_corbeau": [
    "Les Loups ont choisi. Ils ferment les yeux. Corbeau, à toi : sur qui jetteras-tu ta marque ?",
    "La meute s'endort. Corbeau, lève-toi et désigne ta cible pour le vote de demain."
  ],
  "wolves_to_witch": [
    "Les Loups ont choisi leur victime. Ils dorment à nouveau. Sorcière, lève-toi face à tes potions.",
    "La meute referme ses yeux. Sorcière, à toi : sauveras-tu, ou frapperas-tu ?",
    "Les Loups ont parlé. Sorcière, ouvre les yeux et choisis ton geste."
  ],
  "wolves_to_day": [
    "Les Loups ont fait leur œuvre. La nuit s'achève dans le silence. Que le village se réveille.",
    "La meute s'endort. L'aube se lève. Villageois, ouvrez les yeux."
  ],

  // === Petite Fille (après la Voyante) ===
  "*_to_petiteFille": [
    "Petite Fille, ouvre les yeux. Désigne trois joueurs : tu sauras si un Loup se cache parmi eux.",
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
    "La Voyante a vu ce qu'elle devait voir. Elle referme les yeux. Corbeau, à toi.",
    "Les visions s'estompent. La Voyante dort. Corbeau, lève-toi et marque ta cible."
  ],
  "seer_to_witch": [
    "La Voyante a percé un secret. Elle referme les yeux. Sorcière, c'est ton tour.",
    "La Voyante retourne au sommeil. Sorcière, ouvre les yeux : potion de vie, potion de mort, ton choix.",
    "Les visions s'effacent. Sorcière, à toi de jouer."
  ],
  "seer_to_day": [
    "La Voyante a vu. La nuit s'achève. Que le village se réveille.",
    "Les visions s'éteignent. L'aube approche. Ouvrez les yeux."
  ],

  // === Corbeau → suite ===
  "corbeau_to_witch": [
    "Le Corbeau a posé sa marque. Il replie ses ailes. Sorcière, à toi.",
    "Le messager noir a parlé. Sorcière, lève-toi maintenant.",
    "Le Corbeau retourne dans l'ombre. Sorcière, ouvre les yeux."
  ],
  "corbeau_to_day": [
    "Le Corbeau a marqué sa cible. La nuit s'achève. Le village se réveille.",
    "Le messager noir replie ses ailes. L'aube se lève."
  ],

  // === Sorcière / fin de nuit ===
  "witch_to_day": [
    "La Sorcière range ses fioles. La nuit s'achève. Le village se réveille pour découvrir ce qu'il en reste.",
    "Les potions sont scellées. L'aube se lève sur le village. Ouvrez les yeux.",
    "La Sorcière dort à nouveau. Le jour pointe. Que les villageois s'éveillent."
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
  "wolves_to_nightPause":    ["Loups-Garous, fermez les yeux.", "La meute se rendort. Loups, fermez les yeux."],
  "seer_to_nightPause":      ["Voyante, ferme les yeux."],
  "petiteFille_to_nightPause": ["Petite Fille, ferme les yeux."],
  "corbeau_to_nightPause":   ["Corbeau, ferme les yeux."],
  "witch_to_nightPause":     ["Sorcière, ferme les yeux."],
  "nightPause_to_cupid":     ["Cupidon, ouvre les yeux. Désigne les deux amoureux."],
  "nightPause_to_wolves":    ["Loups-Garous, ouvrez les yeux. Choisissez votre victime.", "Que la meute s'éveille et désigne sa proie."],
  "nightPause_to_seer":      ["Voyante, ouvre les yeux. Désigne celui dont tu veux connaître le rôle."],
  "nightPause_to_petiteFille": ["Petite Fille, ouvre les yeux. Désigne trois joueurs : tu sauras si un Loup se cache parmi eux."],
  "nightPause_to_corbeau":   ["Corbeau, ouvre les yeux. Qui accuseras-tu demain ?"],
  "nightPause_to_witch":     ["Sorcière, ouvre les yeux. Voici la victime des Loups."],
  "crepuscule_to_nightPause": ["Le village s'endort. Que chacun ferme les yeux.", "La nuit tombe sur le village. Fermez les yeux."],
  "nightPause_to_day":       ["Le jour se lève sur le village. Ouvrez les yeux.", "L'aube pointe. Villageois, réveillez-vous."],
  "nightPause_to_missionBonus": ["Le jour se lève sur une mission réussie. Maire, l'information est à toi."],

  "witch_to_missionBonus": [
    "La Sorcière range ses fioles. Le jour se lève sur une mission réussie. Maire, l'information est à toi.",
    "La nuit s'achève. La mission a réussi. Maire, choisis trois personnes à inspecter."
  ],
  "missionBonus_to_day": [
    "L'inspection est faite. Le Maire garde son secret. Le village peut désormais débattre.",
    "Le Maire a inspecté. Place au débat."
  ],

  // === Jour → nuit suivante ===
  "day_to_wolves": [
    "Le village a rendu son verdict. La nuit reprend ses droits. Que tout le monde ferme les yeux. Loups-Garous, à vous.",
    "Le débat s'achève. La nuit recouvre le village. Loups, réveillez-vous.",
    "Le verdict est tombé. La nuit s'installe. La meute s'éveille."
  ],

  // === Chasseur ===
  "*_to_chasseur": [
    "Le Chasseur, dans un dernier souffle, lève son arme. Choisis ta cible.",
    "La balle du Chasseur est encore chargée. Désigne celui ou celle qui partira avec toi.",
    "Le Chasseur tombe, mais pas sans riposter. Une dernière balle, une dernière cible."
  ],
  "chasseur_to_day": [
    "Le coup est parti. Le Chasseur s'éteint. Le village reprend ses esprits.",
    "Une dernière balle dans le silence. Le Chasseur n'est plus."
  ],
  "chasseur_to_wolves": [
    "Le Chasseur a tiré. Le silence revient. La nuit s'installe à nouveau. Loups, à vous.",
    "Le coup résonne, puis s'efface. La nuit reprend ses droits."
  ],

  // === Transfert Maire ===
  "*_to_mayorTransfer": [
    "Le Maire mourant désigne son successeur avant de s'éteindre.",
    "Avant de partir, le Maire choisit qui prendra l'écharpe.",
    "Une dernière décision pour le maire : à qui confier le village ?"
  ],
  "mayorTransfer_to_day": [
    "Le nouveau Maire prend l'écharpe. Le village peut continuer.",
    "L'écharpe change d'épaules. Le débat reprend."
  ],
  "mayorTransfer_to_wolves": [
    "Le nouveau Maire est en place. La nuit reprend ses droits.",
    "L'écharpe est transmise. La nuit s'installe à nouveau."
  ],
  "mayorTransfer_to_missionBonus": [
    "Le nouveau Maire prend ses fonctions et hérite de l'inspection. À toi de choisir trois cibles.",
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
  const text = auHasard(variants);
  // Petit délai pour laisser les sons de rôle (loup, voyante, etc.) finir ; rien si la
  // phase a changé entre-temps (ex. victoire → lobby)
  setTimeout(() => {
    if (state.phase === toPhase) {
      versMJ("narrate", { text });
    }
  }, 900);
}

function setNarrationEnabled(enabled) {
  narrationEnabled = !!enabled;
}

module.exports = { narrate, setNarrationEnabled };
