import { test } from 'vitest';
import { testTransform } from '../../../test';
import selfDefending from '../self-defending';

const expectJS = testTransform(selfDefending);

function controller(prefix: string, beforeRes = ''): string {
  return `
    var controller = function () {
      ${prefix}var firstCall = true;
      return function (context, fn) {
        var rfn = firstCall ? function () {
          if (fn) {
            ${beforeRes}var res = fn.apply(context, arguments);
            fn = null;
            return res;
          }
        } : function () {};
        firstCall = false;
        return rfn;
      };
    }();
    var selfDefending = controller(this, function () {});
    selfDefending();
  `;
}

test('removes exact-shape controller', () =>
  expectJS(controller('')).toMatchInlineSnapshot(``));

test('removes controller with leading bare vars', () =>
  expectJS(controller('var a; var b;')).toMatchInlineSnapshot(``));

// Cleanup passes hoist `var`s out of removed dead branches, which can land
// nested inside the returned function: the obfuscator.io "high" sample
// leaves a bare `var` right before the `if (fn)` block's `res` declaration.
test('removes controller with nested bare var before res', () =>
  expectJS(controller('', 'var x; ')).toMatchInlineSnapshot(``));

test('keeps controller when a leading var has an initializer', () =>
  expectJS(controller('var a = 1;')).toMatchInlineSnapshot(`
    var controller = function () {
      var a = 1;
      var firstCall = true;
      return function (context, fn) {
        var rfn = firstCall ? function () {
          if (fn) {
            var res = fn.apply(context, arguments);
            fn = null;
            return res;
          }
        } : function () {};
        firstCall = false;
        return rfn;
      };
    }();
    var selfDefending = controller(this, function () {});
    selfDefending();
  `));
