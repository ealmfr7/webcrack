// M1.8 eval harness runner.
//
// Runs each task in tasks.jsonl with a real Claude agent against the local
// MCP server and records accuracy, tool calls and tokens. NEVER invoked from
// tests: spawning `claude` costs money. The user runs it by hand:
//
//   node --experimental-strip-types packages/mcp/evals/run.ts [--dry-run] [--set v1|v2|all]
//
// `--dry-run` validates the tasks, checks the samples exist and starts the
// built server (`packages/mcp/dist/index.js`) over stdio to verify it serves
// the expected tools. It spawns our own server, never `claude`.

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
  aggregateBySet,
  findMissingTools,
  formatResultsRow,
  isEvalSet,
  parseStreamJson,
  parseTasksJsonl,
  RESULTS_HEADER,
  runCheck,
  validateSamples,
  type EvalSet,
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

export type SetFilter = EvalSet | "all";

interface Options {
  dryRun: boolean;
  only?: string;
  set: SetFilter;
  concurrency: number;
  timeoutMs: number;
}

function parseArgs(argv: string[]): Options | { error: string } {
  const options: Options = {
    dryRun: false,
    only: undefined,
    set: "all",
    concurrency: 1,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--set") {
      const value = argv[i + 1];
      if (value === undefined || (!isEvalSet(value) && value !== "all")) {
        return { error: "--set needs v1, v2 or all" };
      }
      options.set = value as SetFilter;
      i += 1;
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
        set: task.set,
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
          set: task.set,
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
          set: task.set,
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
          set: task.set,
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

function selectTasks(tasks: EvalTask[], options: Pick<Options, "only" | "set">): EvalTask[] {
  const selected = tasks.filter(
    (task) =>
      (options.set === "all" || task.set === options.set) &&
      (options.only === undefined || task.id === options.only),
  );
  if (selected.length === 0) {
    throw new Error(
      `--only ${JSON.stringify(options.only)} --set ${options.set} matches no task`,
    );
  }
  return selected;
}

const REQUIRED_SERVER_TOOLS = ["wc_open", "wc_trace"];

/**
 * Spawn the built server over stdio and verify it serves the tools the
 * evals need. Throws a clear error when the build is missing or the server
 * fails to start. Spawns our own server, never `claude`.
 */
async function checkServerBuild(): Promise<void> {
  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(
      `server build missing (${path.relative(ROOT, SERVER_ENTRY)}); build the mcp package first`,
    );
  }
  let Client: typeof import("@modelcontextprotocol/sdk/client/index.js").Client;
  let StdioClientTransport: typeof import("@modelcontextprotocol/sdk/client/stdio.js").StdioClientTransport;
  try {
    ({ Client } = await import("@modelcontextprotocol/sdk/client/index.js"));
    ({ StdioClientTransport } =
      await import("@modelcontextprotocol/sdk/client/stdio.js"));
  } catch (error) {
    throw new Error(
      `cannot load @modelcontextprotocol/sdk, needed to check the server: ${error instanceof Error ? error.message : error}`,
    );
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
  });
  const client = new Client(
    { name: "webcrack-eval-dry-run", version: "0.0.0" },
    { capabilities: {} },
  );
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools ?? [];
    const missing = findMissingTools(
      tools.map((tool) => tool.name),
      REQUIRED_SERVER_TOOLS,
    );
    if (missing.length > 0) {
      throw new Error(
        `server is missing required tools: ${missing.join(", ")} (got: ${tools.map((tool) => tool.name).join(", ") || "none"})`,
      );
    }
    console.log(
      `server check passed: ${path.relative(ROOT, SERVER_ENTRY)} serves ${tools.length} tools (wc_open, wc_trace present)`,
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("server ")) throw error;
    throw new Error(
      `server failed to start (${path.relative(ROOT, SERVER_ENTRY)}): ${error instanceof Error ? error.message : error}`,
    );
  } finally {
    await client.close().catch(() => {});
  }
}

async function dryRun(options: Pick<Options, "only" | "set">): Promise<void> {
  const tasks = loadTasks();
  const selected = selectTasks(tasks, options);
  if (!existsSync(MCP_CONFIG)) throw new Error(`missing ${MCP_CONFIG}`);
  JSON.parse(readFileSync(MCP_CONFIG, "utf8") as string);
  const v1 = selected.filter((t) => t.set === "v1").length;
  const v2 = selected.filter((t) => t.set === "v2").length;
  console.log(
    `tasks: ${selected.length}/${tasks.length} valid (set=${options.set}: v1=${v1} v2=${v2}), all samples exist`,
  );
  for (const task of selected) {
    console.log(`  ok [${task.set}] ${task.id} (${task.sample})`);
  }
  await checkServerBuild();
  console.log("dry-run: server checked, `claude` not spawned");
}

async function realRun(options: Options): Promise<void> {
  const tasks = loadTasks();
  const selected = selectTasks(tasks, options);
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
  const bySet = aggregateBySet(outcomes, date, commit);
  const sets = (["v1", "v2"] as const).filter((set) => bySet[set].total > 0);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const jsonPath = path.join(RESULTS_DIR, `${date}-${commit}.json`);
  writeFileSync(jsonPath, `${JSON.stringify({ summary, bySet, outcomes }, null, 2)}\n`);
  if (!existsSync(RESULTS_MD)) {
    writeFileSync(RESULTS_MD, `# Eval results (M1.8 / M2.6)\n\n${RESULTS_HEADER}\n`);
  }
  for (const set of sets) {
    appendFileSync(RESULTS_MD, `${formatResultsRow(bySet[set])}\n`);
  }
  console.log(
    `solved ${summary.solved}/${summary.total} (${summary.successPct.toFixed(1)}%), ` +
      sets.map((set) => `${set} ${bySet[set].solved}/${bySet[set].total}`).join(", ") +
      `, median tool calls ${summary.medianToolCalls} -> ${jsonPath}`,
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!("dryRun" in options)) {
    const narrow = options as { error: string };
    console.error(`usage: run.ts [--dry-run] [--set v1|v2|all] [--only <id>] [--concurrency N] [--timeout-ms N]\n${narrow.error}`);
    process.exitCode = 1;
    return;
  }
  if (options.dryRun) {
    await dryRun(options);
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
