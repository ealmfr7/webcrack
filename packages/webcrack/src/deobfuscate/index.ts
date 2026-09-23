import traverse from '@babel/traverse';
import debug from 'debug';
import type { AsyncTransform } from '../ast-utils';
import {
  applyTransform,
  applyTransformAsync,
  applyTransforms,
} from '../ast-utils';
import mergeStrings from '../unminify/transforms/merge-strings';
import { findArrayRotator } from './array-rotator';
import constantFolding from './constant-folding';
import controlFlowObject from './control-flow-object';
import controlFlowSwitch from './control-flow-switch';
import deadCode from './dead-code';
import opaquePredicates from './opaque-predicates';
import { findDecoders } from './decoder';
import encodedPayload from './encoded-payload';
import jjencode from './jjencode';
import aaencode from './aaencode';
import evalUnwrap from './eval-unwrap';
import genericDecoders from './generic-decoders';
import inlineDecodedStrings from './inline-decoded-strings';
import inlineDecoderWrappers from './inline-decoder-wrappers';
import inlineObjectProps from './inline-object-props';
import packer from './packer';
import { findStringArray } from './string-array';
import type { Sandbox } from './vm';
import { VMDecoder, createBrowserSandbox, createNodeSandbox } from './vm';

export { createBrowserSandbox, createNodeSandbox, type Sandbox };

// Upper bound on fixpoint iterations of the deobfuscation pipeline.
// Each iteration must make at least one change to continue.
export const MAX_ITERATIONS = 10;

// https://astexplorer.net/#/gist/b1018df4a8daebfcb1daf9d61fe17557/4ff9ad0e9c40b9616956f17f59a2d9888cd62a4f

export default {
  name: 'deobfuscate',
  tags: ['unsafe'],
  scope: true,
  async run(ast, state, sandbox) {
    // Unwrap packing/eval layers first, repeated until an iteration yields
    // no changes. `encodedPayload` evaluates encoded (JSFuck/JJEncode/
    // AAEncode) payloads in the sandbox and rewrites them as
    // `Function("...")()` calls for `evalUnwrap` to splice on the next
    // iteration. It is async, so it runs as its own step; without a
    // sandbox it is a no-op and the loop behaves as before.
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const changesBeforeUnwrap = state.changes;
      state.changes += applyTransforms(ast, [packer, evalUnwrap]).changes;
      if (sandbox) {
        for (const t of [encodedPayload, jjencode, aaencode])
          state.changes += (await applyTransformAsync(ast, t, sandbox)).changes;
      }
      if (state.changes === changesBeforeUnwrap) break;
    }
    if (state.changes > 0) {
      traverse(ast, {
        Program(path) {
          path.scope.crawl();
          path.stop();
        },
      });
    }

    if (!sandbox) return;

    const logger = debug('webcrack:deobfuscate');

    // String-array detection and removal happens only once. When no
    // string array is found these steps are skipped and the cleanup
    // passes in the loop below still run.
    const stringArray = findStringArray(ast);
    logger(
      stringArray
        ? `String Array: ${stringArray.originalName}, length ${stringArray.length}`
        : 'String Array: no',
    );

    if (stringArray) {
      const rotator = findArrayRotator(stringArray);
      logger(`String Array Rotate: ${rotator ? 'yes' : 'no'}`);

      const decoders = findDecoders(stringArray);
      logger(
        `String Array Decoders: ${decoders
          .map((d) => d.originalName)
          .join(', ')}`,
      );

      state.changes += applyTransform(ast, inlineObjectProps).changes;

      for (const decoder of decoders) {
        state.changes += applyTransform(
          ast,
          inlineDecoderWrappers,
          decoder,
        ).changes;
      }

      const vm = new VMDecoder(sandbox, stringArray, decoders, rotator);
      state.changes += (
        await applyTransformAsync(ast, inlineDecodedStrings, { vm })
      ).changes;

      if (decoders.length > 0) {
        stringArray.path.remove();
        rotator?.remove();
        decoders.forEach((decoder) => decoder.path.remove());
        state.changes += 2 + decoders.length;
      }
    }

    // The string-array block above removes nodes without re-crawling, so
    // scope caches may still reference removed nodes. Re-collect before
    // the scope-dependent genericDecoders step.
    traverse(ast, {
      Program(path) {
        path.scope.crawl();
        path.stop();
      },
    });

    state.changes += (
      await applyTransformAsync(ast, genericDecoders, sandbox)
    ).changes;

    // Cheap cleanup passes, repeated until an iteration yields no
    // changes. New passes (constant folding, opaque predicates, ...)
    // go into the list below.
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      if (iteration > 0) {
        // Babel caches scope info per node across traversals, so bindings
        // still reference nodes removed by the previous iteration. Re-collect
        // them before re-running scope-dependent passes.
        traverse(ast, {
          Program(path) {
            path.scope.crawl();
            path.stop();
          },
        });
      }

      const changesBeforeIteration = state.changes;

      state.changes += applyTransform(ast, inlineObjectProps).changes;
      state.changes += applyTransforms(
        ast,
        [
          mergeStrings,
          constantFolding,
          opaquePredicates,
          deadCode,
          controlFlowObject,
          controlFlowSwitch,
        ],
        { noScope: true },
      ).changes;

      if (state.changes === changesBeforeIteration) break;

      if (iteration === MAX_ITERATIONS - 1) {
        logger(
          `Deobfuscate: reached max iterations (${MAX_ITERATIONS}), stopping`,
        );
      }
    }
  },
} satisfies AsyncTransform<Sandbox>;
