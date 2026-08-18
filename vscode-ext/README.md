# opencode-v2 VS Code extension — local patches

Local fixes for `sst-dev.opencode-v2` (v0.1.1, latest on the marketplace as of
2026-08-18). The extension is patched in place at
`~/.vscode/extensions/sst-dev.opencode-v2-*/`; this directory is the canonical
source, since any extension update wipes the installed copy.

## Contents

- `extension.js` — wrapper around the vendor bundle (installed as
  `dist/extension.js`, with the vendor bundle renamed to
  `dist/extension.vendor.js`). Architecture:
  - **Sessions sidebar** for the activity-bar view the vendor declares but
    never implements ("There is no data provider registered" error):
    "+ New session", search, list of the current workspace's sessions
    (read from `~/.local/share/opencode/opencode.db` via `sqlite3`,
    auto-refreshed by watching the db WAL).
  - **One editor tab per session.** The vendor's assistant panel is a bare
    iframe onto the opencode server's web UI with dead postMessage plumbing,
    so the wrapper bypasses it: it owns the `opencode serve` process (spawn
    on demand, reap orphans at activation, kill on deactivate) and opens one
    WebviewPanel per session on its deep-link URL
    (`/server/{base64url(origin)}/session/{id}`). Tabs are restored across
    window reloads via a webview serializer. Session ids are shape-validated
    before touching HTML.
  - **Injecting proxy.** The web UI has no embed mode, so tabs load it
    through a local proxy (ephemeral port) that forwards to the server and
    injects CSS hiding the app's internal tab bar
    (`header[data-slot="titlebar-v2"]`); WebSocket upgrades are tunneled.
  - **Ctrl+Escape** (`opencode-v2.openPanel`) is re-registered via a
    `require("vscode")` shim around the vendor bundle to open a web-UI home
    tab against our server — the vendor's own handler would spawn a second
    server on the same fixed port and die with `ServeError`.
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
5. The extension's bundled React chat UI is dead code: the panel is an iframe
   onto the server's web UI, whose outer HTML has no script, so the vendor's
   postMessage-based session switching can never reach it.
