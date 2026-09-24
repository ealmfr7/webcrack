// Unit tests for the M1.8 eval harness pure logic.
// These tests never spawn `claude`: the stream-json parser runs on a
// hand-written fixture, and the task-file test only reads tasks.jsonl.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  aggregate,
  aggregateBySet,
  formatResultsRow,
  median,
  parseStreamJson,
  parseTasksJsonl,
  RESULTS_HEADER,
  runCheck,
  validateSamples,
  type Check,
  type TaskOutcome,
} from "./lib.ts";

const EVALS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(EVALS_DIR, "..", "..", "..");
const CORPUS_DIR = path.join(ROOT, "packages/webcrack/test/corpus");

describe("runCheck", () => {
  it("matches contains case-insensitively", () => {
    const check: Check = { type: "contains", value: "webpack" };
    expect(runCheck(check, "This is a Webpack bundle")).toBe(true);
    expect(runCheck(check, "This is a Rollup bundle")).toBe(false);
  });

  it("matches regex case-insensitively", () => {
    const check: Check = { type: "regex", value: "3\\s+modules?" };
    expect(runCheck(check, "contains 3 modules")).toBe(true);
    expect(runCheck(check, "contains 3 MODULES total")).toBe(true);
    expect(runCheck(check, "contains 12 modules")).toBe(false);
  });

  it("combines with all-of and any-of", () => {
    const all: Check = {
      type: "all-of",
      checks: [
        { type: "contains", value: "metro" },
        { type: "contains", value: "index.js" },
      ],
    };
    expect(runCheck(all, "metro bundle, entry index.js")).toBe(true);
    expect(runCheck(all, "metro bundle, entry main.js")).toBe(false);

    const any: Check = {
      type: "any-of",
      checks: [
        { type: "contains", value: "alpha" },
        { type: "contains", value: "beta" },
      ],
    };
    expect(runCheck(any, "has beta")).toBe(true);
    expect(runCheck(any, "has neither")).toBe(false);
  });
});

describe("parseTasksJsonl", () => {
  it("accepts valid tasks and rejects bad lines", () => {
    const text = [
      `{"id":"a","sample":"x.js","prompt":"p","check":{"type":"contains","value":"v"}}`,
      ``,
      `not json`,
      `{"id":"a","sample":"y.js","prompt":"p","check":{"type":"contains","value":"v"}}`,
      `{"id":"b","sample":"y.js","prompt":"p","check":{"type":"bogus","value":"v"}}`,
      `{"id":"c","sample":"y.js","prompt":"p","check":{"type":"regex","value":"(["}}`,
      `{"id":"d","sample":"y","prompt":"p","check":{"type":"contains","value":"v"}}`,
      `{"id":"e","sample":"y.js","prompt":"p","check":{"type":"all-of","checks":[]}}`,
    ].join("\n");
    const { tasks, errors } = parseTasksJsonl(text);
    expect(tasks.map((t) => t.id)).toEqual(["a"]);
    expect(errors).toHaveLength(6);
  });

  it("every task in tasks.jsonl is valid and its sample exists", () => {
    const text = readFileSync(path.join(EVALS_DIR, "tasks.jsonl"), "utf8");
    const { tasks, errors } = parseTasksJsonl(text);
    expect(errors).toEqual([]);
    expect(tasks.length).toBeGreaterThanOrEqual(20);
    expect(tasks.filter((t) => t.set === "v1").length).toBeGreaterThanOrEqual(13);
    expect(tasks.filter((t) => t.set === "v2").length).toBeGreaterThanOrEqual(7);
    expect(
      validateSamples(tasks, (sample) => existsSync(path.join(CORPUS_DIR, sample))),
    ).toEqual([]);
    for (const task of tasks) {
      expect(task.prompt).toContain(`packages/webcrack/test/corpus/${task.sample}`);
      expect(["v1", "v2"]).toContain(task.set);
    }
  });

  it("defaults a missing set to v1 and rejects unknown sets", () => {
    const { tasks, errors } = parseTasksJsonl(
      [
        `{"id":"a","sample":"x.js","prompt":"p","check":{"type":"contains","value":"v"}}`,
        `{"id":"b","sample":"y.js","prompt":"p","set":"v2","check":{"type":"contains","value":"v"}}`,
      ].join("\n"),
    );
    expect(errors).toEqual([]);
    expect(tasks.map((t) => t.set)).toEqual(["v1", "v2"]);

    const bad = parseTasksJsonl(
      `{"id":"c","sample":"y.js","prompt":"p","set":"v3","check":{"type":"contains","value":"v"}}`,
    );
    expect(bad.tasks).toEqual([]);
    expect(bad.errors).toHaveLength(1);
    expect(bad.errors[0]).toContain('"set"');
  });

  it("reports missing samples", () => {
    const { tasks } = parseTasksJsonl(
      `{"id":"a","sample":"nope.js","prompt":"p","check":{"type":"contains","value":"v"}}`,
    );
    expect(validateSamples(tasks, () => false)).toHaveLength(1);
  });
});

const FIXTURE_STREAM = [
  `{"type":"system","subtype":"init","session_id":"s1"}`,
  `{"type":"assistant","message":{"content":[{"type":"text","text":"looking"},{"type":"tool_use","id":"1","name":"mcp__webcrack__wc_open","input":{}}]}}`,
  `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"2","name":"mcp__webcrack__wc_read","input":{}},{"type":"tool_use","id":"3","name":"Read","input":{}}]}}`,
  `not json {{{`,
  ``,
  `{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}`,
  `{"type":"result","subtype":"success","result":"It is a webpack bundle with 3 modules","num_turns":4,"total_cost_usd":0.0123,"usage":{"input_tokens":1000,"output_tokens":50}}`,
].join("\n");

describe("parseStreamJson", () => {
  it("counts tool calls split by webcrack vs other and reads the result event", () => {
    const parsed = parseStreamJson(FIXTURE_STREAM);
    expect(parsed.webcrackCalls).toBe(2);
    expect(parsed.otherCalls).toBe(1);
    expect(parsed.toolCalls).toBe(3);
    expect(parsed.numTurns).toBe(4);
    expect(parsed.inputTokens).toBe(1000);
    expect(parsed.outputTokens).toBe(50);
    expect(parsed.totalCostUsd).toBeCloseTo(0.0123);
    expect(parsed.resultText).toBe("It is a webpack bundle with 3 modules");
    expect(parsed.hasResult).toBe(true);
  });

  it("reports no result when the stream has none", () => {
    const parsed = parseStreamJson(`{"type":"assistant","message":{"content":[]}}\n`);
    expect(parsed.hasResult).toBe(false);
    expect(parsed.toolCalls).toBe(0);
  });

  it("keeps the final result event", () => {
    const parsed = parseStreamJson(
      `{"type":"result","result":"first","num_turns":1}\n{"type":"result","result":"last","num_turns":2}\n`,
    );
    expect(parsed.resultText).toBe("last");
    expect(parsed.numTurns).toBe(2);
  });
});

function outcome(partial: Partial<TaskOutcome> & { id: string }): TaskOutcome {
  return {
    passed: false,
    toolCalls: 0,
    webcrackCalls: 0,
    otherCalls: 0,
    numTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalCostUsd: 0,
    ...partial,
  };
}

describe("aggregate", () => {
  it("computes success rate, median tool calls and token totals", () => {
    const summary = aggregate(
      [
        outcome({ id: "a", passed: true, toolCalls: 4, inputTokens: 10, outputTokens: 2, totalCostUsd: 0.01 }),
        outcome({ id: "b", passed: false, toolCalls: 12, inputTokens: 20, outputTokens: 4, totalCostUsd: 0.03 }),
        outcome({ id: "c", passed: true, toolCalls: 8, inputTokens: 30, outputTokens: 6, totalCostUsd: 0.05 }),
      ],
      "2026-09-24",
      "abc1234",
    );
    expect(summary.total).toBe(3);
    expect(summary.solved).toBe(2);
    expect(summary.successPct).toBeCloseTo(66.666, 2);
    expect(summary.medianToolCalls).toBe(8);
    expect(summary.totalInputTokens).toBe(60);
    expect(summary.totalOutputTokens).toBe(12);
    expect(summary.totalCostUsd).toBeCloseTo(0.09);
  });

  it("handles the empty list", () => {
    const summary = aggregate([], "2026-09-24", "abc1234");
    expect(summary.successPct).toBe(0);
    expect(summary.medianToolCalls).toBe(0);
  });
});

describe("median", () => {
  it("handles odd, even and empty inputs", () => {
    expect(median([8])).toBe(8);
    expect(median([4, 12])).toBe(8);
    expect(median([12, 4, 8])).toBe(8);
    expect(median([])).toBe(0);
  });
});

describe("aggregateBySet", () => {
  it("groups outcomes per set and always returns both keys", () => {
    const bySet = aggregateBySet(
      [
        outcome({ id: "a", set: "v1", passed: true, toolCalls: 4 }),
        outcome({ id: "b", set: "v1", passed: false, toolCalls: 12 }),
        outcome({ id: "c", set: "v2", passed: true, toolCalls: 8 }),
      ],
      "2026-09-24",
      "abc1234",
    );
    expect(bySet.v1.total).toBe(2);
    expect(bySet.v1.solved).toBe(1);
    expect(bySet.v1.set).toBe("v1");
    expect(bySet.v2.total).toBe(1);
    expect(bySet.v2.solved).toBe(1);
    expect(bySet.v2.set).toBe("v2");
    expect(bySet.v2.medianToolCalls).toBe(8);
  });

  it("counts outcomes without a set as v1", () => {
    const bySet = aggregateBySet(
      [outcome({ id: "a", passed: true })],
      "2026-09-24",
      "abc1234",
    );
    expect(bySet.v1.total).toBe(1);
    expect(bySet.v2.total).toBe(0);
    expect(bySet.v2.successPct).toBe(0);
  });
});

describe("formatResultsRow", () => {
  it("produces a row with the same column count as the header", () => {
    const summary = aggregate(
      [outcome({ id: "a", passed: true, toolCalls: 5, inputTokens: 7, outputTokens: 3, totalCostUsd: 0.02 })],
      "2026-09-24",
      "abc1234",
    );
    const row = formatResultsRow(summary);
    const columns = (line: string): number => line.split("|").length;
    expect(columns(row)).toBe(columns(RESULTS_HEADER));
    expect(row).toContain("1/1 (100.0%)");
    expect(row).toContain("2026-09-24");
  });

  it("includes the set in the row", () => {
    const bySet = aggregateBySet(
      [outcome({ id: "a", set: "v2", passed: true })],
      "2026-09-24",
      "abc1234",
    );
    const row = formatResultsRow(bySet.v2);
    const columns = (line: string): number => line.split("|").length;
    expect(columns(row)).toBe(columns(RESULTS_HEADER));
    expect(row).toContain("v2");
    expect(RESULTS_HEADER).toContain("Set");
  });
});
