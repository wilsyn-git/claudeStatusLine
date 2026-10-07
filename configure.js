#!/usr/bin/env node
// Visual editor for the status line config. Serves configure.html on 127.0.0.1, previews changes with the real
// renderer, and saves to ~/.claude/statusLine.json (or $STATUSLINE_CONFIG), keeping the previous file as .bak.
//
//   node configure.js [--port N] [--no-open]
//
// Every API call needs the per-run token from the URL, and the Host header must be the loopback address, so other
// pages in your browser can't read or write the config (a saved command segment runs on every refresh).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const sl = require('./statusLine.js');

const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf('--port') + 1]) || 0;
const TOKEN = crypto.randomBytes(16).toString('hex');
const PAGE = path.join(__dirname, 'configure.html');
const FILE = sl.CONFIG_FILE;

// The first Nerd Font file found, served so the browser preview shows the same glyphs as the terminal
const FONT = (() => {
  const dirs = [path.join(os.homedir(), 'Library/Fonts'), '/Library/Fonts', path.join(os.homedir(), '.local/share/fonts'), '/usr/share/fonts'];
  for (const dir of dirs) {
    try {
      const files = fs.readdirSync(dir, { recursive: true }).filter((f) => /nerd/i.test(f) && /\.(ttf|otf)$/i.test(f));
      const pick = files.find((f) => /mono/i.test(f)) ?? files[0];
      if (pick) return path.join(dir, pick);
    } catch {}
  }
  return null;
})();

function readConfig() {
  try {
    return { config: JSON.parse(fs.readFileSync(FILE, 'utf8')), exists: true };
  } catch (e) {
    if (e.code === 'ENOENT') return { config: {}, exists: false };
    return { config: {}, exists: true, error: `Couldn't read ${FILE}: ${e.message}. Saving will replace it.` };
  }
}

// Pretty-prints JSON, keeping short arrays and objects on one line so lines/options stay readable
function flat(v) {
  if (Array.isArray(v)) return `[${v.map(flat).join(', ')}]`;
  if (v && typeof v === 'object') {
    const entries = Object.entries(v);
    return entries.length ? `{ ${entries.map(([k, x]) => `${JSON.stringify(k)}: ${flat(x)}`).join(', ')} }` : '{}';
  }
  // Private-use glyphs (Nerd Font icons) are written as \uXXXX so they stay visible in any editor
  return JSON.stringify(v).replace(/[\ue000-\uf8ff]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
}

function format(v, indent = '') {
  const one = flat(v);
  if (one.length + indent.length <= 100 || v === null || typeof v !== 'object') return one;
  const inner = indent + '  ';
  const items = Array.isArray(v) ? v.map((x) => inner + format(x, inner)) : Object.entries(v).map(([k, x]) => `${inner}${JSON.stringify(k)}: ${format(x, inner)}`);
  return Array.isArray(v) ? `[\n${items.join(',\n')}\n${indent}]` : `{\n${items.join(',\n')}\n${indent}}`;
}

// Converts the renderer's 24-bit ANSI output to HTML spans
function ansiToHtml(s) {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let style = '';
  let html = '';
  for (const [i, part] of s.split(/\x1b\[([0-9;]*)m/).entries()) {
    if (i % 2 === 0) {
      if (part) html += style ? `<span style="${style}">${esc(part)}</span>` : esc(part);
      continue;
    }
    const codes = part.split(';').map(Number);
    if (!part || codes[0] === 0) style = '';
    const fg = codes.indexOf(38);
    if (fg >= 0 && codes[fg + 1] === 2) style = `color:rgb(${codes.slice(fg + 2, fg + 5).join(',')})${codes.includes(1) ? ';font-weight:700' : ''}`;
  }
  return html;
}

function preview(config, scenario) {
  const { cfg } = sl.resolveConfig(config);
  const out = sl.render(sl.samplePayload(scenario), cfg, { preview: true });
  return out.split('\n').map(ansiToHtml);
}

function save(config) {
  const problems = sl.validate(config);
  if (problems.length) return { status: 422, body: { problems } };
  const { $schema, ...rest } = config;
  const text = format({ $schema: $schema ?? sl.SCHEMA_URL, ...rest }) + '\n';
  let backup = null;
  if (fs.existsSync(FILE)) {
    backup = `${FILE}.bak`;
    fs.copyFileSync(FILE, backup);
  }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, FILE);
  return { status: 200, body: { ok: true, path: FILE, backup, config: JSON.parse(text) } };
}

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const { port } = server.address();
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return send(res, 403, { error: 'bad host' });

  if (req.method === 'GET' && url.pathname === '/') {
    if (url.searchParams.get('t') !== TOKEN) return send(res, 403, 'Open the URL printed by configure.js.', 'text/plain');
    return send(res, 200, fs.readFileSync(PAGE, 'utf8').replace('__TOKEN__', TOKEN), 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && url.pathname === '/font') {
    if (!FONT) return send(res, 404, { error: 'no Nerd Font found' });
    res.writeHead(200, { 'content-type': FONT.endsWith('otf') ? 'font/otf' : 'font/ttf', 'cache-control': 'max-age=3600' });
    return fs.createReadStream(FONT).pipe(res);
  }
  if (req.method !== 'POST' || req.headers['x-token'] !== TOKEN) return send(res, 403, { error: 'forbidden' });

  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1e6) req.destroy();
  });
  req.on('end', () => {
    let input;
    try {
      input = body ? JSON.parse(body) : {};
    } catch {
      return send(res, 400, { error: 'bad JSON' });
    }
    try {
      switch (url.pathname) {
        case '/api/state':
          return send(res, 200, {
            ...readConfig(),
            path: FILE,
            spec: sl.SPEC,
            defaults: sl.DEFAULTS,
            palette: sl.PALETTE,
            icons: sl.ICONS,
            font: Boolean(FONT),
          });
        case '/api/preview':
          return send(res, 200, { problems: sl.validate(input.config), lines: preview(input.config, input.scenario) });
        case '/api/save': {
          const r = save(input.config);
          return send(res, r.status, r.body);
        }
        case '/api/quit':
          send(res, 200, { ok: true });
          return setTimeout(() => process.exit(0), 50);
        default:
          return send(res, 404, { error: 'not found' });
      }
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}/?t=${TOKEN}`;
  console.log(`Status line configurator: ${url}\nEditing ${FILE}. Ctrl-C or Done to stop.`);
  if (args.includes('--no-open')) return;
  const [cmd, ...cmdArgs] = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url];
  spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
});
