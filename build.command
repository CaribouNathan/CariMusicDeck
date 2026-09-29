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
echo "▸ Bundle"
npm run build
echo "▸ Paquet Stream Deck"
mkdir -p release
npx streamdeck pack fr.cariboulabs.caricover.sdPlugin -o release -f
echo "✓ release/fr.cariboulabs.caricover.streamDeckPlugin — double-cliquer pour installer"
open release
