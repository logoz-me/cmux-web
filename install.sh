#!/bin/bash
#
# cmux-web — installation sur macOS.
#
#   ./install.sh                 installe et demarre le service
#   ./install.sh --port 9999     autre port
#   ./install.sh --host 0.0.0.0  ecoute sur le reseau (LAN / VPN)
#   ./install.sh --uninstall     desinstalle
#
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="$HOME"
PLIST="$HOME_DIR/Library/LaunchAgents/com.cmux.web.plist"
LABEL="com.cmux.web"
PORT=9999
HOST="127.0.0.1"
MODE="install"

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --uninstall) MODE="uninstall"; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "option inconnue : $1" >&2; exit 1 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
info() { printf '  %s\n' "$1"; }
fail() { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }

NODE_BIN="$(command -v node || true)"
CMUX_BIN="$(command -v cmux || true)"
if [ -z "$CMUX_BIN" ] && [ -x /Applications/cmux.app/Contents/Resources/bin/cmux ]; then
  CMUX_BIN=/Applications/cmux.app/Contents/Resources/bin/cmux
fi
[ -n "$CMUX_BIN" ] || fail "cmux est introuvable. Installez-le depuis https://cmux.com puis relancez."

if [ "$MODE" = "uninstall" ]; then
  bold "Desinstallation de cmux-web"
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  info "service supprime"
  info "le mode du socket cmux n'est pas modifie : cmux settings open automation"
  exit 0
fi

bold "cmux-web — installation"

if [ -z "$NODE_BIN" ]; then
  fail "node est introuvable. Installez Node.js 18+ (https://nodejs.org) puis relancez."
fi
info "node      : $("$NODE_BIN" --version)"
info "cmux      : $("$CMUX_BIN" version 2>/dev/null | head -1)"

if ! "$CMUX_BIN" ping >/dev/null 2>&1; then
  info "l'application cmux ne repond pas — ouvrez-la au moins une fois."
fi

info ""
info "Configuration du socket de controle cmux..."
python3 "$DIR/scripts/setup-cmux-socket.py" --mode password
"$CMUX_BIN" reload-config >/dev/null 2>&1 || true
sleep 1

if ! "$CMUX_BIN" ping >/dev/null 2>&1; then
  fail "le socket cmux refuse la connexion. Verifiez que l'application cmux est lancee."
fi
info "socket    : accessible"

if [ ! -f "$DIR/config.json" ]; then
  printf '{\n  "host": "%s",\n  "port": %s\n}\n' "$HOST" "$PORT" > "$DIR/config.json"
  info "config    : $DIR/config.json (cree)"
else
  info "config    : $DIR/config.json (existe deja)"
fi

if [ ! -f "$DIR/.web-token" ]; then
  "$NODE_BIN" -e "require('fs').writeFileSync(process.argv[1], require('crypto').randomBytes(24).toString('base64url'), {mode:0o600})" "$DIR/.web-token"
  info "jeton     : genere"
else
  info "jeton     : existe deja"
fi
chmod 600 "$DIR/.web-token" 2>/dev/null || true

mkdir -p "$HOME_DIR/Library/LaunchAgents"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$DIR/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME_DIR</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$DIR/server.log</string>
  <key>StandardErrorPath</key>
  <string>$DIR/server.log</string>
</dict>
</plist>
PLISTEOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
sleep 1

# Utilitaire en ligne de commande (si un repertoire du PATH est inscriptible).
for BIN_DIR in "$HOME_DIR/.local/bin" "/usr/local/bin"; do
  if mkdir -p "$BIN_DIR" 2>/dev/null && [ -w "$BIN_DIR" ]; then
    ln -sf "$DIR/cmux-web" "$BIN_DIR/cmux-web"
    info "commande  : $BIN_DIR/cmux-web"
    break
  fi
done

TOKEN="$(cat "$DIR/.web-token")"
ADDR="$HOST"
if [ "$HOST" = "0.0.0.0" ]; then
  ADDR="$(ipconfig getifaddr en0 2>/dev/null || hostname)"
fi

bold "Installation terminee."
info ""
info "  interface : http://$ADDR:$PORT/?token=$TOKEN"
info "  jeton     : $DIR/.web-token"
info "  service   : com.cmux.web (demarrage automatique)"
info "  commande  : cmux-web status | cmux-web url | cmux-web logs"
info ""
info "Pour exposer l'interface sur le reseau (LAN ou VPN) : cmux-web start lan"
info ""
info "L'acces a distance donne un controle total sur les terminaux de ce Mac."
info "Gardez le jeton secret."
