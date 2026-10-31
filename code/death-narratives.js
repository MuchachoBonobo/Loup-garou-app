// death-narratives.js — Récits de mort variés selon la cause + le rôle.
//
// Chaque cause a un set `default` et peut surcharger par rôle (clé = nom interne du rôle).
// Toutes les variantes utilisent les placeholders {name} et {role} ({role} : le nom du rôle avec
// son article, « la Voyante »). Le MJ les lit à voix haute : tournures neutres, sans « il/elle »
// ni « (e) », pour qu'elles conviennent à tout le monde.
// Le module exporte buildDeathNarrative({ role, cause, name }) → le récit, ou null.

const LOUPS = {
  default: [
    "Pendant que le village dormait, {name} a senti une présence dans l'ombre. La meute s'est régalée.",
    "Au petit matin, on a retrouvé le corps de {name} à l'orée du bois, déchiqueté par des crocs invisibles.",
    "Un cri étouffé dans la nuit, puis plus rien. {name} ne se réveillera pas. Les Loups ont frappé.",
    "{name} n'a rien vu venir. Quand la lune s'est couchée, il ne restait que du sang sur les draps."
  ],
  PetiteFille: [
    "La curiosité aura été fatale à {name}. La Petite Fille posait trop de questions : la meute l'a fait taire.",
    "{name} fouinait de maison en maison. Cette nuit, la Petite Fille a frappé à la mauvaise porte."
  ],
  Voyante: [
    "{name} avait percé bien des secrets. Mais les Loups ont percé le sien, cette nuit.",
    "Les visions de {name} se sont éteintes pour toujours. La meute a trouvé la Voyante."
  ],
  Sorcière: [
    "{name} n'a pas eu le temps de saisir une fiole. Les Loups étaient déjà sur la Sorcière.",
    "Les potions de {name} sont restées scellées. La Sorcière a péri sans avoir pu réagir."
  ],
  Chasseur: [
    "Mais {name} était le Chasseur ! Dans un dernier souffle, le fusil se lève une dernière fois…",
    "Les Loups ont sous-estimé {name}. Le Chasseur a encore une balle à tirer."
  ],
  Cupidon: [
    "{name} avait noué le fil de l'amour. Cette nuit, les Loups l'ont coupé.",
    "Cupidon — {name} — repose désormais dans la même tombe que les espoirs des amoureux."
  ],
  Salvateur: [
    "{name} avait protégé tant d'autres. Cette nuit, personne n'a veillé sur le Salvateur.",
    "Le bouclier de {name} a finalement cédé. Le Salvateur n'aura pas survécu à sa mission."
  ],
  Corbeau: [
    "{name} ne marquera plus personne. Le Corbeau a trouvé plus prédateur que lui.",
    "Les plumes du Corbeau jonchent le sol. {name} ne reviendra pas."
  ],
  Idiot: [
    "{name} riait si fort qu'on aurait cru à une ruse. Hélas, non.",
    "L'Idiot du village est mort comme il a vécu : sans prévoir le coup."
  ],
  Sœurs: [
    "Une des Sœurs jumelles ne se réveillera pas. {name} a péri sous les crocs des Loups.",
    "Le lien des Sœurs vient de se briser. {name} n'est plus."
  ],
};

const SORCIERE = {
  default: [
    "Une fiole brisée, un dernier souffle. La mort a pris {name} au pied de son lit.",
    "{name} a bu sans le savoir. La potion de la Sorcière n'a fait qu'une gorgée.",
    "On a retrouvé {name} sans une marque sur le corps. Mais la Sorcière avait frappé."
  ],
  Loup: [
    "La Sorcière avait visé juste. {name} — un Loup-Garou — gît, foudroyé par la potion de mort.",
    "Un Loup empoisonné cette nuit. {name} ne grognera plus."
  ],
};

const VOTE = {
  default: [
    "Le village a tranché. {name} monte à la potence : c'était {role}.",
    "Acculé, accusé, condamné : {name} part la corde au cou. C'était {role}.",
    "Le verdict est tombé : {name} doit payer. Le village découvre alors que c'était {role}.",
    "{name} n'a pas su convaincre. Le village l'élimine — c'était {role}."
  ],
  Loup: [
    "Le village a démasqué un Loup ! {name} se débat, en vain. Les villageois respirent.",
    "{name} arrache son masque dans un dernier rugissement — c'était bien un Loup !",
    "L'instinct du village a parlé juste. {name} était {role} — un de moins."
  ],
  Idiot: [
    "{name} était l'Idiot du village ! La sentence ne s'applique pas : {name} survit, mais perd à jamais le droit de voter."
  ],
  // Désigné APRÈS le premier vote : l'Ange a laissé passer sa chance
  Ange: [
    "{name} était l'Ange… mais son heure était passée. Le village l'élimine comme les autres.",
    "Trop tard pour s'envoler : {name}, l'Ange, finit à la potence comme tout le monde."
  ],
};

const AMOUR = {
  default: [
    "Sans son amour, le cœur de {name} cesse de battre — c'était {role}.",
    "{name} refuse de survivre à son amour et le suit dans la mort — c'était {role}.",
    "Le lien d'amour était trop fort. {name} expire de chagrin — c'était {role}."
  ],
};

const CHASSEUR = {
  default: [
    "Dans un dernier souffle, le Chasseur a visé {name}. La balle ne pardonne pas — c'était {role}.",
    "Le tir du Chasseur foudroie {name}. C'était {role}.",
    "Le Chasseur emporte {name} dans la tombe. C'était {role}."
  ],
};

const CAUSES = { loups: LOUPS, "sorcière": SORCIERE, vote: VOTE, amour: AMOUR, chasseur: CHASSEUR };

function pickDeathNarrative(role, cause) {
  const byCause = CAUSES[cause];
  if (!byCause) return null;
  const variants = byCause[role] || byCause.default || [];
  if (variants.length === 0) return null;
  const tpl = variants[Math.floor(Math.random() * variants.length)];
  return tpl;
}

// Remplace les placeholders {name} et {role}
function renderNarrative(tpl, name, roleLabel) {
  if (!tpl) return null;
  return tpl.replace(/\{name\}/g, name || "?").replace(/\{role\}/g, roleLabel || "?");
}

// Récit d'une mort (une variante au hasard), le rôle nommé avec son article
function buildDeathNarrative({ role, cause, name }) {
  const tpl = pickDeathNarrative(role, cause);
  return tpl ? renderNarrative(tpl, name, ROLE_LABEL[role] || role) : null;
}

// Nom du rôle tel qu'il apparaît dans les récits de mort, avec son article (« c'était la Voyante »).
const ROLE_LABEL = {
  Loup: "un Loup-Garou", Voyante: "la Voyante", Sorcière: "la Sorcière",
  Chasseur: "le Chasseur", Cupidon: "Cupidon", Villageois: "un Villageois",
  PetiteFille: "la Petite Fille", Idiot: "l'Idiot du village", Ange: "l'Ange",
  Corbeau: "le Corbeau", Salvateur: "le Salvateur", Sœurs: "une des Sœurs jumelles",
};

module.exports = { buildDeathNarrative };
