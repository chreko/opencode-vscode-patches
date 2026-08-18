# opencode-v2 VS Code extension — local patches

Local fixes for `sst-dev.opencode-v2` (v0.1.1, latest on the marketplace as of
2026-08-18). The extension is patched in place at
`~/.vscode/extensions/sst-dev.opencode-v2-*/`; this directory is the canonical
source, since any extension update wipes the installed copy.

## Contents

- `extension.js` — wrapper around the vendor bundle (installed as
  `dist/extension.js`, with the vendor bundle renamed to
  `dist/extension.vendor.js`). Provides:
  - **Sessions sidebar** for the activity-bar view the vendor declares but
    never implements ("There is no data provider registered" error):
    "+ New session", search, list of the current workspace's sessions
    (read from `~/.local/share/opencode/opencode.db` via `sqlite3`).
    Clicking a session opens the vendor assistant panel and switches to it by
    invoking the vendor's own webview message handler, captured through a
    `require("vscode")` shim around the vendor bundle.
  - **Stale-server reaping**: the vendor hardcodes port 4096, leaks its
    `opencode serve` child on window reload, and dies with `ServeError` when
    the port is taken. The wrapper reaps orphans at activation and kills its
    own server on deactivate. (The server deliberately outlives the panel —
    never reap mid-session.)
  - **No floating window**: swallows the vendor's forced
    `workbench.action.moveEditorToNewWindow` so the assistant stays a normal
    editor tab.
- `repatch.sh` — re-applies everything after an extension update:
  the win32 spawn fix ([anomalyco/opencode#38376]), the wrapper install, and
  the `package.json` contribution changes (webview view type, activation
  event, view-title menu). Idempotent.

[anomalyco/opencode#38376]: https://github.com/anomalyco/opencode/issues/38376

## Upstream bugs found along the way

1. `spawn opencode ENOENT` on Windows — needs `shell: true` (#38376, open).
2. Declared view `opencode-v2.panel` has no registered provider.
3. `opencode serve` child leaks across window reloads; next panel open fails
   with an unhandled `ServeError` (port 4096 collision).
4. Panel force-moved to a floating window on every open.
