#!/usr/bin/env bash
# Re-apply local patches to the sst-dev.opencode-v2 VS Code extension after an update:
#  1. win32 spawn fix (anomalyco/opencode#38376)
#  2. sessions sidebar wrapper (extension.js -> extension.vendor.js + wrapper)
# Canonical wrapper source: ~/opt/opencode/vscode-ext/extension.js
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$(ls -d "$HOME"/.vscode/extensions/sst-dev.opencode-v2-* 2>/dev/null | sort -V | tail -1)"
[ -n "$EXT_DIR" ] || { echo "opencode-v2 extension not found"; exit 1; }
echo "Patching: $EXT_DIR"
DIST="$EXT_DIR/dist"

if [ -f "$DIST/extension.vendor.js" ]; then
  echo "Already wrapped (extension.vendor.js exists)."
else
  # 1. win32 spawn fix on the fresh vendor bundle
  if grep -q 'shell:process.platform==="win32"' "$DIST/extension.js"; then
    echo "win32 fix already present upstream."
  else
    cp "$DIST/extension.js" "$DIST/extension.js.orig"
    perl -0pi -e 's/\Q("opencode",["serve",\E(.*?)\{signal:(\w+)\.signal,/("opencode",["serve",$1\{signal:$2.signal,shell:process.platform==="win32",/s' "$DIST/extension.js"
    grep -q 'shell:process.platform==="win32"' "$DIST/extension.js" || { echo "WARN: win32 patch pattern not found — upstream code changed, check manually"; }
  fi
  # 2. install sidebar wrapper
  mv "$DIST/extension.js" "$DIST/extension.vendor.js"
  cp "$SRC_DIR/extension.js" "$DIST/extension.js"
  node --check "$DIST/extension.js"
  echo "Wrapper installed."
fi

# 3. package.json: webview view type, activation, menus (idempotent)
python3 - "$EXT_DIR/package.json" <<'EOF'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
c = d.setdefault('contributes', {})
views = c.setdefault('views', {}).get('opencode-v2', [])
if not views or views[0].get('type') != 'webview':
    import shutil; shutil.copy(p, p + '.orig')
    c['views']['opencode-v2'] = [{'id': 'opencode-v2.panel', 'type': 'webview', 'name': 'Sessions'}]
    d['activationEvents'] = sorted(set(d.get('activationEvents', []) + ['onView:opencode-v2.panel']))
    cmds = {x['command'] for x in c.setdefault('commands', [])}
    for cmd, title, icon in [('opencode-v2.refreshSessions', 'OpenCode: Refresh Sessions', '$(refresh)'),
                             ('opencode-v2.newSession', 'OpenCode: New Session', '$(add)')]:
        if cmd not in cmds:
            c['commands'].append({'command': cmd, 'title': title, 'icon': icon})
    c.setdefault('menus', {})['view/title'] = [
        {'command': 'opencode-v2.newSession', 'when': 'view == opencode-v2.panel', 'group': 'navigation@1'},
        {'command': 'opencode-v2.refreshSessions', 'when': 'view == opencode-v2.panel', 'group': 'navigation@2'},
    ]
    json.dump(d, open(p, 'w'), indent=2)
    print('package.json patched')
else:
    print('package.json already patched')
EOF
echo "Done. Reload VS Code (Developer: Reload Window)."
