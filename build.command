#!/bin/bash
# CariMusicDeck — build turnkey : compile et dépose le .streamDeckPlugin dans ./release
# Aucune suppression de fichier, aucune écriture hors de ce dossier.
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js est requis (v20 ou plus) : https://nodejs.org"
  read -r -p "Entrée pour fermer…" _
  exit 1
fi

echo "▸ Dépendances"
npm install --no-fund --no-audit
echo "▸ Vérification TypeScript"
npm run typecheck
echo "▸ Adaptateur « À l'écoute » (Deezer, TIDAL, Qobuz, navigateurs…)"
# mediaremote-adapter (BSD-3, vendor/) : compilé ici, chargé par /usr/bin/perl, seul accès autorisé
# à MediaRemote depuis macOS 15.4. Requiert les outils de ligne de commande Xcode (xcode-select --install).
MRA=vendor/mediaremote-adapter
OUT=fr.cariboulabs.caricover.sdPlugin/mediaremote
build_adapter() {
  mkdir -p "$OUT/MediaRemoteAdapter.framework" &&
  xcrun clang -dynamiclib -fobjc-arc -fvisibility=default -O2 \
    -arch arm64 -arch x86_64 -mmacosx-version-min=12.0 \
    -I"$MRA/include" -I"$MRA/src" \
    "$MRA"/src/adapter/*.m "$MRA"/src/private/*.m "$MRA"/src/utility/*.m \
    -framework Foundation -framework AppKit -framework UniformTypeIdentifiers \
    -install_name @rpath/MediaRemoteAdapter.framework/MediaRemoteAdapter \
    -o "$OUT/MediaRemoteAdapter.framework/MediaRemoteAdapter" &&
  codesign --force --sign - "$OUT/MediaRemoteAdapter.framework/MediaRemoteAdapter" &&
  cp "$MRA/bin/mediaremote-adapter.pl" "$OUT/"
}
if xcode-select -p >/dev/null 2>&1 && xcrun --find clang >/dev/null 2>&1; then
  if build_adapter; then
    echo "  ✓ adaptateur compilé"
  else
    echo "  ⚠︎ échec de compilation : source « Autres apps » via Homebrew uniquement (brew install media-control)"
  fi
else
  echo "  ⚠︎ outils Xcode absents (xcode-select --install) : source « Autres apps » via Homebrew uniquement (brew install media-control)"
fi

echo "▸ Bundle"
npm run build
echo "▸ Paquet Stream Deck"
mkdir -p release
npx streamdeck pack fr.cariboulabs.caricover.sdPlugin -o release -f
echo "✓ release/fr.cariboulabs.caricover.streamDeckPlugin — double-cliquer pour installer"
open release
