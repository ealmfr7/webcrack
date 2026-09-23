/**
 * An error whose message is shown to the agent as-is. Messages must say what
 * went wrong *and* what to do next (a valid value, a similar name, a tool).
 */
export class WcError extends Error {
  constructor(
    message: string,
    readonly suggestions: string[] = [],
  ) {
    super(message);
    this.name = 'WcError';
  }
}

export function notImplemented(task: string): never {
  throw new WcError(`Not implemented yet (ROADMAP_MCP.md task ${task}).`);
}

/**
 * Up to `max` candidates closest to `name`: prefix/substring matches first,
 * then by edit distance.
 */
export function suggest(
  name: string,
  candidates: Iterable<string>,
  max = 5,
): string[] {
  const needle = name.toLowerCase();
  const scored: [string, number][] = [];
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    const score = lower.includes(needle)
      ? 0
      : levenshtein(needle, lower) / Math.max(needle.length, lower.length);
    if (score <= 0.5) scored.push([candidate, score]);
  }
  return scored
    .sort((a, b) => a[1] - b[1] || a[0].length - b[0].length)
    .slice(0, max)
    .map(([candidate]) => candidate);
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[b.length];
}
