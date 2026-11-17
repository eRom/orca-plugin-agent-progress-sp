#!/bin/sh
# Regénère les médias de la fiche du plugin (icône, couverture, captures).
#
#   media/build.sh          recompose depuis media/raw/*.png et media/icon.svg
#   media/build.sh shoot    refait d'abord les prises brutes avec Orca, puis recompose
#
# Prérequis : rsvg-convert et magick (ImageMagick 7). Pour `shoot` : Orca lancé sur cette machine.
# Les prises sont de vrais rendus du panneau (scénarios de src/panel.check.ts, données neutres) ;
# le script ne dessine aucune interface, il pose les rendus sur un fond calme.
set -eu

cd "$(dirname "$0")/.."
RAW=media/raw
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Police du titre de la couverture : SF Pro si elle est installée, sinon la police par défaut d'ImageMagick.
FONT_BOLD="$HOME/Library/Fonts/SF-Pro-Display-Semibold.otf"
FONT_TEXT="$HOME/Library/Fonts/SF-Pro-Display-Regular.otf"
[ -f "$FONT_BOLD" ] || FONT_BOLD=Helvetica-Bold
[ -f "$FONT_TEXT" ] || FONT_TEXT=Helvetica

if [ "${1:-}" = "shoot" ]; then
  mkdir -p "$RAW"
  # La fenêtre d'Orca doit être masquée pendant les prises ; elle est rouverte même en cas d'échec.
  osascript -e 'tell application "System Events" to set visible of process "Orca" to false'
  trap 'osascript -e '"'"'tell application "System Events" to set visible of process "Orca" to true'"'"'; rm -rf "$TMP"' EXIT
  shoot() { orca plugin shot . --panel progress --scenario "$1" --theme "$2" --width 380 --out "$RAW/$3.png"; }
  shoot focused dark focused-dark
  shoot focused light focused-light
  shoot review dark review-dark
  shoot review light review-light
  shoot needsYou dark needs-you-dark
  shoot focusedResting dark resting-dark
fi

# Icône : le PNG 512x512 est rendu depuis le SVG.
rsvg-convert -w 512 -h 512 media/icon.svg -o media/icon.png

# panel <prise> <hauteur> <sortie> : prise redimensionnée, coins arrondis, liseré fin et ombre portée.
panel() {
  magick "$1" -strip -colorspace sRGB -type TrueColor -resize "x$2" -alpha set "PNG32:$TMP/p.png"
  W=$(magick identify -format '%w' "$TMP/p.png")
  H=$(magick identify -format '%h' "$TMP/p.png")
  magick -size "${W}x${H}" xc:none -fill white -draw "roundrectangle 0,0,$((W - 1)),$((H - 1)),22,22" "PNG32:$TMP/mask.png"
  magick "$TMP/p.png" "$TMP/mask.png" -compose DstIn -composite -compose Over \
    -fill none -stroke 'rgba(128,128,128,0.35)' -strokewidth 1 -draw "roundrectangle 0.5,0.5,$((W - 1)).5,$((H - 1)).5,22,22" \
    \( +clone -background black -shadow 40x20+0+14 \) +swap -background none -layers merge +repage "PNG32:$3"
}

# backdrop <sombre|clair> <sortie> : dégradé calme et halo ambre, sans motif.
backdrop() {
  if [ "$1" = dark ]; then
    magick -size 1600x1000 gradient:'#262730-#0f1013' \
      \( -size 1300x1300 radial-gradient:'#ffb84d-black' -evaluate Multiply 0.13 \) \
      -geometry +650+250 -compose Screen -composite "$2"
  else
    magick -size 1600x1000 gradient:'#f4f2ed-#e2dfd7' "$2"
  fi
}

# pair <thème> <gauche> <droite> <sortie> : deux prises centrées sur le fond, à la même échelle.
pair() {
  backdrop "$1" "$TMP/bg.png"
  S=0.9
  panel "$RAW/$2.png" "$(magick identify -format "%[fx:round(h*$S)]" "$RAW/$2.png")" "$TMP/left.png"
  panel "$RAW/$3.png" "$(magick identify -format "%[fx:round(h*$S)]" "$RAW/$3.png")" "$TMP/right.png"
  LW=$(magick identify -format '%w' "$TMP/left.png"); LH=$(magick identify -format '%h' "$TMP/left.png")
  RW=$(magick identify -format '%w' "$TMP/right.png"); RH=$(magick identify -format '%h' "$TMP/right.png")
  GAP=40
  X0=$(((1600 - LW - RW - GAP) / 2))
  magick "$TMP/bg.png" \
    "$TMP/left.png" -geometry "+${X0}+$(((1000 - LH) / 2))" -compose Over -composite \
    "$TMP/right.png" -geometry "+$((X0 + LW + GAP))+$(((1000 - RH) / 2))" -compose Over -composite \
    -strip "PNG24:$4"
}

pair dark focused-dark review-dark media/screenshot-dark.png
pair light focused-light review-light media/screenshot-light.png
pair dark needs-you-dark resting-dark media/screenshot-needs-you.png

# Couverture : titre à gauche, deux rendus réels à droite.
backdrop dark "$TMP/bg.png"
panel "$RAW/focused-dark.png" 640 "$TMP/c1.png"
panel "$RAW/resting-dark.png" 232 "$TMP/c2.png"
C1W=$(magick identify -format '%w' "$TMP/c1.png")
magick "$TMP/bg.png" \
  -font "$FONT_BOLD" -fill '#ffb84d' -pointsize 26 -kerning 4 -annotate +96+318 'AGENT PROGRESS' \
  -font "$FONT_BOLD" -fill '#f4f4f6' -pointsize 66 -kerning -1 -annotate +92+404 'Where every' \
  -font "$FONT_BOLD" -fill '#f4f4f6' -pointsize 66 -kerning -1 -annotate +92+480 'Superpowers plan' \
  -font "$FONT_BOLD" -fill '#f4f4f6' -pointsize 66 -kerning -1 -annotate +92+556 'stands.' \
  -font "$FONT_TEXT" -fill '#a9abb6' -pointsize 28 -kerning 0 -annotate +96+624 'Stage, tasks and the agent at work,' \
  -font "$FONT_TEXT" -fill '#a9abb6' -pointsize 28 -kerning 0 -annotate +96+664 'read from your spec, plan and ledger.' \
  "$TMP/c1.png" -geometry "+620+170" -compose Over -composite \
  "$TMP/c2.png" -geometry "+$((620 + C1W - 120 + 40))+330" -compose Over -composite \
  -strip "PNG24:media/cover.png"

ls -l media/icon.png media/cover.png media/screenshot-*.png
