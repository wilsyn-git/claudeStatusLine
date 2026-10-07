#!/usr/bin/env node
// Claude Code status line. Reads the status JSON Claude Code pipes on stdin and prints two lines:
//   1. model · effort │ context bar vs. handoff target │ room/turns to handoff │ token mix
//   2. prompt cache │ plan limits │ cost │ git
// Context thresholds are keyed to HANDOFF_PCT (default 60): refresh the session there instead of compacting.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HANDOFF_PCT = Number(process.env.HANDOFF_PCT) || 60;
const WARN_PCT = HANDOFF_PCT - 15;
const BAR_CELLS = 10;
const HISTORY_TURNS = 10;
const STATE_DIR = path.join(os.tmpdir(), 'claudeStatusLine');

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

function paint(hex, text, bold = false) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `\x1b[${bold ? '1;' : ''}38;2;${r};${g};${b}m${text}\x1b[0m`;
}

const SEP = paint(C.dim, ' │ ');

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

function modelSegment(d) {
  const id = d.model?.id ?? '';
  const name = (d.model?.display_name ?? id).replace(/\s*\(.*\)\s*$/, '');
  if (!name) return null;
  const color = /opus/i.test(id) ? C.purple : /sonnet/i.test(id) ? C.blue : /haiku/i.test(id) ? C.green : /fable/i.test(id) ? C.teal : C.cyan;
  let s = paint(color, `${I.model} ${name}`, true);
  const effort = d.effort?.level;
  if (effort) s += paint(C.dim, ' · ') + paint(EFFORT_COLORS[effort] ?? C.fg, effort);
  if (d.fast_mode) s += ' ' + paint(C.yellow, I.fast);
  return s;
}

function contextSegments(d) {
  const cw = d.context_window;
  if (!cw) return [];
  const size = cw.context_window_size;
  const u = cw.current_usage;
  const used = u ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) : cw.total_input_tokens ?? 0;
  const pct = cw.used_percentage ?? (size ? (used / size) * 100 : 0);
  const color = pct >= HANDOFF_PCT ? C.red : pct >= WARN_PCT ? C.yellow : C.green;

  const filled = Math.min(BAR_CELLS, Math.max(0, Math.round((pct / 100) * BAR_CELLS)));
  let ctx = paint(color, '▰'.repeat(filled)) + paint(C.dim, '▱'.repeat(BAR_CELLS - filled));
  ctx += ' ' + paint(color, `${Math.round(pct)}%`, true) + paint(C.dim, ` ${fmtTokens(used)}/${fmtTokens(size)}`);

  const { delta, avg } = turnStats(d.session_id, d.prompt_id, used);
  if (delta > 0) ctx += ' ' + paint(C.cyan, `+${fmtTokens(delta)}`);

  let handoff;
  if (pct >= HANDOFF_PCT) {
    handoff = paint(C.red, `${I.warn} handoff now`, true);
  } else if (size) {
    const room = (size * HANDOFF_PCT) / 100 - used;
    handoff = paint(pct >= WARN_PCT ? C.yellow : C.fg, `${I.flag} ${fmtTokens(room)}`);
    if (avg) handoff += paint(C.dim, ` ~${Math.floor(room / avg)} turns`);
  }

  let tokens = null;
  if (u) {
    // in = tokens newly processed this request (uncached + cache write); cached = cache read
    tokens =
      paint(C.blue, `↑${fmtTokens((u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0))}`) +
      ' ' + paint(C.purple, `↓${fmtTokens(u.output_tokens ?? 0)}`) +
      ' ' + paint(C.teal, `${I.cache} ${fmtTokens(u.cache_read_input_tokens ?? 0)}`);
  }
  return [ctx, handoff, tokens];
}

function cacheSegment(pc, now) {
  if (!pc?.caching_observed) return null;
  let hit = '';
  if (pc.hit_ratio != null) {
    const h = Math.round(pc.hit_ratio * 100);
    hit = ' ' + paint(h >= 80 ? C.green : h >= 50 ? C.yellow : C.red, `${h}%`) + paint(C.dim, ' hit');
  }
  if (pc.misses > 0) hit += ' ' + paint(C.yellow, `${pc.misses} miss`);

  if (!pc.warm || (pc.expires_at && pc.expires_at <= now)) {
    return paint(C.red, `${I.clock} cold`, true) + paint(C.dim, ' re-bill ') + paint(C.orange, fmtTokens(pc.recache_tokens_if_cold)) + hit;
  }
  if (!pc.expires_at) return paint(C.green, `${I.clock} warm`) + hit;
  const left = pc.expires_at - now;
  const color = left > 15 * 60 ? C.green : left > 5 * 60 ? C.yellow : C.orange;
  return paint(color, `${I.clock} ${fmtDuration(left)}`) + hit;
}

function limitsSegment(rl, now) {
  if (!rl) return null;
  const part = (label, limit) => {
    if (limit?.used_percentage == null) return null;
    const pct = Math.round(limit.used_percentage);
    let s = paint(C.dim, `${label} `) + paint(pctColor(pct), `${pct}%`);
    if (pct >= 50 && limit.resets_at) s += paint(C.dim, ` ↻${fmtDuration(limit.resets_at - now)}`);
    return s;
  };
  const parts = [part('5h', rl.five_hour), part('wk', rl.seven_day)].filter(Boolean);
  return parts.length ? paint(C.blue, I.gauge) + ' ' + parts.join(' ') : null;
}

function costSegment(cost) {
  if (cost?.total_cost_usd == null) return null;
  let s = paint(C.green, `$${cost.total_cost_usd.toFixed(2)}`);
  const hours = (cost.total_duration_ms ?? 0) / 3.6e6;
  // Burn rate is noise in the first few minutes
  if (hours >= 5 / 60) {
    const rate = cost.total_cost_usd / hours;
    s += paint(C.dim, ` $${rate.toFixed(rate < 10 ? 1 : 0)}/h`);
  }
  return s;
}

function gitSegment(cwd, cost) {
  if (!cwd) return null;
  let out;
  try {
    out = execFileSync('git', ['--no-optional-locks', '-C', cwd, 'status', '--porcelain=v2', '--branch'], {
      encoding: 'utf8',
      timeout: 500,
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
  const added = cost?.total_lines_added ?? 0;
  const removed = cost?.total_lines_removed ?? 0;
  if (added || removed) s += ' ' + paint(C.green, `+${added}`) + ' ' + paint(C.red, `−${removed}`);
  return s;
}

function main() {
  let d;
  try {
    d = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch (e) {
    process.stdout.write(paint(C.red, `statusLine: bad input (${e.message})`));
    return;
  }
  const now = Date.now() / 1000;
  const line1 = [modelSegment(d), ...contextSegments(d)].filter(Boolean).join(SEP);
  const line2 = [
    cacheSegment(d.prompt_cache, now),
    limitsSegment(d.rate_limits, now),
    costSegment(d.cost),
    gitSegment(d.workspace?.current_dir ?? d.cwd, d.cost),
  ]
    .filter(Boolean)
    .join(SEP);
  process.stdout.write(line2 ? `${line1}\n${line2}` : line1);
}

try {
  main();
} catch (e) {
  process.stdout.write(`statusLine error: ${e.message}`);
}
