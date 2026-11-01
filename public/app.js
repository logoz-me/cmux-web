'use strict';

// ---------------------------------------------------------------------------
// cmux-web — pilote l'application cmux locale depuis le navigateur.
//
// L'interface reproduit celle de l'app native : barre de titre (chrome
// macOS, toggle sidebar, cloche, nouveau workspace), sidebar des workspaces
// (carte sélectionnée bleue, aperçu de l'agent, branche · dossier), canvas
// avec un onglet par surface et un panneau par pane.
//
// Les données viennent du socket de contrôle cmux via le serveur local.
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  sidebar: null,        // extension.sidebar.snapshot
  tree: null,           // cmux tree
  panes: null,          // pane.list (géométrie)
  workspace: null,      // workspace sélectionné (id)
  surface: null,        // surface sélectionnée (id)
  focusPane: null,
  screens: new Map(),   // surfaceId -> {hash, html}
  notifications: [],
  rawBuffer: '',
  rawTimer: null,
  sidebarHidden: false,
  rightMode: 'feed',
  rightOpen: false,
  sendQueue: Promise.resolve(),
  rawPending: false,
  agents: {},
  canvasSignature: '',
  fontStep: 0,
  drawerOpen: false,
  ctrlArmed: false,
};

// --------------------------------------------------------------------- API

const API = {
  async get(path) {
    const r = await fetch(path, { credentials: 'same-origin' });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || ('HTTP ' + r.status));
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || ('HTTP ' + r.status));
    return r.json();
  },
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

let hintTimer = null;

function hint(msg, kind) {
  const el = $('#hint');
  const bar = $('#hint-bar');
  el.textContent = msg || '';
  el.className = kind || '';
  if (bar) {
    bar.classList.toggle('show', !!msg);
    clearTimeout(hintTimer);
    if (msg) hintTimer = setTimeout(() => bar.classList.remove('show'), 2200);
  }
}

function shortPath(p) {
  if (!p) return '';
  const home = homeDir();
  if (p === home) return '~';
  if (p.startsWith(home + '/')) return '~' + p.slice(home.length);
  return p;
}

// Le dossier personnel, déduit des workspaces (le plus court cheminObservé).
function homeDir() {
  const dirs = (state.sidebar && state.sidebar.workspaces || [])
    .map((w) => w.current_directory || '')
    .filter(Boolean)
    .sort((a, b) => a.length - b.length);
  if (dirs.length) {
    const first = dirs[0];
    const m = first.match(/^(\/Users\/[^/]+)/);
    if (m) return m[1];
  }
  return '/Users';
}

// ----------------------------------------------------------------- sidebar

function workspaceRows() {
  const snap = state.sidebar;
  if (!snap) return [];
  const list = (snap.workspaces || []).slice();
  const q = $('#search').value.trim().toLowerCase();
  if (!q) return list;
  return list.filter((w) => {
    const hay = [w.title, w.description, w.current_directory, (w.git_branches || []).join(' ')]
      .filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });
}

function agentChips(ws) {
  const chips = [];
  const preview = ws.latest_conversation_message;
  if (preview) chips.push({ text: preview, link: true });
  if (ws.latest_notification_text && ws.latest_notification_text !== preview) {
    chips.push({ text: ws.latest_notification_text, link: false });
  }
  return chips;
}

// Nom court d'un agent, comme dans la sidebar cmux ("cc=" pour Claude Code).
function agentShort(key) {
  const map = {
    claude_code: 'cc',
    claude: 'cc',
    codex: 'codex',
    opencode: 'oc',
    gemini: 'gemini',
    cursor: 'cursor',
  };
  return map[key] || key;
}

// État lisible de l'agent d'un workspace.
function agentStatusText(agent) {
  if (!agent) return '';
  const name = agent.agent === 'claude_code' ? 'Claude Code'
    : agent.agent === 'codex' ? 'Codex'
    : agent.agent;
  const stale = Date.now() - (agent.at || 0) > 10 * 60 * 1000;
  if (agent.pending > 0 && !stale) return name + ' attend votre input';
  if (agent.phase === 'running' && !stale) return 'Running';
  return '';
}

function renderSidebar() {
  const host = $('#ws-list');
  const rows = workspaceRows();
  const html = rows.map((ws) => {
    const sel = ws.id === state.workspace ? ' sel' : '';
    const branches = (ws.git_branches || []).filter(Boolean);
    const branch = branches.length ? branches[0] : (ws.branch_summary || '');
    const dir = shortPath(ws.current_directory || ws.root_path || '');
    const meta = [branch, dir].filter(Boolean).join(' · ');

    // Badge de notifications non lues (pastille bleue en tête de ligne).
    const badge = ws.unread_count
      ? '<span class="ws-badge">' + ws.unread_count + '</span>'
      : '';

    // Ligne secondaire : état de l'agent, sinon dernier message / notification.
    const agent = state.agents[ws.id] || null;
    const agentStatus = agentStatusText(agent);
    const status = agentStatus
      || ws.latest_conversation_message
      || ws.latest_notification_text
      || ws.description
      || '';
    const chipText = ws.latest_conversation_message && ws.latest_notification_text
      ? ws.latest_notification_text
      : '';
    const chipHtml = chipText
      ? '<div class="ws-chip link" title="' + esc(chipText) + '">' + esc(chipText) + '</div>'
      : '';

    const agentChip = agent && agent.agent
      ? '<div class="ws-chip" title="' + esc(agent.agent) + '">' + esc(agentShort(agent.agent)) + '</div>'
      : '';

    return '<div class="ws' + sel + '" data-ws="' + esc(ws.id) + '">'
      + '<div class="ws-line1">'
      + badge
      + '<span class="ws-name" title="' + esc(ws.title) + '">' + esc(ws.title) + '</span>'
      + '</div>'
      + (status ? '<div class="ws-status">' + esc(status) + '</div>' : '')
      + (agentChip || chipHtml ? '<div class="ws-chips">' + agentChip + chipHtml + '</div>' : '')
      + (meta ? '<div class="ws-meta"><span class="branch">' + esc(branch) + '</span>'
          + (branch && dir ? ' · ' : '') + esc(dir) + '</div>' : '')
      + '</div>';
  }).join('');

  host.innerHTML = html;

  for (const el of host.querySelectorAll('.ws')) {
    const ws = (state.sidebar.workspaces || []).find((w) => w.id === el.dataset.ws);
    el.addEventListener('click', () => selectWorkspace(el.dataset.ws));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (ws) workspaceMenu(ws, e.clientX, e.clientY);
    });
  }
}

// ------------------------------------------------------------------ canvas

function findSurface(id) {
  const ws = currentWorkspaceNode();
  if (!ws) return null;
  for (const p of ws.panes || []) {
    for (const s of p.surfaces || []) {
      if (s.id === id) return s;
    }
  }
  return null;
}

function currentWorkspaceNode() {
  if (!state.tree) return null;
  for (const win of state.tree.windows || []) {
    for (const ws of win.workspaces || []) {
      if (ws.id === state.workspace) return ws;
    }
  }
  return null;
}

function paneGeometry() {
  // pane.list renvoie des frames en points quand le workspace est affiché.
  const panes = (state.panes && state.panes.panes) || [];
  const frame = state.panes && state.panes.container_frame;
  const usable = panes.filter((p) => p.pixel_frame && p.pixel_frame.width > 0);
  if (usable.length === panes.length && usable.length > 0 && frame && frame.width > 0) {
    return { mode: 'exact', frame, panes: usable };
  }
  return { mode: 'auto', frame: frame || { width: 0, height: 0 }, panes };
}

// Fusionne les panes du tree (qui portent les surfaces/onglets) avec la
// géométrie renvoyée par pane.list.
function mergedPanes(wsNode) {
  const treePanes = (wsNode && wsNode.panes) || [];
  const geoPanes = (state.panes && state.panes.panes) || [];
  return treePanes.map((tp, i) => {
    const gp = geoPanes.find((g) => g.id === tp.id) || geoPanes[i] || {};
    return Object.assign({}, tp, {
      focused: gp.focused !== undefined ? gp.focused : tp.focused,
      selected_surface_id: gp.selected_surface_id || tp.selected_surface_id,
      pixel_frame: gp.pixel_frame || null,
    });
  });
}

function paneStyle(pane, index, panes) {
  const geo = pane.pixel_frame;
  const all = panes.map((p) => p.pixel_frame).filter((f) => f && f.width > 0);
  if (all.length === panes.length && all.length > 0 && geo && geo.width > 0) {
    // Les frames sont exprimées en coordonnées fenêtre : on recentre sur
    // l'union des panes pour obtenir des pourcentages relatifs au canvas.
    const originX = Math.min.apply(null, all.map((f) => f.x));
    const originY = Math.min.apply(null, all.map((f) => f.y));
    const totalW = Math.max.apply(null, all.map((f) => f.x + f.width)) - originX;
    const totalH = Math.max.apply(null, all.map((f) => f.y + f.height)) - originY;
    if (totalW > 0 && totalH > 0) {
      return 'position:absolute;left:' + ((geo.x - originX) / totalW * 100) + '%;top:'
        + ((geo.y - originY) / totalH * 100) + '%;width:' + (geo.width / totalW * 100)
        + '%;height:' + (geo.height / totalH * 100) + '%';
    }
  }
  return 'flex:1 1 0';
}

const TAB_ICONS = {
  terminal: '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1.2" y="2.6" width="13.6" height="10.8" rx="1.6"/><path d="m4 6.6 2.2 1.9L4 10.4M8.4 10.6h3.4" stroke-linecap="round"/></svg>',
  browser: '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="6.2"/><path d="M1.8 8h12.4M8 1.8c3.4 3.6 3.4 8.8 0 12.4-3.4-3.6-3.4-8.8 0-12.4Z"/></svg>',
  simulator: '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="3" y="1.8" width="10" height="12.4" rx="1.8"/><path d="M6 11.6h4"/></svg>',
};

function renderCanvas() {
  const host = $('#panes');
  const ws = currentWorkspaceNode();
  $('#empty').classList.toggle('hidden', !!ws);

  if (!ws) { host.innerHTML = ''; return; }

  const panes = mergedPanes(ws);

  // Ne reconstruit le DOM que si la structure a changé : sinon on perd la
  // position de défilement et on fait clignoter le terminal.
  const signature = JSON.stringify(panes.map((p) => [
    p.ref,
    p.focused,
    p.selected_surface_id,
    (p.surfaces || []).map((s) => [s.id, s.title, s.type]),
  ])) + '|' + (state.surface || '');
  if (signature === state.canvasSignature) {
    updateActiveTab();
    return;
  }
  state.canvasSignature = signature;

  const html = panes.map((pane, i) => {
    const focused = pane.focused !== false;
    const surfaces = pane.surfaces || [];
    // La surface sélectionnée localement prime : le clic sur un onglet doit
    // être visible immédiatement, avant le prochain rafraîchissement.
    const activeId = (state.surface && surfaces.some((s) => s.id === state.surface))
      ? state.surface
      : (pane.selected_surface_id || (surfaces[0] && surfaces[0].id));

    const tabs = surfaces.map((s) => {
      const active = s.id === activeId;
      return '<div class="tab' + (active ? ' active' : '') + '" data-surface="' + esc(s.id) + '"'
        + ' data-workspace="' + esc(ws.id) + '" title="' + esc(s.title || s.ref) + '">'
        + '<span class="ico">' + (TAB_ICONS[s.type] || TAB_ICONS.terminal) + '</span>'
        + '<span class="t">' + esc(s.title || s.ref) + '</span>'
        + '<button class="tab-close" data-close="' + esc(s.id) + '" title="Fermer l’onglet">✕</button>'
        + '</div>';
    }).join('');

    const tools = '<div class="tabbar-tools">'
      + '<button class="tb-tool" data-act="new-tab" data-pane="' + esc(pane.ref) + '" title="Nouvel onglet">'
      + '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 3.4v9.2M3.4 8h9.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>'
      + '<button class="tb-tool" data-act="split" data-pane="' + esc(pane.ref) + '" title="Diviser">'
      + '<svg viewBox="0 0 16 16" width="12" height="12"><rect x="1.8" y="3" width="12.4" height="10" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 3v10" stroke="currentColor" stroke-width="1.2"/></svg></button>'
      + '</div>';

    const active = surfaces.find((s) => s.id === activeId) || surfaces[0];
    let content;
    if (!active) {
      content = '<div class="pane-placeholder">Aucun terminal</div>';
    } else if (active.type === 'browser') {
      content = '<div class="pane-placeholder">Surface navigateur — '
        + esc(active.url || 'aucune URL') + '<br>Ouvrez-le dans cmux.</div>';
    } else {
      content = '<div class="term" data-surface="' + esc(active.id) + '"></div>';
    }

    return '<div class="pane' + (focused ? ' focused' : ' dimmed') + '" data-pane="' + esc(pane.ref) + '"'
      + ' style="' + paneStyle(pane, i, panes) + '">'
      + '<div class="tabbar">' + tabs + tools + '</div>'
      + content
      + '</div>';
  }).join('');

  host.innerHTML = html;

  for (const el of host.querySelectorAll('.tab')) {
    const surf = findSurface(el.dataset.surface);
    el.addEventListener('click', () => selectSurface(el.dataset.surface));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (surf) tabMenu(surf, e.clientX, e.clientY);
    });
  }
  for (const el of host.querySelectorAll('.tab-close')) {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = el.dataset.close;
      try {
        await API.post('/api/close-surface', { surface: id });
        if (state.surface === id) state.surface = null;
        state.screens.delete(id);
        await refresh();
      } catch (err) {
        hint(String(err.message || err), 'err');
      }
    });
  }
  for (const el of host.querySelectorAll('.tb-tool')) {
    el.addEventListener('click', (e) => { e.stopPropagation(); handleTool(el.dataset.act, el.dataset.pane); });
  }
  for (const el of host.querySelectorAll('.pane')) {
    el.addEventListener('mousedown', () => focusPane(el.dataset.pane));
  }

  // Le canvas est reconstruit à chaque rafraîchissement : on rejoue le
  // contenu déjà connu pour éviter le clignotement.
  for (const el of host.querySelectorAll('.term')) {
    const cached = state.screens.get(el.dataset.surface);
    if (cached) {
      el.innerHTML = cached.html;
      fitTerminals();
      followCursor(el, cached.cursor);
    }
  }
}

// Met à jour la classe « active » sans reconstruire le canvas.
function updateActiveTab() {
  for (const el of document.querySelectorAll('.tab')) {
    el.classList.toggle('active', el.dataset.surface === state.surface);
  }
}

async function handleTool(act, pane) {
  try {
    if (act === 'new-tab') {
      await API.post('/api/new-surface', { pane, workspace: state.workspace });
    } else if (act === 'split') {
      await API.post('/api/new-split', { direction: 'right', pane, workspace: state.workspace });
    } else if (act === 'right') {
      state.rightOpen = !state.rightOpen;
      $('#rightbar').classList.toggle('hidden', !state.rightOpen);
    }
    await refresh();
  } catch (e) {
    hint(String(e.message || e), 'err');
  }
}

function focusPane(paneRef) {
  if (state.focusPane === paneRef) return;
  state.focusPane = paneRef;
  API.post('/api/focus', { pane: paneRef }).catch(() => {});
}

// ------------------------------------------------------------- rendering

function styleCss(st) {
  if (!st) return '';
  const fg = st.inverse ? st.background : st.foreground;
  const bg = st.inverse ? st.foreground : st.background;
  const css = [];
  if (fg && st.foreground_source !== 'default') css.push('color:' + fg);
  if (bg && st.background_source !== 'default') css.push('background:' + bg);
  if (st.bold) css.push('font-weight:700');
  if (st.faint) css.push('opacity:.65');
  if (st.italic) css.push('font-style:italic');
  if (st.underline) css.push('text-decoration:underline');
  if (st.strikethrough) css.push('text-decoration:line-through');
  if (st.invisible) css.push('opacity:0');
  if (st.blink) css.push('animation:blinker 1s steps(2,start) infinite');
  return css.join(';');
}

function buildGridHtml(data) {
  const styles = data.styles || [];
  const cols = data.columns || 80;
  const rows = data.rows || 24;

  const grid = [];
  for (let r = 0; r < rows; r++) grid.push(new Array(cols).fill(null));

  for (const sp of data.row_spans || []) {
    const row = grid[sp.row];
    if (!row) continue;
    const chars = Array.from(sp.text || '');
    const width = sp.cell_width != null ? sp.cell_width : chars.length;
    for (let i = 0; i < width; i++) {
      const c = sp.column + i;
      if (c < 0 || c >= cols) continue;
      row[c] = { ch: i < chars.length ? chars[i] : ' ', style: sp.style_id };
    }
  }

  const cur = data.cursor;
  const curRow = cur && cur.visible ? cur.row : -1;
  const curCol = cur && cur.visible ? cur.column : -1;

  let lastRow = curRow;
  for (const sp of data.row_spans || []) if (sp.row > lastRow) lastRow = sp.row;
  const shown = Math.min(rows, Math.max(lastRow + 1, 1));

  const out = [];
  for (let r = 0; r < shown; r++) {
    const row = grid[r];
    let html = '';
    let runStyle = null, runText = '';
    const flush = () => {
      if (!runText) return;
      const css = styleCss(styles[runStyle] || null);
      html += css ? '<span style="' + css + '">' + esc(runText) + '</span>' : esc(runText);
      runText = '';
    };
    for (let c = 0; c < cols; c++) {
      const cell = row[c];
      const isCur = r === curRow && c === curCol;
      if (isCur) {
        flush();
        runStyle = null;
        html += '<span class="curcell">' + esc(cell ? cell.ch : ' ') + '</span>';
        continue;
      }
      const styleId = cell ? cell.style : 0;
      if (styleId !== runStyle) { flush(); runStyle = styleId; }
      runText += cell ? cell.ch : ' ';
    }
    flush();
    out.push('<div class="row">' + (html || '&nbsp;') + '</div>');
  }
  return { html: out.join(''), background: data.background, cursor: { row: curRow, column: curCol } };
}

let polling = false;

async function pollScreen() {
  if (polling || !state.surface) return;
  polling = true;
  try {
    const data = await API.get('/api/screen?surface=' + encodeURIComponent(state.surface));
    const key = (data.row_spans || []).map((s) => s.row + ',' + s.column + ',' + s.style_id + ',' + s.text).join('|');
    const prev = state.screens.get(state.surface);
    if (!prev || prev.key !== key) {
      const built = buildGridHtml(data);
      const el = document.querySelector('.term[data-surface="' + state.surface + '"]');
      if (el) {
        el.dataset.cols = String(data.columns || 80);
        el.innerHTML = built.html;
        el.style.background = built.background || 'transparent';
        fitTerminals();
        followCursor(el, built.cursor);
      }
      state.screens.set(state.surface, { key, html: built.html, cursor: built.cursor });
    }
  } catch (e) {
    /* surface disparue : le refresh suivant corrigera */
  } finally {
    polling = false;
  }
}

// ---------------------------------------------------------------- actions

async function selectWorkspace(id) {
  state.workspace = id;
  state.surface = null;
  state.focusPane = null;
  state.screens.clear();
  renderSidebar();
  try {
    const ws = (state.sidebar.workspaces || []).find((w) => w.id === id);
    if (ws) $('#tb-title').textContent = ws.title;
    await API.post('/api/focus', { workspace: id });
  } catch (e) { /* ignore */ }
  await refresh();
}

async function selectSurface(id) {
  state.surface = id;
  await API.post('/api/focus', { surface: id }).catch(() => {});
  renderCanvas();
  await pollScreen();
}

async function sendKey(key) {
  if (!state.surface) return hint('Aucune surface sélectionnée', 'err');
  await enqueue(() => API.post('/api/input', { surface: state.surface, key }));
  hint('touche ' + key, 'ok');
  setTimeout(pollScreen, 120);
}

async function sendText(text, submit) {
  if (!state.surface) return hint('Aucune surface sélectionnée', 'err');
  if (!text) return;
  try {
    await enqueue(async () => {
      await API.post('/api/input', { surface: state.surface, text });
      if (submit) await API.post('/api/input', { surface: state.surface, key: 'enter' });
    });
    hint(submit ? 'envoyé + validé' : 'texte envoyé', 'ok');
    setTimeout(pollScreen, 200);
  } catch (e) {
    hint(String(e.message || e), 'err');
  }
}

// File d'attente : tout ce qui va vers le terminal passe par là, pour que
// l'ordre des frappes soit garanti.
function enqueue(fn) {
  state.sendQueue = state.sendQueue.then(fn, fn);
  return state.sendQueue;
}

function rawPush(text) {
  state.rawBuffer += text;
  if (state.rawPending) return;
  // Le créneau est réservé immédiatement, au moment de la frappe : l'ordre
  // dans la file est donc celui des frappes, même si l'envoi est groupé.
  state.rawPending = true;
  enqueue(async () => {
    await new Promise((r) => setTimeout(r, 45));
    const buf = state.rawBuffer;
    state.rawBuffer = '';
    state.rawPending = false;
    if (buf && state.surface) {
      try { await API.post('/api/input', { surface: state.surface, text: buf }); } catch { /* ignore */ }
    }
    setTimeout(pollScreen, 120);
  });
}

const KEYMAP = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
  Tab: 'tab', Escape: 'escape', Backspace: 'backspace', Delete: 'delete',
};

// Saisie directe dans le terminal : le clic sur la surface place le focus
// clavier, puis chaque frappe est envoyée à cmux comme dans l'app native.
function initKeyboard() {
  const kbd = $('#kbd');

  // Le clic (et non le mousedown) : le navigateur déplace le focus sur
  // l'élément cliqué après le mousedown, ce qui annulerait notre focus.
  $('#canvas').addEventListener('click', (e) => {
    if (e.target.closest('.tab') || e.target.closest('.tb-tool')) return;
    if (!state.surface) return;
    kbd.focus();
  });

  kbd.addEventListener('keydown', (e) => {
    if (!state.surface) return;
    if (e.metaKey || e.altKey) return;

    if (e.key === 'Enter') { e.preventDefault(); sendKey('enter'); return; }
    if (e.key === 'Tab') { e.preventDefault(); sendKey(e.shiftKey ? 'shift+tab' : 'tab'); return; }
    if (e.key === 'Escape') { e.preventDefault(); sendKey('escape'); return; }
    if (e.key === 'Backspace') { e.preventDefault(); sendKey('backspace'); return; }
    if (e.key === 'Delete') { e.preventDefault(); sendKey('delete'); return; }
    if (KEYMAP[e.key]) { e.preventDefault(); sendKey(KEYMAP[e.key]); return; }
    if (e.ctrlKey && e.key.length === 1) {
      e.preventDefault();
      sendKey('ctrl+' + e.key.toLowerCase());
      return;
    }
    if (e.key.length === 1) {
      e.preventDefault();
      if (state.ctrlArmed) {
        state.ctrlArmed = false;
        const mod = $('#mb-ctrl');
        if (mod) mod.classList.remove('on');
        sendKey('ctrl+' + e.key.toLowerCase());
      } else {
        rawPush(e.key);
      }
    }
  });
}

// ------------------------------------------------------------- menu ctx

function closeMenu() {
  const m = $('#menu');
  m.classList.add('hidden');
  m.innerHTML = '';
}

function showMenu(x, y, items) {
  const m = $('#menu');
  m.innerHTML = items.map((it, i) => {
    if (it.sep) return '<div class="sep"></div>';
    return '<div class="mi" data-i="' + i + '">' + esc(it.label) + '</div>';
  }).join('');
  m.classList.remove('hidden');

  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';

  for (const el of m.querySelectorAll('.mi')) {
    el.addEventListener('click', () => {
      const item = items[Number(el.dataset.i)];
      closeMenu();
      if (item && item.run) item.run();
    });
  }
}

document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#menu')) closeMenu();
});

function workspaceMenu(ws, x, y) {
  const items = [];
  const add = (label, run) => items.push({ label, run });
  const sep = () => items.push({ sep: true });

  add('Renommer…', async () => {
    const title = window.prompt('Nom du workspace', ws.title || '');
    if (title) {
      await API.post('/api/workspace-action', { action: 'rename', workspace: ws.id, title });
      await refresh();
    }
  });
  add(ws.pinned ? 'Détacher' : 'Épingler', async () => {
    await API.post('/api/workspace-action', { action: ws.pinned ? 'unpin' : 'pin', workspace: ws.id });
    await refresh();
  });
  add('Description…', async () => {
    const d = window.prompt('Description', ws.description || '');
    if (d !== null) {
      await API.post('/api/workspace-action', {
        action: d ? 'set-description' : 'clear-description',
        workspace: ws.id,
        description: d,
      });
      await refresh();
    }
  });
  sep();
  add('Monter', () => API.post('/api/workspace-action', { action: 'move-up', workspace: ws.id }).then(refresh));
  add('Descendre', () => API.post('/api/workspace-action', { action: 'move-down', workspace: ws.id }).then(refresh));
  if (ws.unread_count) {
    add('Marquer comme lu', () => API.post('/api/workspace-action', { action: 'mark-read', workspace: ws.id }).then(refresh));
  }
  sep();
  add('Fermer le workspace', async () => {
    await API.post('/api/close-workspace', { workspace: ws.id });
    state.workspace = null;
    state.surface = null;
    await refresh();
  });

  showMenu(x, y, items);
}

function tabMenu(surface, x, y) {
  const items = [];
  const add = (label, run) => items.push({ label, run });
  const sep = () => items.push({ sep: true });

  add('Renommer…', async () => {
    const title = window.prompt('Nom de l’onglet', surface.title || '');
    if (title) {
      await API.post('/api/tab-action', { action: 'rename', surface: surface.id, title });
      await refresh();
    }
  });
  add('Dupliquer', () => API.post('/api/tab-action', { action: 'duplicate', surface: surface.id }).then(refresh));
  add('Nouveau terminal à droite', () => API.post('/api/tab-action', { action: 'new-terminal-right', surface: surface.id }).then(refresh));
  sep();
  add('Fermer l’onglet', async () => {
    await API.post('/api/close-surface', { surface: surface.id });
    state.surface = null;
    await refresh();
  });

  showMenu(x, y, items);
}

// ---------------------------------------------------------- palette (⌘P)

const PALETTE_COMMANDS = [
  { name: 'Nouveau workspace', run: () => API.post('/api/new-workspace', {}).then(refresh) },
  { name: 'Diviser à droite', run: () => handleTool('split', null) },
  { name: 'Diviser en bas', run: () => API.post('/api/new-split', { direction: 'down', workspace: state.workspace }).then(refresh) },
  { name: 'Nouvel onglet', run: () => API.post('/api/new-surface', { workspace: state.workspace }).then(refresh) },
  { name: 'Fermer l’onglet', run: () => API.post('/api/close-surface', { surface: state.surface }).then(refresh) },
  { name: 'Afficher / masquer la sidebar', run: () => $('#tb-sidebar').click() },
  { name: 'Afficher / masquer la barre latérale droite', run: () => $('#tb-right').click() },
  { name: 'Notifications', run: () => $('#tb-bell').click() },
  { name: 'Feed', run: () => { state.rightMode = 'feed'; state.rightOpen = true; $('#rightbar').classList.remove('hidden'); renderRight(); } },
  { name: 'Sessions', run: () => { state.rightMode = 'sessions'; state.rightOpen = true; $('#rightbar').classList.remove('hidden'); renderRight(); } },
  { name: 'Tâches du workspace', run: () => { state.rightMode = 'todo'; state.rightOpen = true; $('#rightbar').classList.remove('hidden'); renderRight(); } },
  { name: 'Rechercher dans la sidebar', run: () => { const s = $('#search'); s.parentElement.classList.remove('hidden'); s.focus(); } },
];

let paletteIndex = 0;

function openPalette() {
  const p = $('#palette');
  p.classList.remove('hidden');
  const input = $('#palette-input');
  input.value = '';
  paletteIndex = 0;
  renderPalette();
  input.focus();
}

function closePalette() {
  $('#palette').classList.add('hidden');
}

function paletteMatches() {
  const q = $('#palette-input').value.trim().toLowerCase();
  if (!q) return PALETTE_COMMANDS;
  return PALETTE_COMMANDS.filter((c) => c.name.toLowerCase().includes(q));
}

function renderPalette() {
  const items = paletteMatches();
  $('#palette-list').innerHTML = items.map((c, i) =>
    '<div class="pi' + (i === paletteIndex ? ' on' : '') + '" data-i="' + i + '">' + esc(c.name) + '</div>'
  ).join('');
  for (const el of $('#palette-list').querySelectorAll('.pi')) {
    el.addEventListener('click', () => {
      const c = items[Number(el.dataset.i)];
      closePalette();
      if (c) c.run();
    });
  }
}

function initPalette() {
  const input = $('#palette-input');
  input.addEventListener('input', () => { paletteIndex = 0; renderPalette(); });
  input.addEventListener('keydown', (e) => {
    const items = paletteMatches();
    if (e.key === 'ArrowDown') { e.preventDefault(); paletteIndex = Math.min(paletteIndex + 1, items.length - 1); renderPalette(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); paletteIndex = Math.max(paletteIndex - 1, 0); renderPalette(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const c = items[paletteIndex];
      closePalette();
      if (c) c.run();
    } else if (e.key === 'Escape') { closePalette(); }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      openPalette();
    }
  });
}

// ------------------------------------------------------------ right sidebar

async function renderRight() {
  const host = $('#rb-body');
  if (!state.rightOpen) return;
  for (const b of $$('.rb-modes button')) b.classList.toggle('on', b.dataset.mode === state.rightMode);

  try {
    if (state.rightMode === 'feed') {
      const feed = await API.get('/api/feed');
      const items = (feed.items || []).slice(0, 80);
      host.innerHTML = '<h4>Feed</h4>' + (items.length ? items.map((it) =>
        '<div class="rb-item"><div class="t">' + esc(it.title || it.kind || '') + '</div>'
        + '<div class="s">' + esc(shortPath(it.cwd || '')) + ' · ' + esc(it.source || '') + '</div></div>'
      ).join('') : '<div class="rb-item">Aucun événement</div>');
    } else if (state.rightMode === 'sessions') {
      const s = await API.get('/api/sessions');
      const items = (s.items || s.records || []).slice(0, 60);
      host.innerHTML = '<h4>Sessions</h4>' + (items.length ? items.map((it) =>
        '<div class="rb-item"><div class="t">' + esc(it.agent || it.title || '') + '</div>'
        + '<div class="s">' + esc(shortPath(it.cwd || '')) + '</div></div>'
      ).join('') : '<div class="rb-item">Aucune session</div>');
    } else if (state.rightMode === 'todo') {
      const t = await API.get('/api/todos?workspace=' + encodeURIComponent(state.workspace || ''));
      const items = t.items || [];
      host.innerHTML = '<h4>Tâches</h4>' + (items.length ? items.map((it) =>
        '<div class="rb-item"><div class="t">' + esc(it.text || it.title || '') + '</div>'
        + '<div class="s">' + esc(it.done ? 'fait' : 'à faire') + '</div></div>'
      ).join('') : '<div class="rb-item">Aucune tâche</div>');
    } else if (state.rightMode === 'files') {
      const ws = (state.sidebar && state.sidebar.workspaces || []).find((w) => w.id === state.workspace);
      const dirs = (ws && ws.panel_directories) || [];
      host.innerHTML = '<h4>Fichiers</h4>' + dirs.map((d) =>
        '<div class="rb-item"><div class="t">' + esc(d.split('/').pop() || d) + '</div>'
        + '<div class="s">' + esc(d) + '</div></div>').join('');
    } else {
      host.innerHTML = '<h4>Recherche</h4><div class="rb-item">Recherche globale — utilisez ⌘⇧F dans cmux.</div>';
    }
  } catch (e) {
    host.innerHTML = '<div class="rb-item">Erreur : ' + esc(String(e.message || e)) + '</div>';
  }
}

// ---------------------------------------------------------- notifications

async function refreshNotifications() {
  try {
    const list = await API.get('/api/notifications');
    state.notifications = Array.isArray(list) ? list : (list.notifications || []);
    const unread = state.notifications.filter((n) => !n.is_read).length;
    const badge = $('#tb-badge');
    badge.textContent = unread;
    badge.hidden = unread === 0;
    $('#notif-list').innerHTML = state.notifications.length
      ? state.notifications.map((n) => (
          '<div class="notif" data-surface="' + esc(n.surface_id || '') + '">'
          + '<div class="t">' + esc(n.title || 'notification') + '</div>'
          + '<div class="b">' + esc(n.body || n.subtitle || '') + '</div>'
          + '<div class="w">' + esc(n.tab_title || '') + ' · '
          + esc(String(n.created_at || '').slice(0, 16).replace('T', ' ')) + '</div>'
          + '</div>'
        )).join('')
      : '<div class="notif"><div class="b">Aucune notification</div></div>';
    for (const el of $$('#notif-list .notif')) {
      el.addEventListener('click', () => {
        $('#notif-panel').classList.add('hidden');
        if (el.dataset.surface) selectSurface(el.dataset.surface);
      });
    }
  } catch { /* ignore */ }
}

// ------------------------------------------------------------------ boot

async function refresh() {
  try {
    const [sidebar, tree, agents] = await Promise.all([
      API.get('/api/sidebar'),
      API.get('/api/tree'),
      API.get('/api/agents').catch(() => ({ agents: {} })),
    ]);
    state.sidebar = sidebar;
    state.tree = tree;
    state.agents = agents.agents || {};

    if (!state.workspace) {
      const sel = (sidebar.workspaces || []).find((w) => w.selected)
        || (sidebar.workspaces || [])[0];
      if (sel) {
        state.workspace = sel.id;
        $('#tb-title').textContent = sel.title;
      }
    } else {
      const cur = (sidebar.workspaces || []).find((w) => w.id === state.workspace);
      if (cur) $('#tb-title').textContent = cur.title;
    }

    renderSidebar();
    renderCanvas();

    const ws = currentWorkspaceNode();
    if (ws) {
      state.panes = await API.get('/api/panes?workspace=' + encodeURIComponent(ws.id)).catch(() => null);
    }

    // Surface sélectionnée : celle du pane focalisé, sinon celle du workspace actif.
    if (!state.surface) {
      const panes = (state.panes && state.panes.panes) || [];
      const pane = panes.find((p) => p.focused) || panes[0];
      if (pane && pane.selected_surface_id) state.surface = pane.selected_surface_id;
      else {
        const active = state.tree && state.tree.active;
        if (active && active.surface_id) state.surface = active.surface_id;
      }
    }
    renderCanvas();
    await pollScreen();
  } catch (e) {
    hint('cmux injoignable : ' + String(e.message || e), 'err');
  }
}

function initEvents() {
  try {
    const es = new EventSource('/api/events');
    es.onmessage = () => {
      clearTimeout(initEvents.t);
      initEvents.t = setTimeout(() => { refresh(); refreshNotifications(); }, 500);
    };
  } catch { /* ignore */ }
}

function init() {
  initKeyboard();
  initPalette();
  initMobile();

  // Sur un petit écran la sidebar est repliée, comme dans l'app mobile.
  if (window.innerWidth < 820) {
    state.sidebarHidden = true;
    $('#tb-sidebar').classList.remove('seg-on');
    $('#titlebar').classList.add('no-sidebar');
  } else {
    $('#sidebar').classList.remove('hidden');
  }

  $('#search').addEventListener('input', renderSidebar);

  // ⌘⇧F : la recherche de la sidebar n'apparaît que sur demande, comme
  // dans l'app.
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      const s = $('#search');
      s.parentElement.classList.remove('hidden');
      s.focus();
      s.select();
    }
    if (e.key === 'Escape' && document.activeElement === $('#search')) {
      $('#search').parentElement.classList.add('hidden');
      $('#search').blur();
    }
  });

  $('#tb-sidebar').addEventListener('click', () => {
    if (isMobile()) {
      setDrawer(!state.drawerOpen);
      return;
    }
    state.sidebarHidden = !state.sidebarHidden;
    $('#sidebar').classList.toggle('hidden', state.sidebarHidden);
    $('#tb-sidebar').classList.toggle('seg-on', !state.sidebarHidden);
    $('#titlebar').classList.toggle('no-sidebar', state.sidebarHidden);
  });

  $('#tb-split').addEventListener('click', () => handleTool('split', null));

  $('#tb-bell').addEventListener('click', () => {
    const p = $('#notif-panel');
    p.classList.toggle('hidden');
    if (!p.classList.contains('hidden')) refreshNotifications();
  });

  $('#notif-close').addEventListener('click', () => $('#notif-panel').classList.add('hidden'));

  $('#tb-new').addEventListener('click', async () => {
    try {
      await API.post('/api/new-workspace', {});
      await refresh();
    } catch (e) { hint(String(e.message || e), 'err'); }
  });

  $('#tb-right').addEventListener('click', () => {
    state.rightOpen = !state.rightOpen;
    $('#rightbar').classList.toggle('hidden', !state.rightOpen);
    renderRight();
  });

  for (const b of $$('.rb-modes button')) {
    b.addEventListener('click', () => { state.rightMode = b.dataset.mode; renderRight(); });
  }

  refresh();
  refreshNotifications();
  initEvents();

  setInterval(pollScreen, 150);
  setInterval(refresh, 900);
  setInterval(refreshNotifications, 4000);
  setInterval(renderRight, 5000);
}

document.addEventListener('DOMContentLoaded', init);
// ===========================================================================
// Adaptation mobile : tiroir de workspaces, barre d'actions basse, terminal
// mis à l'échelle, clavier logiciel, swipe entre onglets.
// ===========================================================================

const MOBILE_QUERY = '(max-width: 820px), (pointer: coarse)';

function isMobile() {
  return window.matchMedia(MOBILE_QUERY).matches;
}

// --------------------------------------------------------- taille du texte

// Le terminal d'un pane large peut faire 150 colonnes : sur un téléphone on
// garde une police lisible et on suit le curseur horizontalement, plutôt que
// de tout réduire à 7 px. Le mode « Entier » reste disponible.
const FONT_MODES = [
  { name: 'Lisible', size: 11 },
  { name: 'Normal', size: 13 },
  { name: 'Grand', size: 16 },
  { name: 'Entier', size: 'fit' },
];

function fitTerminals() {
  const mode = FONT_MODES[state.fontStep] || FONT_MODES[0];
  for (const el of document.querySelectorAll('.term')) {
    const cols = Number(el.dataset.cols) || 80;
    const avail = Math.max(120, el.clientWidth - 12);
    const fit = avail / (cols * 0.6);
    const size = mode.size === 'fit'
      ? Math.max(6, Math.min(24, fit))
      : mode.size;
    el.style.setProperty('--fs', size.toFixed(2) + 'px');
    el.dataset.cellw = (size * 0.6).toFixed(2);
  }
}

function cycleFontSize() {
  state.fontStep = (state.fontStep + 1) % FONT_MODES.length;
  try { localStorage.setItem('cmux-web.fontStep', String(state.fontStep)); } catch { /* ignore */ }
  fitTerminals();
  hint('Texte : ' + (FONT_MODES[state.fontStep] || FONT_MODES[0]).name);
}

// Garde la zone interesting du terminal visible : en bas (dernière ligne) et
// autour du curseur (la colonne active).
function followCursor(el, cursor) {
  if (!el) return;
  el.scrollTop = el.scrollHeight;
  if (!cursor || !cursor.visible) return;
  const cell = Number(el.dataset.cellw) || 8;
  const x = cursor.column * cell;
  const left = el.scrollLeft;
  const right = left + el.clientWidth;
  if (x < left + cell * 2 || x > right - cell * 2) {
    el.scrollLeft = Math.max(0, x - el.clientWidth * 0.6);
  }
}

// --------------------------------------------------------------- le tiroir

function setDrawer(open) {
  const sidebar = $('#sidebar');
  if (open) sidebar.classList.remove('hidden');
  sidebar.classList.toggle('open', open);
  $('#scrim').classList.toggle('on', open);
  state.drawerOpen = open;
  if (!open && !state.sidebarHidden) sidebar.classList.add('hidden');
}

// ------------------------------------------------------- barre d'actions bas

function initMobileBar() {
  const bar = $('#mobilebar');

  for (const btn of bar.querySelectorAll('button[data-key]')) {
    btn.addEventListener('click', () => sendKey(btn.dataset.key));
  }

  // Modificateur Ctrl : s'applique à la prochaine touche tapée.
  $('#mb-ctrl').addEventListener('click', () => {
    state.ctrlArmed = !state.ctrlArmed;
    $('#mb-ctrl').classList.toggle('on', state.ctrlArmed);
  });

  // Ouvre le clavier logiciel et place le focus dans le terminal.
  $('#mb-keys').addEventListener('click', () => {
    focusKeyboard();
  });
}

// Le clavier logiciel : on focalise un vrai input (invisible mais présent)
// pour qu'iOS/Android ouvrent le pavé, puis on renvoie les frappes à cmux.
function focusKeyboard() {
  const kbd = $('#kbd');
  kbd.style.display = 'block';
  kbd.focus({ preventScroll: true });
  if (state.surface) {
    hint('Clavier actif — tapez pour envoyer à cmux', 'ok');
  }
}

// Le clavier logiciel réduit la hauteur visible : on décale les barres.
function initViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const update = () => {
    const keyboard = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--kb', keyboard + 'px');
    if (keyboard > 60) {
      const term = document.querySelector('.term');
      if (term) term.scrollTop = term.scrollHeight;
    }
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
}

// Swipe horizontal dans le terminal : change d'onglet.
function initSwipe() {
  const wrap = $('#canvas');
  let startX = 0, startY = 0, startT = 0;

  wrap.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    startT = Date.now();
  }, { passive: true });

  wrap.addEventListener('touchend', (e) => {
    if (!e.changedTouches.length) return;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Date.now() - startT > 600) return;
    if (Math.abs(dx) < 60 || Math.abs(dy) > 40) return;
    stepTab(dx < 0 ? 1 : -1);
  }, { passive: true });
}

// Change d'onglet dans le panneau courant.
function stepTab(direction) {
  const tabs = Array.from(document.querySelectorAll('.tab'));
  if (tabs.length < 2) return;
  const current = tabs.findIndex((t) => t.classList.contains('active'));
  const next = (current + direction + tabs.length) % tabs.length;
  const target = tabs[next];
  if (target) selectSurface(target.dataset.surface);
}

// ------------------------------------------------------------------- init

function initMobile() {
  // Taille de police mémorisée.
  try {
    const saved = Number(localStorage.getItem('cmux-web.fontStep'));
    if (saved >= 0 && saved < FONT_MODES.length) state.fontStep = saved;
  } catch { /* ignore */ }

  // Le tiroir.
  $('#tb-menu').addEventListener('click', () => setDrawer(!state.drawerOpen));
  $('#tb-font').addEventListener('click', cycleFontSize);
  $('#scrim').addEventListener('click', () => setDrawer(false));

  // Sur mobile, la sidebar du tiroir est l'unique moyen de changer de
  // workspace : on ferme le tiroir après le choix.
  document.addEventListener('click', (e) => {
    const row = e.target.closest('.ws');
    if (row && isMobile()) setDrawer(false);
  });

  initMobileBar();
  initViewport();
  initSwipe();

  window.addEventListener('resize', () => {
    fitTerminals();
    if (!isMobile()) {
      setDrawer(false);
      $('#sidebar').classList.toggle('hidden', state.sidebarHidden);
    }
  });
}
