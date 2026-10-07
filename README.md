# claude-cache-guard

A [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) that keeps the prompt
cache warm while you are away and asks before a prompt that would re-cache a large conversation.
The Claude Code port of [pi-cache-guard](https://github.com/justmytwospence/pi-cache-guard), with
the same core (`hooks/core.ts`) and settings file.

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
- **Size:** on the 1h tier of Opus 5.5 that works out to about 15k tokens of context or more.
- **For how long:** refreshes stop 2 hours (1h tier) or 30 minutes (5m tier) after the last real
  request.
- **On a miss:** a refresh that reads less than 80% of the prefix from the cache stops the
  keep-warm until the next turn.
- **In the transcript:** each refresh logs a line such as `kept the prompt cache warm (601k tokens
  read, ~$0.12 at API prices)`. The model never sees these lines.

**Warns.** A prompt you type while idle onto an expired cache asks first when the rewrite would
cost at least `warn.minCost` (default $0.50 at API prices):

```
Prompt cache miss. The prompt cache expired 10m ago: this prompt re-caches 601k tokens (~$4.69 at API prices). Send it anyway?
1. Keep the prompt   2. Send anyway
```

`Keep the prompt` (the default, also on Esc) drops the submission and puts the text back in the
prompt box. Resumed and forked sessions are judged from the transcript, or from the SessionStart
hook input (`seconds_since_last_response`, `context_tokens`) when the transcript is not written
yet. Prompts from loops, peers, notifications, the SDK and `-p` are never held, and neither are
slash commands.

**Status.** Claude Code reports the cache to the status line itself (`prompt_cache.warm`,
`expires_at`, `ttl`, `recache_tokens_if_cold`). A mod cannot ship a status line, so the countdown
belongs in your status line script, e.g. `jq '.prompt_cache.expires_at'`. The mod draws none.

Claude Code's own guards stay in place: `/model` and `/effort` ask while the cache is warm, and
`/resume` offers to resume from a summary after a long break.

## Commands

- `/cache-guard` or `/cache-guard status`: the last request, TTL and its source, time left or how
  long since it expired, and the keep-warm state.
- `/cache-guard warm`: a refresh now, whatever the schedule and the expected saving say. Use it to
  bridge a break, or to check that refreshes hit.
- `/cache-guard on`, `/cache-guard off`: for this session.

## Settings

`~/.config/agents/cache-guard.json` (shared with the other ports), then `~/.claude/cache-guard.json`,
then the project's `.agents/cache-guard.json` and `.claude/cache-guard.json`. Later files win;
objects merge.

```json
{
  "enabled": true,
  "warn": { "enabled": true, "minCost": 0.5 },
  "warm": { "enabled": true, "continuationProbability": 0.15, "minSavings": 0.05,
            "idleMinutes": { "5m": 30, "1h": 120 },
            "prompt": "Cache keep-alive. Do not use tools or think. Reply with exactly: ok" }
}
```

## Install

It is a plugin directory with a hooks module. Load it with `claude --plugin-dir <checkout>`, or list
it in `CLAUDE_CODE_PLUGIN_DIRS`. It needs Claude Code 2.1.287 or newer and was tested with 2.1.289.

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

## Development

```sh
claude plugin validate .   # static analysis of the hooks module
claude plugin test         # tests/, no session or network
tsc -p .                   # after one load, which writes .claude-plugin/types/
```
