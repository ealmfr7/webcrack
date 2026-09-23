import type { Node, TraverseOptions, Visitor } from '@babel/traverse';
import traverse, { visitors } from '@babel/traverse';
import debug from 'debug';
import { diffLines, getTracer } from '../trace';
import { generate } from './generator';

const logger = debug('webcrack:transforms');

export async function applyTransformAsync<TOptions>(
  ast: Node,
  transform: AsyncTransform<TOptions>,
  options?: TOptions,
): Promise<TransformState> {
  logger(`${transform.name}: started`);
  const state: TransformState = { changes: 0 };
  const tracer = getTracer();
  // generate() is only called when a tracer is active (zero overhead otherwise)
  const before = tracer === null ? undefined : generate(ast);

  await transform.run?.(ast, state, options);
  if (transform.visitor)
    traverse(ast, transform.visitor(options), undefined, state);

  logger(`${transform.name}: finished with ${state.changes} changes`);
  if (tracer !== null && before !== undefined) {
    tracer({
      name: transform.name,
      changes: state.changes,
      diff: diffLines(before, generate(ast)),
    });
  }
  return state;
}

export function applyTransform<TOptions>(
  ast: Node,
  transform: Transform<TOptions>,
  options?: TOptions,
): TransformState {
  logger(`${transform.name}: started`);
  const state: TransformState = { changes: 0 };
  const tracer = getTracer();
  // generate() is only called when a tracer is active (zero overhead otherwise)
  const before = tracer === null ? undefined : generate(ast);
  transform.run?.(ast, state, options);

  if (transform.visitor) {
    const visitor = transform.visitor(
      options,
    ) as TraverseOptions<TransformState>;
    visitor.noScope = !transform.scope;
    traverse(ast, visitor, undefined, state);
  }

  logger(`${transform.name}: finished with ${state.changes} changes`);
  if (tracer !== null && before !== undefined) {
    tracer({
      name: transform.name,
      changes: state.changes,
      diff: diffLines(before, generate(ast)),
    });
  }
  return state;
}

export function applyTransforms(
  ast: Node,
  transforms: Transform[],
  options: { noScope?: boolean; name?: string; log?: boolean } = {},
): TransformState {
  options.log ??= true;
  const name = options.name ?? transforms.map((t) => t.name).join(', ');
  if (options.log) logger(`${name}: started`);
  const state: TransformState = { changes: 0 };
  const tracer = getTracer();
  // generate() is only called when a tracer is active (zero overhead otherwise).
  // Visitors are merged into a single traversal, so one entry is recorded
  // per merged batch under the batch name.
  const before = tracer === null ? undefined : generate(ast);

  for (const transform of transforms) {
    transform.run?.(ast, state);
  }

  const traverseOptions = transforms.flatMap((t) => t.visitor?.() ?? []);
  if (traverseOptions.length > 0) {
    const visitor: TraverseOptions<TransformState> =
      visitors.merge(traverseOptions);
    visitor.noScope = options.noScope || transforms.every((t) => !t.scope);
    traverse(ast, visitor, undefined, state);
  }

  if (options.log) logger(`${name}: finished with ${state.changes} changes`);
  if (tracer !== null && before !== undefined) {
    tracer({
      name,
      changes: state.changes,
      diff: diffLines(before, generate(ast)),
    });
  }
  return state;
}

export function mergeTransforms(options: {
  name: string;
  tags: Tag[];
  transforms: Transform[];
}): Transform {
  return {
    name: options.name,
    tags: options.tags,
    scope: options.transforms.some((t) => t.scope),
    visitor() {
      return visitors.merge(
        options.transforms.flatMap((t) => t.visitor?.() ?? []),
      );
    },
  };
}

export interface TransformState {
  changes: number;
}

export interface Transform<TOptions = unknown> {
  name: string;
  tags: Tag[];
  scope?: boolean;
  run?: (ast: Node, state: TransformState, options?: TOptions) => void;
  visitor?: (options?: TOptions) => Visitor<TransformState>;
}

export interface AsyncTransform<TOptions = unknown> extends Omit<
  Transform<TOptions>,
  'run'
> {
  run?: (ast: Node, state: TransformState, options?: TOptions) => Promise<void>;
}

export type Tag = 'safe' | 'unsafe';
