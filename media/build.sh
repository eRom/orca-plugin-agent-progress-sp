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
  magick -size "${W}x${H}" xc:none -fill white -draw "roundrectangle 0,0,$((W - 1)),$((H - 1)),16,16" "PNG32:$TMP/mask.png"
  magick "$TMP/p.png" "$TMP/mask.png" -compose DstIn -composite -compose Over \
    -fill none -stroke 'rgba(128,128,128,0.35)' -strokewidth 1 -draw "roundrectangle 0.5,0.5,$((W - 1)).5,$((H - 1)).5,16,16" \
    \( +clone -background black -shadow 30x20+0+14 \) +swap -background none -layers merge +repage "PNG32:$3"
}

# backdrop <sombre|clair> <sortie> : fond uni de la famille Agent*, avec un halo ambre très discret derrière le panneau.
backdrop() {
  if [ "$1" = dark ]; then
    magick -size 1600x1000 xc:'#111216' \
      \( -size 1400x1400 radial-gradient:'#ffb84d-black' -evaluate Multiply 0.07 \) \
      -geometry +500-200 -compose Screen -composite "$2"
  else
    magick -size 1600x1000 xc:'#ecedf0' \
      \( -size 1400x1400 radial-gradient:'#f1e6df-white' \) \
      -geometry +500-200 -compose Multiply -composite "$2"
  fi
}

# Typographie de la famille : titre 84 px, sous-titre 30 px gris, puces 25 px avec triangle ambre.
# Dessin du texte : écrit dans $TMP/text.png depuis le fond passé en argument.
INK_DARK='#f4f4f6'; SUB_DARK='#8b8d98'; BUL_DARK='#dcdde2'
INK_LIGHT='#17181c'; SUB_LIGHT='#6b6d78'

# screenshot <thème> <prise> <titre> <ligne1> <ligne2> <sortie> : titre et sous-titre à gauche, un seul rendu réel à droite.
screenshot() {
  backdrop "$1" "$TMP/bg.png"
  if [ "$1" = dark ]; then INK=$INK_DARK; SUB=$SUB_DARK; else INK=$INK_LIGHT; SUB=$SUB_LIGHT; fi
  panel "$RAW/$2.png" "$(magick identify -format '%[fx:round(h*0.98)]' "$RAW/$2.png")" "$TMP/s.png"
  SW=$(magick identify -format '%w' "$TMP/s.png"); SH=$(magick identify -format '%h' "$TMP/s.png")
  magick "$TMP/bg.png" \
    -font "$FONT_BOLD" -fill "$INK" -pointsize 56 -kerning -1.5 -annotate +112+478 "$3" \
    -font "$FONT_TEXT" -fill "$SUB" -pointsize 26 -kerning 0 -annotate +112+535 "$4" \
    -font "$FONT_TEXT" -fill "$SUB" -pointsize 26 -kerning 0 -annotate +112+572 "$5" \
    "$TMP/s.png" -geometry "+$((1190 - SW / 2))+$(((1000 - SH) / 2))" -compose Over -composite \
    -strip "PNG24:$6"
}

screenshot dark focused-dark 'Your plan, step by step' 'Stage, tasks and the agent at work,' 'read from your spec, plan and ledger.' media/screenshot-dark.png
screenshot light review-light 'Every task done, review next' 'The stage bar follows the plan' 'as the ledger moves.' media/screenshot-light.png
screenshot dark needs-you-dark 'Know when Claude needs you' 'The agent that is waiting shows up' 'at the top, with how long it has waited.' media/screenshot-needs-you.png

# bullet <y> <texte> : triangle ambre et ligne de puce.
bullet() {
  magick "$TMP/cover.png" \
    -fill '#f59a3a' -draw "polygon 112,$(($1 - 9)) 112,$(($1 + 9)) 125,$1" \
    -font "$FONT_TEXT" -fill "$BUL_DARK" -pointsize 25 -kerning 0 -annotate +143+$(($1 + 9)) "$2" "$TMP/cover.png"
}

# Couverture : pastille, nom du produit, sous-titre et trois puces à gauche ; le panneau réel à droite,
# recouvert en partie par la vue « autres plans » comme sur les couvertures sœurs.
backdrop dark "$TMP/cover.png"
magick "$RAW/focused-dark.png" -crop 547x548+0+0 +repage "$TMP/focus-top.png"
panel "$TMP/focus-top.png" 548 "$TMP/c1.png"
panel "$RAW/resting-dark.png" 214 "$TMP/c2.png"
C1W=$(magick identify -format '%w' "$TMP/c1.png")
C2H=$(magick identify -format '%h' "$TMP/c2.png")
magick media/icon.png -resize 128x128 \( +clone -background black -shadow 40x14+0+8 \) +swap -background none -layers merge +repage "PNG32:$TMP/tile.png"
magick "$TMP/cover.png" \
  "$TMP/tile.png" -geometry +76+200 -compose Over -composite \
  -font "$FONT_BOLD" -fill "$INK_DARK" -pointsize 80 -kerning -2.2 -annotate +108+462 'Agent Progress' \
  -font "$FONT_TEXT" -fill "$SUB_DARK" -pointsize 31 -kerning 0 -annotate +112+530 'Where every Superpowers plan stands,' \
  -font "$FONT_TEXT" -fill "$SUB_DARK" -pointsize 31 -kerning 0 -annotate +112+568 'read from disk.' \
  "$TMP/c1.png" -geometry "+$((1487 - C1W))+110" -compose Over -composite \
  "$TMP/c2.png" -geometry "+800+$((885 - C2H))" -compose Over -composite \
  "$TMP/cover.png"
bullet 653 'Stage, tasks and agent of the current workspace'
bullet 709 'Every other plan in progress, one line each'
bullet 764 'Read from your spec, plan and ledger, never guessed'
magick "$TMP/cover.png" -strip "PNG24:media/cover.png"

ls -l media/icon.png media/cover.png media/screenshot-*.png
