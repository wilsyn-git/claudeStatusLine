#!/usr/bin/env node
// Claude Code status line. Reads the status JSON Claude Code pipes on stdin and prints one line per entry in `lines`.
// Default layout:
//   1. model · effort │ context bar vs. handoff target │ room/turns to handoff │ token mix
//   2. prompt cache │ plan limits │ cost │ git
// Layout and per-segment options come from SPEC defaults, overridden by ~/.claude/statusLine.json (or $STATUSLINE_CONFIG).
// Context thresholds are keyed to handoffPct (default 60): refresh the session there instead of compacting.
//
//   node statusLine.js            render (Claude Code runs this on every refresh)
//   node statusLine.js --check    validate the config file and preview it
//   node statusLine.js --schema   print the config JSON Schema (committed as statusLine.schema.json)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, execSync } = require('child_process');

const HISTORY_TURNS = 10;
const STATE_DIR = path.join(os.tmpdir(), 'claudeStatusLine');
const CONFIG_FILE = process.env.STATUSLINE_CONFIG || path.join(os.homedir(), '.claude', 'statusLine.json');
const SCHEMA_URL = 'https://raw.githubusercontent.com/wilsyn-git/claudeStatusLine/main/statusLine.schema.json';

// TokyoNight Night palette
const PALETTE = {
  fg: '#c0caf5', dim: '#565f89', blue: '#7aa2f7', cyan: '#7dcfff', purple: '#bb9af7', green: '#9ece6a',
  yellow: '#e0af68', orange: '#ff9e64', red: '#f7768e', teal: '#73daca', magenta: '#ff007c',
};

// Nerd Font glyphs from the Font Awesome 4 and Powerline ranges, which are stable across Nerd Font v2 and v3
const ICONS = {
  model: '', fast: '', flag: '', warn: '', clock: '',
  cache: '', gauge: '', branch: '',
};

// The active palette and icons: the defaults above plus config overrides, reapplied on each render
const C = { ...PALETTE };
const I = { ...ICONS };

const EFFORT_COLORS = { low: 'dim', medium: 'blue', high: 'yellow', xhigh: 'orange', max: 'magenta' };
const LIMIT_WINDOWS = { '5h': 'five_hour', wk: 'seven_day' };

// Every configurable setting with its type, default and description. DEFAULTS, validation, the JSON Schema
// and the visual configurator (configure.js) are all derived from this table, so a new option goes here only.
const SPEC = {
  settings: {
    handoffPct: { type: 'number', min: 1, max: 100, default: 60, desc: 'Context percentage at which to hand off to a fresh session. The HANDOFF_PCT env var overrides it.' },
    warnBelow: { type: 'number', min: 0, max: 100, default: 15, desc: 'Context turns yellow this many points below handoffPct.' },
    separator: { type: 'string', default: ' │ ', desc: 'Text between segments.' },
  },
  lines: [
    ['model', 'context', 'handoff', 'tokens'],
    ['cache', 'limits', 'cost', 'git'],
  ],
  segments: {
    model: {
      desc: 'Model name colored by family, reasoning effort, and a bolt when fast mode is on.',
      options: {
        effort: { type: 'boolean', default: true, desc: 'Show the reasoning effort level.' },
        fast: { type: 'boolean', default: true, desc: 'Show a bolt when fast mode is on.' },
      },
    },
    context: {
      desc: 'Context used vs. window size; yellow near the handoff target, red past it.',
      options: {
        barCells: { type: 'integer', min: 1, max: 40, default: 10, desc: 'Width of the bar in cells.' },
        turnDelta: { type: 'boolean', default: true, desc: "Show this turn's context growth (+N)." },
      },
    },
    handoff: {
      desc: 'Tokens left before the handoff target, or "handoff now" once past it.',
      options: {
        turnEstimate: { type: 'boolean', default: true, desc: 'Estimate turns left from the average growth of recent turns.' },
      },
    },
    tokens: { desc: 'Last request: newly processed input, output, and cache read.', options: {} },
    cache: {
      desc: 'Prompt cache time left (or cold plus the tokens a re-cache would bill), hit ratio, misses.',
      options: {
        hitRatio: { type: 'boolean', default: true, desc: 'Show the cache hit ratio.' },
        misses: { type: 'boolean', default: true, desc: 'Show the cache miss count.' },
      },
    },
    limits: {
      desc: 'Plan usage for the 5-hour and weekly windows.',
      options: {
        windows: { type: 'list', items: Object.keys(LIMIT_WINDOWS), default: ['5h', 'wk'], desc: 'Which windows to show, in order.' },
        showResetAbove: { type: 'number', min: 0, max: 100, default: 50, desc: 'Show the reset countdown at or above this percentage.' },
        warn: { type: 'number', min: 0, max: 100, default: 50, desc: 'Yellow at or above this percentage.' },
        bad: { type: 'number', min: 0, max: 100, default: 80, desc: 'Red at or above this percentage.' },
      },
    },
    cost: {
      desc: 'Session cost and burn rate per hour.',
      options: {
        burnRate: { type: 'boolean', default: true, desc: 'Show the burn rate per hour.' },
        burnRateAfterMin: { type: 'number', min: 0, default: 5, desc: 'Minutes into the session before the burn rate appears.' },
      },
    },
    git: {
      desc: 'Branch, dirty file count, ahead/behind, and lines added/removed this session.',
      options: {
        lineDelta: { type: 'boolean', default: true, desc: 'Show lines added/removed this session.' },
        timeoutMs: { type: 'integer', min: 50, max: 5000, default: 500, desc: 'Give up on git after this many milliseconds.' },
      },
    },
    command: {
      multi: true,
      desc: 'First line of output from a shell command, run in the session directory. Can be used more than once.',
      options: {
        cmd: { type: 'string', required: true, desc: 'Shell command to run.' },
        icon: { type: 'string', desc: 'Text shown before the output.' },
        color: { type: 'color', default: 'fg', desc: 'Palette name or #rrggbb.' },
        timeoutMs: { type: 'integer', min: 50, max: 5000, default: 300, desc: 'Give up on the command after this many milliseconds.' },
        cacheSec: { type: 'number', min: 0, default: 30, desc: 'Reuse the last result (including a failure) for this many seconds.' },
      },
    },
  },
};

const defaultsOf = (options) =>
  Object.fromEntries(Object.entries(options).filter(([, o]) => 'default' in o).map(([k, o]) => [k, o.default]));

// Every key here can be overridden from the config file. Objects merge key by key; arrays and scalars replace.
const DEFAULTS = {
  ...defaultsOf(SPEC.settings),
  lines: SPEC.lines,
  segments: Object.fromEntries(Object.entries(SPEC.segments).map(([id, s]) => [id, defaultsOf(s.options)])),
  colors: {},
  icons: {},
};

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isHex = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

function merge(base, over) {
  if (!isObject(base) || !isObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
  return out;
}

// Returns a list of "path: problem" strings; empty means the config is valid.
function validate(user) {
  if (!isObject(user)) return ['top level must be an object'];
  const problems = [];
  const bad = (p, msg) => problems.push(`${p}: ${msg}`);
  const colorNames = new Set([...Object.keys(PALETTE), ...(isObject(user.colors) ? Object.keys(user.colors) : [])]);
  const unknown = (p, what, key, known) => {
    const near = known.find((k) => k.toLowerCase() === key.toLowerCase());
    bad(p, near ? `unknown ${what} "${key}", did you mean "${near}"?` : `unknown ${what} "${key}" (expected one of ${known.join(', ')})`);
  };

  const checkValue = (p, spec, v) => {
    switch (spec.type) {
      case 'boolean':
        if (typeof v !== 'boolean') bad(p, 'must be true or false');
        return;
      case 'number':
      case 'integer':
        if (typeof v !== 'number' || !Number.isFinite(v)) return bad(p, 'must be a number');
        if (spec.type === 'integer' && !Number.isInteger(v)) return bad(p, 'must be a whole number');
        if (spec.min != null && v < spec.min) bad(p, `must be at least ${spec.min}`);
        if (spec.max != null && v > spec.max) bad(p, `must be at most ${spec.max}`);
        return;
      case 'string':
        if (typeof v !== 'string') bad(p, 'must be a string');
        return;
      case 'color':
        if (!isHex(v) && !colorNames.has(v)) bad(p, `must be #rrggbb or a palette name (${[...colorNames].join(', ')})`);
        return;
      case 'list':
        if (!Array.isArray(v)) return bad(p, `must be a list of ${spec.items.join(', ')}`);
        v.forEach((x, i) => spec.items.includes(x) || bad(`${p}[${i}]`, `must be one of ${spec.items.join(', ')}`));
    }
  };

  const checkOptions = (p, id, opts, skip = []) => {
    const specs = SPEC.segments[id].options;
    for (const [k, v] of Object.entries(opts)) {
      if (skip.includes(k)) continue;
      if (specs[k]) checkValue(`${p}.${k}`, specs[k], v);
      else unknown(p, 'option', k, Object.keys(specs));
    }
  };

  for (const [k, v] of Object.entries(user)) {
    if (k === '$schema') continue;
    if (SPEC.settings[k]) checkValue(k, SPEC.settings[k], v);
    else if (k === 'lines') {
      if (!Array.isArray(v) || !v.every(Array.isArray)) {
        bad('lines', 'must be a list of lines, each a list of segments');
        continue;
      }
      v.forEach((line, li) =>
        line.forEach((entry, ei) => {
          const p = `lines[${li}][${ei}]`;
          const id = typeof entry === 'string' ? entry : isObject(entry) ? entry.id : undefined;
          if (typeof id !== 'string') return bad(p, 'must be a segment id or an object with an "id"');
          if (!SPEC.segments[id]) return unknown(p, 'segment', id, Object.keys(SPEC.segments));
          if (isObject(entry)) checkOptions(p, id, entry, ['id']);
          if (id === 'command' && !(isObject(entry) && entry.cmd) && !user.segments?.command?.cmd) bad(p, 'command needs a "cmd"');
        })
      );
    } else if (k === 'segments') {
      if (!isObject(v)) {
        bad('segments', 'must be an object keyed by segment id');
        continue;
      }
      for (const [id, opts] of Object.entries(v)) {
        if (!SPEC.segments[id]) unknown('segments', 'segment', id, Object.keys(SPEC.segments));
        else if (!isObject(opts)) bad(`segments.${id}`, 'must be an object of options');
        else checkOptions(`segments.${id}`, id, opts);
      }
    } else if (k === 'colors') {
      if (!isObject(v)) bad('colors', 'must be an object of name: "#rrggbb"');
      else for (const [name, hex] of Object.entries(v)) if (!isHex(hex)) bad(`colors.${name}`, 'must be #rrggbb');
    } else if (k === 'icons') {
      if (!isObject(v)) bad('icons', 'must be an object of name: "glyph"');
      else
        for (const [name, glyph] of Object.entries(v)) {
          if (!ICONS[name]) unknown('icons', 'icon', name, Object.keys(ICONS));
          else if (typeof glyph !== 'string') bad(`icons.${name}`, 'must be a string');
        }
    } else unknown('(top level)', 'setting', k, ['$schema', ...Object.keys(SPEC.settings), 'lines', 'segments', 'colors', 'icons']);
  }
  return problems;
}

// Merges a parsed config over DEFAULTS, keeping whatever is usable from an invalid one. Never throws.
function resolveConfig(user) {
  const problems = validate(user);
  const cfg = merge(DEFAULTS, isObject(user) ? user : {});
  if (!Array.isArray(cfg.lines) || !cfg.lines.every(Array.isArray)) cfg.lines = DEFAULTS.lines;
  if (typeof cfg.separator !== 'string') cfg.separator = DEFAULTS.separator;
  if (process.env.HANDOFF_PCT) cfg.handoffPct = Number(process.env.HANDOFF_PCT) || cfg.handoffPct;
  cfg.handoffPct = Number(cfg.handoffPct) || DEFAULTS.handoffPct;
  cfg.warnPct = cfg.handoffPct - (Number(cfg.warnBelow) || 0);
  return { cfg, problems };
}

// A missing file means defaults; an unreadable or invalid one means defaults plus problems to report.
function loadConfig(file = CONFIG_FILE) {
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') return { ...resolveConfig({}), problems: [e.message] };
  }
  return resolveConfig(user);
}

function applyTheme(cfg) {
  for (const k of Object.keys(C)) delete C[k];
  Object.assign(C, PALETTE);
  if (isObject(cfg.colors)) for (const [k, v] of Object.entries(cfg.colors)) if (isHex(v)) C[k] = v;
  Object.assign(I, ICONS);
  if (isObject(cfg.icons)) for (const [k, v] of Object.entries(cfg.icons)) if (ICONS[k] && typeof v === 'string') I[k] = v;
}

// Config colors can be a palette name ("cyan") or a hex value ("#ff5555")
const color = (v, fallback = C.fg) => (isHex(v) ? v : Object.hasOwn(C, v) ? C[v] : fallback);

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
  if (o.effort && effort) s += paint(C.dim, ' · ') + paint(C[EFFORT_COLORS[effort]] ?? C.fg, effort);
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
// In preview mode (the configurator, --check) it never runs: it shows the last cached result or a placeholder,
// so a half-typed command can't execute.
function commandSegment({ cwd, now, preview }, o) {
  if (typeof o.cmd !== 'string' || !o.cmd) return null;
  const key = crypto.createHash('sha1').update(`${cwd ?? ''}\0${o.cmd}`).digest('hex').slice(0, 16);
  const file = path.join(STATE_DIR, `cmd-${key}.json`);
  let cached;
  try {
    cached = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  let text = cached && (preview || now - cached.at < (Number(o.cacheSec) || 0)) ? cached.text : null;
  if (text == null && preview) text = `‹${o.cmd.length > 24 ? `${o.cmd.slice(0, 23)}…` : o.cmd}›`;
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

// Renders a status payload with a resolved config. `problems` (from validation) adds a warning to line 1.
function render(d, cfg, { problems = [], preview = false } = {}) {
  applyTheme(cfg);
  const ctx = { d, cfg, preview, now: Date.now() / 1000, cwd: d.workspace?.current_dir ?? d.cwd, memo: {} };
  const sep = paint(C.dim, cfg.separator);
  const lines = cfg.lines.map((entries) => entries.map((e) => renderEntry(ctx, e)).filter(Boolean));
  if (problems.length) {
    if (!lines.length) lines.push([]);
    const more = problems.length > 1 ? ` (+${problems.length - 1} more, run --check)` : '';
    lines[0].push(paint(C.red, `${I.warn} cfg`) + paint(C.dim, ` ${problems[0]}${more}`));
  }
  return lines.map((l) => l.join(sep)).filter(Boolean).join('\n');
}

// Sample payloads for previews, from comfortable to past the handoff target
function samplePayload(scenario = 'typical', cwd = process.cwd()) {
  const now = Math.floor(Date.now() / 1000);
  const s = {
    typical: { pct: 31, cacheLeft: 2900, warm: true, five: 34, week: 61, cost: 4.12 },
    warning: { pct: 52, cacheLeft: 240, warm: true, five: 72, week: 64, cost: 9.8 },
    handoff: { pct: 64, cacheLeft: 0, warm: false, five: 91, week: 83, cost: 17.35 },
  }[scenario] ?? {};
  const used = s.pct * 10000;
  return {
    model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
    effort: { level: 'high' },
    fast_mode: true,
    context_window: {
      context_window_size: 1000000,
      used_percentage: s.pct,
      current_usage: { input_tokens: 2000, cache_creation_input_tokens: 12000, cache_read_input_tokens: used - 14000, output_tokens: 2100 },
    },
    prompt_cache: { caching_observed: true, warm: s.warm, expires_at: s.warm ? now + s.cacheLeft : now - 60, hit_ratio: 0.98, misses: 1, recache_tokens_if_cold: used },
    rate_limits: {
      five_hour: { used_percentage: s.five, resets_at: now + 9000 },
      seven_day: { used_percentage: s.week, resets_at: now + 190000 },
    },
    cost: { total_cost_usd: s.cost, total_duration_ms: 3900000, total_lines_added: 120, total_lines_removed: 34 },
    cwd,
  };
}

function schemaFor(spec) {
  const s = { description: spec.desc };
  if ('default' in spec) s.default = spec.default;
  switch (spec.type) {
    case 'number':
    case 'integer':
      s.type = spec.type;
      if (spec.min != null) s.minimum = spec.min;
      if (spec.max != null) s.maximum = spec.max;
      break;
    case 'color':
      s.type = 'string';
      s.anyOf = [{ enum: Object.keys(PALETTE) }, { pattern: '^#[0-9a-fA-F]{6}$', format: 'color-hex' }, { description: 'A name defined under "colors"' }];
      break;
    case 'list':
      Object.assign(s, { type: 'array', items: { enum: spec.items }, uniqueItems: true });
      break;
    default:
      s.type = spec.type;
  }
  return s;
}

function toSchema() {
  const optionProps = (id) => Object.fromEntries(Object.entries(SPEC.segments[id].options).map(([k, o]) => [k, schemaFor(o)]));
  const ids = Object.keys(SPEC.segments);
  const entry = {
    anyOf: [
      { enum: ids, description: 'A segment id' },
      ...ids.map((id) => ({
        type: 'object',
        description: `${SPEC.segments[id].desc} Options set here apply to this placement only.`,
        required: ['id', ...Object.entries(SPEC.segments[id].options).filter(([, o]) => o.required).map(([k]) => k)],
        properties: { id: { const: id }, ...optionProps(id) },
        additionalProperties: false,
      })),
    ],
  };
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: SCHEMA_URL,
    title: 'claudeStatusLine config',
    description: 'Layout and options for claudeStatusLine. Every key is optional and merges over the built-in defaults.',
    type: 'object',
    additionalProperties: false,
    properties: {
      $schema: { type: 'string' },
      ...Object.fromEntries(Object.entries(SPEC.settings).map(([k, o]) => [k, schemaFor(o)])),
      lines: {
        description: 'One list per output line, naming segments in order. An entry is a segment id, or {"id": ..., options} to override options in that one place.',
        default: SPEC.lines,
        type: 'array',
        items: { type: 'array', items: entry },
      },
      segments: {
        description: 'Default options per segment id.',
        type: 'object',
        additionalProperties: false,
        properties: Object.fromEntries(
          ids.map((id) => [id, { description: SPEC.segments[id].desc, type: 'object', additionalProperties: false, properties: optionProps(id) }])
        ),
      },
      colors: {
        description: 'Palette overrides as #rrggbb. New names can be used as a command segment color.',
        type: 'object',
        properties: Object.fromEntries(Object.entries(PALETTE).map(([k, v]) => [k, { type: 'string', format: 'color-hex', pattern: '^#[0-9a-fA-F]{6}$', default: v }])),
        additionalProperties: { type: 'string', format: 'color-hex', pattern: '^#[0-9a-fA-F]{6}$' },
      },
      icons: {
        description: 'Icon overrides. Defaults are Nerd Font glyphs.',
        type: 'object',
        additionalProperties: false,
        properties: Object.fromEntries(Object.entries(ICONS).map(([k, v]) => [k, { type: 'string', default: v }])),
      },
    },
  };
}

// --check: validates the config file and previews it in all three sample scenarios. Exits 1 on problems.
function check(file) {
  const { cfg, problems } = loadConfig(file);
  const exists = fs.existsSync(file);
  const out = [`${file}${exists ? '' : ' (not found, using defaults)'}`];
  if (problems.length) out.push(...problems.map((p) => paint(PALETTE.red, `  ✗ ${p}`)));
  else out.push(paint(PALETTE.green, '  ✓ valid'));
  for (const scenario of ['typical', 'warning', 'handoff']) {
    out.push('', paint(PALETTE.dim, `${scenario}:`), render(samplePayload(scenario), cfg, { preview: true }));
  }
  process.stdout.write(out.join('\n') + '\n');
  process.exitCode = problems.length ? 1 : 0;
}

function main() {
  const { cfg, problems } = loadConfig();
  let d;
  try {
    d = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch (e) {
    process.stdout.write(paint(C.red, `statusLine: bad input (${e.message})`));
    return;
  }
  process.stdout.write(render(d, cfg, { problems }));
}

module.exports = { SPEC, DEFAULTS, PALETTE, ICONS, CONFIG_FILE, SCHEMA_URL, validate, resolveConfig, render, samplePayload, toSchema };

if (require.main === module) {
  const [flag, arg] = process.argv.slice(2);
  try {
    if (flag === '--schema') process.stdout.write(JSON.stringify(toSchema(), null, 2) + '\n');
    else if (flag === '--check') check(arg ? path.resolve(arg) : CONFIG_FILE);
    else main();
  } catch (e) {
    process.stdout.write(`statusLine error: ${e.message}`);
  }
}
