#!/usr/bin/env bash
# Doomscroll-Driven Development: installer.
# Copies the two mods into Herdr, builds the `main-reels` layout from your
# current `main` layout (+ the Reels column), adds Cmd+Shift+R to that layout
# only, and switches to it. Your `main` layout is never touched.
set -euo pipefail

APP="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="$HOME/.local/share/reels-widget"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf '❌ %s\n' "$*" >&2; exit 1; }

[ "$(uname)" = Darwin ] || die "macOS only, for now. Your manager says thanks."
command -v node >/dev/null || die "Node.js 18+ is required."
command -v hc >/dev/null || die "herdr-core (hc) not found. Install Herdr first: https://herdr.dev"
command -v herdr-app >/dev/null || die "herdr-app not found. Open Herdr once so it links itself."
[ -x "$CHROME" ] || die "Google Chrome not found at: $CHROME"
[ -f "$APP/layouts/main.json" ] || die "No $APP/layouts/main.json. Open Herdr once first."
/bin/zsh -ic 'command -v node' >/dev/null 2>&1 || die "node isn't on PATH in an interactive zsh (the mod starts it with zsh -i)."

stamp="$(date +%Y%m%d-%H%M%S)"
backup="$DATA/backup-$stamp"

# 1. Mods (anything already there is moved to a backup, never overwritten).
for m in reels-bar tabs-reels; do
  if [ -e "$APP/mods/$m" ]; then
    mkdir -p "$backup" && mv "$APP/mods/$m" "$backup/$m"
    say "Moved your existing mods/$m to $backup/$m"
  fi
  cp -R "$SRC/mods/$m" "$APP/mods/$m"
done

# 2. The browser terminal (one, named "reels", kept alive by Herdr).
addr="$(hc ls --json | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    const t = (JSON.parse(s || "{}").terminals || []).find(t => t.name === "reels" && t.state === "live")
    process.stdout.write(t ? t.address : "")
  })')"
if [ -z "$addr" ]; then
  addr="$(hc run --bg --json --no-parent --keep --name reels -- \
    /bin/zsh -ic 'while true; do node "$0" || sleep 4; sleep 1; done' \
    "$APP/mods/reels-bar/bin/reels-term.mjs" | node -e '
      let s = ""; process.stdin.on("data", d => s += d).on("end", () => process.stdout.write(JSON.parse(s).address))')"
fi
say "Browser terminal: $addr"

# 3. Layout `main-reels` = your `main` + the Reels column + the Reels button.
if [ -e "$APP/layouts/main-reels.json" ]; then
  mkdir -p "$backup" && cp "$APP/layouts/main-reels.json" "$backup/main-reels.json"
fi
APP="$APP" ADDR="$addr" node <<'NODE'
const fs = require("fs")
const dir = `${process.env.APP}/layouts`
const find = (n, id) => n && n.id === id ? n : (n?.children ?? []).map(c => find(c, id)).find(Boolean) ?? null
const main = JSON.parse(fs.readFileSync(`${dir}/main.json`, "utf8"))
const tabs = find(main, "tabs"), body = find(main, "work-body")
if (!tabs || !body?.children) { console.error("❌ Unexpected main.json shape (no `tabs`/`work-body`). Herdr changed; open an issue."); process.exit(1) }
tabs.content = { mod: "tabs-reels" }
body.children.push({
  id: "reels", type: "column", size: { px: 420 }, min: 320, max: 900, resizable: false,
  radius: 10, background: "background", border: { width: 1, color: "border" },
  children: [
    { id: "reels-bar", type: "block", size: { px: 32 }, content: { mod: "reels-bar" } },
    { id: "reels-view", type: "block", content: { terminal: process.env.ADDR } },
  ],
})
const { id, ...rest } = main
fs.writeFileSync(`${dir}/main-reels.json`, JSON.stringify({ id, cloned_from: { name: "main" }, ...rest }, null, 2) + "\n")
NODE

# 4. Cmd+Shift+R, only while `main-reels` shows (keeps yours if you bound it).
APP="$APP" node <<'NODE'
const fs = require("fs")
const file = `${process.env.APP}/keys.json`
const keys = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {}
const sec = keys["layout:main-reels"] ??= {}
if (sec["cmd-shift-r"] && sec["cmd-shift-r"] !== "layout.toggle:reels") {
  console.log("Cmd+Shift+R is already yours in main-reels; left it alone. Use the Reels button.")
} else {
  sec["cmd-shift-r"] = "layout.toggle:reels"
  fs.writeFileSync(file, JSON.stringify(keys, null, 2) + "\n")
}
NODE

# 5. Check and switch.
herdr-app check "$APP/mods/reels-bar" >/dev/null
herdr-app check "$APP/mods/tabs-reels" >/dev/null
herdr-app do layout.switch '{"name":"main-reels"}' >/dev/null 2>&1 \
  && say "Switched to the main-reels layout." \
  || say "Installed. Switch layouts with Ctrl+Shift+L (or Cmd+Shift+L) and pick main-reels."

say "🎬 Done. Click 'Reels' in the tab bar, log into Instagram once, and ship nothing today."
