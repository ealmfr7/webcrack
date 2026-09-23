import type { Binding, Node, Scope } from '@babel/traverse';
import traverse from '@babel/traverse';
import { isValidIdentifier } from '@babel/types';
import { codePreview } from '../ast-utils/generator';
import { generateUid } from '../ast-utils/scope';

/**
 * One binding offered to the name-suggestion callback.
 */
export interface LLMBindingInfo {
  /** Current (mangled/short) name of the binding. */
  name: string;
  /** Binding kind (`param`, `const`, `let`, `var`, `hoisted`, `local`, ...). */
  kind: string;
  /** Short code snippet around the binding's declaration. */
  context: string;
  /** Type of the block that owns the binding's scope. */
  scopeType: string;
}

/**
 * User-supplied async callback (the CLI/MCP layer provides one backed by an
 * LLM, tests provide a fake). Receives one batch of bindings and returns a
 * map of current name -> suggested name. Unknown keys and invalid values are
 * ignored. No network access happens here; this module only orchestrates.
 */
export type SuggestNames = (
  batch: LLMBindingInfo[],
) => Promise<Record<string, string>>;

export interface RenameLLMOptions {
  suggestNames: SuggestNames;
  /** Max bindings per `suggestNames` call. Defaults to 20. */
  batchSize?: number;
  /** Return false to exclude a binding from renaming. */
  filter?: (info: LLMBindingInfo) => boolean;
}

export interface RenameLogEntry {
  from: string;
  to: string;
  kind: string;
}

const DEFAULT_BATCH_SIZE = 20;

// Mirrors the minified-name rule in rename-heuristics.ts: only short or
// machine-generated names are candidates. Already-descriptive names are
// never offered to the callback.
const MINIFIED_PATTERNS = [
  /^_0x[0-9a-f]+$/i, // javascript-obfuscator identifiers
  /^\$[a-zA-Z0-9_$]*$/, // $a, $$, ...
  /^[a-zA-Z_$][a-zA-Z0-9_$]*\$\d+$/, // e$1, foo$2 (bundler scope joins)
];

function isMangledName(name: string): boolean {
  return (
    name.length <= 2 || MINIFIED_PATTERNS.some((pattern) => pattern.test(name))
  );
}

// Mirrors the export guard in rename-heuristics.ts: renaming an export (or a
// binding referenced by one) would break importers.
function isExported(binding: Binding): boolean {
  if (
    binding.path.findParent(
      (parent) =>
        parent.isExportNamedDeclaration() ||
        parent.isExportDefaultDeclaration(),
    )
  )
    return true;
  return binding.referencePaths.some(
    (reference) =>
      reference.isExportNamedDeclaration() ||
      reference.isExportDefaultDeclaration(),
  );
}

interface Candidate {
  binding: Binding;
  kind: string;
  scopeType: string;
  order: number;
}

function collectCandidates(ast: Node): Candidate[] {
  const seenScopes = new Set<Scope>();
  const seenBindings = new Set<Binding>();
  const candidates: Candidate[] = [];
  let order = 0;

  traverse(ast, {
    enter(path) {
      const scope = path.scope;
      if (!scope || seenScopes.has(scope)) return;
      seenScopes.add(scope);
      for (const binding of Object.values(scope.bindings)) {
        if (seenBindings.has(binding)) continue;
        seenBindings.add(binding);
        const name = binding.identifier.name;
        // Globals never appear in scope bindings; import bindings keep
        // their (meaningful) module names and named imports cannot be
        // renamed without breaking the import.
        if (binding.kind === 'module') continue;
        if (!isMangledName(name)) continue;
        if (isExported(binding)) continue;
        candidates.push({
          binding,
          kind: binding.kind,
          scopeType: scope.block.type,
          order: order++,
        });
      }
    },
  });

  // Deterministic order: source position, then collection order.
  candidates.sort((a, b) => {
    const aStart = a.binding.identifier.loc?.start;
    const bStart = b.binding.identifier.loc?.start;
    if (aStart && bStart) {
      if (aStart.line !== bStart.line) return aStart.line - bStart.line;
      if (aStart.column !== bStart.column) return aStart.column - bStart.column;
    } else if (aStart !== bStart) {
      return aStart ? -1 : 1;
    }
    return a.order - b.order;
  });

  return candidates;
}

function toInfo(candidate: Candidate): LLMBindingInfo {
  return {
    name: candidate.binding.identifier.name,
    kind: candidate.kind,
    context: codePreview(candidate.binding.path.node),
    scopeType: candidate.scopeType,
  };
}

/**
 * Rename short/mangled bindings using names from a user-supplied async
 * callback. No LLM SDK or network dependency: the caller provides
 * `suggestNames` (the CLI/MCP layer will supply an LLM-backed one later).
 *
 * Candidates are offered to the callback in batches. Each batch is applied
 * atomically: if the callback throws for a batch, that batch is skipped and
 * the AST is left unchanged by it, while other batches still apply.
 * Suggestions are validated (valid, non-reserved identifiers only),
 * collision-safe (suffixed via `generateUid` when taken) and applied with
 * `scope.rename`, which keeps shadowing correct. Returns a deterministic
 * rename log in application order.
 */
export async function renameWithLLM(
  ast: Node,
  options: RenameLLMOptions,
): Promise<RenameLogEntry[]> {
  const batchSize = Math.max(
    1,
    Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE) || DEFAULT_BATCH_SIZE,
  );
  const log: RenameLogEntry[] = [];
  const renamed = new Set<Binding>();

  let candidates = collectCandidates(ast);
  if (options.filter) {
    const filter = options.filter;
    candidates = candidates.filter((candidate) => filter(toInfo(candidate)));
  }

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const infos = batch.map(toInfo);

    let suggestions: Record<string, string>;
    try {
      suggestions = await options.suggestNames(infos);
    } catch {
      // Atomic per batch: a failing callback leaves this batch unapplied.
      continue;
    }
    if (!suggestions || typeof suggestions !== 'object') continue;

    for (const [oldName, desired] of Object.entries(suggestions)) {
      if (typeof desired !== 'string' || !isValidIdentifier(desired)) continue;
      if (desired === oldName) continue;
      for (const candidate of batch) {
        const { binding } = candidate;
        if (renamed.has(binding)) continue;
        if (binding.identifier.name !== oldName) continue;
        const newName = generateUid(binding.scope, desired);
        if (newName === oldName) continue;
        binding.scope.rename(oldName, newName);
        renamed.add(binding);
        log.push({ from: oldName, to: newName, kind: candidate.kind });
      }
    }
  }

  return log;
}
