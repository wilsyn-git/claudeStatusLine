#!/usr/bin/env node
// Claude Code status line. Reads the status JSON Claude Code pipes on stdin and prints one line per entry in `lines`.
// Default layout:
//   1. model · effort │ context bar vs. handoff target │ room/turns to handoff │ token mix
//   2. prompt cache │ plan limits │ cost │ git
// Layout and per-segment options come from DEFAULTS, overridden by ~/.claude/statusLine.json (or $STATUSLINE_CONFIG).
// Context thresholds are keyed to handoffPct (default 60): refresh the session there instead of compacting.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, execSync } = require('child_process');

const HISTORY_TURNS = 10;
const STATE_DIR = path.join(os.tmpdir(), 'claudeStatusLine');
const CONFIG_FILE = process.env.STATUSLINE_CONFIG || path.join(os.homedir(), '.claude', 'statusLine.json');

// Every key here can be overridden from the config file. Objects merge key by key; arrays and scalars replace.
const DEFAULTS = {
  handoffPct: 60,
  warnBelow: 15,
  separator: ' │ ',
  lines: [
    ['model', 'context', 'handoff', 'tokens'],
    ['cache', 'limits', 'cost', 'git'],
  ],
  segments: {
    model: { effort: true, fast: true },
    context: { barCells: 10, turnDelta: true },
    handoff: { turnEstimate: true },
    tokens: {},
    cache: { hitRatio: true, misses: true },
    limits: { windows: ['5h', 'wk'], showResetAbove: 50, warn: 50, bad: 80 },
    cost: { burnRate: true, burnRateAfterMin: 5 },
    git: { lineDelta: true, timeoutMs: 500 },
    command: { timeoutMs: 300, cacheSec: 30, color: 'fg' },
  },
  colors: {},
  icons: {},
};

// TokyoNight Night palette
const C = {
  fg: '#c0caf5', dim: '#565f89', blue: '#7aa2f7', cyan: '#7dcfff', purple: '#bb9af7', green: '#9ece6a',
  yellow: '#e0af68', orange: '#ff9e64', red: '#f7768e', teal: '#73daca', magenta: '#ff007c',
};

// Nerd Font glyphs from the Font Awesome 4 and Powerline ranges, which are stable across Nerd Font v2 and v3
const I = {
  model: '', fast: '', flag: '', warn: '', clock: '',
  cache: '', gauge: '', branch: '',
};

const EFFORT_COLORS = { low: C.dim, medium: C.blue, high: C.yellow, xhigh: C.orange, max: C.magenta };

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isHex = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

function merge(base, over) {
  if (!isObject(base) || !isObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
  return out;
}

// Never throws: a missing file means defaults, a broken one means defaults plus a warning on line 1.
function loadConfig() {
  let user = {};
  let error = null;
  try {
    user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (!isObject(user)) throw new Error('top level must be an object');
  } catch (e) {
    if (e.code !== 'ENOENT') error = e.message;
    user = {};
  }
  const cfg = merge(DEFAULTS, user);
  if (!Array.isArray(cfg.lines) || !cfg.lines.every(Array.isArray)) {
    error = '"lines" must be an array of arrays';
    cfg.lines = DEFAULTS.lines;
  }
  if (process.env.HANDOFF_PCT) cfg.handoffPct = Number(process.env.HANDOFF_PCT) || cfg.handoffPct;
  cfg.handoffPct = Number(cfg.handoffPct) || DEFAULTS.handoffPct;
  cfg.warnPct = cfg.handoffPct - (Number(cfg.warnBelow) || 0);
  if (isObject(cfg.colors)) for (const [k, v] of Object.entries(cfg.colors)) if (isHex(v)) C[k] = v;
  if (isObject(cfg.icons)) for (const [k, v] of Object.entries(cfg.icons)) if (typeof v === 'string') I[k] = v;
  return { cfg, error };
}

// Config colors can be a palette name ("cyan") or a hex value ("#ff5555")
const color = (v, fallback = C.fg) => (isHex(v) ? v : C[v] ?? fallback);

function paint(hex, text, bold = false) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `\x1b[${bold ? '1;' : ''}38;2;${r};${g};${b}m${text}\x1b[0m`;
}

function fmtTokens(n) {
  if (n == null || Number.isNaN(n)) return '?';
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return n < 10000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${Math.round(n / 1000)}k`;
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
}

function fmtDuration(sec) {
  if (sec <= 0) return '0m';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d${h}h`;
  if (h) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

const pctColor = (pct, warn = 50, bad = 80) => (pct >= bad ? C.red : pct >= warn ? C.yellow : C.green);

// Tracks context growth per user prompt so we can show this turn's delta and estimate turns left.
// Each status refresh is a separate process, so the running numbers live in a small per-session file.
function turnStats(sessionId, promptId, used) {
  if (!sessionId || used == null) return {};
  const file = path.join(STATE_DIR, `${sessionId.replace(/[^\w-]/g, '')}.json`);
  let st = {};
  try {
    st = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  // Context shrank (compact/clear/rewind): earlier deltas no longer describe this context
  if (st.lastUsed != null && used < st.lastUsed) st = {};
  if (st.promptId !== (promptId ?? null)) {
    const history = st.history ?? [];
    if (st.promptId != null && st.lastUsed != null && st.lastUsed > st.startUsed) history.push(st.lastUsed - st.startUsed);
    st = { promptId: promptId ?? null, startUsed: st.lastUsed ?? used, history: history.slice(-HISTORY_TURNS) };
  }
  st.lastUsed = used;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(st));
  } catch {}

  const delta = used - st.startUsed;
  const samples = st.history.length ? st.history : delta > 0 ? [delta] : [];
  const avg = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : null;
  return { delta, avg };
}

// Context numbers shared by the context, handoff and tokens segments. Computed once per refresh so the
// turn-state file is written once no matter how many of those segments are shown.
function contextInfo(ctx) {
  if (ctx.memo.context !== undefined) return ctx.memo.context;
  const { d, cfg } = ctx;
  const cw = d.context_window;
  let info = null;
  if (cw) {
    const size = cw.context_window_size;
    const u = cw.current_usage;
    const used = u ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) : cw.total_input_tokens ?? 0;
    const pct = cw.used_percentage ?? (size ? (used / size) * 100 : 0);
    const color = pct >= cfg.handoffPct ? C.red : pct >= cfg.warnPct ? C.yellow : C.green;
    info = { size, u, used, pct, color, ...turnStats(d.session_id, d.prompt_id, used) };
  }
  return (ctx.memo.context = info);
}

function modelSegment({ d }, o) {
  const id = d.model?.id ?? '';
  const name = (d.model?.display_name ?? id).replace(/\s*\(.*\)\s*$/, '');
  if (!name) return null;
  const color = /opus/i.test(id) ? C.purple : /sonnet/i.test(id) ? C.blue : /haiku/i.test(id) ? C.green : /fable/i.test(id) ? C.teal : C.cyan;
  let s = paint(color, `${I.model} ${name}`, true);
  const effort = d.effort?.level;
  if (o.effort && effort) s += paint(C.dim, ' · ') + paint(EFFORT_COLORS[effort] ?? C.fg, effort);
  if (o.fast && d.fast_mode) s += ' ' + paint(C.yellow, I.fast);
  return s;
}

function contextSegment(ctx, o) {
  const c = contextInfo(ctx);
  if (!c) return null;
  const cells = Math.max(1, Number(o.barCells) || 10);
  const filled = Math.min(cells, Math.max(0, Math.round((c.pct / 100) * cells)));
  let s = paint(c.color, '▰'.repeat(filled)) + paint(C.dim, '▱'.repeat(cells - filled));
  s += ' ' + paint(c.color, `${Math.round(c.pct)}%`, true) + paint(C.dim, ` ${fmtTokens(c.used)}/${fmtTokens(c.size)}`);
  if (o.turnDelta && c.delta > 0) s += ' ' + paint(C.cyan, `+${fmtTokens(c.delta)}`);
  return s;
}

function handoffSegment(ctx, o) {
  const c = contextInfo(ctx);
  if (!c) return null;
  const { handoffPct, warnPct } = ctx.cfg;
  if (c.pct >= handoffPct) return paint(C.red, `${I.warn} handoff now`, true);
  if (!c.size) return null;
  const room = (c.size * handoffPct) / 100 - c.used;
  let s = paint(c.pct >= warnPct ? C.yellow : C.fg, `${I.flag} ${fmtTokens(room)}`);
  if (o.turnEstimate && c.avg) s += paint(C.dim, ` ~${Math.floor(room / c.avg)} turns`);
  return s;
}

function tokensSegment(ctx) {
  const u = contextInfo(ctx)?.u;
  if (!u) return null;
  // in = tokens newly processed this request (uncached + cache write); cached = cache read
  return (
    paint(C.blue, `↑${fmtTokens((u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0))}`) +
    ' ' + paint(C.purple, `↓${fmtTokens(u.output_tokens ?? 0)}`) +
    ' ' + paint(C.teal, `${I.cache} ${fmtTokens(u.cache_read_input_tokens ?? 0)}`)
  );
}

function cacheSegment({ d, now }, o) {
  const pc = d.prompt_cache;
  if (!pc?.caching_observed) return null;
  let hit = '';
  if (o.hitRatio && pc.hit_ratio != null) {
    const h = Math.round(pc.hit_ratio * 100);
    hit = ' ' + paint(h >= 80 ? C.green : h >= 50 ? C.yellow : C.red, `${h}%`) + paint(C.dim, ' hit');
  }
  if (o.misses && pc.misses > 0) hit += ' ' + paint(C.yellow, `${pc.misses} miss`);

  if (!pc.warm || (pc.expires_at && pc.expires_at <= now)) {
    return paint(C.red, `${I.clock} cold`, true) + paint(C.dim, ' re-bill ') + paint(C.orange, fmtTokens(pc.recache_tokens_if_cold)) + hit;
  }
  if (!pc.expires_at) return paint(C.green, `${I.clock} warm`) + hit;
  const left = pc.expires_at - now;
  const color = left > 15 * 60 ? C.green : left > 5 * 60 ? C.yellow : C.orange;
  return paint(color, `${I.clock} ${fmtDuration(left)}`) + hit;
}

const LIMIT_WINDOWS = { '5h': 'five_hour', wk: 'seven_day' };

function limitsSegment({ d, now }, o) {
  const rl = d.rate_limits;
  if (!rl) return null;
  const part = (label) => {
    const limit = rl[LIMIT_WINDOWS[label]];
    if (limit?.used_percentage == null) return null;
    const pct = Math.round(limit.used_percentage);
    let s = paint(C.dim, `${label} `) + paint(pctColor(pct, o.warn, o.bad), `${pct}%`);
    if (pct >= o.showResetAbove && limit.resets_at) s += paint(C.dim, ` ↻${fmtDuration(limit.resets_at - now)}`);
    return s;
  };
  const parts = (Array.isArray(o.windows) ? o.windows : []).map(part).filter(Boolean);
  return parts.length ? paint(C.blue, I.gauge) + ' ' + parts.join(' ') : null;
}

function costSegment({ d }, o) {
  const cost = d.cost;
  if (cost?.total_cost_usd == null) return null;
  let s = paint(C.green, `$${cost.total_cost_usd.toFixed(2)}`);
  const hours = (cost.total_duration_ms ?? 0) / 3.6e6;
  // Burn rate is noise in the first few minutes
  if (o.burnRate && hours >= o.burnRateAfterMin / 60) {
    const rate = cost.total_cost_usd / hours;
    s += paint(C.dim, ` $${rate.toFixed(rate < 10 ? 1 : 0)}/h`);
  }
  return s;
}

function gitSegment({ d, cwd }, o) {
  if (!cwd) return null;
  let out;
  try {
    out = execFileSync('git', ['--no-optional-locks', '-C', cwd, 'status', '--porcelain=v2', '--branch'], {
      encoding: 'utf8',
      timeout: o.timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  let head = '';
  let ahead = 0;
  let behind = 0;
  let dirty = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) head = line.slice('# branch.head '.length);
    else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) [ahead, behind] = [Number(m[1]), Number(m[2])];
    } else if (line && !line.startsWith('#')) dirty++;
  }
  let s = paint(C.purple, `${I.branch} ${head}`);
  if (dirty) s += ' ' + paint(C.yellow, `●${dirty}`);
  if (ahead) s += ' ' + paint(C.green, `↑${ahead}`);
  if (behind) s += ' ' + paint(C.red, `↓${behind}`);
  const added = d.cost?.total_lines_added ?? 0;
  const removed = d.cost?.total_lines_removed ?? 0;
  if (o.lineDelta && (added || removed)) s += ' ' + paint(C.green, `+${added}`) + ' ' + paint(C.red, `−${removed}`);
  return s;
}

// Runs a user-supplied shell command and shows the first line of its output. The result (including failure)
// is cached per command and directory for cacheSec, so a slow command costs at most one run per interval.
function commandSegment({ cwd, now }, o) {
  if (typeof o.cmd !== 'string' || !o.cmd) return null;
  const key = crypto.createHash('sha1').update(`${cwd ?? ''}\0${o.cmd}`).digest('hex').slice(0, 16);
  const file = path.join(STATE_DIR, `cmd-${key}.json`);
  let cached;
  try {
    cached = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  let text = cached && now - cached.at < (Number(o.cacheSec) || 0) ? cached.text : null;
  if (text == null) {
    try {
      text = execSync(o.cmd, {
        cwd: cwd || undefined,
        encoding: 'utf8',
        timeout: Number(o.timeoutMs) || 300,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      text = '';
    }
    text = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ at: now, text }));
    } catch {}
  }
  if (!text) return null;
  return paint(color(o.color), o.icon ? `${o.icon} ${text}` : text);
}

const SEGMENTS = {
  model: modelSegment,
  context: contextSegment,
  handoff: handoffSegment,
  tokens: tokensSegment,
  cache: cacheSegment,
  limits: limitsSegment,
  cost: costSegment,
  git: gitSegment,
  command: commandSegment,
};

// A line entry is a segment id ("git") or an object with an id plus options that override that segment's config.
// An unknown id or a segment that throws renders as a marker instead of taking the rest of the line down with it.
function renderEntry(ctx, entry) {
  const { id, ...inline } = typeof entry === 'string' ? { id: entry } : isObject(entry) ? entry : {};
  const fn = SEGMENTS[id];
  if (!fn) return paint(C.dim, `?${id ?? ''}`);
  try {
    return fn(ctx, merge(ctx.cfg.segments?.[id] ?? {}, inline));
  } catch {
    return paint(C.red, `!${id}`);
  }
}

function main() {
  const { cfg, error } = loadConfig();
  let d;
  try {
    d = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch (e) {
    process.stdout.write(paint(C.red, `statusLine: bad input (${e.message})`));
    return;
  }
  const ctx = { d, cfg, now: Date.now() / 1000, cwd: d.workspace?.current_dir ?? d.cwd, memo: {} };
  const sep = paint(C.dim, typeof cfg.separator === 'string' ? cfg.separator : DEFAULTS.separator);
  const lines = cfg.lines.map((entries) => entries.map((e) => renderEntry(ctx, e)).filter(Boolean));
  if (error) {
    if (!lines.length) lines.push([]);
    lines[0].push(paint(C.red, `${I.warn} cfg`) + paint(C.dim, ` ${error}`));
  }
  process.stdout.write(lines.map((l) => l.join(sep)).filter(Boolean).join('\n'));
}

try {
  main();
} catch (e) {
  process.stdout.write(`statusLine error: ${e.message}`);
}
