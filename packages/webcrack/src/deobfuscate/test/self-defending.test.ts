import { test } from 'vitest';
import { testTransform } from '../../../test';
import selfDefending from '../self-defending';

const expectJS = testTransform(selfDefending);

function controller(prefix: string): string {
  return `
    var controller = function () {
      ${prefix}var firstCall = true;
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
  `;
}

test('removes exact-shape controller', () =>
  expectJS(controller('')).toMatchInlineSnapshot(``));

test('removes controller with leading bare vars', () =>
  expectJS(controller('var a; var b;')).toMatchInlineSnapshot(``));

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
