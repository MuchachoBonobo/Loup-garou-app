# 🐺 Loup-Garou — Rapport d'Analyse du Code

Analyse complète de `server.js`, `public/index.html` et `public/mj.html`.

Contexte : usage soirée entre amis (LAN, 6-15 joueurs, MJ humain).

---

## ✅ Ce qui est solide

Ton code est en réalité **plus riche** que ta description. En lisant, j'ai trouvé :

- Rôles supplémentaires déjà implémentés : **Petite Fille, Idiot du Village, Corbeau** (en plus de Loup, Voyante, Sorcière, Chasseur, Cupidon, Villageois, Maire)
- Phase **Mission** (équipe de 3, cartes secrètes, bonus pour le maire)
- Gestion fine des **égalités** (le maire tranche, fallback aléatoire)
- **Reconnexion** des joueurs avec restauration d'état
- **Chat des morts** + chat post-partie
- **Détection partie bloquée** (timeouts par phase)
- **Rate-limiting** des votes (anti-spam)
- 4 modes de vote (Libre / Verrouillé / Express / Noir)
- Gestion du **Chasseur amoureux** + **Maire chasseur** (cas tordus bien gérés)
- Vision spectateur pour les morts
- Animations narratives, ambiance sonore, QR code, statistiques de fin

C'est un boulot très propre. Les bugs ci-dessous sont surtout des cas-limites.

---

## 🔴 BUGS CRITIQUES (à corriger en priorité)

### 1. La reconnexion automatique ne fonctionne pas — `localStorage` jamais sauvegardé

**`public/index.html`, ligne 568 :**
```js
if (_wasConnected) socket.emit("register", localStorage.getItem("lgName") || "");
```

Mais nulle part dans `join()` on ne fait `localStorage.setItem("lgName", name)`. Résultat : si un joueur perd sa connexion, la reconnexion automatique envoie une chaîne vide → le serveur l'ignore.

**Correction (ligne ~836, dans `join()`) :**
```js
function join() {
  const name = document.getElementById("name").value.trim();
  if (!name) return;
  localStorage.setItem("lgName", name);   // ← AJOUTER
  socket.emit("register", name);
  document.getElementById("lobby").style.display = "none";
}
```

---

### 2. Mort en cascade pendant `doResolveNight` — risque d'incohérence

**`server.js`, ligne 568-572 :**
```js
deaths.forEach(d => {
  if (!gameStats.firstDead) gameStats.firstDead = { name: d.name, role: d.role };
  gameStats.deathLog.push(d);
  killPlayer(d.id);   // ← peut basculer vers phase "chasseur" ou "mayorTransfer"
});
```

Si la victime des loups ET la cible de la sorcière doivent mourir, et que la première mort déclenche `setPhase("chasseur")` (car chasseur), le `forEach` continue et appelle `killPlayer` sur le 2ᵉ alors qu'on n'est plus en phase de résolution → la 2ᵉ mort peut court-circuiter le tir du chasseur.

**Correction :** sortir de la boucle dès qu'un changement de phase a été déclenché.
```js
for (const d of deaths) {
  if (!gameStats.firstDead) gameStats.firstDead = { name: d.name, role: d.role };
  gameStats.deathLog.push(d);
  killPlayer(d.id);
  if (phase === "chasseur" || phase === "mayorTransfer") break;
}
```

---

### 3. Lobby : nom rejeté à tort si quelqu'un s'est déconnecté

**`server.js`, ligne 766-768 :**
```js
if (phase === "lobby" && playerRegistry[key]) {
  socket.emit("registerError", "Ce prénom est déjà pris."); return;
}
```

Le `disconnect` ligne 1266 supprime bien du `playerRegistry` **uniquement si `phase === "lobby"`**. Mais entre deux parties (après `gameReset`), `playerRegistry` peut contenir des entrées fantômes si quelqu'un s'est déconnecté pendant la partie précédente puis reconnecté avec un autre prénom.

**Correction :** dans le bloc lobby, vérifier si l'entrée correspond à un socket toujours connecté :
```js
if (phase === "lobby" && playerRegistry[key]) {
  const existing = players.find(p => p.name.toLowerCase() === key);
  if (existing && existing.id !== socket.id) {
    // Si le socket existant est encore connecté, refuser
    if (io.sockets.sockets.get(existing.id)) {
      socket.emit("registerError", "Ce prénom est déjà pris."); return;
    }
    // Sinon : remplacer l'ancien socket
    existing.id = socket.id;
    playerRegistry[key].id = socket.id;
    playerRegistry[key].oldId = socket.id;
    io.emit("players", players);
    return;
  }
}
```

---

### 4. `lockDayVotes` non protégé contre le double-clic

**`server.js`, ligne 1199-1203 :**
```js
socket.on("lockDayVotes", () => {
  if (!isMJ(socket.id) || phase !== "day") return;
  if (mjSocketId) io.to(mjSocketId).emit("soundPlay", "crowd_gasp");
  setTimeout(() => resolveDayVote(), 800);
});
```

Si le MJ double-clique « Terminer » : 2 `setTimeout`, donc 2 résolutions consécutives → la 2ᵉ tournera dans le vide ou pire (le 1er a déjà fait `votesDay = {}`). Mais entre les deux, le timer héritage `voteTimer` peut aussi se déclencher.

**Correction :**
```js
let dayResolutionPending = false;

socket.on("lockDayVotes", () => {
  if (!isMJ(socket.id) || phase !== "day" || dayResolutionPending) return;
  dayResolutionPending = true;
  clearVoteTimer();   // bloque le timer s'il existe
  if (mjSocketId) io.to(mjSocketId).emit("soundPlay", "crowd_gasp");
  setTimeout(() => { resolveDayVote(); dayResolutionPending = false; }, 800);
});
```

(Et remettre `dayResolutionPending = false` aussi dans `resetGameState`.)

---

### 5. Spam de `sendDeadVision` à chaque vote

**`server.js`, lignes 1039 et 1187 :**
```js
deadPlayers.forEach(did => sendDeadVision(did));
```

Appelé **à chaque** `voteWolf` et `voteDay`. Pour 6 morts × 50 votes = 300 émissions inutiles d'un objet contenant tous les rôles. Lent + saturation réseau sur un wifi de soirée.

**Correction :** ne renvoyer la vision morts que quand l'état change significativement (nouvelle mort, fin de tour de vote). Les votes qui mettent à jour les compteurs sont déjà broadcastés via `votesDayMJ` / `wolfVotesUpdate`.

```js
// Supprime simplement les deux lignes — la vision spectateur sera mise à jour
// au prochain événement deadPlayers / phase / dayCounts
```

---

### 6. Faille XSS sur les noms et messages de chat

**Plusieurs endroits :**
- `index.html` ligne 1693 : `rl.innerHTML += ...${p.name}...`
- `mj.html` ligne 659 : `el.innerHTML = '...${msg.name}</span>${msg.text}'`
- `mj.html` ligne 599 : `div.innerHTML += '...${p.name}...'`

Un joueur qui s'inscrit avec le nom `<img src=x onerror=alert(1)>` peut exécuter du JS chez tous les autres. Pour soirée entre amis le risque est limité, mais c'est trivial à exploiter.

**Correction :**
- Côté serveur (server.js, ligne 738-742, dans `register`) : limiter la longueur et filtrer les caractères dangereux.
  ```js
  const trimmed = name.trim().slice(0, 20).replace(/[<>"'&]/g, '');
  if (!trimmed || trimmed.length < 1) return;
  ```
- Côté client : remplacer les `innerHTML += ...${variable}...` par création DOM avec `textContent`. Exemple ligne 1693 :
  ```js
  const row = document.createElement("div");
  row.className = "dead-role-row";
  const span1 = document.createElement("span");
  span1.textContent = `${p.name} ${badges}`;
  const span2 = document.createElement("span");
  span2.textContent = ROLE_DISPLAY[r] || r;
  row.appendChild(span1); row.appendChild(span2);
  rl.appendChild(row);
  ```

---

## 🟠 BUGS MOYENS

### 7. Pas de validation de la config de rôles

**`server.js`, ligne 651-657 :** Si tu mets 5 loups sur 4 joueurs, `add()` retourne silencieusement et le reste devient Villageois. Aucune alerte au MJ. Pareil si `loups + voyante + sorcière + cupidon > nombre de joueurs`.

**Correction :** valider en début d'`assignAndStart` :
```js
function assignAndStart(config, playerList) {
  const totalSpecial = (config.cupidon||0) + (config.voyante||0) + (config.sorciere||0)
    + (config.chasseur||0) + (config.loup||0) + (config.petiteFille||0)
    + (config.idiot||0) + (config.corbeau||0);
  if (totalSpecial > playerList.length) {
    if (mjSocketId) io.to(mjSocketId).emit("autoResolve",
      `⚠️ Trop de rôles (${totalSpecial}) pour ${playerList.length} joueurs.`);
    return;
  }
  if ((config.loup||0) < 1) {
    if (mjSocketId) io.to(mjSocketId).emit("autoResolve",
      "⚠️ Il faut au moins 1 loup.");
    return;
  }
  if ((config.loup||0) >= playerList.length / 2) {
    if (mjSocketId) io.to(mjSocketId).emit("autoResolve",
      "⚠️ Trop de loups : ils sont déjà majoritaires.");
    return;
  }
  // ... reste du code existant
}
```

---

### 8. Phase `mission` peut bloquer indéfiniment côté MJ (pas de stuck timer)

**`server.js`, ligne 240-245 :**
```js
if (['wolves','seer','corbeau','witch','cupid'].includes(p)) {
  startStuckTimer();
}
```

Les phases `mission`, `missionVote`, `missionBonus`, `mayorVote`, `chasseur`, `mayorTransfer` ne déclenchent pas le stuck timer. Or il y a déjà des timeouts dédiés (`MISSION_TEAM_TIMEOUT_MS`, etc.) — c'est OK pour mission, **mais `chasseur` et `mayorTransfer` n'ont aucun timeout** : si le joueur ferme son onglet, la partie est figée.

**Correction :** ajouter un timeout pour `chasseur` et `mayorTransfer` :
```js
if (p === "chasseur") {
  const chasseurId = Object.keys(roles).find(id => roles[id] === "Chasseur" && deadPlayers.includes(id));
  setTimeout(() => {
    if (phase === "chasseur") {
      const alive = alivePlayers().filter(p => p.id !== chasseurId);
      if (alive.length > 0) {
        const random = alive[Math.floor(Math.random() * alive.length)];
        io.emit("autoResolve", "⏱ Le Chasseur a tardé — tir aléatoire.");
        // Simuler le tir
        // (réutiliser la logique de chasseurAction)
      }
    }
  }, 60000); // 60s
}
```

---

### 9. Timer du MJ légèrement décalé par rapport aux joueurs

**`mj.html`, ligne 666 :**
```js
mjEndsAt = data.endsAt;
```

Pas de correction de latence comme côté joueur (`index.html` ligne 1559-1562). Sur un wifi un peu lent, l'écart peut atteindre 500ms.

**Correction :**
```js
socket.on("voteStarted", data => {
  if (data.serverNow && data.endsAt) {
    const networkLatency = Date.now() - data.serverNow;
    mjEndsAt = data.endsAt + networkLatency;
  } else {
    mjEndsAt = data.endsAt;
  }
  mjTotalMs = data.duration;
  // ...
});
```

---

### 10. Auto-vote autorisé

**`server.js`, ligne 1166-1167 :** rien n'empêche un joueur de voter pour lui-même au vote du jour ou du maire.

C'est peut-être voulu (auto-désignation comme bouc-émissaire), mais le client filtre déjà `p.id !== socket.id` pour le bouton « Voter » côté UI. Donc incohérence : impossible via l'UI, possible via console JS. **À toi de décider** : si tu veux interdire, ajouter `if (id === socket.id) return;` dans `voteDay` et `voteMayor`.

---

### 11. `mayorTransfer` défini deux fois côté client

**`public/index.html` :**
- ligne 1516 : `function mayorTransfer(id) { socket.emit("mayorTransferChoice", id); }`
- ligne 1760 : même définition (avec `if(gameIsOver) return;`)

La 2ᵉ écrase la 1ʳᵉ. Pas de bug fonctionnel mais piège pour la maintenance. **Correction :** supprimer la ligne 1516 et garder uniquement la version avec le guard `gameIsOver`.

---

### 12. Pas de garde sur reset pendant un transfert/chasseur en cours

**`server.js`, ligne 1252-1258 :**
```js
socket.on("reset", () => {
  if (!isMJ(socket.id)) return;
  resetGameState(true);
  // ...
});
```

Si le MJ reset au moment où un chasseur tire, des socket events déjà déclenchés (`chasseurAction`) peuvent arriver après — guards par `phase` mais on vient de mettre `phase=lobby`. OK la plupart du temps, mais le `dyingMayorId`, `chasseurPostContext`, `mission.team`... sont bien remis à zéro par `resetGameState`. Vérifié, c'est propre.

---

## 🟡 AMÉLIORATIONS DE QUALITÉ

### 13. CSS répété en `cssText`

Dans `index.html`, des dizaines de blocs comme :
```js
panel.style.cssText = [
  "display:flex","flex-direction:column","align-items:center", ...
].join(";");
```
sont répétés à l'identique pour `chasseurPanel`, `tiebreakPanel`, `mayorTransfer`. Crée une classe CSS unique :
```css
.fullscreen-panel {
  display:flex; flex-direction:column; align-items:center;
  justify-content:center; position:fixed; inset:0; z-index:9500;
  padding:30px; text-align:center;
}
```
Et utilise `panel.classList.add("fullscreen-panel")` + `panel.classList.add("bg-orange")` pour la couleur.

---

### 14. Tout dans un seul `index.html` (1879 lignes)

Pour une soirée entre amis ce n'est pas grave, mais quand tu voudras ajouter de nouveaux rôles, ça va devenir pénible. Suggestion (quand tu en auras envie) :
- `public/style.css` : tout le CSS
- `public/game-state.js` : variables globales et state
- `public/render.js` : fonctions `render*`
- `public/socket-handlers.js` : tous les `socket.on(...)`

---

### 15. Pas de protection Ctrl+R / fermeture d'onglet pour le MJ

Si le MJ ferme son onglet par mégarde, il perd la session. Solution :
```js
window.addEventListener("beforeunload", e => {
  if (currentPhaseForBar !== "lobby") {
    e.preventDefault();
    e.returnValue = "Une partie est en cours — vraiment quitter ?";
  }
});
```
À ajouter dans `mj.html` (et en plus léger dans `index.html` si tu veux protéger les joueurs aussi).

---

### 16. `playerRegistry` ne nettoie pas les déconnectés post-partie

Quand tu fais un `replayGame` avec `keepPlayers=true`, on garde tous les joueurs même ceux qui sont partis. Le `survivingRegistry` ne contient que `players` actuels — c'est OK. Mais on ne supprime pas les sockets.id obsolètes des `roles`, `lovers`, etc. avant `assignAndStart`. **En l'état c'est sans conséquence** car `roles = {}` est fait dans `resetGameState`. Vérifié.

---

### 17. Constante `CUPID_SOUND_MS = 4000` en dur

Si tu changes `cupid.mp3`, n'oublie pas d'ajuster. Idéalement, charger le son et lire sa `duration` :
```js
ambianceAudio.addEventListener("loadedmetadata", () => {
  const realDuration = ambianceAudio.duration * 1000;
  // ...
});
```
Mais pour l'instant, juste mets un commentaire en haut du fichier rappelant la valeur attendue.

---

## 🆕 IDÉES POUR LA REMASTERISATION (soirée entre amis)

Tu m'as dit ne pas vouloir de nouveaux rôles tout de suite, mais voici des **améliorations utiles sans toucher la logique de jeu** :

1. **Sauvegarde du nom** (déjà mentionné, bug #1)
2. **Mode silencieux pour les joueurs** : toggle pour ne pas être dérangé par les notifications quand on est mort
3. **Délai d'inactivité MJ** : avertir le MJ si aucun joueur n'a voté pendant 30s
4. **Historique des parties** sauvegardé en JSON local côté MJ
5. **Bouton « Pause »** côté MJ : freeze tous les timers (pour ravitaillement, toilettes, etc.)
6. **Mode démo / tutoriel** pour expliquer chaque rôle aux nouveaux

---

## 🎯 ORDRE DE CORRECTION RECOMMANDÉ

1. ✅ **Bug #1** (localStorage) — 1 ligne, impact énorme
2. ✅ **Bug #6** (XSS) — limiter le nom serveur, sécurité
3. ✅ **Bug #2** (mort en cascade) — corrige un crash potentiel
4. ✅ **Bug #5** (spam sendDeadVision) — gain de perf significatif
5. ✅ **Bug #4** (double-clic Terminer) — stabilité MJ
6. ✅ **Bug #7** (validation config) — UX MJ
7. ✅ **Bug #11** (doublon `mayorTransfer`) — propreté
8. ✅ **Bug #9** (timer MJ) — cosmétique
9. ✅ **Bug #15** (protection beforeunload) — qualité

---

Veux-tu que je passe à l'application des corrections ? Je peux commencer par les 4 bugs critiques (#1, #6, #2, #5) qui ont le plus d'impact pour ta soirée.
