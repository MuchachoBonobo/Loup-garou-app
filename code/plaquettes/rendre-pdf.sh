#!/bin/sh
# Fabrique les PDF des plaquettes (Chrome headless) dans gestion/Plaquettes.
# Usage : sh code/plaquettes/rendre-pdf.sh [fichier.html ...]   (sans argument : toutes)
cd "$(dirname "$0")"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
SORTIE="../../gestion/Plaquettes"
mkdir -p "$SORTIE"
[ $# -eq 0 ] && set -- *.html
for f in "$@"; do
  nom=$(basename "$f" .html)
  "$CHROME" --headless=new --disable-gpu --no-pdf-header-footer --virtual-time-budget=8000 \
    --print-to-pdf="$(cygpath -w "$SORTIE/$nom.pdf")" "file:///$(cygpath -m "$PWD/$f")" 2>/dev/null
  echo "$SORTIE/$nom.pdf"
done
