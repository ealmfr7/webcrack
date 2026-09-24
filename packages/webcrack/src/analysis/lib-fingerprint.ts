import * as t from '@babel/types';
import { matcher } from '@codemod/matchers';
import type { Matcher } from '@codemod/matchers';
import { createHash } from 'node:crypto';
import type { Bundle } from '../unpack/bundle';
import { SIGNATURES } from './signatures/index';

/**
 * A known library module: its structural hash plus the metadata needed to
 * identify it. Stored as JSON under `./signatures/` (see `README.md` there).
 */
export interface LibrarySignature {
  /** Library name, e.g. `tiny-hash`. */
  library: string;
  /** Library version the signature was taken from, if known. */
  version?: string;
  /**
   * Mapping key for this module, e.g. `tiny-hash/crc32.js`. Usable directly
   * as a webcrack `mappings` key (`Bundle.applyMappings` resolves it under
   * `node_modules/`).
   */
  path: string;
  /** Hex sha256 returned by {@link fingerprint} for the module AST. */
  hash: string;
  /** Original module source the hash was built from. */
  source: string;
}

/**
 * A suggested library identification for one bundle module. The `path` is
 * usable directly as a webcrack `mappings` key (see {@link toMappings}).
 */
export interface LibraryMatch {
  /** Id of the matched module inside the bundle. */
  moduleId: string;
  /** Library name, e.g. `tiny-hash`. */
  library: string;
  /** Library version, when the matched signature records one. */
  version?: string;
  /** Suggested mapping key, e.g. `tiny-hash/crc32.js`. */
  path: string;
  /** 1 for an exact structural-hash match (0..1 scale for future fuzzy use). */
  confidence: number;
}

/**
 * Strings longer than this are replaced by a length placeholder: long
 * embedded blobs (tables, license text) would otherwise dominate the hash
 * while carrying no structural meaning. Short strings are kept verbatim
 * because they are semantic (`'use strict'`, require specifiers, operators
 * written as strings).
 */
const MAX_SHORT_STRING = 32;

/**
 * Node fields with no structural meaning: source positions, attached
 * comments and the raw text of literals (`extra.raw`, so `0x10` and `16`
 * hash the same).
 */
const META_KEYS = new Set([
  'loc',
  'start',
  'end',
  'leadingComments',
  'trailingComments',
  'innerComments',
  'extra',
]);

function isNode(value: unknown): value is t.Node {
  if (typeof value !== 'object' || value === null) return false;
  return 'type' in value && typeof value.type === 'string';
}

/**
 * Whether an `Identifier` in this position survives minification and is
 * therefore kept. Minifiers rename local bindings but must preserve
 * non-computed member/object/class property names (`obj.prop`,
 * `{ key: … }`, methods), so those are kept while everything else
 * (declarations, references, function/class ids, labels) is stripped.
 */
function keepName(
  parent: t.Node | undefined,
  key: string | undefined,
): boolean {
  if (!parent || key === undefined) return false;
  if (
    (t.isMemberExpression(parent) || t.isOptionalMemberExpression(parent)) &&
    key === 'property' &&
    parent.computed === false
  ) {
    return true;
  }
  if (
    key === 'key' &&
    (t.isObjectProperty(parent) ||
      t.isObjectMethod(parent) ||
      t.isClassMethod(parent) ||
      t.isClassProperty(parent))
  ) {
    return parent.computed !== true;
  }
  return false;
}

function writeString(value: string, out: string[]): void {
  if (value.length <= MAX_SHORT_STRING) {
    out.push(`s${JSON.stringify(value)}`);
  } else {
    out.push(`l${value.length}`);
  }
}

function writeValue(
  value: unknown,
  parent: t.Node | undefined,
  key: string | undefined,
  out: string[],
): void {
  if (Array.isArray(value)) {
    out.push('[');
    value.forEach((item, index) => {
      if (index > 0) out.push(',');
      writeValue(item, parent, key, out);
    });
    out.push(']');
    return;
  }
  if (isNode(value)) {
    writeNode(value, parent, key, out);
    return;
  }
  if (typeof value === 'string') {
    writeString(value, out);
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    out.push(JSON.stringify(value));
    return;
  }
  if (typeof value === 'bigint') {
    out.push(`${String(value)}n`);
    return;
  }
  if (value === null) {
    out.push('null');
    return;
  }
  // undefined, functions and symbols carry no structural meaning.
}

function writeNode(
  node: t.Node,
  parent: t.Node | undefined,
  key: string | undefined,
  out: string[],
): void {
  // Binding names are stripped (minifiers rename them); property-position
  // names are kept (minifiers must preserve them).
  if (t.isIdentifier(node)) {
    out.push(keepName(parent, key) ? `I${JSON.stringify(node.name)}` : 'I');
    return;
  }
  if (t.isJSXIdentifier(node)) {
    out.push(`J${JSON.stringify(node.name)}`);
    return;
  }
  // Private names (`#x`) can be renamed as a unit, so only keep the shape.
  if (t.isPrivateName(node)) {
    out.push('P');
    return;
  }
  if (t.isStringLiteral(node) || t.isDirectiveLiteral(node)) {
    out.push(`{${node.type};`);
    writeString(node.value, out);
    out.push('}');
    return;
  }
  if (t.isTemplateElement(node)) {
    out.push(`{TemplateElement;tail=${node.tail ? '1' : '0'};`);
    const cooked = node.value.cooked;
    if (typeof cooked === 'string') writeString(cooked, out);
    else out.push('null');
    out.push('}');
    return;
  }
  // Numeric values (not raw text) so hex/octal/binary spellings agree.
  if (t.isNumericLiteral(node)) {
    out.push(`{NumericLiteral;n=${JSON.stringify(node.value)}}`);
    return;
  }
  out.push(`{${node.type}`);
  for (const field of Object.keys(node).sort()) {
    // `sourceType` is a parser option artifact, not code structure.
    if (field === 'type' || field === 'sourceType' || META_KEYS.has(field)) {
      continue;
    }
    const fieldValue: unknown = (node as unknown as Record<string, unknown>)[
      field
    ];
    if (fieldValue === undefined) continue;
    out.push(`;${field}=`);
    writeValue(fieldValue, node, field, out);
  }
  out.push('}');
}

/**
 * Structural hash of a module or function AST, stable under minification:
 * identifier bindings, comments, formatting and long string contents are
 * stripped while node types, shape, operators, property names and short
 * literals are kept. A `File` hashes as its `Program`, so wrapped and
 * unwrapped forms of the same code agree.
 */
export function fingerprint(node: t.Node): string {
  const out: string[] = [];
  writeNode(t.isFile(node) ? node.program : node, undefined, undefined, out);
  return createHash('sha256').update(out.join('')).digest('hex');
}

/**
 * Suggest library identifications for the modules of a bundle by exact
 * structural-hash lookup. Results are sorted by `moduleId`. The returned
 * `path` values are usable directly as webcrack `mappings` keys, e.g. via
 * {@link toMappings}.
 */
export function matchModules(
  bundle: Bundle,
  db: LibrarySignature[] = SIGNATURES,
): LibraryMatch[] {
  const byHash = new Map<string, LibrarySignature>();
  for (const signature of db) {
    if (!byHash.has(signature.hash)) byHash.set(signature.hash, signature);
  }
  const matches: LibraryMatch[] = [];
  for (const module of bundle.modules.values()) {
    const signature = byHash.get(fingerprint(module.ast));
    if (signature) {
      matches.push({
        moduleId: module.id,
        library: signature.library,
        version: signature.version,
        path: signature.path,
        confidence: 1,
      });
    }
  }
  matches.sort((a, b) => (a.moduleId < b.moduleId ? -1 : 1));
  return matches;
}

/**
 * Convert matches to webcrack `mappings` (`Record<path, Matcher>`) for
 * `Bundle.applyMappings`: each mapping matches the root (`Program`) of a
 * module whose structural hash equals a signature recorded under that path.
 * At most one mapping per path is produced (first match wins); callers with
 * duplicate library copies in one bundle should dedupe matches first,
 * otherwise `applyMappings` throws `Mapping <path> is already used.`
 */
export function toMappings(
  matches: LibraryMatch[],
  db: LibrarySignature[] = SIGNATURES,
): Record<string, Matcher<unknown>> {
  const hashesByPath = new Map<string, Set<string>>();
  for (const signature of db) {
    let hashes = hashesByPath.get(signature.path);
    if (!hashes) {
      hashes = new Set();
      hashesByPath.set(signature.path, hashes);
    }
    hashes.add(signature.hash);
  }
  const mappings: Record<string, Matcher<unknown>> = {};
  for (const match of matches) {
    if (match.path in mappings) continue;
    const hashes = hashesByPath.get(match.path) ?? new Set<string>();
    mappings[match.path] = matcher(
      (node: unknown) =>
        isNode(node) &&
        (t.isFile(node) || t.isProgram(node)) &&
        hashes.has(fingerprint(node)),
    );
  }
  return mappings;
}
