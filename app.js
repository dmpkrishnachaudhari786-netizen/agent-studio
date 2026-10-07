/* Agent Studio — console for the Real Android AI Agent + Web Builder.
   Run modes: (1) local Python server (server.py), (2) FastAPI backend,
   (3) fully in-browser with your own Gemini key. No fake functionality. */
'use strict';

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const LS_KEY = 'agent-studio-settings-v1';
const DEFAULT_SETTINGS = {
  backendUrl: '', user: 'admin', geminiKey: '',
  geminiModel: 'gemini-3.8-flash', netlifyToken: '', netlifySite: ''
};

const state = {
  settings: { ...DEFAULT_SETTINGS },
  token: null,
  server: false,          // local Python server detected on same origin
  history: [],            // [{role:'user'|'model', text}]
  files: [],
  activeFile: null,
  pyodide: null,
  pyodideLoading: null,
  busy: false,
};

/* ---------------- persistence ---------------- */
function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) state.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    state.token = localStorage.getItem(LS_KEY + ':token') || null;
    state.history = JSON.parse(localStorage.getItem(LS_KEY + ':history') || '[]');
  } catch (_) { /* corrupt storage — fall back to defaults */ }
}
function saveSettings() {
  localStorage.setItem(LS_KEY, JSON.stringify(state.settings));
  if (state.token) localStorage.setItem(LS_KEY + ':token', state.token);
  else localStorage.removeItem(LS_KEY + ':token');
  localStorage.setItem(LS_KEY + ':history', JSON.stringify(state.history.slice(-40)));
}

/* ---------------- ui helpers ---------------- */
let toastTimer;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast ' + kind), 3200);
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function setConn(mode, label) {
  $('#connDot').className = 'dot ' + mode;
  $('#connLabel').textContent = label;
}
function updateConn() {
  if (state.server) setConn('on', 'Python server');
  else if (state.settings.backendUrl && state.token) setConn('on', 'Backend connected');
  else if (state.settings.geminiKey) setConn('on', 'Direct APIs mode');
  else setConn('', 'Offline mode');
}
function chatHint() {
  const el = $('#chatHint');
  if (state.server) el.textContent = 'Replies come from your local Python server.';
  else if (state.settings.backendUrl && state.token) el.textContent = 'Replies come from your backend.';
  else if (state.settings.geminiKey) el.textContent = 'Replies come straight from Gemini (' + state.settings.geminiModel + ').';
  else el.textContent = 'No AI connected yet — add a Gemini key in Settings, or run server.py.';
}

/* ---------------- navigation ---------------- */
$$('.nav-btn, .tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
});
function goTo(view) {
  const b = document.querySelector('.nav-btn[data-view="' + view + '"]') ||
            document.querySelector('.tab-btn[data-view="' + view + '"]');
  if (b) b.click();
}

/* ---------------- backend client ---------------- */
async function backend(path, { method = 'GET', body } = {}) {
  const base = state.settings.backendUrl.replace(/\/+$/, '');
  if (!base) throw new Error('Backend URL is not set (Settings).');
  const h = {};
  if (state.token) h['Authorization'] = 'Bearer ' + state.token;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(base + path, {
    method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { detail: text }; }
  if (!res.ok) {
    const msg = data && (data.detail || data.message) ? (data.detail || data.message) : ('HTTP ' + res.status);
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data;
}

/* Detect the local Python server (server.py) on this origin. */
async function probeServer() {
  try {
    const res = await fetch('api/health', { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return false;
    const j = await res.json();
    state.server = j && j.server === 'agent-studio';
    return state.server;
  } catch (_) { return false; }
}

/* ---------------- allow-list (mirrors backend/app/allowlist.py) ---------------- */
const ALLOWED = {
  open_app: { package_name: v => /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(v) },
  open_settings: { action: v => /^[A-Za-z0-9_.]+$/.test(v) && v.length >= 1 && v.length <= 120 },
  back: {},
  home: {},
  share_text: { text: v => typeof v === 'string' && v.length >= 1 && v.length <= 5000 },
  clipboard_set: { text: v => typeof v === 'string' && v.length <= 10000 },
};
function validateTool(name, args) {
  if (!(name in ALLOWED)) throw new Error('Tool not allowed: ' + name);
  const spec = ALLOWED[name];
  const out = {};
  for (const key of Object.keys(spec)) {
    if (!(key in args)) throw new Error('Missing argument "' + key + '" for ' + name);
    if (!spec[key](args[key])) throw new Error('Invalid value for ' + name + '.' + key);
    out[key] = args[key];
  }
  const extra = Object.keys(args).filter(k => !(k in spec));
  if (extra.length) throw new Error('Unexpected argument(s) for ' + name + ': ' + extra.join(', '));
  return out;
}

const TOOL_DECLARATIONS = [
  { name: 'open_app', description: 'Open an installed Android app by package name.', parameters: { type: 'object', properties: { package_name: { type: 'string' } }, required: ['package_name'] } },
  { name: 'open_settings', description: 'Open a supported Android settings action.', parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] } },
  { name: 'back', description: 'Perform Android back via AccessibilityService when enabled.', parameters: { type: 'object', properties: {} } },
  { name: 'home', description: 'Perform Android home via AccessibilityService when enabled.', parameters: { type: 'object', properties: {} } },
  { name: 'share_text', description: 'Open Android share sheet with text.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'clipboard_set', description: 'Write text to the Android clipboard.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
];

/* ---------------- chat ---------------- */
function appendMsg(role, html) {
  const log = $('#chatLog');
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;
  wrap.innerHTML = '<div class="bubble">' + html + '</div>';
  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
  return wrap;
}
function renderHistory() {
  const log = $('#chatLog');
  log.innerHTML = '';
  state.history.forEach(m => {
    const who = m.role === 'user' ? '' : '<div class="who">Agent</div>';
    appendMsg(m.role === 'user' ? 'user' : 'ai', who + esc(m.text));
  });
}
function bubbleFor(res) {
  let html = esc(res.text || res.message || '');
  if (res.tool_call) {
    html += '<div><span class="tool">' + esc(res.tool_call.name) + '</span></div>';
    html += '<div class="kv">' + esc(JSON.stringify(res.tool_call.args, null, 2)) + '</div>';
    html += '<div class="hint" style="margin-top:6px">Validated against the allow-list. The Android app executes it after its own permission checks.</div>';
  }
  return html;
}

/* Direct Gemini call — current API (Gemini 3.x): key via header, no temperature. */
async function callGemini(message) {
  const key = state.settings.geminiKey;
  if (!key) throw new Error('No Gemini API key set.');
  const model = state.settings.geminiModel || 'gemini-3.8-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const contents = state.history.slice(-12).map(m => ({
    role: m.role === 'model' ? 'model' : 'user',
    parts: [{ text: m.text }]
  }));
  contents.push({ role: 'user', parts: [{ text: message }] });
  const body = {
    contents,
    tools: [{ function_declarations: TOOL_DECLARATIONS }],
    system_instruction: { parts: [{ text: 'You are an Android task planner. Reply briefly and helpfully. Choose only declared tools. Never invent permissions or capabilities. For app launching, return an actual Android package name only when you can infer one confidently; otherwise ask the user to provide it.' }] }
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || ('Gemini HTTP ' + res.status));
  const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  for (const part of parts) {
    if (part.functionCall) {
      const name = part.functionCall.name, args = part.functionCall.args || {};
      if (!(name in ALLOWED)) return { text: 'Model requested an unsupported action.' };
      let safe = args;
      try { safe = validateTool(name, args); }
      catch (e) { return { text: 'Planned tool rejected by the allow-list: ' + e.message }; }
      return { text: 'Planned action: ' + name, tool_call: { name, args: safe } };
    }
  }
  const text = parts.map(p => p.text || '').join('').trim();
  return { text: text || 'No response returned.' };
}

async function sendMessage(rawText) {
  const text = (rawText !== undefined ? rawText : $('#chatInput').value).trim();
  if (!text || state.busy) return;
  $('#chatInput').value = '';
  autoGrow();
  state.history.push({ role: 'user', text });
  appendMsg('user', esc(text));
  const typing = appendMsg('ai', '<span class="typing"><span></span><span></span><span></span></span>');

  state.busy = true;
  $('#sendBtn').disabled = true;
  try {
    let res;
    if (state.server) {
      const r = await fetch('api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, model: state.settings.geminiModel, history: state.history.slice(-12) })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || ('Server HTTP ' + r.status));
      res = { text: d.reply, tool_call: d.tool_call };
    } else if (state.settings.backendUrl && state.token) {
      const d = await backend('/api/agent/plan', { method: 'POST', body: { command: text } });
      res = { text: d.message, tool_call: d.tool_call };
    } else {
      res = await callGemini(text);
    }
    typing.remove();
    appendMsg('ai', '<div class="who">Agent</div>' + bubbleFor(res));
    state.history.push({ role: 'model', text: res.text });
    saveSettings();
  } catch (err) {
    typing.remove();
    appendMsg('err', '<div class="who">Error</div>' + esc(err.message) +
      '<div class="hint" style="margin-top:6px">Add a Gemini key in Settings, or run server.py, then try again.</div>');
  } finally {
    state.busy = false;
    $('#sendBtn').disabled = false;
  }
}
function autoGrow() {
  const t = $('#chatInput');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 130) + 'px';
}

/* ---------------- web builder ---------------- */
const TEMPLATE = [
  { path: 'index.html', content: '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1" />\n  <title>My Site</title>\n  <link rel="stylesheet" href="styles.css" />\n</head>\n<body>\n  <main>\n    <h1>Hello from Agent Studio</h1>\n    <p>Edit these files, preview, then deploy.</p>\n    <button id="btn">Click me</button>\n    <p id="out"></p>\n  </main>\n  <script src="app.js"><\/script>\n</body>\n</html>\n' },
  { path: 'styles.css', content: 'body{font-family:system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#0b0f1a;color:#e8edf7}\nmain{text-align:center;padding:2rem}\nbutton{padding:.6rem 1.1rem;border-radius:10px;border:0;background:#6d8bff;color:#0b1020;font-weight:600;cursor:pointer}\n' },
  { path: 'app.js', content: 'document.getElementById("btn").addEventListener("click",()=>{\n  document.getElementById("out").textContent="It works — "+new Date().toLocaleTimeString();\n});\n' },
];

function renderFiles() {
  const ul = $('#fileList');
  ul.innerHTML = '';
  state.files.forEach(f => {
    const li = document.createElement('li');
    li.className = f.path === state.activeFile ? 'active' : '';
    li.innerHTML = `<span>${esc(f.path)}</span><button class="del" title="Delete">×</button>`;
    li.addEventListener('click', e => {
      if (e.target.classList.contains('del')) { deleteFile(f.path); return; }
      selectFile(f.path);
    });
    ul.appendChild(li);
  });
}
function selectFile(path) {
  state.activeFile = path;
  const f = state.files.find(x => x.path === path);
  $('#fileEditor').value = f ? f.content : '';
  $('#editorTitle').textContent = path || 'Select a file';
  renderFiles();
}
function deleteFile(path) {
  state.files = state.files.filter(f => f.path !== path);
  if (state.activeFile === path) state.activeFile = state.files[0] ? state.files[0].path : null;
  selectFile(state.activeFile);
  renderFiles();
}
function addFile() {
  const path = prompt('New file path (e.g. about.html or assets/logo.svg):');
  if (!path) return;
  if (state.files.some(f => f.path === path)) { toast('That file already exists.', 'err'); return; }
  if (path.includes('..') || path.startsWith('/')) { toast('Unsafe path.', 'err'); return; }
  state.files.push({ path, content: '' });
  selectFile(path);
}
function logTo(el, msg, kind) {
  const cls = kind === 'err' ? 'err' : kind === 'ok' ? 'ok' : '';
  el.innerHTML = `<span class="${cls}">${esc(msg)}</span>`;
}
function entryHtml() {
  const entry = state.files.find(f => f.path === 'index.html');
  if (!entry) return null;
  const byPath = {};
  state.files.forEach(f => { byPath[f.path] = f; });
  const lookup = ref => {
    if (!ref) return null;
    const r = String(ref).replace(/^\.\//, '').split('?')[0].split('#')[0];
    if (byPath[r]) return byPath[r];
    const base = r.split('/').pop();
    return state.files.find(f => f.path.split('/').pop() === base) || null;
  };
  let html = entry.content;
  html = html.replace(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi, (m, href) => {
    const f = lookup(href);
    return f && /\.css$/i.test(f.path) ? '<style>\n' + f.content + '\n</style>' : m;
  });
  html = html.replace(/<script\b[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/gi, (m, src) => {
    const f = lookup(src);
    return f && /\.js$/i.test(f.path) ? '<script>\n' + f.content + '\n</script>' : m;
  });
  html = html.replace(/\b(src|href)=["']([^"']+\.(?:png|jpe?g|gif|webp|svg))["']/gi, (m, attr, path) => {
    const f = lookup(path);
    if (!f) return m;
    let b64;
    try { b64 = btoa(unescape(encodeURIComponent(f.content))); } catch (_) { return m; }
    return attr + '="data:' + mimeFor(f.path) + ';base64,' + b64 + '"';
  });
  return html;
}
function mimeFor(p) {
  if (p.endsWith('.css')) return 'text/css';
  if (p.endsWith('.js')) return 'text/javascript';
  if (p.endsWith('.json')) return 'application/json';
  if (p.endsWith('.svg')) return 'image/svg+xml';
  if (/\.(png|jpe?g|gif|webp)$/i.test(p)) return 'image/*';
  return 'text/plain';
}
function doPreview() {
  const html = entryHtml();
  const log = $('#builderLog');
  if (!html) { logTo(log, 'Preview needs an index.html at the project root.', 'err'); return; }
  const frame = $('#previewFrame');
  frame.srcdoc = html;
  frame.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  logTo(log, 'Preview rendered from index.html (' + state.files.length + ' file(s)).', 'ok');
}
function doValidate() {
  const log = $('#builderLog');
  const framework = $('#framework').value;
  const command = $('#buildCommand').value.trim();
  if (!state.files.length) { logTo(log, 'No files to validate.', 'err'); return; }
  if (framework === 'static') {
    if (!state.files.some(f => f.path === 'index.html')) { logTo(log, 'Static projects require an index.html.', 'err'); return; }
    logTo(log, 'Static project valid — ' + state.files.length + ' file(s), index.html present.', 'ok');
  } else if (!command) {
    logTo(log, 'A build command is required for ' + framework + ' projects.', 'err');
  } else {
    logTo(log, 'Client-side validation passed. Real builds for "' + framework + '" run on the backend (connect it in Settings).', 'ok');
  }
}

/* minimal store-only ZIP (real, valid .zip) */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function buildZip(files) {
  const enc = new TextEncoder();
  const chunks = []; const central = []; let offset = 0;
  const u16 = v => new Uint8Array([v & 255, (v >> 8) & 255]);
  const u32 = v => new Uint8Array([v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255]);
  const cat = arrs => { let n = 0; arrs.forEach(a => n += a.length); const out = new Uint8Array(n); let p = 0; arrs.forEach(a => { out.set(a, p); p += a.length; }); return out; };
  for (const f of files) {
    const nameB = enc.encode(f.path);
    const dataB = enc.encode(f.content);
    const crc = crc32(dataB);
    const local = cat([u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(dataB.length), u32(dataB.length), u16(nameB.length), u16(0), nameB, dataB]);
    chunks.push(local);
    central.push(cat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(dataB.length), u32(dataB.length), u16(nameB.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameB]));
    offset += local.length;
  }
  const cd = cat(central);
  const end = cat([u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cd.length), u32(offset), u16(0)]);
  return new Blob([cat(chunks), cd, end], { type: 'application/zip' });
}
function doZip() {
  if (!state.files.length) { toast('No files to zip.', 'err'); return; }
  const blob = buildZip(state.files);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'project.zip';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  logTo($('#builderLog'), 'ZIP built with ' + state.files.length + ' file(s) and downloaded.', 'ok');
}
async function doDeploy() {
  const log = $('#builderLog');
  const framework = $('#framework').value;
  const command = $('#buildCommand').value.trim();
  const payload = { framework, files: state.files.map(f => ({ path: f.path, content: f.content })), command };
  if (!state.files.length) { toast('Add files first.', 'err'); return; }
  const btn = $('#deployBtn'); btn.disabled = true;
  logTo(log, 'Deploying…');
  try {
    if (state.settings.backendUrl && state.token) {
      const r = await backend('/api/web/deploy-netlify', { method: 'POST', body: payload });
      logTo(log, 'Deployed via backend → ' + r.url + ' (HTTP ' + r.http_status + ')', 'ok');
      toast('Deployed: ' + r.url, 'ok');
    } else if (state.settings.netlifyToken) {
      const blob = buildZip(state.files);
      const site = state.settings.netlifySite;
      const url = site
        ? 'https://api.netlify.com/api/v1/sites/' + encodeURIComponent(site) + '/deploys'
        : 'https://api.netlify.com/api/v1/sites';
      const res = await fetch(url, { method: 'POST', headers: { 'Authorization': 'Bearer ' + state.settings.netlifyToken, 'Content-Type': 'application/zip' }, body: blob });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || ('Netlify HTTP ' + res.status));
      const deployUrl = data.ssl_url || data.url;
      if (!deployUrl) throw new Error('Netlify returned no public URL.');
      logTo(log, 'Deployed directly to Netlify → ' + deployUrl, 'ok');
      toast('Deployed: ' + deployUrl, 'ok');
    } else {
      throw new Error('No deploy path configured. Add a Netlify token, or connect the backend, in Settings.');
    }
  } catch (err) {
    logTo(log, 'Deploy failed: ' + err.message + (String(err.message).includes('Failed to fetch') ? ' — the provider may block direct browser calls; use the backend for deploys.' : ''), 'err');
    toast('Deploy failed.', 'err');
  } finally { btn.disabled = false; }
}

/* ---------------- python ---------------- */
function pyEngineLabel() {
  const connected = state.server || (state.settings.backendUrl && state.token);
  $('#pyEngineHint').textContent = connected ? 'Runs on the backend sandbox.' : 'Runs in your browser via Pyodide (loads once).';
}
async function ensurePyodide() {
  if (state.pyodide) return state.pyodide;
  if (state.pyodideLoading) return state.pyodideLoading;
  state.pyodideLoading = (async () => {
    $('#pyStatus').textContent = 'Loading Pyodide…';
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js';
      s.onload = resolve; s.onerror = () => reject(new Error('Could not load Pyodide from CDN.'));
      document.head.appendChild(s);
    });
    state.pyodide = await window.loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/' });
    return state.pyodide;
  })();
  return state.pyodideLoading;
}
async function runPython() {
  const code = $('#pyCode').value;
  const stdin = $('#pyStdin').value;
  const btn = $('#runPyBtn'); btn.disabled = true;
  const out = $('#pyOut');
  out.textContent = '';
  $('#pyStatus').textContent = 'Running…';
  try {
    if (state.settings.backendUrl && state.token) {
      const r = await backend('/api/python/run', { method: 'POST', body: { code, stdin } });
      out.textContent = (r.stdout || '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '') + '\n[exit ' + r.exit_code + ']';
    } else {
      const py = await ensurePyodide();
      let buffer = '';
      py.setStdout({ batched: s => { buffer += s + '\n'; } });
      py.setStderr({ batched: s => { buffer += s + '\n'; } });
      const lines = stdin.split('\n');
      let li = 0;
      py.setStdin({ stdin: () => (li < lines.length ? lines[li++] : '') });
      try {
        await py.runPythonAsync(code);
        out.textContent = buffer || '(no output)';
      } catch (e) {
        out.textContent = buffer + '\n[error]\n' + (e.message || e);
      }
    }
    $('#pyStatus').textContent = 'Done';
  } catch (err) {
    out.textContent = 'Error: ' + err.message;
    $('#pyStatus').textContent = 'Failed';
  } finally { btn.disabled = false; }
}

/* ---------------- settings ---------------- */
function fillSettings() {
  const s = state.settings;
  $('#sBackendUrl').value = s.backendUrl; $('#sUser').value = s.user;
  $('#sGeminiKey').value = s.geminiKey; $('#sGeminiModel').value = s.geminiModel;
  $('#sNetlifyToken').value = s.netlifyToken; $('#sNetlifySite').value = s.netlifySite;
  $('#authState').textContent = state.token ? 'Logged in (token stored).' : 'Not logged in.';
}
function readSettings() {
  const s = state.settings;
  s.backendUrl = $('#sBackendUrl').value.trim();
  s.user = $('#sUser').value.trim() || 'admin';
  s.geminiKey = $('#sGeminiKey').value.trim();
  s.geminiModel = $('#sGeminiModel').value.trim() || 'gemini-3.8-flash';
  s.netlifyToken = $('#sNetlifyToken').value.trim();
  s.netlifySite = $('#sNetlifySite').value.trim();
}
async function doLogin() {
  readSettings();
  const pass = $('#sPass').value;
  if (!state.settings.backendUrl) { toast('Set a backend URL first.', 'err'); return; }
  try {
    const r = await backend('/api/auth/login', { method: 'POST', body: { username: state.settings.user, password: pass } });
    state.token = r.access_token;
    saveSettings(); fillSettings(); updateConn(); pyEngineLabel(); chatHint();
    $('#sPass').value = '';
    toast('Logged in.', 'ok');
  } catch (err) { toast('Login failed: ' + err.message, 'err'); }
}
async function doHealth() {
  readSettings(); saveSettings();
  if (!state.settings.backendUrl) { toast('Set a backend URL first.', 'err'); return; }
  try {
    const r = await backend('/health');
    toast('Backend healthy: ' + JSON.stringify(r), 'ok');
  } catch (err) { toast('Health check failed: ' + err.message, 'err'); }
}

/* ---------------- wire up ---------------- */
function init() {
  loadSettings(); fillSettings(); updateConn(); pyEngineLabel(); chatHint();
  renderHistory();

  // chat
  $('#sendBtn').addEventListener('click', () => sendMessage());
  $('#chatInput').addEventListener('input', autoGrow);
  $('#chatInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  $$('#chatChips .chip').forEach(c => c.addEventListener('click', () => { $('#chatInput').value = c.dataset.cmd; sendMessage(); }));

  // builder
  $('#addFileBtn').addEventListener('click', addFile);
  $('#loadTemplateBtn').addEventListener('click', () => {
    state.files = TEMPLATE.map(f => ({ ...f })); selectFile('index.html'); renderFiles();
    logTo($('#builderLog'), 'Starter template loaded.', 'ok');
  });
  $('#deleteFileBtn').addEventListener('click', () => { if (state.activeFile) deleteFile(state.activeFile); });
  $('#fileEditor').addEventListener('input', e => {
    const f = state.files.find(x => x.path === state.activeFile);
    if (f) f.content = e.target.value;
  });
  $('#previewBtn').addEventListener('click', doPreview);
  $('#validateBtn').addEventListener('click', doValidate);
  $('#zipBtn').addEventListener('click', doZip);
  $('#deployBtn').addEventListener('click', doDeploy);
  $('#closePreviewBtn').addEventListener('click', () => { $('#previewFrame').srcdoc = ''; });

  // python
  $('#runPyBtn').addEventListener('click', runPython);

  // settings
  $('#saveSettingsBtn').addEventListener('click', () => { readSettings(); saveSettings(); updateConn(); chatHint(); toast('Settings saved.', 'ok'); });
  $('#loginBtn').addEventListener('click', doLogin);
  $('#healthBtn').addEventListener('click', doHealth);
  $('#logoutBtn').addEventListener('click', () => { state.token = null; saveSettings(); fillSettings(); updateConn(); pyEngineLabel(); chatHint(); toast('Logged out.'); });
  $('#clearSettingsBtn').addEventListener('click', () => {
    if (!confirm('Clear all settings, token, chat and files from this browser?')) return;
    localStorage.removeItem(LS_KEY); localStorage.removeItem(LS_KEY + ':token'); localStorage.removeItem(LS_KEY + ':history');
    state.settings = { ...DEFAULT_SETTINGS }; state.token = null; state.history = []; state.files = []; state.activeFile = null;
    fillSettings(); renderHistory(); renderFiles(); $('#fileEditor').value = ''; $('#editorTitle').textContent = 'Select a file';
    updateConn(); pyEngineLabel(); chatHint(); toast('Cleared.');
  });
  $('#connPill').addEventListener('click', () => goTo('settings'));

  // seed files
  state.files = TEMPLATE.map(f => ({ ...f }));
  selectFile('index.html');

  // detect local Python server, then refresh status
  probeServer().then(() => { updateConn(); pyEngineLabel(); chatHint(); });

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
}
document.addEventListener('DOMContentLoaded', init);
