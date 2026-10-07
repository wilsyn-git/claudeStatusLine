# claudeStatusLine

A configurable [Claude Code](https://docs.claude.com/en/docs/claude-code/statusline) status line, tuned for handoff-based session management: instead of letting a session compact, you hand off to a fresh one once context reaches a target. Single Node script, no dependencies. Colors are [Tokyo Night](https://github.com/folke/tokyonight.nvim).

```
 Opus 5.5 · high │ ▰▰▰▱▱▱▱▱▱▱ 31% 310k/1M │  290k │ ↑14k ↓2.1k  296k
 52m 98% hit │  5h 34% wk 61% ↻2d3h │ $4.12 $3.8/h │  main ●3 +120 −34
```

## What it shows

**Line 1 — model and context**

| Segment | Meaning |
| --- | --- |
| Model · effort | Model name (colored by family), reasoning effort, and a bolt when fast mode is on |
| Context bar | Context used vs. window size; turns yellow at `HANDOFF_PCT − 15` and red at `HANDOFF_PCT`. `+N` is this turn's growth |
| Handoff | Tokens left before the handoff target, and an estimate of turns left based on the average growth of the last 10 turns. Shows **handoff now** once past it |
| Token mix | Last request: `↑` newly processed input (uncached + cache write), `↓` output, cache read |

**Line 2 — cost and environment**

| Segment | Meaning |
| --- | --- |
| Prompt cache | Time until the cache expires (or **cold** plus the tokens a re-cache would bill), hit ratio, misses |
| Plan limits | 5-hour and weekly usage; reset countdown appears at 50% and above |
| Cost | Session cost and burn rate per hour (after the first 5 minutes) |
| Git | Branch, dirty file count, ahead/behind, and lines added/removed this session |

Segments with no data are omitted. Which segments appear, on which line and in what order, is [configurable](#configuration).

## Install

Requires Node and a [Nerd Font](https://www.nerdfonts.com/) in your terminal.

```sh
git clone https://github.com/wilsyn-git/claudeStatusLine.git ~/code/claudeStatusLine
~/code/claudeStatusLine/install.sh
```

`install.sh` symlinks `statusLine.js` to `~/.claude/statusLine.js`, then prints the `statusLine` block to add to `~/.claude/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "node ~/.claude/statusLine.js",
  "padding": 0
}
```

Because it's a symlink, `git pull` updates the live status line.

## Configuration

With no config file you get the layout shown above. To change it, create `~/.claude/statusLine.json` (or point `STATUSLINE_CONFIG` at another path). It lives outside the repo, so `git pull` never touches it. Every key is optional and merges over the built-in defaults: objects merge key by key, while arrays and scalars replace the default.

### Editing the config

- **Visual editor:** `node ~/code/claudeStatusLine/configure.js` opens a page in your browser. Drag segments between lines, change options and colors, and watch a live preview in your Nerd Font across three sample sessions (comfortable, near handoff, past handoff). Save validates first and keeps the previous file as `statusLine.json.bak`. It only listens on 127.0.0.1, behind a per-run token, and the preview never runs `command` segments, so a half-typed command can't execute.
- **In your editor:** keep the `"$schema"` line (the visual editor adds it on save) and VS Code or any JSON Schema-aware editor autocompletes segment ids and options, shows what each one does, and flags bad values as you type.
- **From the terminal:** `node statusLine.js --check [file]` lists every problem with its path (`segments.context: unknown option "barcells", did you mean "barCells"?`) and previews the result. It exits 1 when there are problems.

The live status line validates too: a problem shows as a red **cfg** warning on line 1 instead of being silently ignored.

### Reference

```json
{
  "$schema": "https://raw.githubusercontent.com/wilsyn-git/claudeStatusLine/main/statusLine.schema.json",
  "handoffPct": 50,
  "separator": " │ ",
  "lines": [
    ["model", "context", "handoff"],
    [{ "id": "limits", "windows": ["5h"] }, "cost", "git",
     { "id": "command", "cmd": "kubectl config current-context", "icon": "⎈", "color": "cyan" }]
  ],
  "segments": {
    "git": { "lineDelta": false }
  },
  "colors": { "red": "#ff5555" },
  "icons": { "branch": "⎇" }
}
```

| Key | Default | Effect |
| --- | --- | --- |
| `handoffPct` | `60` | Context percentage at which to hand off. The `HANDOFF_PCT` env var overrides it |
| `warnBelow` | `15` | Context turns yellow this many points below `handoffPct` |
| `separator` | `" │ "` | Text between segments |
| `lines` | the two lines above | One array per output line, listing segments in order. An entry is a segment id, or `{ "id": …, …options }` to override that segment's options in that one place |
| `segments` | see below | Default options per segment id |
| `colors` | Tokyo Night | Override palette entries (`fg`, `dim`, `blue`, `cyan`, `purple`, `green`, `yellow`, `orange`, `red`, `teal`, `magenta`) with `#rrggbb` values |
| `icons` | Nerd Font glyphs | Override icons (`model`, `fast`, `flag`, `warn`, `clock`, `cache`, `gauge`, `branch`). Write Nerd Font glyphs as `"\uf2db"` escapes to keep them visible in any editor |

**Segments and their options**

| Id | Options (defaults) |
| --- | --- |
| `model` | `effort` (true), `fast` (true) |
| `context` | `barCells` (10), `turnDelta` (true) |
| `handoff` | `turnEstimate` (true) |
| `tokens` | none |
| `cache` | `hitRatio` (true), `misses` (true) |
| `limits` | `windows` (`["5h", "wk"]`), `showResetAbove` (50), `warn` (50), `bad` (80) |
| `cost` | `burnRate` (true), `burnRateAfterMin` (5) |
| `git` | `lineDelta` (true), `timeoutMs` (500) |
| `command` | `cmd` (required), `icon`, `color` (`"fg"`: a palette name or `#rrggbb`), `timeoutMs` (300), `cacheSec` (30) |

`command` runs `cmd` through your shell in the session's directory and shows the first line of output. Its result, including a failure or timeout, is cached for `cacheSec`, so a slow command runs at most once per interval. Use it more than once with different inline options to add several custom segments.

When something is wrong in the config, the status line still renders: a broken file falls back to the defaults, any problem adds a red **cfg** warning to line 1, an unknown segment id shows as `?id`, and a segment that throws shows as `!id`.

Per-turn context history is kept in `$TMPDIR/claudeStatusLine/<session>.json`, and `command` results in `$TMPDIR/claudeStatusLine/cmd-*.json`, since each status refresh runs as a separate process.

## Try it

Pipe a status payload in to preview the output without Claude Code:

```sh
echo '{"model":{"id":"claude-opus-5-5","display_name":"Opus 5.5"},"effort":{"level":"high"},"context_window":{"context_window_size":1000000,"used_percentage":31,"current_usage":{"input_tokens":2000,"cache_creation_input_tokens":12000,"cache_read_input_tokens":296000,"output_tokens":2100}},"cost":{"total_cost_usd":4.12,"total_duration_ms":3900000},"cwd":"."}' | node statusLine.js
```

## License

[MIT](LICENSE)
