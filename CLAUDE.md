# claudeStatusLine

One-file Claude Code status line (`statusLine.js`). The README covers the segments, install, and a sample payload.

## The working copy is live

`~/.claude/statusLine.js` is a symlink to `statusLine.js` in this checkout, so every save renders in every open Claude session on its next refresh, whatever branch is checked out. A broken save blanks the status line everywhere, including in the session making the edit.

- Make multi-step changes in a scratch copy outside the repo and move it in once it passes the gate below.
- **Gate** (there is no test suite), run before moving a change in and before every commit:
  1. `node --check statusLine.js`
  2. Pipe the README's "Try it" payload through it, adding `| sed 's/\x1b\[[0-9;]*m//g'` to strip color. Extend the payload with whatever your change reads (`prompt_cache`, `rate_limits`, `cost`, `session_id`), because a segment with no data is omitted and a broken one can look identical to an empty one. `node statusLine.js --check` previews all three sample scenarios with every field filled in.
  3. If `SPEC` changed, regenerate the schema: `node statusLine.js --schema > statusLine.schema.json`.

## Input contract

Claude Code pipes the status JSON on stdin; its schema is documented at https://docs.claude.com/en/docs/claude-code/statusline. Treat every field as optional: read with `?.` and `??`, and have a segment function return `null` when its data is missing. `main` filters out the nulls.

## Segments and config

- A segment is a function `(ctx, opts) => string | null` registered in `SEGMENTS`. `ctx` carries the payload (`d`), merged config (`cfg`), `now`, `cwd`, `preview` and a per-refresh `memo`; `opts` is that segment's shared options merged with any inline options from `lines`.
- `SPEC` is the single source for every setting's type, default and description. `DEFAULTS`, `validate`, `--schema` and the configurator's forms are all derived from it, so adding a segment means a function, a `SEGMENTS` entry, a `SPEC.segments` entry, a row in the README's segments table, and a regenerated schema. The configurator's display name and chip color live in `NAMES`/`CHIP_COLOR` in `configure.html`.
- User config is `~/.claude/statusLine.json` (or `$STATUSLINE_CONFIG`), outside the repo. `loadConfig` must never throw: bad config falls back to defaults plus a `cfg` warning. Gate config changes by pointing `STATUSLINE_CONFIG` at a scratch file.
- `statusLine.js` is also a module: `configure.js` requires it for `SPEC`, `validate` and `render`, so top-level code must stay side-effect free (CLI work is behind `require.main === module`).
- Width fitting lives in `layout`/`fitLine`: segments render first, then lines wider than `COLUMNS − widthReserve` drop by `priority` (a universal option added to every segment from `SPEC.segments[id].priority`). Anything that adds escape sequences must keep `ESCAPES` and `visibleWidth` in sync, or widths and `truncate` go wrong. Test fitting with `COLUMNS=N` on the gate command, or `--check --width N`.
- Segments must honor `ctx.preview`: the configurator and `--check` render unsaved config, so nothing that runs user input (like `command`) may execute in preview.

## Configurator

`configure.js` serves `configure.html` on 127.0.0.1 and is not on the hot path, so it can be slower and bigger. Every API call needs the per-run token and a loopback Host header, because a saved `command` segment runs on every refresh. Check UI changes in a browser in light and dark mode and at phone width, pointing `STATUSLINE_CONFIG` at a scratch copy so the real config isn't touched.

## Constraints

- Node built-ins only: the install is a symlink, with no `npm install` step.
- All output goes through one `process.stdout.write`. Failures surface as a one-line message from the `try` around `main()`.
- It runs on every refresh, so it has to be fast. Subprocesses get a timeout, and git also gets `--no-optional-locks` (see `gitSegment`).
- Colors come from the Tokyo Night palette in `PALETTE`. Icons come from `ICONS`, written as `\uXXXX` escapes (raw private-use glyphs get lost by editing tools), using only the Nerd Font Font Awesome 4 (`U+F000–F2E0`) and Powerline (`U+E0A0–E0D4`) ranges, the ones that are stable across Nerd Font v2 and v3.

## Handoff model

The design goal is handing a session off to a fresh one, not compacting it. `handoffPct` (config, default 60, overridden by the `HANDOFF_PCT` env var) is the handoff point, and warnings start `warnBelow` (default 15) points below it. Turn estimates come from per-session state in `$TMPDIR/claudeStatusLine/<session>.json`, because each refresh is a separate process. That state resets when context shrinks (compact, clear, or rewind).
