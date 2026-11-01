#!/bin/bash
# cmux-web — desinstallation (voir install.sh --uninstall).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/install.sh" --uninstall
