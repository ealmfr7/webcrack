// M1.8 eval harness — pure logic (no I/O, no subprocesses).
//
// This module is intentionally dependency-free so it can run under
// `node --experimental-strip-types` and inside vitest without a build step.
// All matching is case-insensitive: agent answers vary in capitalization
// ("Webpack" vs "webpack") and the checkers should not punish that.

export type Check =
  | { type: "contains"; value: string }
  | { type: "regex"; value: string }
  | { type: "all-of"; checks: Check[] }
  | { type: "any-of"; checks: Check[] };

export type EvalSet = "v1" | "v2";

export function isEvalSet(value: unknown): value is EvalSet {
  return value === "v1" || value === "v2";
}

export interface EvalTask {
  id: string;
  sample: string;
  prompt: string;
  check: Check;
  set: EvalSet;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate a raw `check` value. Returns the typed check plus any errors. */
export function validateCheck(
  raw: unknown,
  path: string,
): { check?: Check; errors: string[] } {
  if (!isRecord(raw) || typeof raw["type"] !== "string") {
    return { errors: [`${path}: check must be an object with a string "type"`] };
  }
  const type = raw["type"] as string;
  if (type === "contains" || type === "regex") {
    if (typeof raw["value"] !== "string" || raw["value"].length === 0) {
      return { errors: [`${path}: check type "${type}" needs a non-empty "value"`] };
    }
    if (type === "regex") {
      try {
        new RegExp(raw["value"] as string, "i");
      } catch {
        return { errors: [`${path}: invalid regex ${JSON.stringify(raw["value"])}`] };
      }
    }
    return { check: { type, value: raw["value"] as string }, errors: [] };
  }
  if (type === "all-of" || type === "any-of") {
    if (!Array.isArray(raw["checks"]) || raw["checks"].length === 0) {
      return { errors: [`${path}: check type "${type}" needs a non-empty "checks" array`] };
    }
    const checks: Check[] = [];
    const errors: string[] = [];
    (raw["checks"] as unknown[]).forEach((child, index) => {
      const result = validateCheck(child, `${path}.${type}[${index}]`);
      if (result.check !== undefined) checks.push(result.check);
      errors.push(...result.errors);
    });
    if (errors.length > 0) return { errors };
    return { check: { type, checks }, errors: [] };
  }
  return {
    errors: [
      `${path}: unknown check type ${JSON.stringify(type)} (want contains|regex|all-of|any-of)`,
    ],
  };
}

/** Validate one parsed task line. `takenIds` enforces unique ids. */
export function validateTask(
  raw: unknown,
  lineNo: number,
  takenIds: Set<string>,
): { task?: EvalTask; errors: string[] } {
  const path = `tasks.jsonl:${lineNo}`;
  if (!isRecord(raw)) return { errors: [`${path}: each line must be a JSON object`] };
  const errors: string[] = [];
  const id = raw["id"];
  const sample = raw["sample"];
  const prompt = raw["prompt"];
  if (typeof id !== "string" || id.length === 0) {
    errors.push(`${path}: "id" must be a non-empty string`);
  } else if (takenIds.has(id)) {
    errors.push(`${path}: duplicate task id ${JSON.stringify(id)}`);
  }
  if (typeof sample !== "string" || !/^[A-Za-z0-9_.-]+\.js$/.test(sample)) {
    errors.push(`${path}: "sample" must be a "<name>.js" file name`);
  }
  if (typeof prompt !== "string" || prompt.length === 0) {
    errors.push(`${path}: "prompt" must be a non-empty string`);
  }
  // `set` is optional for back-compat and defaults to "v1".
  let set: EvalSet = "v1";
  if (raw["set"] !== undefined) {
    if (!isEvalSet(raw["set"])) {
      errors.push(`${path}: "set" must be "v1" or "v2"`);
    } else {
      set = raw["set"];
    }
  }
  const checkResult = validateCheck(raw["check"], path);
  errors.push(...checkResult.errors);
  if (errors.length > 0 || checkResult.check === undefined) return { errors };
  takenIds.add(id as string);
  return {
    task: {
      id: id as string,
      sample: sample as string,
      prompt: prompt as string,
      check: checkResult.check,
      set,
    },
    errors: [],
  };
}

/** Parse and validate a tasks.jsonl document. Blank lines are ignored. */
export function parseTasksJsonl(text: string): { tasks: EvalTask[]; errors: string[] } {
  const tasks: EvalTask[] = [];
  const errors: string[] = [];
  const takenIds = new Set<string>();
  text.split("\n").forEach((line, index) => {
    if (line.trim().length === 0) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      errors.push(`tasks.jsonl:${index + 1}: invalid JSON`);
      return;
    }
    const result = validateTask(raw, index + 1, takenIds);
    if (result.task !== undefined) tasks.push(result.task);
    errors.push(...result.errors);
  });
  return { tasks, errors };
}

/**
 * Check that every task's sample resolves. `exists` maps a sample file name
 * (e.g. "webpack-5.js") to whether it is present in the corpus directory.
 */
export function validateSamples(
  tasks: EvalTask[],
  exists: (sample: string) => boolean,
): string[] {
  return tasks
    .filter((task) => !exists(task.sample))
    .map((task) => `task "${task.id}": sample not found: ${task.sample}`);
}

/** Apply a checker to the agent's final result text (case-insensitive). */
export function runCheck(check: Check, resultText: string): boolean {
  switch (check.type) {
    case "contains":
      return resultText.toLowerCase().includes(check.value.toLowerCase());
    case "regex":
      return new RegExp(check.value, "i").test(resultText);
    case "all-of":
      return check.checks.every((child) => runCheck(child, resultText));
    case "any-of":
      return check.checks.some((child) => runCheck(child, resultText));
  }
}

export interface ParsedRun {
  toolCalls: number;
  webcrackCalls: number;
  otherCalls: number;
  numTurns: number;
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  resultText: string;
  hasResult: boolean;
}

interface StreamContentBlock {
  type?: unknown;
  name?: unknown;
}

function countToolUse(content: unknown): { webcrack: number; other: number } {
  let webcrack = 0;
  let other = 0;
  if (!Array.isArray(content)) return { webcrack, other };
  for (const block of content as StreamContentBlock[]) {
    if (!isRecord(block) || block["type"] !== "tool_use") continue;
    if (typeof block["name"] === "string" && block["name"].startsWith("mcp__webcrack")) {
      webcrack += 1;
    } else {
      other += 1;
    }
  }
  return { webcrack, other };
}

/**
 * Parse `claude -p --output-format stream-json --verbose` stdout (JSONL).
 *
 * Counts assistant `tool_use` blocks, split into webcrack MCP tools vs other
 * tools, and takes num_turns, token usage, total cost and the final result
 * text from the final `result` event. Malformed lines are skipped.
 */
export function parseStreamJson(stdout: string): ParsedRun {
  const parsed: ParsedRun = {
    toolCalls: 0,
    webcrackCalls: 0,
    otherCalls: 0,
    numTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalCostUsd: 0,
    resultText: "",
    hasResult: false,
  };
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(event) || typeof event["type"] !== "string") continue;
    if (event["type"] === "assistant" && isRecord(event["message"])) {
      const counts = countToolUse(event["message"]["content"]);
      parsed.webcrackCalls += counts.webcrack;
      parsed.otherCalls += counts.other;
    } else if (event["type"] === "result") {
      // The final `result` event wins: keep overwriting so the last one sticks.
      if (typeof event["result"] === "string") {
        parsed.resultText = event["result"];
        parsed.hasResult = true;
      }
      if (typeof event["num_turns"] === "number") parsed.numTurns = event["num_turns"];
      if (typeof event["total_cost_usd"] === "number") {
        parsed.totalCostUsd = event["total_cost_usd"];
      }
      if (isRecord(event["usage"])) {
        const usage = event["usage"];
        if (typeof usage["input_tokens"] === "number") {
          parsed.inputTokens = usage["input_tokens"];
        }
        if (typeof usage["output_tokens"] === "number") {
          parsed.outputTokens = usage["output_tokens"];
        }
      }
    }
  }
  parsed.toolCalls = parsed.webcrackCalls + parsed.otherCalls;
  return parsed;
}

export interface TaskOutcome {
  id: string;
  set?: EvalSet;
  passed: boolean;
  toolCalls: number;
  webcrackCalls: number;
  otherCalls: number;
  numTurns: number;
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  error?: string;
}

/** Median of a list of numbers (0 for the empty list). */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export interface EvalSummary {
  date: string;
  commit: string;
  set?: EvalSet;
  total: number;
  solved: number;
  successPct: number;
  medianToolCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
}

/** Aggregate per-task outcomes into headline numbers. */
export function aggregate(
  outcomes: TaskOutcome[],
  date: string,
  commit: string,
): EvalSummary {
  const solved = outcomes.filter((outcome) => outcome.passed).length;
  const total = outcomes.length;
  return {
    date,
    commit,
    total,
    solved,
    successPct: total === 0 ? 0 : (solved / total) * 100,
    medianToolCalls: median(outcomes.map((outcome) => outcome.toolCalls)),
    totalInputTokens: outcomes.reduce((sum, outcome) => sum + outcome.inputTokens, 0),
    totalOutputTokens: outcomes.reduce((sum, outcome) => sum + outcome.outputTokens, 0),
    totalCostUsd: outcomes.reduce((sum, outcome) => sum + outcome.totalCostUsd, 0),
  };
}

/**
 * Aggregate per-task outcomes grouped by eval set. Outcomes without a `set`
 * are counted as "v1" (back-compat with runs recorded before sets existed).
 * Both keys are always present so callers can render one RESULTS.md row per
 * set without nil checks.
 */
export function aggregateBySet(
  outcomes: TaskOutcome[],
  date: string,
  commit: string,
): Record<EvalSet, EvalSummary> {
  const bySet = (set: EvalSet): EvalSummary => ({
    ...aggregate(
      outcomes.filter((outcome) => (outcome.set ?? "v1") === set),
      date,
      commit,
    ),
    set,
  });
  return { v1: bySet("v1"), v2: bySet("v2") };
}

export const RESULTS_HEADER =
  "| Date | Set | Commit | Solved | Median tool calls | Input tokens | Output tokens | Cost (USD) |";

/** Format one RESULTS.md table row for a summary (includes the set). */
export function formatResultsRow(summary: EvalSummary): string {
  const solved = `${summary.solved}/${summary.total} (${summary.successPct.toFixed(1)}%)`;
  return (
    `| ${summary.date} | ${summary.set ?? "all"} | ${summary.commit} | ${solved} ` +
    `| ${summary.medianToolCalls} | ${summary.totalInputTokens} ` +
    `| ${summary.totalOutputTokens} | $${summary.totalCostUsd.toFixed(4)} |`
  );
}
