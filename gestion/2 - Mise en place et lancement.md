# Mise en place et lancement d'une partie

## Le principe en 30 secondes

Ton **ordinateur** fait tourner le jeu. Tous les appareils (tablette du MJ, téléphones des joueurs) se connectent à lui **par le Wi-Fi**, comme s'ils ouvraient un site web. Il n'y a pas besoin d'Internet : il faut seulement que **tout le monde soit sur le même réseau Wi-Fi que l'ordinateur**.

```
   Téléphones des joueurs ──┐
                            ├── même Wi-Fi ── Ordinateur (le jeu tourne ici)
   Tablette du MJ ──────────┘                     │
        │                                         └── Bridge Philips Hue (option)
     Enceinte                                          └── ampoules de la pièce
```

## Matériel

| Quoi | Pourquoi | Obligatoire ? |
|------|----------|---------------|
| L'ordinateur Windows avec le dossier `LoupGarouVoteApp` | Fait tourner le jeu | Oui |
| Une box ou un routeur Wi-Fi | Relie tout le monde | Oui |
| Une tablette (ou l'ordinateur lui-même) pour le MJ | Écran du Maître du Jeu, voix du narrateur, musique, sons | Oui |
| Une enceinte branchée à la tablette du MJ | La musique et les sons sortent de l'appareil du MJ | Fortement conseillé |
| Un chargeur pour la tablette du MJ | L'écran reste allumé toute la partie | Conseillé |
| Bridge + ampoules Philips Hue | Les lumières d'ambiance | Non — voir `3 - Lumieres Philips Hue.md` |
| Un téléphone par joueur | Rôle, votes, actions de nuit | Oui |

## Avant la soirée (une seule fois sur un nouvel ordinateur ou un nouveau réseau)

1. **Déclarer le Wi-Fi comme « privé » sur l'ordinateur** — sinon Windows bloque les téléphones.
   Paramètres → Réseau et Internet → Wi-Fi → (ton réseau) → Type de profil réseau → **Réseau privé**.
2. **Autoriser le jeu dans le pare-feu** : au tout premier lancement, Windows affiche une fenêtre « Autoriser Node.js ? ». Coche **Réseaux privés** et clique sur **Autoriser**.
3. **Faire un essai à blanc** : lancer le jeu (étape 1 ci-dessous), ouvrir l'adresse des joueurs sur ton propre téléphone. Si la page s'ouvre, tout est bon.

## Le jour J

### 1. Démarrer le jeu sur l'ordinateur
- Double-clique sur **`Lancer le jeu.bat`** (dans ce dossier `gestion`).
- Une fenêtre noire s'ouvre et affiche deux adresses, par exemple :
  - `IP locale : http://192.168.1.25:3000` → l'adresse des **joueurs**
  - `MJ : http://192.168.1.25:3000/mj` → l'adresse du **Maître du Jeu**
- **Ne ferme pas cette fenêtre** pendant la partie : la fermer arrête le jeu.

### 2. Préparer la tablette du MJ
- Ouvre l'adresse **MJ** dans le navigateur (Chrome conseillé), passe en plein écran.
- Branche l'enceinte. Touche l'écran une fois : les navigateurs ne jouent aucun son tant qu'on n'a pas touché la page.

### 3. Faire entrer les joueurs
- Sur l'écran MJ, appuie sur **« 📺 Afficher le QR en grand »**.
- Chaque joueur scanne le QR code avec l'appareil photo de son téléphone, tape son **prénom**, et peut prendre un **selfie**.
- Rappelle à tout le monde de **mettre son téléphone en silencieux** (le rappel est affiché sous le QR).
- Les joueurs connectés apparaissent dans la liste « Joueurs connectés » du MJ.

### 4. Choisir les rôles et lancer
- Dans « Démarrage de la partie », règle le nombre de chaque rôle (par défaut : 2 Loups, 1 Cupidon, 1 Voyante, 1 Sorcière, 1 Chasseur ; les autres joueurs sont Villageois). Repère simple : **environ 1 loup pour 4 à 5 joueurs**.
- Coche « Mission » si tu veux les missions.
- Laisse **« Pilotage MJ du jour »** coché (c'est le mode prévu : c'est toi qui ouvres le vote).
- Appuie sur **« 🚀 Lancer la partie »**. Les téléphones vibrent, chacun retourne sa carte pour découvrir son rôle.

### 5. Pendant la partie
- Le panneau vert **« 📜 Pense à dire »** te souffle la phrase à dire à chaque étape.
- La nuit s'enchaîne toute seule : tu annonces, les joueurs concernés agissent sur leur téléphone.
- Pour les **Sœurs jumelles**, une carte rose apparaît : appuie sur « Lancer le timer » une fois que tout le monde a les yeux fermés.
- Le jour, laisse débattre, puis appuie sur **« 🚀 Lancer le vote »** (60 secondes).
- Bouton **Pause** en haut si besoin (les lumières s'assombrissent).

### 6. Fin de soirée
- Ferme la fenêtre noire sur l'ordinateur. C'est tout.

## Jouer ailleurs que chez soi

Les Wi-Fi d'hôtels, de bars, de gîtes ou les réseaux « invités » **empêchent souvent les appareils de se voir entre eux** (c'est une protection appelée « isolation des clients ») : les téléphones n'arrivent alors pas à ouvrir la page du jeu, même si Internet marche.

La solution fiable : **apporter son propre réseau**.
- **Un petit routeur de voyage** (environ 30 à 60 €) : on le branche, l'ordinateur, la tablette et les téléphones s'y connectent. C'est la solution à prévoir dans un kit de location.
- **Dépannage** : le partage de connexion d'un téléphone fonctionne aussi pour quelques joueurs, mais il est moins stable avec beaucoup d'appareils.
- **Lumières** : le Bridge Hue doit être sur le même réseau que l'ordinateur. Sur un nouveau réseau, son adresse change → demande à Claude de mettre à jour la configuration des lumières (voir la fiche lumières).

## Dépannage

| Problème | Solution |
|----------|----------|
| Les téléphones n'ouvrent pas la page | Vérifie qu'ils sont sur **le même Wi-Fi** que l'ordinateur (pas en 4G/5G). Vérifie que le réseau est « privé » et que Node.js est autorisé dans le pare-feu. |
| Le QR code mène à une adresse qui ne marche pas | L'ordinateur a plusieurs connexions (VPN, câble + Wi-Fi…). Coupe le VPN, ou tape à la main l'adresse « IP locale » affichée dans la fenêtre noire. |
| Un joueur a perdu la connexion / fermé la page | Il rouvre l'adresse et retape **exactement le même prénom** : il retrouve sa place et son rôle. |
| L'ordinateur a planté ou la fenêtre a été fermée | Relance `Lancer le jeu.bat`, rouvre la page MJ : une carte propose **« Reprendre la partie »** (l'état est sauvegardé toutes les 5 secondes). Les joueurs se reconnectent tout seuls. |
| Pas de son | Touche l'écran de la tablette MJ, vérifie le volume et l'enceinte, vérifie le bouton narration (🔊 ON). |
| La partie semble bloquée | Ouvre « ⚠️ Contrôles manuels d'urgence » sur l'écran MJ pour forcer l'étape suivante. |
| Les lumières ne réagissent pas | Le jeu continue normalement sans elles. Voir `3 - Lumieres Philips Hue.md`. |

## Tester seul

Sur l'écran MJ, avant de lancer, **« + Bot »** ajoute des joueurs automatiques : pratique pour vérifier que tout marche (sons, lumières) sans réunir personne.
