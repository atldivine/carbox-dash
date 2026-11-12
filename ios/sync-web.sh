#!/bin/bash
# Copies the web dash (the folder above ios/) into ios/web, which the app bundles.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/.."
mkdir -p "$HERE/web"
rm -rf "$HERE/web/"*
cp "$SRC/index.html" "$SRC/style.css" "$HERE/web/"
cp -R "$SRC/js" "$SRC/fonts" "$SRC/data" "$SRC/icons" "$HERE/web/"
echo "web dash synced into $HERE/web"
