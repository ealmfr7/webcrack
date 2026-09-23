import { test } from 'vitest';
import { testTransform } from '../../../test';
import slicedToArray from '../transforms/sliced-to-array';

const expectJS = testTransform(slicedToArray);

const arrayWithHoles = `function _arrayWithHoles(r) { if (Array.isArray(r)) return r; }`;
const iterableToArrayLimit = `function _iterableToArrayLimit(r, l) { var t = null == r ? null : "undefined" != typeof Symbol && r[Symbol.iterator] || r["@@iterator"]; if (null != t) { var e, n, i, u, a = [], f = !0, o = !1; try { if (i = (t = t.call(r)).next, 0 === l) { if (Object(t) !== t) return; f = !1; } else for (; !(f = (e = i.call(t)).done) && (a.push(e.value), a.length !== l); f = !0); } catch (r) { o = !0, n = r; } finally { try { if (!f && null != t.return && (u = t.return(), Object(u) !== u)) return; } finally { if (o) throw n; } } return a; } }`;
const unsupportedIterableToArray = `function _unsupportedIterableToArray(r, a) { if (r) { if ("string" == typeof r) return _arrayLikeToArray(r, a); var t = {}.toString.call(r).slice(8, -1); return "Object" === t && r.constructor && (t = r.constructor.name), "Map" === t || "Set" === t ? Array.from(r) : "Arguments" === t || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(t) ? _arrayLikeToArray(r, a) : void 0; } }`;
const nonIterableRest = `function _nonIterableRest() { throw new TypeError("Invalid attempt to destructure non-iterable instance.\\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method."); }`;
const slicedToArrayHelper = `function _slicedToArray(r, e) { return _arrayWithHoles(r) || _iterableToArrayLimit(r, e) || _unsupportedIterableToArray(r, e) || _nonIterableRest(); }`;

test('basic var declaration', () =>
  expectJS(`
    var _x = _slicedToArray(arr, 2), a = _x[0], b = _x[1];
    console.log(a, b);
  `).toMatchInlineSnapshot(`
    var [a, b] = arr;
    console.log(a, b);
  `));

test('let and const declarations', () =>
  expectJS(`
    let _x = _slicedToArray(arr, 2), a = _x[0], b = _x[1];
    const _y = _slicedToArray(other, 1), c = _y[0];
    console.log(a, b, c);
  `).toMatchInlineSnapshot(`
    let [a, b] = arr;
    const [c] = other;
    console.log(a, b, c);
  `));

test('defaults', () =>
  expectJS(`
    var _x = _slicedToArray(arr, 2), a = _x[0], b = _x[1] === void 0 ? 10 : _x[1];
    console.log(a, b);
  `).toMatchInlineSnapshot(`
    var [a, b = 10] = arr;
    console.log(a, b);
  `));

test('holes', () =>
  expectJS(`
    var _x = _slicedToArray(arr, 3), a = _x[0], b = _x[2];
    console.log(a, b);
  `).toMatchInlineSnapshot(`
    var [a,, b] = arr;
    console.log(a, b);
  `));

test('function params', () =>
  expectJS(`
    function f(_ref) {
      var _ref2 = _slicedToArray(_ref, 2), a = _ref2[0], b = _ref2[1];
      return a + b;
    }
  `).toMatchInlineSnapshot(`
    function f([a, b]) {
      return a + b;
    }
  `));

test('for-of head', () =>
  expectJS(`
    for (var _ref of arr) {
      var _x = _slicedToArray(_ref, 2), a = _x[0], b = _x[1];
      console.log(a, b);
    }
  `).toMatchInlineSnapshot(`
    for (var [a, b] of arr) {
      console.log(a, b);
    }
  `));

test('minified helper names', () =>
  expectJS(`
    function _a(r, e) { return _b(r) || _c(r, e) || _d(r, e) || _f(); }
    function _b(r) { if (Array.isArray(r)) return r; }
    function _c(r, l) { var t = null == r ? null : "undefined" != typeof Symbol && r[Symbol.iterator] || r["@@iterator"]; if (null != t) { try { var e = t.call(r).next; return [e.call(t).value]; } catch (r) {} } }
    function _d(r, a) { if (r) { var t = "Map"; if (t === "Map" || t === "Set") return Array.from(r); } }
    function _f() { throw new TypeError("nope"); }
    var _x = _a(arr, 2), a = _x[0], b = _x[1];
    console.log(a, b);
  `).toMatchInlineSnapshot(`
    var [a, b] = arr;
    console.log(a, b);
  `));

test('real Babel 7 output removes helpers', () =>
  expectJS(`
    ${arrayWithHoles}
    ${iterableToArrayLimit}
    ${unsupportedIterableToArray}
    ${nonIterableRest}
    ${slicedToArrayHelper}
    var _arr = _slicedToArray(arr, 2), a = _arr[0], b = _arr[1];
    console.log(a, b);
  `).toMatchInlineSnapshot(`
    var [a, b] = arr;
    console.log(a, b);
  `));

test('nested destructuring', () =>
  expectJS(`
    var _x = _slicedToArray(arr, 2), a = _x[0], _y = _slicedToArray(_x[1], 2), b = _y[0], c = _y[1];
    console.log(a, b, c);
  `).toMatchInlineSnapshot(`
    var [a, [b, c]] = arr;
    console.log(a, b, c);
  `));

test('TS __read output', () =>
  expectJS(`
    var __read = function (o, n) { var m = typeof Symbol === "function" && o[Symbol.iterator]; if (!m) return o; var i = m.call(o), r, ar = [], e; try { while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value); } catch (error) { e = { error: error }; } finally { try { if (r && !r.done && (m = i["return"])) m.call(i); } finally { if (e) throw e.error; } } return ar; };
    var _a = __read(arr, 2), a = _a[0], b = _a[1] === void 0 ? 10 : _a[1];
    console.log(a, b);
  `).toMatchInlineSnapshot(`
    var [a, b = 10] = arr;
    console.log(a, b);
  `));

test('tslib require', () =>
  expectJS(`
    var tslib_1 = require("tslib");
    var _a = tslib_1.__read(arr, 2), a = _a[0], b = _a[1];
    console.log(a, b);
  `).toMatchInlineSnapshot(`
    var [a, b] = arr;
    console.log(a, b);
  `));

test('@babel/runtime require', () =>
  expectJS(`
    var _slicedToArray = require("@babel/runtime/helpers/slicedToArray");
    var _x = _slicedToArray(arr, 2), a = _x[0], b = _x[1];
    console.log(a, b);
  `).toMatchInlineSnapshot(`
    var [a, b] = arr;
    console.log(a, b);
  `));

test('temp var used elsewhere is left alone', () =>
  expectJS(`
    var _x = _slicedToArray(arr, 2), a = _x[0];
    console.log(_x);
  `).toMatchInlineSnapshot(`
    var _x = _slicedToArray(arr, 2),
      a = _x[0];
    console.log(_x);
  `));

test('lookalike function is left alone', () =>
  expectJS(`
    function _slicedToArray(a, b) { return a + b; }
    var _x = _slicedToArray(arr, 2), a = _x[0];
    console.log(a);
  `).toMatchInlineSnapshot(`
    function _slicedToArray(a, b) {
      return a + b;
    }
    var _x = _slicedToArray(arr, 2),
      a = _x[0];
    console.log(a);
  `));

test('out of range index is left alone', () =>
  expectJS(`
    var _x = _slicedToArray(arr, 1), a = _x[0], b = _x[1];
    console.log(a, b);
  `).toMatchInlineSnapshot(`
    var _x = _slicedToArray(arr, 1),
      a = _x[0],
      b = _x[1];
    console.log(a, b);
  `));

test('reassigned temp is left alone', () =>
  expectJS(`
    var _x = _slicedToArray(arr, 2), a = _x[0], b = _x[1];
    _x = [];
    console.log(a, b);
  `).toMatchInlineSnapshot(`
    var _x = _slicedToArray(arr, 2),
      a = _x[0],
      b = _x[1];
    _x = [];
    console.log(a, b);
  `));

test('member access off an element is left alone', () =>
  expectJS(`
    var _x = _slicedToArray(arr, 2), a = _x[0], b = _x[1].lines;
    console.log(a, b);
  `).toMatchInlineSnapshot(`
    var _x = _slicedToArray(arr, 2),
      a = _x[0],
      b = _x[1].lines;
    console.log(a, b);
  `));

test('flipped void check still converts', () =>
  expectJS(`
    var _x = _slicedToArray(arr, 2), a = _x[0], b = void 0 === _x[1] ? 10 : _x[1];
    console.log(a, b);
  `).toMatchInlineSnapshot(`
    var [a, b = 10] = arr;
    console.log(a, b);
  `));

test('param used elsewhere keeps the declaration', () =>
  expectJS(`
    function f(_ref) {
      var _x = _slicedToArray(_ref, 2), a = _x[0], b = _x[1];
      return [_ref, a, b];
    }
  `).toMatchInlineSnapshot(`
    function f(_ref) {
      var [a, b] = _ref;
      return [_ref, a, b];
    }
  `));

test('exported temp is left alone', () =>
  expectJS(`
    export var _x = _slicedToArray(arr, 2), a = _x[0];
    console.log(a);
  `).toMatchInlineSnapshot(`
    export var _x = _slicedToArray(arr, 2),
      a = _x[0];
    console.log(a);
  `));

test('tslib named import', () =>
  expectJS(`
    import { __read } from "tslib";
    var _a = __read(arr, 2), a = _a[0], b = _a[1];
    console.log(a, b);
  `).toMatchInlineSnapshot(`
    var [a, b] = arr;
    console.log(a, b);
  `));

test('arrow function params', () =>
  expectJS(`
    var f = (_ref) => {
      var _x = _slicedToArray(_ref, 2), a = _x[0], b = _x[1];
      return a + b;
    };
  `).toMatchInlineSnapshot(`
    var f = ([a, b]) => {
      return a + b;
    };
  `));
