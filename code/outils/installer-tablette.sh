#!/data/data/com.termux/files/usr/bin/bash
# installer-tablette.sh — installe (ou met à jour) le Loup-Garou sur la tablette du MJ, dans Termux.
#
# Une seule fois, dans Termux :
#   termux-setup-storage                          (autoriser l'accès aux fichiers)
#   bash ~/storage/downloads/installer-tablette.sh
#
# Pour mettre à jour les raccourcis eux-mêmes (après une amélioration de ce fichier), on le relance :
#   bash ~/loupgarou/code/outils/installer-tablette.sh
#
# Il installe Node.js et git, récupère le jeu depuis GitHub, copie les réglages des lumières
# (lumieres.env, posé dans « Téléchargements » depuis l'ordinateur), écrit l'adresse de la tablette,
# et crée les raccourcis de l'écran d'accueil (Termux:Widget) : « Lancer le jeu », « Mettre à jour
# le jeu ». Relançable sans risque : il met à jour ce qui est déjà là.
set -e
# Tout le script est lu avant de commencer (accolades) : il peut se mettre à jour lui-même (git pull)
# sans que bash lise la nouvelle version en plein milieu.
{
DEPOT="https://github.com/MuchachoBonobo/Loup-garou-app.git"
DOSSIER="$HOME/loupgarou"
TELECHARGEMENTS="$HOME/storage/downloads"

echo
echo "== 1/5 Mise à jour de Termux (quelques minutes)"
pkg update -y
yes | pkg upgrade -y

echo
echo "== 2/5 Node.js et git"
pkg install -y nodejs-lts git procps   # procps : pkill, pour arrêter un ancien jeu

echo
echo "== 3/5 Le jeu"
if [ -d "$DOSSIER/.git" ]; then
  git -C "$DOSSIER" checkout -- .   # npm retouche parfois package-lock.json : sans ça, la mise à jour se bloque
  git -C "$DOSSIER" pull --ff-only
else
  git clone --depth 1 "$DEPOT" "$DOSSIER"
fi
cd "$DOSSIER/code"
npm install --omit=dev --no-audit --no-fund

echo
echo "== 4/5 Les réglages"
if [ -f "$TELECHARGEMENTS/lumieres.env" ]; then
  tr -d '\r' < "$TELECHARGEMENTS/lumieres.env" > .env
  echo "Réglages des lumières copiés."
elif [ ! -f .env ]; then
  cp .env.example .env
  echo "Pas de lumieres.env dans Téléchargements : le jeu tournera sans les lumières."
fi
ACTUELLE=$(sed -n 's/^ADRESSE_DU_JEU=//p' .env)
echo "Adresse IP de la tablette : Paramètres > Connexions > Wi-Fi > roue dentée du réseau."
read -r -p "Tape-la (ex. 192.168.8.232)${ACTUELLE:+, ou Entrée pour garder $ACTUELLE} : " IP
if [ -n "$IP" ]; then
  sed -i '/^#\? *ADRESSE_DU_JEU=/d' .env
  echo "ADRESSE_DU_JEU=$IP" >> .env
fi

echo
echo "== 5/5 Les raccourcis de l'écran d'accueil"
mkdir -p "$HOME/.shortcuts"
cat > "$HOME/.shortcuts/Lancer le jeu" <<'FIN'
#!/data/data/com.termux/files/usr/bin/bash
# Le jeu tourne tant que cette fenêtre reste ouverte ; la page du MJ s'ouvre seule.
# Un ancien jeu encore ouvert dans une autre fenêtre Termux garderait la place (et son ancienne
# version) : on l'arrête d'abord.
pkill -f "node server.js" 2>/dev/null && sleep 1
termux-wake-lock
cd "$HOME/loupgarou/code"
echo "Loup-Garou : le jeu démarre. Laisse cette fenêtre ouverte (la fermer arrête le jeu)."
(sleep 4; termux-open-url "http://localhost:3000/mj") &
node server.js || true
termux-wake-unlock
read -r -p "Le jeu s'est arrêté. Appuie sur Entrée pour fermer."
FIN
cat > "$HOME/.shortcuts/Mettre à jour le jeu" <<'FIN'
#!/data/data/com.termux/files/usr/bin/bash
# Récupère la dernière version du jeu sur GitHub (Wi-Fi avec Internet nécessaire). Le jeu en cours
# s'arrête : il ne prend la nouvelle version qu'en redémarrant (« Lancer le jeu »).
pkill -f "node server.js" 2>/dev/null && echo "Jeu arrêté."
cd "$HOME/loupgarou" && git checkout -- . && git pull --ff-only && cd code && npm install --omit=dev --no-audit --no-fund \
  && echo "Jeu à jour. Relance-le avec « Lancer le jeu »." || echo "La mise à jour a échoué (Internet ?). L'ancienne version reste en place."
read -r -p "Appuie sur Entrée pour fermer."
FIN
chmod 700 "$HOME/.shortcuts" "$HOME/.shortcuts/"*

echo
echo "Installation terminée."
echo "Ajoute le widget « Termux:Widget » sur l'écran d'accueil : il montre « Lancer le jeu »."
exit 0
}
