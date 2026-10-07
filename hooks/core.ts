// cache-guard core: the prompt-cache clock, the cost of a miss, and when a keep-warm request or a
// warning pays. Shared verbatim by pi-cache-guard, claude-cache-guard, opencode-cache-guard and
// codex-cache-guard; keep it free of harness imports so each port can copy this file as is.
//
// The model is Anthropic's: a cached prefix lives for its TTL from the start of the last request
// that read or wrote it (the API guarantees that minimum and deletes soon after), and a request
// after that re-writes the whole prefix. Prices are dollars per million tokens at API list rates;
// on a subscription they stand for plan usage in the same proportions.

export const NAME = "cache-guard";

export interface Price {
  /** Uncached input. */
  input: number;
  /** A cache read (hit or refresh). */
  cacheRead: number;
  /** A 5-minute cache write; 1.25x input when absent. A 1-hour write is always 2x input. */
  cacheWrite?: number;
}

export interface Settings {
  enabled: boolean;
  warn: {
    enabled: boolean;
    /** Ask before a prompt whose re-cache costs at least this many dollars (when prices are known). */
    minCost: number;
    /** Without prices, ask when at least this many tokens would be re-sent uncached. */
    minTokens: number;
    /** Where a harness can only block, sending the same prompt again within this window sends it. */
    confirmSeconds: number;
    /** Providers that publish no TTL (OpenAI, Codex): warn after this long idle. */
    idleMinutes: number;
  };
  warm: {
    enabled: boolean;
    /** Chance a real request arrives before the entry expires while idle (Pi's measured constant). */
    continuationProbability: number;
    /** A refresh is sent only when it is expected to save at least this many dollars. */
    minSavings: number;
    /** Stop refreshing this long after the last real request, per TTL tier. */
    idleMinutes: { "5m": number; "1h": number };
    /** What a keep-warm request asks, where the harness has to send a message. */
    prompt: string;
  };
  herdr: {
    /** Report the pane token `cache` to herdr (inside a herdr pane) so its agents sidebar can show doomed sessions. */
    enabled: boolean;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  warn: { enabled: true, minCost: 0.5, minTokens: 100_000, confirmSeconds: 120, idleMinutes: 180 },
  warm: {
    enabled: true,
    continuationProbability: 0.15,
    minSavings: 0.05,
    idleMinutes: { "5m": 30, "1h": 120 },
    prompt: "Cache keep-alive. Do not use tools or think. Reply with exactly: ok",
  },
  herdr: { enabled: true },
};

/** The herdr pane token the ports report (`herdr pane report-metadata --source cache-guard`). */
export const HERDR_TOKEN = "cache";
export const HERDR_SOURCE = NAME;

export const FIVE_MINUTES = 5 * 60_000;
export const ONE_HOUR = 60 * 60_000;

/** "5m" or "1h": the tier a TTL bills as (anything from an hour up writes at 2x). */
export function tier(ttlMs: number): "5m" | "1h" {
  return ttlMs >= ONE_HOUR ? "1h" : "5m";
}

/** Refresh at 90% of the TTL, keeping at least ten seconds of margin (Pi's rule). */
export function warmDelayMs(ttlMs: number): number | undefined {
  if (ttlMs <= 10_000) return undefined;
  return Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)));
}

/** Milliseconds the entry written or refreshed at `lastAt` has left; 0 once expired. */
export function remainingMs(lastAt: number, ttlMs: number, now: number): number {
  return Math.max(0, lastAt + ttlMs - now);
}

export function writePrice(price: Price, ttlMs: number): number {
  return tier(ttlMs) === "1h" ? price.input * 2 : (price.cacheWrite ?? price.input * 1.25);
}

/** What a miss costs over a hit: the prefix written again instead of read. */
export function missCost(tokens: number, price: Price, ttlMs: number): number {
  return Math.max(0, (tokens * (writePrice(price, ttlMs) - price.cacheRead)) / 1e6);
}

/** What one refresh costs: the prefix read (plus a token or two, ignored). */
export function warmCost(tokens: number, price: Price): number {
  return (tokens * price.cacheRead) / 1e6;
}

export interface WarmDecision {
  action: "warm" | "stop";
  warmCost: number;
  missCost: number;
  expectedSavings: number;
}

/**
 * Pi's rule: refresh when `p * missCost - warmCost` is at least `minSavings`, with p = 1 while the
 * agent is still running (its next request is certain) and the idle constant otherwise.
 */
export function decideWarm(tokens: number, price: Price, ttlMs: number, idle: boolean, settings: Settings): WarmDecision {
  const miss = missCost(tokens, price, ttlMs);
  const warm = warmCost(tokens, price);
  const p = idle ? settings.warm.continuationProbability : 1;
  const expectedSavings = p * miss - warm;
  return { action: expectedSavings >= settings.warm.minSavings ? "warm" : "stop", warmCost: warm, missCost: miss, expectedSavings };
}

/** The last moment a refresh may be sent for a cache last used by a real request at `lastRealAt`. */
export function warmDeadline(lastRealAt: number, ttlMs: number, settings: Settings): number {
  return lastRealAt + settings.warm.idleMinutes[tier(ttlMs)] * 60_000;
}

/** Whether a re-cache of `tokens` (costing `cost`, when prices are known) is worth asking about. */
export function worthWarning(tokens: number, cost: number | undefined, settings: Settings): boolean {
  if (!settings.enabled || !settings.warn.enabled) return false;
  return cost !== undefined ? cost >= settings.warn.minCost : tokens >= settings.warn.minTokens;
}

export type ColdReason =
  | { kind: "expired"; idleMs: number }
  | { kind: "model"; from: string; to: string }
  | { kind: "idle"; idleMs: number };

/**
 * The herdr `cache` token: `cold 664k` (or `cold? 180k` when only idle time suggests it) while the
 * next prompt would re-cache at least the warning threshold, else undefined (clear the token).
 * Warm and small caches report nothing, so the sidebar lists only the doomed sessions.
 */
export function herdrCacheValue(reason: ColdReason | undefined, tokens: number, cost: number | undefined, settings: Settings): string | undefined {
  if (!reason || !settings.enabled || !settings.herdr.enabled) return undefined;
  const big = cost !== undefined ? cost >= settings.warn.minCost : tokens >= settings.warn.minTokens;
  if (!big) return undefined;
  return `${reason.kind === "idle" ? "cold?" : "cold"} ${formatTokens(tokens)}`;
}

/** One line saying why the next request misses and what that costs. */
export function describeMiss(reason: ColdReason, tokens: number, cost: number | undefined): string {
  const amount = `${formatTokens(tokens)} tokens${cost === undefined ? "" : ` (~${formatCost(cost)} at API prices)`}`;
  switch (reason.kind) {
    case "expired":
      return `The prompt cache expired ${formatDuration(reason.idleMs)} ago: this prompt re-caches ${amount}.`;
    case "idle":
      return `Idle ${formatDuration(reason.idleMs)}: the prompt cache has probably expired, so this prompt may re-cache ${amount}.`;
    case "model":
      return `${reason.to} has no cache of this conversation (it was cached for ${reason.from}): this prompt re-caches ${amount}.`;
  }
}

/** Remembers a blocked prompt so the same prompt sent again within the window goes through. */
export class ConfirmMemo {
  private pending?: { key: string; text: string; at: number };

  /** True when `text` repeats the prompt blocked for `key` within `windowMs`; clears it either way. */
  confirmed(key: string, text: string, now: number, windowMs: number): boolean {
    const pending = this.pending;
    this.pending = undefined;
    return pending !== undefined && pending.key === key && pending.text === text.trim() && now - pending.at <= windowMs;
  }

  arm(key: string, text: string, now: number): void {
    this.pending = { key, text: text.trim(), at: now };
  }
}

/** "4:05" under an hour, "1h05m" above, "0:00" once gone. */
export function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** "45s", "12m", "3h20m", "2d4h". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
  return `${Math.floor(hours / 24)}d${hours % 24 ? `${hours % 24}h` : ""}`;
}

export function formatTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

export function formatCost(dollars: number): string {
  return dollars >= 10 ? `$${dollars.toFixed(0)}` : `$${dollars.toFixed(2)}`;
}

/**
 * List prices of the Claude models, for harnesses that do not carry a model catalog (Claude Code,
 * Codex has no use for it). Longest prefix wins; unknown models price as Opus 5.5.
 */
const CLAUDE_PRICES: ReadonlyArray<readonly [string, Price]> = [
  ["claude-fable-5-1", { input: 10, cacheRead: 0.25 }],
  ["claude-fable-5", { input: 10, cacheRead: 1 }],
  ["claude-mythos-5-1", { input: 10, cacheRead: 0.25 }],
  ["claude-opus-5-5", { input: 4, cacheRead: 0.2 }],
  ["claude-opus-5", { input: 5, cacheRead: 0.5 }],
  ["claude-opus-4", { input: 5, cacheRead: 0.5 }],
  ["claude-sonnet-5", { input: 2, cacheRead: 0.2 }],
  ["claude-sonnet-4", { input: 3, cacheRead: 0.3 }],
  ["claude-haiku-5", { input: 0.1, cacheRead: 0.01 }],
  ["claude-haiku-4", { input: 1, cacheRead: 0.1 }],
];

export function claudePrice(model: string): Price {
  const id = model.toLowerCase().replace(/^.*\//, "").replace(/\[.*$/, "");
  let best: Price | undefined;
  let length = 0;
  for (const [prefix, price] of CLAUDE_PRICES) {
    if (id.startsWith(prefix) && prefix.length > length) {
      best = price;
      length = prefix.length;
    }
  }
  return best ?? { input: 4, cacheRead: 0.2 };
}

export function mergeSettings(base: Settings, texts: readonly (string | undefined)[]): Settings {
  let merged: Record<string, unknown> = structuredClone(base) as unknown as Record<string, unknown>;
  for (const text of texts) {
    if (text === undefined) continue;
    try {
      const value: unknown = JSON.parse(text);
      if (isRecord(value)) merged = merge(merged, value);
    } catch {
      // Invalid JSON: keep what the earlier files said.
    }
  }
  return merged as unknown as Settings;
}

function merge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const current = out[key];
    out[key] = isRecord(current) && isRecord(value) ? merge(current, value) : value;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
