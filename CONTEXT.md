# Contexte produit — LoupGarouVoteApp

Ce document décrit le **pourquoi** et le **pour qui** du projet. Le **quoi** et le **comment** sont dans `HANDOFF.md`.

## Vision

Offrir aux joueurs un **moment interactif, immersif et mémorable** autour du jeu du Loup-Garou. Avant toute considération technique ou commerciale, la question à se poser sur chaque décision est : **est-ce que ça aide les joueurs à passer un bon moment ?**

L'immersion passe par :
- Une **mise en scène** soignée (narration vocale, lumières connectées Hue, cartes plein écran, sons d'ambiance).
- Une **mécanique fluide** qui efface autant que possible la friction du MJ humain (auto-démarrage des votes, transitions de phase, narration assistée).
- Des **moments forts** dramatisés (Conseil des Morts, évènements narratifs, sprint final 30s, voile de nuit en filet de sécurité).
- Des **cartes narratives plein écran** (récap de nuit, évènements du Conseil des Morts) qui jouent un double rôle : **renforcer l'ambiance** pour les joueurs, et **soulager le MJ** en lui donnant un support visuel et un texte de synthèse à raconter — il n'a pas à tout improviser.

## Public

### Aujourd'hui — cercle d'amis
Le jeu est conçu pour être joué **en présentiel sur canapé** avec un groupe d'amis. Le rituel reste celui du Loup-Garou classique : **la nuit, tous les joueurs ferment les yeux**, et seuls ceux qui ont une action à faire les rouvrent quand le MJ (ou la narration vocale) les y invite. C'est le MJ — ou la voix narrative quand le mode autonome est activé — qui rythme l'ouverture et la fermeture des yeux.

Les mécaniques type voile de nuit, hold-to-reveal du rôle et absence de vibrations nocturnes ne remplacent pas ce rituel : ce sont des **filets de sécurité** qui empêchent un joueur qui aurait jeté un œil furtif de glaner une information par-dessus l'épaule d'un voisin. L'app doit garantir que **même si quelqu'un triche en regardant**, il ne voit rien de compromettant.

Caractéristiques de ce public :
- Connaît déjà les bases du Loup-Garou (la complexité des rôles est OK).
- Tolère les imperfections (c'est de l'auto-hébergé sur le réseau local).
- Joue pour rigoler ensemble, pas pour gagner à tout prix.

### Demain — inconnus / clients
L'objectif à moyen terme est d'**ouvrir l'expérience à des inconnus** : soirées organisées, animation d'évènements, location de la mise en scène complète (lumières Hue + tablette MJ + interface joueurs).

Implications pour les choix de design :
- L'interface doit rester **compréhensible sans explication préalable** (un joueur qui n'a jamais joué doit pouvoir suivre).
- Le MJ doit pouvoir **animer une partie pour des gens qu'il ne connaît pas** sans avoir à improviser : la narration TTS, les cartes récap, les évènements scénarisés portent la moitié du travail.
- La robustesse compte plus que les fonctionnalités exotiques (un crash en plein milieu d'une partie payante = catastrophe).

## Modèle économique

Activité de **divertissement secondaire** — pas le revenu principal. Le développement se fait sur temps libre, donc :
- Pas de pression pour livrer vite si la qualité n'y est pas.
- Privilégier les ajouts qui **élèvent l'expérience** plutôt que ceux qui font joli sur une roadmap.
- Les fonctionnalités "techniques" (refonte, tests unitaires, etc.) sont OK mais ne doivent pas passer devant les améliorations d'expérience joueur.

## Priorités de décision

Quand un arbitrage est nécessaire, voici l'ordre :

1. **Les joueurs passent-ils un bon moment ?** — critère absolu.
2. **Est-ce que ça renforce l'immersion ?** — narration, mise en scène, dramaturgie.
3. **Est-ce que ça tient la route pour des inconnus ?** — clarté, robustesse, anti-friction.
4. **Est-ce maintenable pour un développeur solo en temps libre ?** — simplicité, pas d'over-engineering.

## Ton et style

- Narrations TTS : **mystérieux, théâtral, légèrement gothique** — on raconte un village médiéval hanté, pas un tutoriel.
- UI : **lisible à distance** (jeu en présentiel, l'écran est souvent posé au centre de la table ou tenu à bout de bras).
- Évènements du Conseil des Morts : **noms évocateurs** (Émeute, Paranoïa, Éclipse…), descriptions courtes et imagées.

## Ce qui est hors-scope (pour l'instant)

- Mode en ligne / multi-tables distantes — l'expérience cible est présentielle.
- Internationalisation — français uniquement tant qu'on n'a pas validé le concept.
- Monétisation in-app, comptes utilisateurs, persistance long terme — pas pertinent pour le format actuel.
