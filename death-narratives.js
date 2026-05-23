// death-narratives.js — Récits de mort variés selon la cause + le rôle.
//
// Chaque cause a un set `default` et peut surcharger par rôle (clé = nom interne du rôle).
// Toutes les variantes utilisent les placeholders {name} et {role}.
// Le module exporte pickDeathNarrative(role, cause) → string ou null.

const LOUPS = {
  default: [
    "Pendant que le village dormait, {name} a senti une présence dans l'ombre. La meute s'est régalée.",
    "Au petit matin, on a retrouvé le corps de {name} à l'orée du bois, déchiqueté par des crocs invisibles.",
    "Un cri étouffé dans la nuit, puis plus rien. {name} ne se réveillera pas. Les loups ont frappé.",
    "{name} n'a rien vu venir. Quand la lune s'est couchée, il ne restait que du sang sur les draps."
  ],
  PetiteFille: [
    "La curiosité aura été fatale à {name}. Les Loups l'ont surprise les yeux à peine entrouverts.",
    "{name} avait osé regarder. La meute n'a pas pardonné cette indiscrétion."
  ],
  Voyante: [
    "{name} avait percé bien des secrets. Mais les loups ont percé le sien, cette nuit.",
    "Les visions de {name} se sont éteintes pour toujours. La meute a trouvé la Voyante."
  ],
  Sorcière: [
    "{name} n'a pas eu le temps de saisir une fiole. Les loups étaient déjà sur elle.",
    "Les potions de {name} sont restées scellées. La Sorcière a péri sans avoir pu réagir."
  ],
  Chasseur: [
    "Mais {name} était le Chasseur ! Avant de s'éteindre, il arme une dernière fois son fusil…",
    "Les loups ont sous-estimé {name}. Le Chasseur a encore une balle à tirer."
  ],
  Cupidon: [
    "{name} avait noué le fil de l'amour. Cette nuit, les loups l'ont coupé.",
    "Cupidon — {name} — repose désormais dans la même tombe que les espoirs des amoureux."
  ],
  Salvateur: [
    "{name} avait protégé tant d'autres. Personne ne l'a protégé cette nuit.",
    "Le bouclier de {name} a finalement cédé. Le Salvateur n'aura pas survécu à sa mission."
  ],
  Corbeau: [
    "{name} ne marquera plus personne. Le Corbeau s'est fait dévorer par plus prédateur que lui.",
    "Les plumes du Corbeau jonchent le sol. {name} ne reviendra pas."
  ],
  Idiot: [
    "{name} riait tellement, on aurait juré qu'il avait compris quelque chose. Hélas, non.",
    "L'Idiot du village est mort comme il a vécu : sans prévoir le coup."
  ],
  Sœurs: [
    "Une des Sœurs jumelles ne se réveillera pas. {name} a péri sous les crocs des loups.",
    "Le lien des Sœurs vient de se briser. {name} n'est plus."
  ],
  Loup: [
    "Un loup est mort cette nuit. {name} a péri sous les crocs d'un autre prédateur — ou par un piège que personne n'a vu."
  ],
};

const SORCIERE = {
  default: [
    "Une fiole brisée, un dernier souffle. {name} s'est effondré au pied de son lit, empoisonné.",
    "{name} a bu sans le savoir. La potion de la Sorcière n'a fait qu'une gorgée.",
    "On a retrouvé {name} sans une marque sur le corps. Mais la Sorcière avait frappé."
  ],
  Loup: [
    "La Sorcière avait visé juste. {name} — un loup — gît, foudroyé par la potion de mort.",
    "Un loup empoisonné cette nuit. {name} ne grognera plus."
  ],
};

const VOTE = {
  default: [
    "Le village a tranché. {name} est conduit à la potence — il était {role}.",
    "Acculé, accusé, condamné. {name} part la corde au cou. Il était {role}.",
    "Le verdict est tombé : {name} doit payer. Le village découvre alors qu'il était {role}.",
    "{name} n'a pas su convaincre. Les villageois l'éliminent — c'était {role}."
  ],
  Loup: [
    "Le village a démasqué un loup ! {name} se débat, en vain. Les villageois respirent.",
    "{name} arrache son masque dans un dernier rugissement — c'était bien un loup !",
    "L'instinct du village a parlé juste. {name} était {role} — un de moins."
  ],
  Idiot: [
    "{name} était l'Idiot du village ! La sentence ne s'applique pas — il survit, mais perd à jamais le droit de voter."
  ],
};

const AMOUR = {
  default: [
    "Le cœur de {name} n'a pas supporté le départ de son aimé(e). Il/elle s'éteint dans un soupir — c'était {role}.",
    "{name} a refusé de vivre seul(e). Il/elle suit son amour dans la mort — c'était {role}.",
    "Le lien d'amour était trop fort. {name} expire de chagrin — c'était {role}."
  ],
};

const CHASSEUR = {
  default: [
    "Dans un dernier souffle, le Chasseur a visé {name}. La balle ne pardonne pas — il/elle était {role}.",
    "{name} tombe foudroyé(e) par le tir du Chasseur. Il/elle était {role}.",
    "Le Chasseur emporte {name} dans la tombe. Il/elle était {role}."
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

// Helper combiné : pick + render
function buildDeathNarrative({ role, cause, name, roleLabel }) {
  const tpl = pickDeathNarrative(role, cause);
  return tpl ? renderNarrative(tpl, name, roleLabel) : null;
}

module.exports = { pickDeathNarrative, renderNarrative, buildDeathNarrative };
