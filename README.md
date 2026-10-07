# claudeStatusLine

A two-line [Claude Code](https://docs.claude.com/en/docs/claude-code/statusline) status line, tuned for handoff-based session management: instead of letting a session compact, you hand off to a fresh one once context reaches a target. Single Node script, no dependencies. Colors are [Tokyo Night](https://github.com/folke/tokyonight.nvim).

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

Segments with no data are omitted.

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

| Env var | Default | Effect |
| --- | --- | --- |
| `HANDOFF_PCT` | `60` | Context percentage at which to hand off. The warning threshold is 15 points below it |

Per-turn context history is kept in `$TMPDIR/claudeStatusLine/<session>.json`, since each status refresh runs as a separate process.

## Try it

Pipe a status payload in to preview the output without Claude Code:

```sh
echo '{"model":{"id":"claude-opus-5-5","display_name":"Opus 5.5"},"effort":{"level":"high"},"context_window":{"context_window_size":1000000,"used_percentage":31,"current_usage":{"input_tokens":2000,"cache_creation_input_tokens":12000,"cache_read_input_tokens":296000,"output_tokens":2100}},"cost":{"total_cost_usd":4.12,"total_duration_ms":3900000},"cwd":"."}' | node statusLine.js
```

## License

[MIT](LICENSE)
