# CariCover — Caribou Labs

Plugin Stream Deck (macOS, Stream Deck 7.1+) : pochette et commandes de lecture pour **Apple Music** et **Plex**
(Plexamp, Plex HTPC, Plex Web…). Chaque touche suit automatiquement la source en cours de lecture.

## Actions
| Action | Affichage | Appui | Maintien (400 ms) |
|---|---|---|---|
| Pochette | pochette (mosaïque auto sur touches voisines), barre de progression en option | lecture/pause | stop |
| Lecture / Pause | ▶︎ / ❚❚ | lecture/pause | stop |
| Précédent / Suivant | ⏮ / ⏭ | piste préc. (début si > 3 s) / suiv. | recherche continue (pas réglable) |
| Aléatoire | état | bascule | — |
| Répétition | désactivée / tout / un | cycle | — |
| Titre | titre, artiste, album (taille auto ou défilement) | lecture/pause | stop |
| Infos piste | codec, qualité (24/96, 256 kbps), position (7/14) | — | — |
| Temps | écoulé / total ou restant + barre | bascule total/restant | — |
| Note | étoiles (pas 1 ou ½) ; cœur favori pour Apple Music | +1 pas / favori | — |
| Volume + / − | niveau + barre | ± pas (réglable) | répétition continue ; Volume − en option : sourdine + pause |
| Playlist | pochette/nom de la playlist | lance (aléatoire optionnel) | — |
| Radio | état de CariRadio (en direct / pause) | lance CariRadio en lecture, sinon lecture/pause | affiche la fenêtre CariRadio |

Couleur d'accent extraite de la pochette en cours.

## Profil « CariCover XL »
Profil Stream Deck XL prêt à l'emploi (mosaïque 4×4 + toutes les commandes), proposé à l'installation du plugin.
Généré à chaque build par `assets/make_profile.mjs` (disposition modifiable dans ce fichier).

## Sources
- **Apple Music** : AppleScript (autoriser *Stream Deck → Musique* dans Réglages Système › Confidentialité et sécurité ›
  Automatisation). Pochette : bibliothèque, sinon catalogue iTunes.
- **CariRadio** (app Caribou Labs, Radio Choco Sound HD) : API locale `http://127.0.0.1:32700`
  (`/state`, `/toggle`, `/volume?value=`…). Pochette, titre, temps de la piste et volume suivent la radio ;
  précédent/suivant/aléatoire/répétition/note sont inactifs (direct).
- **Plex** : lecture des sessions sur le serveur (`/status/sessions`) ; commandes, volume et temps précis en direct
  sur le lecteur Plexamp (API companion, port 32500, détection automatique ou URL forcée), repli via le serveur.
  « Se connecter à Plex… » : connexion plex.tv par PIN et découverte du serveur.

## Build
`build.command` (double-clic) → `release/`. Sources TypeScript dans `src/`, bundle esbuild, SDK `@elgato/streamdeck` v3,
rendu : SVG pour les touches texte/icônes, jimp (JS pur) pour les pochettes.
Icônes : `python3 assets/make_icons.py fr.cariboulabs.caricover.sdPlugin` (Pillow) et
`node assets/make_action_icons.mjs <dossier contenant playwright-core>`.
