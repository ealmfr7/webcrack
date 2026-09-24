// M1.8 eval harness runner.
//
// Runs each task in tasks.jsonl with a real Claude agent against the local
// MCP server and records accuracy, tool calls and tokens. NEVER invoked from
// tests: spawning `claude` costs money. The user runs it by hand:
//
//   node --experimental-strip-types packages/mcp/evals/run.ts [--dry-run]
//
// `--dry-run` validates the tasks, checks the samples exist and warns when
// the server build is missing. It spawns nothing.

import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  aggregate,
  formatResultsRow,
  parseStreamJson,
  parseTasksJsonl,
  RESULTS_HEADER,
  runCheck,
  validateSamples,
  type EvalTask,
  type TaskOutcome,
} from "./lib.ts";

const EVALS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(EVALS_DIR, "..", "..", "..");
const CORPUS_DIR = path.join(ROOT, "packages/webcrack/test/corpus");
const TASKS_FILE = path.join(EVALS_DIR, "tasks.jsonl");
const MCP_CONFIG = path.join(EVALS_DIR, "mcp.json");
const SERVER_ENTRY = path.join(ROOT, "packages/mcp/dist/index.js");
const RESULTS_DIR = path.join(EVALS_DIR, "results");
const RESULTS_MD = path.join(EVALS_DIR, "RESULTS.md");

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

interface Options {
  dryRun: boolean;
  only?: string;
  concurrency: number;
  timeoutMs: number;
}

function parseArgs(argv: string[]): Options | { error: string } {
  const options: Options = {
    dryRun: false,
    only: undefined,
    concurrency: 1,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--only") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { error: "--only needs a task id" };
      }
      options.only = value;
      i += 1;
    } else if (arg === "--concurrency") {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1) {
        return { error: "--concurrency needs a positive integer" };
      }
      options.concurrency = value;
      i += 1;
    } else if (arg === "--timeout-ms") {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        return { error: "--timeout-ms needs a positive integer" };
      }
      options.timeoutMs = value;
      i += 1;
    } else {
      return { error: `unknown flag: ${arg}` };
    }
  }
  return options;
}

function loadTasks(): EvalTask[] {
  const { tasks, errors } = parseTasksJsonl(readFileSync(TASKS_FILE, "utf8"));
  const sampleErrors = validateSamples(tasks, (sample) =>
    existsSync(path.join(CORPUS_DIR, sample)),
  );
  const allErrors = [...errors, ...sampleErrors];
  if (allErrors.length > 0) {
    throw new Error(`invalid tasks:\n${allErrors.map((e) => `  - ${e}`).join("\n")}`);
  }
  return tasks;
}

function shortCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    return "nogit";
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function runClaude(task: EvalTask, timeoutMs: number): Promise<TaskOutcome> {
  return new Promise((resolve) => {
    const child = spawn(
      "claude",
      [
        "-p",
        task.prompt,
        "--mcp-config",
        MCP_CONFIG,
        "--strict-mcp-config",
        "--allowedTools",
        "mcp__webcrack",
        "--output-format",
        "stream-json",
        "--verbose",
      ],
      { cwd: ROOT, timeout: timeoutMs },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: Error) => {
      resolve({
        id: task.id,
        passed: false,
        toolCalls: 0,
        webcrackCalls: 0,
        otherCalls: 0,
        numTurns: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCostUsd: 0,
        error: `spawn failed: ${error.message}`,
      });
    });
    child.on("close", (code: number | null, signal: string | null) => {
      if (signal !== null || code !== 0) {
        const reason =
          signal !== null
            ? `killed by ${signal} (likely the per-task timeout)`
            : `exit code ${code}: ${stderr.slice(-500)}`;
        resolve({
          id: task.id,
          passed: false,
          toolCalls: 0,
          webcrackCalls: 0,
          otherCalls: 0,
          numTurns: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalCostUsd: 0,
          error: reason,
        });
        return;
      }
      const parsed = parseStreamJson(stdout);
      if (!parsed.hasResult) {
        resolve({
          id: task.id,
          passed: false,
          toolCalls: parsed.toolCalls,
          webcrackCalls: parsed.webcrackCalls,
          otherCalls: parsed.otherCalls,
          numTurns: parsed.numTurns,
          inputTokens: parsed.inputTokens,
          outputTokens: parsed.outputTokens,
          totalCostUsd: parsed.totalCostUsd,
          error: "no result event in stream-json output",
        });
        return;
      }
      resolve({
        id: task.id,
        passed: runCheck(task.check, parsed.resultText),
        toolCalls: parsed.toolCalls,
        webcrackCalls: parsed.webcrackCalls,
        otherCalls: parsed.otherCalls,
        numTurns: parsed.numTurns,
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
        totalCostUsd: parsed.totalCostUsd,
      });
    });
  });
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    () => (async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        out[index] = (await fn(items[index] as T)) as R;
      }
    })(),
  );
  await Promise.all(workers);
  return out;
}

function dryRun(only: string | undefined): void {
  const tasks = loadTasks();
  const selected = only === undefined ? tasks : tasks.filter((t) => t.id === only);
  if (only !== undefined && selected.length === 0) {
    throw new Error(`--only ${JSON.stringify(only)} matches no task`);
  }
  if (!existsSync(MCP_CONFIG)) throw new Error(`missing ${MCP_CONFIG}`);
  JSON.parse(readFileSync(MCP_CONFIG, "utf8") as string);
  console.log(`tasks: ${selected.length}/${tasks.length} valid, all samples exist`);
  for (const task of selected) {
    console.log(`  ok ${task.id} (${task.sample})`);
  }
  if (!existsSync(SERVER_ENTRY)) {
    console.log(
      `warning: server build missing (${path.relative(ROOT, SERVER_ENTRY)}); run the mcp build before a real eval`,
    );
  } else {
    console.log("server build present");
  }
  console.log("dry-run: nothing spawned");
}

async function realRun(options: Options): Promise<void> {
  const tasks = loadTasks();
  const selected =
    options.only === undefined ? tasks : tasks.filter((t) => t.id === options.only);
  if (options.only !== undefined && selected.length === 0) {
    throw new Error(`--only ${JSON.stringify(options.only)} matches no task`);
  }
  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(
      `server build missing (${path.relative(ROOT, SERVER_ENTRY)}); build the mcp package first`,
    );
  }
  const outcomes = await mapPool(selected, options.concurrency, async (task) => {
    const outcome = await runClaude(task, options.timeoutMs);
    const mark = outcome.passed ? "PASS" : "FAIL";
    console.log(
      `${mark} ${outcome.id} tools=${outcome.toolCalls} ` +
        `(webcrack=${outcome.webcrackCalls}) turns=${outcome.numTurns}` +
        (outcome.error !== undefined ? ` error=${outcome.error}` : ""),
    );
    return outcome;
  });
  const commit = shortCommit();
  const date = today();
  const summary = aggregate(outcomes, date, commit);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const jsonPath = path.join(RESULTS_DIR, `${date}-${commit}.json`);
  writeFileSync(jsonPath, `${JSON.stringify({ summary, outcomes }, null, 2)}\n`);
  if (!existsSync(RESULTS_MD)) {
    writeFileSync(RESULTS_MD, `# Eval results (M1.8)\n\n${RESULTS_HEADER}\n`);
  }
  appendFileSync(RESULTS_MD, `${formatResultsRow(summary)}\n`);
  console.log(
    `solved ${summary.solved}/${summary.total} (${summary.successPct.toFixed(1)}%), ` +
      `median tool calls ${summary.medianToolCalls} -> ${jsonPath}`,
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!("dryRun" in options)) {
    const narrow = options as { error: string };
    console.error(`usage: run.ts [--dry-run] [--only <id>] [--concurrency N] [--timeout-ms N]\n${narrow.error}`);
    process.exitCode = 1;
    return;
  }
  if (options.dryRun) {
    dryRun(options.only);
    return;
  }
  await realRun(options);
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
