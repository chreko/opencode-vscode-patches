// Local wrapper around the vendor OpenCode extension bundle (extension.vendor.js).
// Adds a working sidebar (WebviewView) for the "opencode-v2.panel" view that the
// vendor package.json declares but never implements ("no data provider" error).
//
// Sidebar features: "+ New session", session search, list of sessions for the
// current workspace (read from opencode's sqlite db). The vendor panel is an
// iframe onto the opencode server's web UI, so clicking a session opens the
// panel and points that iframe at the session's deep-link URL. The panel is
// captured via a require("vscode") shim around the vendor bundle.
//
// NOTE: wiped by any extension update — see repatch script.

"use strict";

const path = require("path");
const os = require("os");
const fs = require("fs");
const { execFile } = require("child_process");
const Module = require("module");
const vscode = require("vscode");

const state = {
  panel: null, // vendor's WebviewPanel, when open
  handler: null, // vendor's webview message handler: (msg) => Promise
  sidebar: null, // our WebviewView, when visible
  output: null, // OutputChannel
};

function log(msg) {
  if (state.output) state.output.appendLine(`[sidebar] ${msg}`);
}

// ---------------------------------------------------------------------------
// Capture the vendor's panel + message handler.
// The vendor bundle requires "vscode" at module top level; we hand it a facade
// whose window.createWebviewPanel notes the panel and shadows
// webview.onDidReceiveMessage to capture the listener the vendor registers.
// ---------------------------------------------------------------------------

function facade(obj, overrides) {
  const f = {};
  for (const k of Object.keys(obj)) {
    if (k in overrides) continue;
    Object.defineProperty(f, k, {
      enumerable: true,
      get() {
        const v = obj[k];
        return typeof v === "function" ? v.bind(obj) : v;
      },
    });
  }
  return Object.assign(f, overrides);
}

function hookPanel(panel) {
  try {
    const web = panel.webview;
    const orig = web.onDidReceiveMessage.bind(web);
    Object.defineProperty(web, "onDidReceiveMessage", {
      configurable: true,
      value: (listener, thisArg, disposables) => {
        // Registration marks the vendor's panel as fully constructed.
        state.handler = (msg) => Promise.resolve(listener.call(thisArg, msg));
        return orig(listener, thisArg, disposables);
      },
    });
  } catch (e) {
    log(`could not hook panel message handler: ${e.message}`);
  }
  state.panel = panel;
  panel.onDidDispose(() => {
    // Guard: an old panel's dispose can fire after a new panel was hooked —
    // only clear state that still belongs to this panel.
    if (state.panel !== panel) return;
    state.panel = null;
    state.handler = null;
    sendSessions();
  });
}

const windowFacade = facade(vscode.window, {
  createWebviewPanel: (viewType, title, showOptions, options) => {
    const panel = vscode.window.createWebviewPanel(viewType, title, showOptions, options);
    if (viewType === "opencode-v2-assistant") hookPanel(panel);
    return panel;
  },
});
// The vendor force-moves its panel into a floating window right after opening
// it (workbench.action.moveEditorToNewWindow). Swallow that so the assistant
// stays a normal editor tab; everything else passes through.
const commandsFacade = facade(vscode.commands, {
  executeCommand: (cmd, ...args) =>
    cmd === "workbench.action.moveEditorToNewWindow"
      ? Promise.resolve()
      : vscode.commands.executeCommand(cmd, ...args),
});

const vscodeFacade = facade(vscode, { window: windowFacade, commands: commandsFacade });

const vendorPath = path.join(__dirname, "extension.vendor.js");
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode" && parent && parent.filename === vendorPath) return vscodeFacade;
  return origLoad.apply(this, arguments);
};
const vendor = require("./extension.vendor.js");

// ---------------------------------------------------------------------------
// Session data: read opencode's sqlite db via the sqlite3 CLI (read-only).
// ---------------------------------------------------------------------------

function dbPath() {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "opencode", "opencode.db");
}

function workspaceDir() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
}

function querySessions() {
  return new Promise((resolve) => {
    const dir = workspaceDir().replace(/'/g, "''");
    const sql =
      `SELECT id, title, directory, time_updated FROM session ` +
      `WHERE parent_id IS NULL AND time_archived IS NULL ` +
      `AND (directory = '${dir}' OR directory LIKE '${dir}/%') ` +
      `ORDER BY time_updated DESC LIMIT 200;`;
    execFile("sqlite3", ["-readonly", "-json", dbPath(), sql], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        log(`sqlite query failed: ${err.message}`);
        return resolve({ error: err.code === "ENOENT" ? "sqlite3 CLI not found" : err.message, sessions: [] });
      }
      try {
        resolve({ sessions: stdout.trim() ? JSON.parse(stdout) : [] });
      } catch (e) {
        resolve({ error: e.message, sessions: [] });
      }
    });
  });
}

async function sendSessions() {
  if (!state.sidebar) return;
  const result = await querySessions();
  try {
    state.sidebar.webview.postMessage({
      type: "sessions",
      sessions: result.sessions,
      error: result.error,
      workspace: workspaceDir(),
      panelOpen: !!state.panel,
    });
  } catch {
    /* view disposed mid-flight */
  }
}

// ---------------------------------------------------------------------------
// Driving the vendor panel.
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The vendor hardcodes port 4096, does not handle "port already in use" (its
// spawn dies with ServeError and the client never initializes), and leaks its
// server child on window reload. The server deliberately outlives the panel
// (the vendor app persists for panel reuse), so within a session a running
// server is never stale — only one surviving from a previous extension host
// is. Therefore: reap once at activation, and kill our own on deactivate.
const SERVE_PATTERN = "opencode serve --hostname=127\\.0\\.0\\.1 --port=4096";

function reapStaleServer() {
  return new Promise((resolve) => {
    execFile("pkill", ["-f", SERVE_PATTERN], (err) => {
      if (!err) log("reaped stale opencode serve on port 4096");
      resolve(!err); // err = nothing matched (fine) or pkill missing
    });
  });
}

// Single-flight: concurrent sidebar clicks while the panel is still starting
// share ONE open attempt.
let panelOpening = null;

function ensurePanel() {
  if (state.panel && state.handler) {
    try {
      state.panel.reveal(undefined, false);
    } catch {}
    return Promise.resolve(true);
  }
  if (!panelOpening) {
    panelOpening = (async () => {
      try {
        // The vendor's openPanel command awaits its full init (server spawn,
        // model load, panel creation) before resolving.
        await vscode.commands.executeCommand("opencode-v2.openPanel");
        for (let i = 0; i < 150 && !state.handler; i++) await sleep(100); // safety net
        if (!state.handler) {
          vscode.window.showErrorMessage("OpenCode: assistant panel did not become ready.");
          return false;
        }
        return true;
      } finally {
        panelOpening = null;
      }
    })();
  }
  return panelOpening;
}

// The vendor panel is just an iframe onto the opencode server's web UI at
// http://127.0.0.1:4096 (its outer HTML has no script, so the vendor's own
// postMessage-based switchSession can never reach the UI). Navigation is the
// working lever: the web UI deep-links sessions at
//   /server/{base64url(serverUrl)}/session/{sessionId}
const SERVER_URL = "http://127.0.0.1:4096";
const SERVER_SLUG = Buffer.from(SERVER_URL, "utf8")
  .toString("base64")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=/g, "");

function iframeHtml(src) {
  // Mirrors the vendor's getHtmlForWebview, with a parameterized URL.
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body, html { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
    iframe { width: 100%; height: 100%; border: none; }
  </style>
</head>
<body>
  <iframe src="${src}" allow="clipboard-read; clipboard-write"></iframe>
</body>
</html>`;
}

async function navigatePanel(url) {
  if (!(await ensurePanel())) return false;
  const panel = state.panel;
  if (!panel) return false;
  try {
    panel.webview.html = iframeHtml(url);
    panel.reveal(undefined, false);
    return true;
  } catch (e) {
    log(`navigate failed: ${e.message}`);
    return false;
  }
}

function sessionDeepLink(sessionId) {
  // sessionId is interpolated into webview HTML; accept only the id shape
  // opencode generates (ses_ + alphanumerics) so no markup can ride along.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
    log(`rejected malformed session id: ${JSON.stringify(String(sessionId)).slice(0, 200)}`);
    return null;
  }
  return `${SERVER_URL}/server/${SERVER_SLUG}/session/${encodeURIComponent(sessionId)}`;
}

function openSession(sessionId) {
  const url = sessionDeepLink(sessionId);
  return url ? navigatePanel(url) : Promise.resolve(false);
}

async function newSession() {
  if (!(await ensurePanel())) return;
  try {
    const res = await fetch(`${SERVER_URL}/session?directory=${encodeURIComponent(workspaceDir())}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const session = await res.json();
    const url = sessionDeepLink(session.id);
    if (!url) throw new Error("unexpected session id in server response");
    await navigatePanel(url);
  } catch (e) {
    log(`create session failed (${e.message}); falling back to web UI home`);
    await navigatePanel(SERVER_URL);
  }
  await sleep(800);
  sendSessions();
}

// ---------------------------------------------------------------------------
// Sidebar webview.
// ---------------------------------------------------------------------------

class SessionsSidebarProvider {
  resolveWebviewView(view) {
    state.sidebar = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = sidebarHtml();
    view.webview.onDidReceiveMessage(async (m) => {
      switch (m.type) {
        case "ready":
        case "refresh":
          sendSessions();
          break;
        case "newSession":
          newSession();
          break;
        case "openSession":
          if (m.id) openSession(m.id);
          break;
      }
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) sendSessions();
    });
    view.onDidDispose(() => {
      if (state.sidebar === view) state.sidebar = null;
    });
  }
}

function sidebarHtml() {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body { padding: 8px 10px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  button.new {
    width: 100%; padding: 6px 0; margin-bottom: 8px; cursor: pointer; border-radius: 3px;
    color: var(--vscode-button-foreground); background: var(--vscode-button-background);
    border: 1px solid var(--vscode-button-border, transparent); font-size: inherit;
  }
  button.new:hover { background: var(--vscode-button-hoverBackground); }
  input.search {
    width: 100%; box-sizing: border-box; padding: 4px 6px; margin-bottom: 8px; border-radius: 2px;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent); font-size: inherit; outline: none;
  }
  input.search:focus { border-color: var(--vscode-focusBorder); }
  ul { list-style: none; margin: 0; padding: 0; }
  li.session { padding: 5px 6px; border-radius: 4px; cursor: pointer; }
  li.session:hover { background: var(--vscode-list-hoverBackground); }
  li.session .title { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  li.session .meta { display: block; font-size: 0.85em; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .empty, .error { color: var(--vscode-descriptionForeground); padding: 8px 2px; }
  .error { color: var(--vscode-errorForeground); }
</style>
</head>
<body>
  <button class="new" id="new">+ New session</button>
  <input class="search" id="search" type="text" placeholder="Search for sessions" />
  <div id="status"></div>
  <ul id="list"></ul>
<script>
  const vscode = acquireVsCodeApi();
  let sessions = [];
  let workspace = "";

  document.getElementById("new").addEventListener("click", () => vscode.postMessage({ type: "newSession" }));
  document.getElementById("search").addEventListener("input", render);

  function relTime(ms) {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }

  function render() {
    const q = document.getElementById("search").value.toLowerCase();
    const list = document.getElementById("list");
    list.textContent = "";
    const shown = sessions.filter(s => !q || (s.title || "").toLowerCase().includes(q));
    if (!shown.length) {
      const d = document.createElement("div");
      d.className = "empty";
      d.textContent = sessions.length ? "No sessions match." : "No sessions in this workspace yet.";
      list.appendChild(d);
      return;
    }
    for (const s of shown) {
      const li = document.createElement("li");
      li.className = "session";
      li.title = s.directory;
      const t = document.createElement("span");
      t.className = "title";
      t.textContent = s.title || s.id;
      const m = document.createElement("span");
      m.className = "meta";
      const sub = s.directory !== workspace ? " · " + s.directory.slice(workspace.length + 1) : "";
      m.textContent = relTime(s.time_updated) + sub;
      li.appendChild(t);
      li.appendChild(m);
      li.addEventListener("click", () => vscode.postMessage({ type: "openSession", id: s.id }));
      list.appendChild(li);
    }
  }

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (msg.type !== "sessions") return;
    sessions = msg.sessions || [];
    workspace = msg.workspace || "";
    document.getElementById("status").textContent = "";
    if (msg.error) {
      const d = document.createElement("div");
      d.className = "error";
      d.textContent = "Could not read sessions: " + msg.error;
      document.getElementById("status").replaceChildren(d);
    }
    render();
  });

  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Activation.
// ---------------------------------------------------------------------------

let dbWatcher = null;

function activate(context) {
  state.output = vscode.window.createOutputChannel("OpenCode Sidebar");
  context.subscriptions.push(state.output);

  // Fresh extension host: any opencode serve still on 4096 belongs to a dead
  // host (the vendor leaks it on reload) and would make the next spawn fail.
  reapStaleServer();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("opencode-v2.panel", new SessionsSidebarProvider())
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("opencode-v2.refreshSessions", () => sendSessions())
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("opencode-v2.newSession", () => newSession())
  );

  // Refresh the list when opencode writes to its db (debounced).
  try {
    const wal = dbPath() + "-wal";
    if (fs.existsSync(wal)) {
      let t = null;
      dbWatcher = fs.watch(wal, () => {
        clearTimeout(t);
        t = setTimeout(sendSessions, 500);
      });
      context.subscriptions.push({ dispose: () => dbWatcher && dbWatcher.close() });
    }
  } catch (e) {
    log(`db watch unavailable: ${e.message}`);
  }

  return vendor.activate(context);
}

function deactivate() {
  // Don't leak the vendor's server child across window reloads (it would hold
  // port 4096 and make the next panel open fail with ServeError).
  try {
    require("child_process").execFileSync("pkill", ["-f", SERVE_PATTERN]);
  } catch {
    /* nothing matched */
  }
  return vendor.deactivate && vendor.deactivate();
}

module.exports = { activate, deactivate };
