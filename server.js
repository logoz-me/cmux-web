#!/usr/bin/env node
'use strict';

// cmux-web — a self-hosted web interface that pilots the local cmux app.
//
// It talks to cmux through the official control socket by shelling out to the
// cmux CLI, so it only relies on documented cmux behaviour (tree, read-screen,
// send, send-key, events) instead of re-implementing the socket protocol.
//
//   node server.js

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { CmuxSocket } = require('./cmux-socket');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(ROOT, 'config.json');
// Binaire cmux : variable d'environnement, puis PATH, puis l'application.
function resolveCmuxBin() {
  if (process.env.CMUX_BIN) return process.env.CMUX_BIN;
  const dirs = (process.env.PATH || '').split(':');
  for (const dir of dirs) {
    const candidate = path.join(dir, 'cmux');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* suivant */ }
  }
  const app = '/Applications/cmux.app/Contents/Resources/bin/cmux';
  return fs.existsSync(app) ? app : 'cmux';
}

const CMUX_BIN = resolveCmuxBin();
// cmux stores its control-socket password in its own state directory. Reading
// it from there means the web server always agrees with the app, even if the
// password is rotated from the Settings UI.
const SOCKET_PASSWORD_FILES = [
  process.env.CMUX_SOCKET_PASSWORD_FILE,
  path.join(os.homedir(), '.local', 'state', 'cmux', 'socket-control-password'),
  path.join(os.homedir(), '.cmux-socket-password'),
].filter(Boolean);

// --------------------------------------------------------------------- config

function loadConfig() {
  const defaults = {
    host: '127.0.0.1',
    port: 9999,
    tokenFile: path.join(ROOT, '.web-token'),
    cmuxBin: CMUX_BIN,
  };
  let file = {};
  try { file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* first run */ }
  const cfg = { ...defaults, ...file };
  if (!cfg.token) {
    try { cfg.token = fs.readFileSync(cfg.tokenFile, 'utf8').trim(); } catch { /* generate */ }
  }
  if (!cfg.token) {
    cfg.token = crypto.randomBytes(24).toString('base64url');
    fs.writeFileSync(cfg.tokenFile, cfg.token, { mode: 0o600 });
  }
  return cfg;
}

const CONFIG = loadConfig();

function socketPassword() {
  if (process.env.CMUX_SOCKET_PASSWORD) return process.env.CMUX_SOCKET_PASSWORD;
  for (const file of SOCKET_PASSWORD_FILES) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim();
      if (value) return value;
    } catch { /* try the next candidate */ }
  }
  return '';
}

// Connexion permanente au socket de contrôle cmux : un appel coûte ~3 ms
// au lieu de ~150 ms pour un nouveau processus CLI.
const cmuxSocket = new CmuxSocket({ password: () => socketPassword() });

async function socketCall(method, params) {
  const response = await cmuxSocket.call(method, params);
  if (response.ok === false) {
    const error = new Error((response.error && response.error.message) || 'socket error');
    error.code = response.error && response.error.code;
    throw error;
  }
  return response.result || {};
}

// ------------------------------------------------------------------ cmux I/O

function cmux(args, { timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(CONFIG.cmuxBin, args, {
      env: { ...process.env, CMUX_SOCKET_PASSWORD: socketPassword() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('cmux timeout: ' + args.join(' ')));
    }, timeout);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ out, err });
      reject(new Error((err || out || ('exit ' + code)).trim()));
    });
  });
}

async function cmuxJson(args, fallback = null) {
  try {
    const { out } = await cmux([...args, '--json']);
    return JSON.parse(out);
  } catch (e) {
    if (fallback !== null) return fallback;
    throw e;
  }
}

// -------------------------------------------------------------- http helpers

function sendJson(res, code, body) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 4e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function tokenFrom(req, url) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)cmux_token=([^;]+)/);
  if (m) return decodeURIComponent(m[1]);
  return url.searchParams.get('token') || '';
}

function authorized(req, url) {
  const t = tokenFrom(req, url);
  if (!t || t.length !== CONFIG.token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(CONFIG.token));
}

// -------------------------------------------------------------------- routes

// ------------------------------------------------------------------ caches
//
// Assembler l'arborescence coûte ~60 ms dans l'app (elle parcourt tout son
// état sur le thread principal). On garde donc le résultat en cache et on
// l'invalide quand un événement signale un changement de structure.

const CACHE_TTL = {
  tree: 1200,
  panes: 1200,
  agents: 5000,
  notifications: 1500,
};

const caches = {
  tree: { value: null, at: 0 },
  panes: new Map(),
  agents: { value: null, at: 0 },
  notifications: { value: null, at: 0 },
};

function cacheGet(key, ttl) {
  const entry = caches[key];
  if (!entry || !entry.value) return null;
  if (Date.now() - entry.at > ttl) return null;
  return entry.value;
}

function cacheSet(key, value) {
  if (caches[key] && !Array.isArray(caches[key])) {
    caches[key].value = value;
    caches[key].at = Date.now();
  }
}

function invalidateTree() {
  caches.tree.value = null;
  caches.panes.clear();
}

async function apiTree() {
  const cached = cacheGet('tree', CACHE_TTL.tree);
  if (cached) return cached;
  try {
    const tree = await socketCall('system.tree', { all: true, id_format: 'both' });
    cacheSet('tree', tree);
    return tree;
  } catch {
    const tree = await cmuxJson(['tree', '--all', '--id-format', 'both'], null);
    const value = tree || { windows: [], active: null };
    cacheSet('tree', value);
    return value;
  }
}

async function apiScreen(surface, format) {
  if (!surface) throw new Error('surface required');
  if (format === 'text') {
    const { out } = await cmux(['read-screen', '--surface', surface, '--scrollback', '--lines', '500']);
    return { format: 'text', text: out };
  }
  let data;
  try {
    data = await socketCall('terminal.replay', { surface_id: surface });
  } catch {
    const { out } = await cmux(['rpc', 'terminal.replay', JSON.stringify({ surface_id: surface })]);
    data = JSON.parse(out);
  }
  const g = data.render_grid || {};
  return {
    format: 'grid',
    seq: data.seq ?? null,
    columns: g.columns ?? data.columns ?? 80,
    rows: g.rows ?? 24,
    cursor: g.cursor ?? null,
    styles: g.styles ?? [],
    row_spans: g.row_spans ?? [],
    background: g.terminal_background ?? '#0d0f14',
    foreground: g.terminal_foreground ?? '#e6e6e6',
    theme: g.terminal_theme ?? null,
  };
}

async function apiInput(body) {
  const surface = body.surface;
  if (!surface) throw new Error('surface required');
  if (body.key) {
    try {
      await socketCall('surface.send_key', { surface_id: surface, key: String(body.key) });
    } catch {
      await cmux(['send-key', '--surface', surface, String(body.key)]);
    }
    return { ok: true, kind: 'key', key: body.key };
  }
  const text = String(body.text ?? '');
  if (!text) return { ok: true, kind: 'noop' };
  try {
    await socketCall('surface.send_text', { surface_id: surface, text });
  } catch {
    await cmux(['send', '--surface', surface, text]);
  }
  return { ok: true, kind: 'text', length: text.length };
}

async function apiAgentMessage(body) {
  const { out } = await cmux(['rpc', 'agent.message.send', JSON.stringify({
    surface_id: body.surface,
    text: body.text,
  })]);
  return { ok: true, result: JSON.parse(out) };
}

async function apiNotifications() {
  const cached = cacheGet('notifications', CACHE_TTL.notifications);
  if (cached) return cached;
  const list = await cmuxJson(['list-notifications'], []);
  const value = Array.isArray(list) ? list : (list.notifications || []);
  cacheSet('notifications', value);
  return value;
}

async function apiFocus(body) {
  if (body.workspace) {
    try {
      await socketCall('workspace.select', { workspace_id: String(body.workspace) });
    } catch {
      await cmux(['select-workspace', '--workspace', String(body.workspace)]);
    }
  }
  if (body.surface) {
    // C'est ce qui rend l'onglet cliquable : cmux doit sélectionner la
    // surface, sinon le rendu rebascule sur l'onglet précédent.
    try {
      await socketCall('surface.focus', { surface_id: String(body.surface) });
      return { ok: true };
    } catch {
      await cmux(['focus-surface', '--surface', String(body.surface)]);
      return { ok: true };
    }
  }
  if (body.pane) {
    try {
      await socketCall('pane.focus', { pane_id: String(body.pane) });
    } catch {
      try {
        await cmux(['focus-pane', '--pane', String(body.pane)]);
      } catch { /* the pane may not exist any more */ }
    }
  }
  return { ok: true };
}

// The sidebar snapshot carries exactly what the native sidebar renders:
// title, agent preview, git branches, ports, unread count, selection.
async function apiSidebar() {
  try {
    return await socketCall('extension.sidebar.snapshot', {});
  } catch {
    const { out } = await cmux(['rpc', 'extension.sidebar.snapshot', '{}']);
    return JSON.parse(out);
  }
}

// Pane geometry (split layout) for a workspace.
async function apiPanes(workspace) {
  const params = workspace ? { workspace_id: workspace } : {};
  const key = workspace || '';
  const entry = caches.panes.get(key);
  if (entry && Date.now() - entry.at <= CACHE_TTL.panes) return entry.value;
  try {
    const value = await socketCall('pane.list', params);
    caches.panes.set(key, { value, at: Date.now() });
    return value;
  } catch {
    const { out } = await cmux(['rpc', 'pane.list', JSON.stringify(params)]);
    const value = JSON.parse(out);
    caches.panes.set(key, { value, at: Date.now() });
    return value;
  }
}

async function apiFeed() {
  const { out } = await cmux(['rpc', 'feed.list', '{}']);
  return JSON.parse(out);
}

async function apiTodos(workspace) {
  const args = ['todo', 'list', '--json'];
  if (workspace) args.push('--workspace', workspace);
  const { out } = await cmux(args);
  return JSON.parse(out);
}

async function apiSessions() {
  const { out } = await cmux(['sessions', 'list', '--json']);
  return JSON.parse(out);
}

async function apiWorkspaceAction(body) {
  try {
    const result = await socketCall('workspace.action', {
      workspace_id: String(body.workspace),
      action: String(body.action),
      title: body.title,
      description: body.description,
    });
    return { ok: true, result };
  } catch {
    // Repli sur le CLI.
  }
  const args = ['workspace-action', '--action', String(body.action)];
  if (body.workspace) args.push('--workspace', String(body.workspace));
  if (body.title) args.push('--title', String(body.title));
  if (body.description) args.push('--description', String(body.description));
  const { out } = await cmux(args);
  return { ok: true, out: out.trim() };
}

async function apiTabAction(body) {
  try {
    const result = await socketCall('surface.action', {
      surface_id: String(body.surface),
      action: String(body.action),
      title: body.title,
    });
    return { ok: true, result };
  } catch {
    // Repli sur le CLI.
  }
  const args = ['tab-action', '--action', String(body.action)];
  if (body.surface) args.push('--surface', String(body.surface));
  if (body.tab) args.push('--tab', String(body.tab));
  if (body.title) args.push('--title', String(body.title));
  const { out } = await cmux(args);
  return { ok: true, out: out.trim() };
}

async function apiNewSurface(body) {
  const args = ['new-surface'];
  if (body.pane) args.push('--pane', String(body.pane));
  if (body.workspace) args.push('--workspace', String(body.workspace));
  if (body.type) args.push('--type', String(body.type));
  if (body.command) args.push('--command', String(body.command));
  const { out } = await cmux(args);
  return { ok: true, out: out.trim() };
}

async function apiNewSplit(body) {
  const args = ['new-split', String(body.direction || 'right')];
  if (body.surface) args.push('--surface', String(body.surface));
  if (body.workspace) args.push('--workspace', String(body.workspace));
  const { out } = await cmux(args);
  return { ok: true, out: out.trim() };
}

async function apiNewWorkspace(body) {
  const args = ['new-workspace'];
  if (body.cwd) args.push('--cwd', String(body.cwd));
  if (body.name) args.push('--name', String(body.name));
  const { out } = await cmux(args);
  return { ok: true, out: out.trim() };
}

async function apiCloseSurface(body) {
  try {
    await socketCall('surface.close', { surface_id: String(body.surface) });
    return { ok: true };
  } catch {
    const { out } = await cmux(['close-surface', '--surface', String(body.surface)]);
    return { ok: true, out: out.trim() };
  }
}

async function apiCloseWorkspace(body) {
  try {
    await socketCall('workspace.close', { workspace_id: String(body.workspace) });
    return { ok: true };
  } catch {
    const { out } = await cmux(['close-workspace', '--workspace', String(body.workspace)]);
    return { ok: true, out: out.trim() };
  }
}

// État des agents par workspace, lu dans le journal agent de cmux (la même
// source que la sidebar native).
async function apiAgents() {
  const cached = cacheGet('agents', CACHE_TTL.agents);
  if (cached) return cached;
  const candidates = [
    path.join(os.homedir(), 'Library', 'Application Support', 'cmux',
      'agent-journal-com.cmuxterm.app.sqlite3'),
  ];
  const db = candidates.find((f) => fs.existsSync(f));
  if (!db) return { agents: {} };

  const sql = [
    'WITH st AS (',
    '  SELECT workspace_id, agent_key, source, declared_phase, occurred_at_ms,',
    '         ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY sequence DESC) rn',
    '  FROM agent_journal',
    "  WHERE kind='agent.state.changed' AND workspace_id IS NOT NULL",
    '),',
    'att AS (',
    '  SELECT workspace_id,',
    "    SUM(CASE WHEN kind IN ('agent.approval.requested','agent.question.requested') THEN 1 ELSE 0 END)",
    "    - SUM(CASE WHEN kind='agent.attention.resolved' THEN 1 ELSE 0 END) AS pending,",
    '    MAX(CASE WHEN kind IN (\'agent.approval.requested\',\'agent.question.requested\')',
    '      THEN occurred_at_ms ELSE 0 END) AS last_attention_ms',
    '  FROM agent_journal WHERE workspace_id IS NOT NULL GROUP BY workspace_id',
    ')',
    'SELECT st.workspace_id, st.agent_key, st.source, st.declared_phase,',
    '       st.occurred_at_ms, COALESCE(att.pending,0) AS pending,',
    '       COALESCE(att.last_attention_ms,0) AS last_attention_ms',
    'FROM st LEFT JOIN att ON att.workspace_id=st.workspace_id',
    'WHERE st.rn=1;',
  ].join('\n');

  return new Promise((resolve) => {
    const child = spawn('sqlite3', ['-readonly', '-separator', '\t', db, sql], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; });
    child.on('error', () => resolve({ agents: {} }));
    child.on('close', () => {
      const agents = {};
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue;
        const [workspaceId, agentKey, source, phase, at, pending, lastAttention] = line.split('\t');
        agents[workspaceId] = {
          agent: agentKey || null,
          source: source || null,
          phase: phase || null,
          at: Number(at) || 0,
          pending: Number(pending) || 0,
          last_attention_ms: Number(lastAttention) || 0,
        };
      }
      const value = { agents };
      cacheSet('agents', value);
      resolve(value);
    });
  });
}

// --------------------------------------------------------------- event stream

const sseClients = new Set();
let eventsProc = null;

function startEventStream() {
  if (eventsProc) return;
  eventsProc = spawn(CONFIG.cmuxBin, ['events', '--reconnect', '--no-heartbeat'], {
    env: { ...process.env, CMUX_SOCKET_PASSWORD: socketPassword() },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let buf = '';
  eventsProc.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      // Un changement de structure invalide l'arborescence en cache.
      const category = message.category;
      if (category === 'workspace' || category === 'surface' || category === 'pane'
          || category === 'window') {
        invalidateTree();
      }
      if (category === 'notification') {
        caches.notifications.value = null;
      }
      broadcast(message);
    }
  });
  eventsProc.on('exit', () => {
    eventsProc = null;
    setTimeout(startEventStream, 2000);
  });
}

function broadcast(data) {
  const payload = 'data: ' + JSON.stringify(data) + '\n\n';
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

// --------------------------------------------------------------------- pages

function loginPage() {
  return [
    '<!doctype html><html lang="fr"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>cmux-web</title><style>',
    'body{background:#0b0d12;color:#e6e6e6;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
    'display:grid;place-items:center;height:100vh;margin:0}',
    'form{background:#141821;border:1px solid #232a36;border-radius:14px;padding:28px;width:min(360px,90vw)}',
    'h1{font-size:15px;margin:0 0 18px;letter-spacing:.4px}',
    'input{width:100%;box-sizing:border-box;padding:11px;border-radius:9px;border:1px solid #2b3342;',
    'background:#0b0f16;color:#e6e6e6;font-size:14px}',
    'button{margin-top:12px;width:100%;padding:11px;border:0;border-radius:9px;background:#4f8cff;',
    'color:#fff;font-weight:600;cursor:pointer}',
    'small{color:#77839a;display:block;margin-top:16px;word-break:break-all}',
    'code{color:#9db4e8}</style></head><body>',
    '<form method="post" action="/login"><h1>cmux-web — authentification</h1>',
    '<input name="token" type="password" placeholder="jeton d’accès" autofocus required>',
    '<button type="submit">Se connecter</button>',
    '<small>Jeton : <code>' + CONFIG.tokenFile + '</code></small>',
    '</form></body></html>',
  ].join('');
}

// -------------------------------------------------------------------- server

const handler = async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = url.pathname;

  try {
    if (p === '/login' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.token === CONFIG.token) {
        res.writeHead(302, {
          'set-cookie': 'cmux_token=' + encodeURIComponent(CONFIG.token)
            + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000',
          location: '/',
        });
        return res.end();
      }
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('jeton invalide');
    }

    if (!authorized(req, url)) {
      if (p.startsWith('/api/')) return sendJson(res, 401, { error: 'unauthorized' });
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(loginPage());
    }

    // A ?token= link is turned into a session cookie so that the page,
    // its assets and its API calls all share the same authentication.
    if (req.method === 'GET' && url.searchParams.get('token')) {
      res.writeHead(302, {
        'set-cookie': 'cmux_token=' + encodeURIComponent(CONFIG.token)
          + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000',
        location: '/' + (url.searchParams.get('path') || ''),
      });
      return res.end();
    }

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(path.join(PUBLIC, 'index.html')));
    }
    if (req.method === 'GET' && /\.(js|css|svg)$/.test(p)) {
      const file = path.join(PUBLIC, path.basename(p));
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)], 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(file));
    }

    if (p === '/api/tree' && req.method === 'GET') return sendJson(res, 200, await apiTree());

    if (p === '/api/screen' && req.method === 'GET') {
      return sendJson(res, 200, await apiScreen(url.searchParams.get('surface'), url.searchParams.get('format') || 'grid'));
    }

    if (p === '/api/input' && req.method === 'POST') {
      return sendJson(res, 200, await apiInput(await readBody(req)));
    }

    if (p === '/api/agent-message' && req.method === 'POST') {
      return sendJson(res, 200, await apiAgentMessage(await readBody(req)));
    }

    if (p === '/api/notifications' && req.method === 'GET') {
      return sendJson(res, 200, await apiNotifications());
    }

    if (p === '/api/focus' && req.method === 'POST') {
      return sendJson(res, 200, await apiFocus(await readBody(req)));
    }

    if (p === '/api/sidebar' && req.method === 'GET') {
      return sendJson(res, 200, await apiSidebar());
    }

    if (p === '/api/panes' && req.method === 'GET') {
      return sendJson(res, 200, await apiPanes(url.searchParams.get('workspace')));
    }

    if (p === '/api/feed' && req.method === 'GET') {
      return sendJson(res, 200, await apiFeed());
    }

    if (p === '/api/todos' && req.method === 'GET') {
      return sendJson(res, 200, await apiTodos(url.searchParams.get('workspace')));
    }

    if (p === '/api/sessions' && req.method === 'GET') {
      return sendJson(res, 200, await apiSessions());
    }

    if (p === '/api/workspace-action' && req.method === 'POST') {
      return sendJson(res, 200, await apiWorkspaceAction(await readBody(req)));
    }

    if (p === '/api/tab-action' && req.method === 'POST') {
      return sendJson(res, 200, await apiTabAction(await readBody(req)));
    }

    if (p === '/api/new-surface' && req.method === 'POST') {
      return sendJson(res, 200, await apiNewSurface(await readBody(req)));
    }

    if (p === '/api/new-split' && req.method === 'POST') {
      return sendJson(res, 200, await apiNewSplit(await readBody(req)));
    }

    if (p === '/api/new-workspace' && req.method === 'POST') {
      return sendJson(res, 200, await apiNewWorkspace(await readBody(req)));
    }

    if (p === '/api/close-workspace' && req.method === 'POST') {
      return sendJson(res, 200, await apiCloseWorkspace(await readBody(req)));
    }

    if (p === '/api/close-surface' && req.method === 'POST') {
      return sendJson(res, 200, await apiCloseSurface(await readBody(req)));
    }

    if (p === '/api/agents' && req.method === 'GET') {
      return sendJson(res, 200, await apiAgents());
    }

    if (p === '/api/health' && req.method === 'GET') {
      let ok = false, access = null, error = null;
      try {
        const c = await cmuxJson(['capabilities'], null);
        ok = !!c;
        access = c && c.access_mode;
      } catch (e) { error = String(e.message || e); }
      return sendJson(res, 200, {
        ok, access_mode: access, error,
        host: CONFIG.host, port: CONFIG.port,
        socket_password_files: SOCKET_PASSWORD_FILES,
      });
    }

    if (p === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (e) {
    sendJson(res, 500, { error: String((e && e.message) || e) });
  }
};

let server;
if (CONFIG.tls && CONFIG.tls.cert && CONFIG.tls.key
    && fs.existsSync(CONFIG.tls.cert) && fs.existsSync(CONFIG.tls.key)) {
  server = https.createServer({
    cert: fs.readFileSync(CONFIG.tls.cert),
    key: fs.readFileSync(CONFIG.tls.key),
  }, handler);
} else {
  server = http.createServer(handler);
}

server.listen(CONFIG.port, CONFIG.host, () => {
  const shown = CONFIG.host === '0.0.0.0' ? 'localhost' : CONFIG.host;
  const scheme = server instanceof https.Server ? 'https' : 'http';
  console.log('cmux-web → ' + scheme + '://' + shown + ':' + CONFIG.port);
  console.log('jeton : ' + CONFIG.tokenFile);
  startEventStream();
});

server.on('error', (e) => {
  console.error('cmux-web: ' + e.message);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (eventsProc) eventsProc.kill();
    process.exit(0);
  });
}
