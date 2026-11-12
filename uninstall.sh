#!/usr/bin/env bash
# Doomscroll-Driven Development: uninstaller. Productivity restored (allegedly).
#   ./uninstall.sh          removes the mods, the layout and the shortcut
#   ./uninstall.sh --purge  also deletes the browser profile (your Instagram login)
set -euo pipefail

APP="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
DATA="$HOME/.local/share/reels-widget"
say() { printf '\033[1m%s\033[0m\n' "$*"; }

# Leave the layout first, so Herdr isn't showing the browser terminal we stop.
herdr-app do layout.switch '{"name":"main"}' >/dev/null 2>&1 || true
hc kill reels >/dev/null 2>&1 || true

rm -rf "$APP/mods/reels-bar" "$APP/mods/tabs-reels"
rm -f "$APP/layouts/main-reels.json"

if [ -f "$APP/keys.json" ]; then
  APP="$APP" node <<'NODE'
const fs = require("fs")
const file = `${process.env.APP}/keys.json`
const keys = JSON.parse(fs.readFileSync(file, "utf8"))
const sec = keys["layout:main-reels"]
if (sec?.["cmd-shift-r"] === "layout.toggle:reels") delete sec["cmd-shift-r"]
if (sec && !Object.keys(sec).length) delete keys["layout:main-reels"]
fs.writeFileSync(file, JSON.stringify(keys, null, 2) + "\n")
NODE
fi

if [ "${1:-}" = "--purge" ]; then
  rm -rf "$DATA"
  say "Deleted $DATA (browser profile and login)."
else
  say "Kept $DATA (browser profile with your Instagram login). Use --purge to delete it."
fi
say "👋 Uninstalled. Go write some tests."
