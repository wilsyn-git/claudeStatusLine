# claudeStatusLine

One-file Claude Code status line (`statusLine.js`). The README covers the segments, install, and a sample payload.

## The working copy is live

`~/.claude/statusLine.js` is a symlink to `statusLine.js` in this checkout, so every save renders in every open Claude session on its next refresh, whatever branch is checked out. A broken save blanks the status line everywhere, including in the session making the edit.

- Make multi-step changes in a scratch copy outside the repo and move it in once it passes the gate below.
- **Gate** (there is no test suite), run before moving a change in and before every commit:
  1. `node --check statusLine.js`
  2. Pipe the README's "Try it" payload through it, adding `| sed 's/\x1b\[[0-9;]*m//g'` to strip color. Extend the payload with whatever your change reads (`prompt_cache`, `rate_limits`, `cost`, `session_id`), because a segment with no data is omitted and a broken one can look identical to an empty one.

## Input contract

Claude Code pipes the status JSON on stdin; its schema is documented at https://docs.claude.com/en/docs/claude-code/statusline. Treat every field as optional: read with `?.` and `??`, and have a segment function return `null` when its data is missing. `main` filters out the nulls.

## Segments and config

- A segment is a function `(ctx, opts) => string | null` registered in `SEGMENTS`. `ctx` carries the payload (`d`), merged config (`cfg`), `now`, `cwd` and a per-refresh `memo`; `opts` is that segment's entry in `DEFAULTS.segments`, merged with the user's config and any inline options from `lines`.
- Adding a segment means a function, a `SEGMENTS` entry, its default options in `DEFAULTS.segments`, and a row in the README's segments table.
- User config is `~/.claude/statusLine.json` (or `$STATUSLINE_CONFIG`), outside the repo. `loadConfig` must never throw: bad config falls back to defaults plus a `cfg` warning. Gate config changes by pointing `STATUSLINE_CONFIG` at a scratch file.

## Constraints

- Node built-ins only: the install is a symlink, with no `npm install` step.
- All output goes through one `process.stdout.write`. Failures surface as a one-line message from the `try` around `main()`.
- It runs on every refresh, so it has to be fast. Subprocesses get a timeout, and git also gets `--no-optional-locks` (see `gitSegment`).
- Colors come from the Tokyo Night palette in `C`. Icons come from `I`, using only the Nerd Font Font Awesome 4 (`U+F000–F2E0`) and Powerline (`U+E0A0–E0D4`) ranges, the ones that are stable across Nerd Font v2 and v3.

## Handoff model

The design goal is handing a session off to a fresh one, not compacting it. `handoffPct` (config, default 60, overridden by the `HANDOFF_PCT` env var) is the handoff point, and warnings start `warnBelow` (default 15) points below it. Turn estimates come from per-session state in `$TMPDIR/claudeStatusLine/<session>.json`, because each refresh is a separate process. That state resets when context shrinks (compact, clear, or rewind).
