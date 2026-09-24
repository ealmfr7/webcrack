import type { Workspace } from './types';

export interface ApproximateMatch {
  module: string;
  line: number;
  kind: 'definition' | 'use';
  code: string;
}

/** Bounded text fallback for names the exact index cannot resolve. */
export function approximateSymbolMatches(
  ws: Workspace,
  spec: string,
  limit = 8,
): ApproximateMatch[] {
  const colon = spec.lastIndexOf(':');
  const moduleName = colon < 0 ? undefined : spec.slice(0, colon);
  const name = (colon < 0 ? spec : spec.slice(colon + 1))
    .replace(/@\d+$/, '')
    .split('.')
    .at(-1);
  if (name === undefined || !/^[A-Za-z_$][\w$]*$/.test(name)) return [];
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const definition = new RegExp(
    `(?:\\b(?:function|class)\\s+${escaped}\\b|(?:\\.|\\b)${escaped}\\s*=(?![=>])|\\b${escaped}\\s*:\\s*(?:async\\s+)?function\\b|\\b${escaped}\\s*\\([^)]*\\)\\s*\\{)`,
  );
  const usage = new RegExp(`(?:\\.|\\b)${escaped}\\s*\\(`);
  const definitions: ApproximateMatch[] = [];
  const uses: ApproximateMatch[] = [];
  for (const entry of ws.modules.values()) {
    if (moduleName !== undefined && entry.path !== moduleName) continue;
    const lines = entry.code.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const source = lines[i];
      if (source === undefined) continue;
      const kind = definition.test(source)
        ? 'definition'
        : usage.test(source)
          ? 'use'
          : undefined;
      if (kind === undefined) continue;
      const match: ApproximateMatch = {
        module: entry.path,
        line: i + 1,
        kind,
        code: source.trim(),
      };
      if (kind === 'definition' && definitions.length < limit)
        definitions.push(match);
      if (kind === 'use' && uses.length < limit) uses.push(match);
    }
    if (definitions.length >= limit && uses.length >= limit) break;
  }
  return [...definitions, ...uses].slice(0, limit);
}
