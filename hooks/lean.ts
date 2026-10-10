// cache-guard lean: keeping the context small with Jev, TypeSafe's judgment model. Trims large tool
// output to the blocks the agent needs, and sorts a conversation being compacted into what must
// survive word for word, what a note covers, and what can go. Shared verbatim by pi-cache-guard,
// claude-cache-guard, opencode-cache-guard and codex-cache-guard; it imports nothing, so each port
// can copy this file as is. How a port reaches Jev and reads its transcript stays in the port.
//
// Questions and answers use Pi's classifier shapes (`bool`, `choice`, `score`). Ports that call
// Jev's HTTP API directly translate `bool` to its `noul` type and back.

export type Question =
  | { type: "bool"; instructions: string; criteria: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export type Answer =
  | { type: "bool"; probability: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; confidence: number };

/** One line for setup hints: what Jev adds. */
export const JEV_PITCH =
  "Jev, TypeSafe's judgment model, trims large tool output to what the agent needs and compacts a conversation in about a second, without an LLM summary.";

/** Where to get a key for Jev's own API (TYPESAFE_API_KEY). */
export const JEV_KEY_URL = "https://console.typesafe.ai/keys";

export function boolAnswer(answers: Record<string, Answer>, id: string): number | undefined {
  const answer = answers[id];
  return answer?.type === "bool" && Number.isFinite(answer.probability) ? answer.probability : undefined;
}

export function choiceAnswer(answers: Record<string, Answer>, id: string): string | undefined {
  const answer = answers[id];
  return answer?.type === "choice" ? answer.choice : undefined;
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function clipTail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-(max - 1))}` : text;
}

// ---------------------------------------------------------------------------------------------
// Trimming tool output

export interface TrimLimits {
  /** Trim text results longer than this many characters. */
  minChars: number;
  /** For whole-file reads, trim only results longer than this. */
  readMinChars: number;
  /** At most this many blocks are judged. */
  maxBlocks: number;
  /** Characters of output sent to Jev; larger output is pre-filtered first. */
  stateBudgetChars: number;
  /** Keep blocks whose probability of being needed reaches this. */
  keepThreshold: number;
  /** Do not trim when Jev thinks the agent asked for the whole output. */
  needsAllThreshold: number;
  /** Do not trim when more than this share of lines would be kept. */
  maxKeptShare: number;
  headLines: number;
  tailLines: number;
}

const SIGNAL = /error|\bERR!?\b|warn|fail|panic|assert|exception|traceback|fatal|could not|cannot|can't|not found|denied|refused|conflict|exit code|✗|×/iu;

export interface Block {
  id: string;
  /** Line indices (0-based) of the original output in this block. */
  lines: number[];
  text: string;
}

/**
 * Lines worth judging when the output is too large for one request: the first 40, the last 80,
 * every line that looks like an error or warning (with two lines of context), and an even sample
 * of the rest up to the budget.
 */
export function prefilter(lines: readonly string[], budgetChars: number): number[] {
  const n = lines.length;
  const keep = new Set<number>();
  for (let i = 0; i < Math.min(40, n); i++) keep.add(i);
  for (let i = Math.max(0, n - 80); i < n; i++) keep.add(i);
  for (let i = 0; i < n; i++) {
    if (SIGNAL.test(lines[i] as string)) {
      for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) keep.add(j);
    }
  }
  let used = [...keep].reduce((sum, i) => sum + (lines[i] as string).length + 1, 0);
  const rest = [...Array(n).keys()].filter((i) => !keep.has(i));
  if (rest.length && used < budgetChars) {
    const average = rest.reduce((sum, i) => sum + (lines[i] as string).length + 1, 0) / rest.length || 1;
    const room = Math.floor((budgetChars - used) / average);
    const step = Math.max(1, Math.ceil(rest.length / Math.max(1, room)));
    for (let k = 0; k < rest.length; k += step) {
      const i = rest[k] as number;
      const size = (lines[i] as string).length + 1;
      if (used + size > budgetChars) break;
      keep.add(i);
      used += size;
    }
  }
  return [...keep].sort((a, b) => a - b);
}

/** Group the candidate lines into at most `maxBlocks` blocks of consecutive candidates. */
export function makeBlocks(lines: readonly string[], candidates: readonly number[], maxBlocks: number): Block[] {
  const size = Math.max(1, Math.ceil(candidates.length / maxBlocks));
  const blocks: Block[] = [];
  for (let k = 0; k < candidates.length; k += size) {
    const group = candidates.slice(k, k + size);
    const id = `B${String(blocks.length + 1).padStart(3, "0")}`;
    blocks.push({ id, lines: group, text: group.map((i) => clip(lines[i] as string, 400)).join("\n") });
  }
  return blocks;
}

/** The blocks of `text` Jev judges: all lines, or a pre-filtered selection when it is too large. */
export function blocksFor(text: string, limits: TrimLimits): { lines: string[]; blocks: Block[] } {
  const lines = text.split("\n");
  const candidates = text.length > limits.stateBudgetChars ? prefilter(lines, limits.stateBudgetChars) : [...lines.keys()];
  return { lines, blocks: makeBlocks(lines, candidates, limits.maxBlocks) };
}

/**
 * Jev's state for a trim: what the agent is doing (`intent`: the request, what it said since, the
 * tool and its arguments) and the output's blocks.
 */
export function trimState(intent: { user_request: string; agent_said: string; tool: string; arguments: string }, blocks: readonly Block[]) {
  return {
    intent: {
      user_request: clip(intent.user_request, 1_500),
      agent_said: clipTail(intent.agent_said, 2_000) || "(nothing; see the tool call)",
      tool: intent.tool,
      arguments: clip(intent.arguments, 1_000),
    },
    output: Object.fromEntries(blocks.map((b) => [b.id, b.text])),
  };
}

export function trimQuestions(blocks: readonly Block[]): Record<string, Question> {
  const questions: Record<string, Question> = {
    needs_all: {
      type: "bool",
      instructions:
        "Given `intent`, did the agent run this to read the complete output verbatim (for example to copy, review, or count all of it), rather than to find specific results in it?",
      criteria: { true: "The agent needs the whole output", false: "The agent needs only the relevant parts" },
    },
  };
  for (const block of blocks) {
    questions[`block::${block.id}`] = {
      type: "bool",
      instructions: `Does \`output.${block.id}\` contain information the agent needs for \`intent\`: errors, failures, warnings, requested values, or results it would act on?`,
      criteria: {
        true: "The agent should read these lines",
        false: "Routine progress, passing output, boilerplate, or repetition the agent can skip",
      },
    };
  }
  return questions;
}

export interface Assembly {
  text: string;
  keptLines: number;
  totalLines: number;
}

/**
 * The kept lines (kept blocks plus the head and tail) in original order, with
 * `[… N lines omitted …]` markers, and a footer pointing at the full output.
 */
export function assemble(lines: readonly string[], keptBlocks: readonly Block[], limits: TrimLimits, fullPath: string): Assembly {
  const keep = new Set<number>();
  for (let i = 0; i < Math.min(limits.headLines, lines.length); i++) keep.add(i);
  for (let i = Math.max(0, lines.length - limits.tailLines); i < lines.length; i++) keep.add(i);
  for (const block of keptBlocks) for (const i of block.lines) keep.add(i);
  const out: string[] = [];
  let omitted = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep.has(i)) {
      if (omitted) out.push(`[… ${omitted} line${omitted === 1 ? "" : "s"} omitted …]`);
      omitted = 0;
      out.push(lines[i] as string);
    } else omitted++;
  }
  if (omitted) out.push(`[… ${omitted} line${omitted === 1 ? "" : "s"} omitted …]`);
  out.push("", `[Trimmed by Jev: kept ${keep.size} of ${lines.length} lines that matter for this step. Full output: ${fullPath} (read it with offset/limit).]`);
  return { text: out.join("\n"), keptLines: keep.size, totalLines: lines.length };
}

export interface TrimVerdict extends Assembly {
  /** False when the output should stay whole: the agent wants all of it, or most would be kept. */
  trim: boolean;
  needsAll: number;
}

/** Jev's answers turned into the trimmed text, and whether trimming is worth it. */
export function trimVerdict(lines: readonly string[], blocks: readonly Block[], answers: Record<string, Answer>, limits: TrimLimits, fullPath: string): TrimVerdict {
  const needsAll = boolAnswer(answers, "needs_all") ?? 0;
  const kept = blocks.filter((b) => (boolAnswer(answers, `block::${b.id}`) ?? 1) >= limits.keepThreshold);
  const result = assemble(lines, kept, limits, fullPath);
  const trim = needsAll <= limits.needsAllThreshold && result.keptLines / result.totalLines <= limits.maxKeptShare;
  return { ...result, trim, needsAll };
}

// ---------------------------------------------------------------------------------------------
// Compaction

/** One thing in the conversation Jev decides about: a message, an assistant text, or a tool call with its result. */
export interface Unit {
  id: string;
  kind: "user" | "assistant" | "tool" | "other";
  /** Full text for the summary (user/assistant text, tool call and result). */
  text: string;
  tool?: { name: string; args: string; result: string; isError: boolean; callId: string };
  /** Index of the message the unit starts in. */
  message: number;
}

export type Keep = "verbatim" | "summarize" | "drop";

/** The short form Jev reads: user 1.5k, assistant 1k, tool call 300 and result 600 characters. */
export function unitForJev(unit: Unit): Record<string, unknown> {
  if (unit.tool) {
    return { kind: "tool", call: clip(`${unit.tool.name}(${unit.tool.args})`, 300), result: clip(unit.tool.result, 600), ...(unit.tool.isError ? { failed: true } : {}) };
  }
  return { kind: unit.kind, text: clip(unit.text, unit.kind === "user" ? 1_500 : 1_000) };
}

/** Fill in each tool unit's text from its call and result. */
export function finishUnits(units: Unit[]): Unit[] {
  for (const unit of units) {
    if (unit.tool) unit.text = `${unit.tool.name}(${unit.tool.args})\n${unit.tool.isError ? "[error] " : ""}${unit.tool.result}`;
  }
  return units;
}

/** Batches of at most `maxUnits` units and `maxChars` characters of state each. */
export function batches(units: readonly Unit[], maxUnits = 120, maxChars = 60_000): Unit[][] {
  const out: Unit[][] = [];
  let current: Unit[] = [];
  let chars = 0;
  for (const unit of units) {
    const size = JSON.stringify(unitForJev(unit)).length;
    if (current.length && (current.length >= maxUnits || chars + size > maxChars)) {
      out.push(current);
      current = [];
      chars = 0;
    }
    current.push(unit);
    chars += size;
  }
  if (current.length) out.push(current);
  return out;
}

/** Jev's state for one batch: the goal the conversation continues toward, and the units. */
export function keepState(goal: string, batch: readonly Unit[]) {
  return { current_goal: goal.trim() || "(continue the work)", units: Object.fromEntries(batch.map((u) => [u.id, unitForJev(u)])) };
}

export function keepQuestions(units: readonly Unit[]): Record<string, Question> {
  return Object.fromEntries(
    units.map((unit) => [
      `keep::${unit.id}`,
      {
        type: "choice",
        instructions: `The conversation is being compacted to continue \`current_goal\`. How should \`units.${unit.id}\` be kept?`,
        criteria: {
          verbatim: "Must survive word for word: user requirements or preferences, decisions, exact values, names or paths still needed, or errors that are still open",
          summarize: "Useful context, but a one-line note is enough",
          drop: "Superseded, resolved, or noise: routine exploration, passing checks, repeated or abandoned attempts",
        },
      } satisfies Question,
    ]),
  );
}

/** Jev's answer for each unit of a batch; anything unanswered is summarized. */
export function keepAnswers(batch: readonly Unit[], answers: Record<string, Answer>, into = new Map<string, Keep>()): Map<string, Keep> {
  for (const unit of batch) {
    const answer = choiceAnswer(answers, `keep::${unit.id}`);
    into.set(unit.id, answer === "verbatim" || answer === "drop" ? answer : "summarize");
  }
  return into;
}

export function keepCounts(keep: ReadonlyMap<string, Keep>): Record<Keep, number> {
  const counts = { verbatim: 0, summarize: 0, drop: 0 };
  for (const k of keep.values()) counts[k]++;
  return counts;
}

const VERBATIM_ITEM_CHARS = 1_500;
const VERBATIM_TOTAL_CHARS = 24_000;

/** The verbatim units as Markdown, newest kept first when over the budget, in conversation order. */
export function verbatimSection(units: readonly Unit[], keep: ReadonlyMap<string, Keep>): string {
  const chosen = units.filter((u) => keep.get(u.id) === "verbatim");
  const rendered: string[] = [];
  let used = 0;
  for (let i = chosen.length - 1; i >= 0; i--) {
    const item = renderUnit(chosen[i] as Unit);
    if (used + item.length > VERBATIM_TOTAL_CHARS) break;
    rendered.unshift(item);
    used += item.length;
  }
  return rendered.length ? `## Kept verbatim\n\n${rendered.join("\n\n")}` : "";
}

function renderUnit(unit: Unit): string {
  if (unit.tool) {
    return `**Tool \`${unit.tool.name}\`** \`${clip(unit.tool.args, 300)}\`${unit.tool.isError ? " (failed)" : ""}\n\`\`\`\n${clip(unit.tool.result, VERBATIM_ITEM_CHARS)}\n\`\`\``;
  }
  const who = unit.kind === "user" ? "User" : unit.kind === "assistant" ? "Assistant" : "Note";
  return `**${who}:** ${clip(unit.text, VERBATIM_ITEM_CHARS)}`;
}

export interface FileOps {
  read: Iterable<string>;
  written: Iterable<string>;
  edited: Iterable<string>;
}

/** The summary Jev's compaction writes in code, without any LLM. */
export function codeSummary(input: {
  units: readonly Unit[];
  keep: ReadonlyMap<string, Keep>;
  previousSummary?: string;
  fileOps?: FileOps;
  instructions?: string;
}): string {
  const { units, keep } = input;
  const sections: string[] = [];
  const counts = { verbatim: 0, summarize: 0, drop: 0 };
  for (const unit of units) counts[keep.get(unit.id) ?? "summarize"]++;
  sections.push(
    `# Compacted with Jev\n\nJev kept ${counts.verbatim} item${counts.verbatim === 1 ? "" : "s"} word for word, noted ${counts.summarize} and dropped ${counts.drop}; no LLM wrote this summary.${input.instructions ? `\nFocus: ${input.instructions}` : ""}`,
  );
  if (input.previousSummary?.trim()) sections.push(`## Earlier summary\n\n${clip(input.previousSummary.trim(), 4_000)}`);
  const goals = units.filter((u) => u.kind === "user" && keep.get(u.id) !== "drop").map((u) => `- ${clip(u.text.replace(/\s+/gu, " "), 500)}`);
  if (goals.length) sections.push(`## Goal\n\nWhat the user asked for, in order:\n${goals.join("\n")}`);
  const verbatim = verbatimSection(units, keep);
  if (verbatim) sections.push(verbatim);
  const notes = units
    .filter((u) => (keep.get(u.id) ?? "summarize") === "summarize" && u.kind !== "user")
    .map((u) => {
      const first = u.tool ? `${u.tool.name} ${clip(u.tool.args, 120)}${u.tool.isError ? " (failed)" : ""}` : (u.text.split("\n").find((l) => l.trim()) ?? "");
      return `- ${clip(first.trim(), 200)}`;
    });
  if (notes.length) sections.push(`## Notes\n\n${notes.join("\n")}`);
  const files = fileLines(input.fileOps);
  if (files) sections.push(`## Files\n\n${files}`);
  return sections.join("\n\n");
}

function fileLines(ops: FileOps | undefined): string {
  if (!ops) return "";
  const modified = [...new Set([...ops.written, ...ops.edited])].sort();
  const read = [...new Set(ops.read)].filter((f) => !modified.includes(f)).sort();
  const lines: string[] = [];
  if (modified.length) lines.push(`Modified: ${modified.join(", ")}`);
  if (read.length) lines.push(`Read: ${read.join(", ")}`);
  return lines.join("\n");
}
