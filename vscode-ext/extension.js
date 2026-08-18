// Local wrapper around the vendor OpenCode extension bundle (extension.vendor.js).
// Adds a working sidebar (WebviewView) for the "opencode-v2.panel" view that the
// vendor package.json declares but never implements ("no data provider" error).
//
// The vendor's assistant panel is a bare iframe onto the opencode server's web
// UI (http://127.0.0.1:4096); its postMessage plumbing never reaches that UI.
// This wrapper therefore bypasses the vendor panel entirely: it manages the
// `opencode serve` process itself and opens ONE editor tab per session, each an
// iframe on the session's deep-link URL. The sidebar lists the current
// workspace's sessions (read from opencode's sqlite db); clicking one opens or
// reveals its tab. The vendor's openPanel command (Ctrl+Escape) is intercepted
// to open a web-UI home tab against our server instead of crashing on the
// occupied port.
//
// NOTE: wiped by any extension update — see repatch script.

"use strict";

const path = require("path");
const os = require("os");
const fs = require("fs");
const http = require("http");
const net = require("net");
const { execFile, spawn } = require("child_process");
const Module = require("module");
const vscode = require("vscode");

const state = {
  sidebar: null, // our WebviewView, when visible
  output: null, // OutputChannel
};

const panels = new Map(); // sessionId -> WebviewPanel (plus HOME_KEY for the home tab)
const HOME_KEY = Symbol("home");

function log(msg) {
  if (state.output) state.output.appendLine(`[sidebar] ${msg}`);
}

// ---------------------------------------------------------------------------
// Vendor bundle: load it through a require("vscode") shim so we can replace
// the openPanel command it registers. The rest of its activate (output
// channel, refreshPanel command) runs untouched — but its own panel and
// server management are never used.
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

const commandsFacade = facade(vscode.commands, {
  registerCommand: (id, cb, thisArg) => {
    if (id === "opencode-v2.openPanel") {
      // Vendor's panel would spawn a second server on the same fixed port and
      // die with ServeError; give the keybinding a working home tab instead.
      return vscode.commands.registerCommand(id, () => openHome());
    }
    return vscode.commands.registerCommand(id, cb, thisArg);
  },
});
const vscodeFacade = facade(vscode, { commands: commandsFacade });

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
    });
  } catch {
    /* view disposed mid-flight */
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle. The web UI needs `opencode serve` on the fixed port 4096.
// We own the process: reap orphans from dead extension hosts at activation,
// spawn on demand, kill on deactivate.
// ---------------------------------------------------------------------------

const SERVER_URL = "http://127.0.0.1:4096";
const SERVE_PATTERN = "opencode serve --hostname=127\\.0\\.0\\.1 --port=4096";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function reapStaleServer() {
  return new Promise((resolve) => {
    execFile("pkill", ["-f", SERVE_PATTERN], (err) => {
      if (!err) log("reaped stale opencode serve on port 4096");
      resolve(!err); // err = nothing matched (fine) or pkill missing
    });
  });
}

async function serverHealthy() {
  try {
    const res = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

let serverProc = null;
let serverStarting = null; // single-flight

function ensureServer() {
  if (!serverStarting) {
    serverStarting = (async () => {
      try {
        if (await serverHealthy()) return true;
        if (await reapStaleServer()) await sleep(500); // unhealthy squatter — clear the port
        const ws = workspaceDir();
        log(`starting opencode serve (workspace: ${ws})`);
        serverProc = spawn("opencode", ["serve", "--hostname=127.0.0.1", "--port=4096"], {
          env: { ...process.env, PWD: ws, OPENCODE_WORKSPACE: ws },
          stdio: "ignore",
        });
        serverProc.on("exit", (code) => log(`opencode serve exited (code ${code})`));
        serverProc.on("error", (e) => log(`opencode serve spawn error: ${e.message}`));
        for (let i = 0; i < 100; i++) {
          if (await serverHealthy()) return true;
          await sleep(200);
        }
        vscode.window.showErrorMessage("OpenCode: server did not become healthy on port 4096.");
        return false;
      } finally {
        serverStarting = null;
      }
    })();
  }
  return serverStarting;
}

// ---------------------------------------------------------------------------
// Injecting proxy: the web UI has no embed mode, so each tab loads the app
// through a local proxy that forwards to the opencode server and injects one
// CSS rule hiding the app's internal tab bar (header[data-slot=titlebar-v2]).
// The deep link's /server/{b64} segment points at the proxy too, so all API
// and SSE traffic stays same-origin through it.
// ---------------------------------------------------------------------------

const INJECT_CSS = `<style id="oc-vscode-embed">header[data-slot="titlebar-v2"]{display:none !important}</style>`;

let proxyServer = null;
let proxyUrl = null;
let proxyStarting = null; // single-flight

function ensureProxy() {
  if (proxyUrl) return Promise.resolve(proxyUrl);
  if (!proxyStarting) {
    proxyStarting = new Promise((resolve) => {
      proxyServer = http.createServer((req, res) => {
        const headers = { ...req.headers, host: "127.0.0.1:4096" };
        delete headers["accept-encoding"]; // identity encoding so HTML is injectable
        const up = http.request({ hostname: "127.0.0.1", port: 4096, path: req.url, method: req.method, headers }, (ur) => {
          const ct = ur.headers["content-type"] || "";
          if (ct.includes("text/html")) {
            const chunks = [];
            ur.on("data", (c) => chunks.push(c));
            ur.on("end", () => {
              let html = Buffer.concat(chunks).toString("utf8");
              html = html.includes("</head>") ? html.replace("</head>", INJECT_CSS + "</head>") : INJECT_CSS + html;
              const h = { ...ur.headers };
              delete h["content-length"];
              delete h["content-encoding"];
              res.writeHead(ur.statusCode, h);
              res.end(html);
            });
          } else {
            res.writeHead(ur.statusCode, ur.headers);
            ur.pipe(res);
          }
        });
        up.on("error", () => {
          if (!res.headersSent) res.writeHead(502);
          res.end("opencode server unreachable");
        });
        req.pipe(up);
      });
      // Tunnel WebSocket upgrades transparently.
      proxyServer.on("upgrade", (req, socket, head) => {
        const upstream = net.connect(4096, "127.0.0.1", () => {
          let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
          for (let i = 0; i < req.rawHeaders.length; i += 2) {
            const name = req.rawHeaders[i];
            const value = name.toLowerCase() === "host" ? "127.0.0.1:4096" : req.rawHeaders[i + 1];
            raw += `${name}: ${value}\r\n`;
          }
          raw += "\r\n";
          upstream.write(raw);
          if (head && head.length) upstream.write(head);
          upstream.pipe(socket);
          socket.pipe(upstream);
        });
        const drop = () => {
          socket.destroy();
          upstream.destroy();
        };
        upstream.on("error", drop);
        socket.on("error", drop);
      });
      proxyServer.on("error", (e) => {
        log(`proxy error: ${e.message}`);
        resolve(null);
      });
      proxyServer.listen(0, "127.0.0.1", () => {
        proxyUrl = `http://127.0.0.1:${proxyServer.address().port}`;
        log(`embed proxy on ${proxyUrl}`);
        resolve(proxyUrl);
      });
    }).finally(() => {
      proxyStarting = null;
    });
  }
  return proxyStarting;
}

// ---------------------------------------------------------------------------
// Session tabs: one WebviewPanel per session, iframe on the deep-link URL.
// ---------------------------------------------------------------------------

function b64url(s) {
  return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function sessionDeepLink(base, sessionId) {
  // sessionId is interpolated into webview HTML; accept only the id shape
  // opencode generates so no markup can ride along.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
    log(`rejected malformed session id: ${JSON.stringify(String(sessionId)).slice(0, 200)}`);
    return null;
  }
  return `${base}/server/${b64url(base)}/session/${encodeURIComponent(sessionId)}`;
}

function iframeHtml(src, persistState) {
  // persistState (validated session id or null) lets the serializer restore
  // this tab after a window reload.
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body, html { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
    iframe { width: 100%; height: 100%; border: none; }
    p { color: var(--vscode-descriptionForeground); font-family: var(--vscode-font-family); padding: 12px; }
  </style>
</head>
<body>
  <iframe src="${src}" allow="clipboard-read; clipboard-write"></iframe>
  <script>try { acquireVsCodeApi().setState({ sessionId: ${JSON.stringify(persistState)} }); } catch (e) {}</script>
</body>
</html>`;
}

function loadingHtml(text) {
  return `<!DOCTYPE html><html><body style="font-family: var(--vscode-font-family); color: var(--vscode-descriptionForeground); padding: 12px;">${text}</body></html>`;
}

function trackPanel(key, panel) {
  panels.set(key, panel);
  panel.onDidDispose(() => {
    if (panels.get(key) === panel) panels.delete(key);
  });
}

async function fillPanel(panel, sessionId) {
  // sessionId null = home tab
  const base = (await ensureServer()) ? await ensureProxy() : null;
  if (!base) {
    try {
      panel.webview.html = loadingHtml("OpenCode server failed to start. Close this tab and try again.");
    } catch {}
    return false;
  }
  const url = sessionId ? sessionDeepLink(base, sessionId) : base;
  if (!url) return false;
  try {
    panel.webview.html = iframeHtml(url, sessionId);
    return true;
  } catch (e) {
    log(`fillPanel failed: ${e.message}`);
    return false;
  }
}

function openTab(key, sessionId, title) {
  const existing = panels.get(key);
  if (existing) {
    try {
      existing.reveal(undefined, false);
    } catch {}
    return existing;
  }
  const panel = vscode.window.createWebviewPanel(
    "opencode-session",
    title || "OpenCode",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = loadingHtml("Starting OpenCode…");
  trackPanel(key, panel);
  fillPanel(panel, sessionId);
  return panel;
}

function openSession(sessionId, title) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return;
  openTab(sessionId, sessionId, title);
}

function openHome() {
  openTab(HOME_KEY, null, "OpenCode");
}

async function newSession() {
  if (!(await ensureServer())) return;
  try {
    const res = await fetch(`${SERVER_URL}/session?directory=${encodeURIComponent(workspaceDir())}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const session = await res.json();
    if (typeof session.id === "string") {
      openSession(session.id, session.title || "New session");
    } else {
      throw new Error("unexpected session id in server response");
    }
  } catch (e) {
    log(`create session failed (${e.message}); opening web UI home instead`);
    openHome();
  }
  await sleep(800);
  sendSessions();
}

// Restore session tabs across window reloads.
class SessionPanelSerializer {
  async deserializeWebviewPanel(panel, saved) {
    const sessionId = saved && typeof saved.sessionId === "string" ? saved.sessionId : null;
    trackPanel(sessionId || HOME_KEY, panel);
    panel.webview.html = loadingHtml("Starting OpenCode…");
    await fillPanel(panel, sessionId);
  }
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
          if (typeof m.id === "string") openSession(m.id, typeof m.title === "string" ? m.title : undefined);
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
      li.addEventListener("click", () => vscode.postMessage({ type: "openSession", id: s.id, title: s.title }));
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
  // host (spawns are leaked on reload) and would block our own spawn.
  reapStaleServer();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("opencode-v2.panel", new SessionsSidebarProvider())
  );
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("opencode-session", new SessionPanelSerializer())
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
  try {
    if (proxyServer) proxyServer.close();
  } catch {}
  // Don't leak the server across window reloads (it would hold port 4096 and
  // block the next spawn).
  try {
    if (serverProc && !serverProc.killed) serverProc.kill();
  } catch {}
  try {
    require("child_process").execFileSync("pkill", ["-f", SERVE_PATTERN]);
  } catch {
    /* nothing matched */
  }
  return vendor.deactivate && vendor.deactivate();
}

module.exports = { activate, deactivate };
