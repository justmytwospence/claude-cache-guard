# claude-cache-guard

A [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) that keeps the prompt
cache warm while you are away, asks before a prompt that would re-cache a large conversation, and,
with [Jev](https://docs.typesafe.ai) (TypeSafe's fast judgment model), keeps the context lean: large
tool output is trimmed to what the agent needs, and a conversation compacts in about a second.
Everything but the Jev parts works without Jev.

The Claude Code port of [pi-cache-guard](https://github.com/justmytwospence/pi-cache-guard), with
the same core (`hooks/core.ts`, the clock and the settings), the same Jev logic (`hooks/lean.ts`,
the trimming and compaction, with no harness imports) and the same settings file.

## What it does

**Keeps the cache warm.** A cached prefix lives for its TTL from the start of the last request
that used it: 1 hour for the main conversation on a Claude subscription within plan usage, 5
minutes with an API key, a cloud provider or usage credits. The mod reads the tier off the
session's own cache writes in the transcript. At 90% of the TTL with no request since, it calls
`$.model.fork`, which re-sends the main thread's last request (same model, system prompt, tools and
messages) with one short question after it, tools denied and its own tail never cached. The API
serves the prefix from the cache, which restarts its clock.

Each refresh has to pay for itself by Pi's rule:

- **When:** the expected saving must be at least $0.05. While you are idle that saving is
  `15% x miss cost - refresh cost`; during a long tool run it is the whole miss cost.
- **Size:** on the 1h tier of Opus 5.5 that works out to about 52k tokens of context or more.
- **For how long:** refreshes stop 2 hours (1h tier) or 30 minutes (5m tier) after the last real
  request.
- **On a miss:** a refresh that reads less than 80% of the prefix from the cache stops the
  keep-warm until the next turn.
- **In the transcript:** each refresh logs a line such as `kept the prompt cache warm (601k tokens
  read, ~$0.12 at API prices)`. The model never sees these lines.

**Warns.** A prompt you type while idle onto an expired cache asks first when the rewrite would
cost at least `warn.minCost` (default $0.50 at API prices):

```
Prompt cache miss. The prompt cache expired 10m ago: this prompt re-caches 601k tokens (~$4.69 at API prices). What now?
1. Keep the prompt
2. New conversation (~$0)
3. Compact first (~$0 with Jev)
4. Send anyway (~$4.81)
```

The options:

- **Keep the prompt.** The default, so Enter or Esc spends nothing. It drops the submission and
  puts the text back in the prompt box.
- **New conversation.** Runs `/clear` and sends the prompt as the new conversation's first.
- **Compact first.** Asks how (the dialog takes four options, so the compactions share one):
  - **Compact with Jev (~1s, ~$0)**, when Jev is set up. Jev judges every message and tool call
    against the held prompt, and the summary is written in code from its choices: no LLM reads the
    history, so it takes about a second and costs next to nothing. If Jev fails, nothing is
    compacted and the prompt goes back in the box with the reason.
  - **Compact with a summary**, or **a summary focused on this prompt** (keep what it needs, drop
    the rest), or your own guidance typed under "Type something" (**Default summary** and **Focus on
    this prompt** without Jev). Compacting reads the history once, at input price instead of a
    cache write; with Jev it reads only what Jev did not drop, so the price shown is an upper bound
    (`up to ~$2.40`). It then sends the prompt onto the summary. If the compaction is skipped or
    fails, the prompt goes back in the box.
- **Send anyway.**

Without Jev the question ends with a tip: `/cache-guard jev` sets it up, or turns it (and the tip)
off.

The headline cost is what the miss adds over a cache hit; the costs in the options are each path's
total. Images attached to a held prompt are not resent by the New conversation and Compact paths.
`/cache-guard off` stops asking in the session. Resumed and forked sessions are judged from the transcript, or from the SessionStart
hook input (`seconds_since_last_response`, `context_tokens`) when the transcript is not written
yet. Prompts from loops, peers, notifications, the SDK and `-p` are never held, and neither are
slash commands.

**Trims tool output (Jev).** Large text results (over 12k characters from `Bash`, `Grep`, `Glob`,
`LS`, `WebFetch`, `WebSearch` and MCP tools; over 50k from `Read`) are trimmed as their row is
stored (`session.append`), before the model reads them, so the prompt cache is never disturbed.
Jev reads the agent's current step (your request, what the agent said since, the tool and its
arguments) and the output, split into at most 150 blocks, and says which blocks hold what the
agent needs: errors, failures, warnings, requested values, results. The kept blocks plus the
first 5 and last 20 lines stay, in order, with `[… N lines omitted …]` markers, and a footer
points at the full output saved under `~/.claude/cache-guard/tool-output/<session>/<call>.txt`
(under `$CLAUDE_CONFIG_DIR` when set), to read with `offset`/`limit`. The output is saved first;
if that fails it stays whole.

Output too large for one Jev request is pre-filtered in code first (head, tail, every line that
looks like an error with two lines of context, and an even sample). Nothing is trimmed when Jev
thinks the agent wants the whole output, when more than 70% would be kept, when the same tool and
arguments were already trimmed this turn (asking again returns everything), when the tool reported
an error, or when Jev is unavailable or slow (`jev.timeoutMs`, 2.5 s). Edits, writes, agents,
todos and every other tool are never touched. Each trim logs a dim line (`trimmed Bash output to
23 of 1,104 lines (Jev, 412 ms); full output: ...`); `/cache-guard status` shows the tokens kept
out so far.

Subagents are left alone: their tool output never enters the main conversation (the Agent tool
returns their answer), and their transcripts go when they finish. Only the main loop's results are
trimmed.

**Compacts with Jev.** Jev sorts every message and tool call being compacted into *verbatim*
(requirements, decisions, exact values, open errors), *summarize*, or *drop* (superseded or noise),
in batches of up to 120, `compact.concurrency` requests at a time.

- **The cold-cache menu and `/cache-guard compact [focus]`** write the summary in code, with no
  LLM, in about a second: the earlier summary (Claude Code's or Jev's, when the conversation
  starts with one), your requests, the verbatim items, one-line notes for the rest, and the files
  read and modified. The conversation becomes that one message. Strict: if Jev fails, the
  compaction is skipped and nothing is spent.
- **`/compact` and automatic compaction** run Claude Code's own summarizer on the conversation
  with dropped items removed and summarized ones shortened (user text to 1.5k characters,
  assistant text to 1k, tool results to 600), then add the verbatim items as one more message after
  the summary (`"compact": { "filter": false }` leaves them to Claude Code alone). Any failure
  falls back to the normal compaction.
- A `precompute` compaction (the engine summarizing ahead of time) and a subagent's own are never
  touched.

**Status.** Claude Code reports the cache to the status line itself (`prompt_cache.warm`,
`expires_at`, `ttl`, `recache_tokens_if_cold`). A mod cannot ship a status line, so the countdown
belongs in your status line script, e.g. `jq '.prompt_cache.expires_at'`. The mod draws none.

**Tells herdr.** Inside a [herdr](https://herdr.dev) pane, the mod sets the pane token `cache`
with `herdr pane report-metadata --source cache-guard`. The token reads `cold 601k` once the cache
has expired and the next prompt would re-cache at least the warning threshold. It is cleared while
the cache is warm or small, and when the session ends. An expiry timer flips it on time.
herdr's agents sidebar shows it with `{ token = "$cache" }` in a `[ui.sidebar.agents]` row. Set
`"herdr": { "enabled": false }` to turn it off.

Claude Code's own guards stay in place: `/model` and `/effort` ask while the cache is warm, and
`/resume` offers to resume from a summary after a long break.

## Setting up Jev

Claude Code reaches Jev through TypeSafe's own API (`https://api.typesafe.ai/v1/systemone`, via
`$.http.fetch`), so it needs a TypeSafe API key from
[console.typesafe.ai/keys](https://console.typesafe.ai/keys). Give it either way; the plugin
option wins:

- The plugin option `typesafe_api_key`. It is declared sensitive, so Claude Code keeps the value in
  secure storage (the keychain), not in settings.json. Set it with `/plugin configure
  cache-guard@inline` in Claude Code (`cache-guard@<marketplace>` when installed from one), or from
  a shell:

  ```sh
  echo '{"typesafe_api_key": "<key>"}' | claude plugin configure cache-guard@inline --values-stdin
  ```

  A mod cannot set a sensitive option itself (`$.config.set` only reaches the `/config` rows, which
  leave sensitive fields out), so `/cache-guard jev` shows these steps instead of asking for the
  key. The option is read when the mod loads: restart Claude Code after setting it.
- `TYPESAFE_API_KEY` in the environment Claude Code starts in.

`/cache-guard jev` shows which key is in use and checks that Jev answers (`Jev: typesafe/jev-latest
(key from TYPESAFE_API_KEY), answered in 312 ms.`), and can turn Jev off. With no key it explains
the setup and offers to turn Jev off, tips included. Its choice is saved as `jev.enabled` in
`~/.claude/cache-guard.json` (merged into the file; a file that is not a JSON object is left
alone). `jev.model` picks the model (`jev-latest` when empty); `jev.provider` must be empty or
`typesafe` here (the other ports can reach Jev through other providers; this one reports any other
value as "not set up").

## Commands

- `/cache-guard` or `/cache-guard status`: the last request, TTL and its source, time left or how
  long since it expired, the keep-warm state, and which Jev is in use.
- `/cache-guard warm`: a refresh now, whatever the schedule and the expected saving say. Use it to
  bridge a break, or to check that refreshes hit.
- `/cache-guard compact [focus]`: a Jev compaction now, judged against the focus (or your last two
  requests). Without Jev it offers Claude Code's summary instead.
- `/cache-guard jev`: set up, check, or turn off Jev.
- `/cache-guard on`, `/cache-guard off`: the keep-warm and the warning, for this session. Trimming
  and compaction follow the settings.

## Settings

`~/.config/agents/cache-guard.json` (shared with the other ports), then `~/.claude/cache-guard.json`,
then the project's `.agents/cache-guard.json` and `.claude/cache-guard.json`. Later files win;
objects merge. The files are read again at every turn. The defaults, as this port reads them:

```json
{
  "enabled": true,
  "warn": { "enabled": true, "minCost": 0.5 },
  "warm": { "enabled": true, "continuationProbability": 0.15, "minSavings": 0.05,
            "idleMinutes": { "5m": 30, "1h": 120 },
            "prompt": "Cache keep-alive. Do not use tools or think. Reply with exactly: ok" },
  "herdr": { "enabled": true },
  "jev": { "enabled": true, "provider": "", "model": "", "timeoutMs": 2500 },
  "trim": { "enabled": true, "minChars": 12000, "readMinChars": 50000, "maxBlocks": 150, "stateBudgetChars": 60000,
            "keepThreshold": 0.4, "needsAllThreshold": 0.6, "maxKeptShare": 0.7, "headLines": 5, "tailLines": 20 },
  "compact": { "filter": true, "timeoutMs": 10000, "concurrency": 4 }
}
```

`warn.minTokens`, `warn.confirmSeconds` and `warn.idleMinutes` are for the other ports (Claude
Code always has prices and a TTL). `"enabled": false` turns everything off, Jev included;
`"jev": { "enabled": false }` only the Jev parts.

## Install

It is a plugin directory with a hooks module. Load it with `claude --plugin-dir <checkout>`, or list
it in `CLAUDE_CODE_PLUGIN_DIRS`. It needs Claude Code 2.1.287 or newer; the Jev parts use
`session.append`, `session.compact` and `$.http.fetch` as Claude Code 2.1.289 declares them.

## Limits

- **First turn:** a fork right after a session's first response reads only the system prompt and
  tools from the cache, not the messages. This is likely because the fork merges into the
  conversation's only user message. From the second response on, a refresh reads the whole prefix.
  Measured: 42k of 42k tokens, about $0.01 on Sonnet 5.5.
- **Plan usage:** refreshes count against your plan like any other request. On the 1h tier they are
  rare: at most two per break with the defaults.
- **The clock:** it is the API's guaranteed minimum, measured from each request's start; entries are
  deleted soon after, not exactly then. Changes to the system prompt or tools, model switches and
  compaction also invalidate the cache. Claude Code's `prompt_cache.last_miss_cause` reports those;
  this mod only judges time.
- **Prices:** list prices of the Claude models, by model-id prefix (`hooks/core.ts`). Unknown models
  are priced as Opus 5.5.
- **A Jev summary is assembled, not written:** the requests, the items Jev kept word for word and a
  line for the rest. Claude Code's summary reads better when the history needs explaining.
- **Compaction runs as `/compact`:** a plugin's own `$.session.compact` skips its own hooks, so the
  mod runs `/compact` through `$.command.run` and answers (or filters) the compaction in its
  `session.compact` hook. Another plugin answering `session.compact` first would take the Jev
  compaction's place; the mod then reports that the compaction did not reach it and spends nothing.
- **Jev's timeouts** are measured by the mod (`$.http.fetch` has none): a slow request is given up
  on, not cancelled.
- **Trimming judges what the row stores**, which is what the model reads; a result Claude Code
  already shortened (a persisted large output) is trimmed as shown.

## Development

```sh
claude plugin validate .   # static analysis of the hooks module
claude plugin test         # tests/, no session or network (Jev is stubbed)
tsc -p .                   # after one load, which writes .claude-plugin/types/
```

`hooks/core.ts` and `hooks/lean.ts` are copied verbatim from pi-cache-guard; change them there.
`hooks/jev.ts` (the HTTP translation) and `hooks/units.ts` (Claude Code's transcript in and out of
`lean.ts`) are pure; every `$` call is in `hooks/register.ts`, as the host requires.
