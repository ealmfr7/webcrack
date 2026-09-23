import { describe, test } from 'vitest';
import { testTransform } from '../../../test';
import spreadHelpers from '../transforms/spread-helpers';

const expectJS = testTransform(spreadHelpers);

const toConsumableArray = `function _toConsumableArray(arr) { return _arrayWithoutHoles(arr) || _iterableToArray(arr) || _unsupportedIterableToArray(arr) || _nonIterableSpread(); }`;
const arrayWithoutHoles = `function _arrayWithoutHoles(arr) { if (Array.isArray(arr)) return _arrayLikeToArray(arr); }`;
const iterableToArray = `function _iterableToArray(iter) { if (typeof Symbol !== "undefined" && iter[Symbol.iterator] != null || iter["@@iterator"] != null) return Array.from(iter); }`;
const unsupportedIterableToArray = `function _unsupportedIterableToArray(o, minLen) { if (!o) return; if (typeof o === "string") return _arrayLikeToArray(o, minLen); var n = Object.prototype.toString.call(o).slice(8, -1); if (n === "Object" && o.constructor) n = o.constructor.name; if (n === "Map" || n === "Set") return Array.from(o); }`;
const arrayLikeToArray = `function _arrayLikeToArray(arr, len) { if (len == null || len > arr.length) len = arr.length; for (var i = 0, arr2 = new Array(len); i < len; i++) arr2[i] = arr[i]; return arr2; }`;
const nonIterableSpread = `function _nonIterableSpread() { throw new TypeError("Invalid attempt to spread non-iterable instance."); }`;

const objectSpread = `function _objectSpread(target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i] != null ? Object(arguments[i]) : {}; var ownKeys = Object.keys(source); if (typeof Object.getOwnPropertySymbols === "function") { ownKeys.push.apply(ownKeys, Object.getOwnPropertySymbols(source).filter(function (sym) { if (Object.getOwnPropertyDescriptor(source, sym).enumerable) { return sym; } })); } ownKeys.forEach(function (key) { _defineProperty(target, key, source[key]); }); } return target; }`;
const defineProperty = `function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }`;

const extendsHelper = `function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }`;

const tsAssign = `var __assign = function () { __assign = Object.assign || function (t) { for (var s, i = 1, n = arguments.length; i < n; i++) { s = arguments[i]; for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p)) t[p] = s[p]; } return t; }; return __assign.apply(this, arguments); };`;
const tsRead = `var __read = function (o, n) { var m = typeof Symbol === "function" && o[Symbol.iterator]; if (!m) return o; var i = m.call(o), r, ar = [], e; try { while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value); } catch (error) { e = { error: error }; } finally { try { if (r && !r.done && (m = i["return"])) m.call(i); } finally { if (e) throw e.error; } } return ar; };`;
const tsSpreadArray = `var __spreadArray = function (to, from, pack) { if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) { if (ar || !(i in from)) { if (!ar) ar = Array.prototype.slice.call(from, 0, i); ar[i] = from[i]; } } return to.concat(ar || Array.prototype.slice.call(from)); };`;

describe('array spread (_toConsumableArray)', () => {
  test('bare call', () =>
    expectJS(`
      ${toConsumableArray}
      var b = _toConsumableArray(a);
    `).toMatchInlineSnapshot(`
      var b = [...a];
    `));

  test('[].concat form', () =>
    expectJS(`
      ${toConsumableArray}
      ${arrayWithoutHoles}
      ${iterableToArray}
      ${unsupportedIterableToArray}
      ${arrayLikeToArray}
      ${nonIterableSpread}
      var c = [].concat(_toConsumableArray(a), [b]);
    `).toMatchInlineSnapshot(`
      var c = [...a, b];
    `));

  test('fn.apply form', () =>
    expectJS(`
      ${toConsumableArray}
      fn.apply(void 0, _toConsumableArray(args));
    `).toMatchInlineSnapshot(`
      fn(...args);
    `));

  test('member fn.apply keeps receiver', () =>
    expectJS(`
      ${toConsumableArray}
      o.m.apply(o, _toConsumableArray(args));
    `).toMatchInlineSnapshot(`
      o.m(...args);
    `));

  test('minified helper names detected by shape', () =>
    expectJS(`
      function _a(x) { return _b(x) || _c(x) || _d(x); }
      var c = [].concat(_a(a), [b]);
      _e.apply(void 0, _a(args));
    `).toMatchInlineSnapshot(`
      var c = [...a, b];
      _e(...args);
    `));

  test('dead non-helper functions are never removed', () =>
    expectJS(`
      function applyTransforms() {
        this.modules.forEach(inlineVarInjections);
        this.replaceRequireCalls();
      }
      foo();
    `).toMatchInlineSnapshot(`
      function applyTransforms() {
        this.modules.forEach(inlineVarInjections);
        this.replaceRequireCalls();
      }
      foo();
    `));

  test('single-call wrapper is not a helper', () =>
    expectJS(`
      function _toConsumableArray(arr) {
        return JSON.parse(arr);
      }
      var b = _toConsumableArray(a);
    `).toMatchInlineSnapshot(`
      function _toConsumableArray(arr) {
        return JSON.parse(arr);
      }
      var b = _toConsumableArray(a);
    `));

  test('helper from @babel/runtime require', () =>
    expectJS(`
      var _toConsumableArray = require("@babel/runtime/helpers/toConsumableArray");
      var c = [].concat(_toConsumableArray(a), [b]);
    `).toMatchInlineSnapshot(`
      var c = [...a, b];
    `));

  test('helper from @babel/runtime import', () =>
    expectJS(`
      import _toConsumableArray from "@babel/runtime/helpers/toConsumableArray";
      fn.apply(void 0, _toConsumableArray(args));
    `).toMatchInlineSnapshot(`
      fn(...args);
    `));

  test('interop (0, helper) call shape', () =>
    expectJS(`
      ${toConsumableArray}
      var b = (0, _toConsumableArray)(a);
    `).toMatchInlineSnapshot(`
      var b = [...a];
    `));

  test('lookalike function with the same name is left alone', () =>
    expectJS(`
      function _toConsumableArray(a) { return a; }
      var b = _toConsumableArray(a);
    `).toMatchInlineSnapshot(`
      function _toConsumableArray(a) {
        return a;
      }
      var b = _toConsumableArray(a);
    `));

  test('plain concat without helpers is left alone', () =>
    expectJS(`
      var c = [].concat(a, [b]);
    `).toMatchInlineSnapshot(`
      var c = [].concat(a, [b]);
    `));

  test('concat with a possibly-array value keeps .concat', () =>
    expectJS(`
      ${toConsumableArray}
      var c = [].concat(_toConsumableArray(a), b);
    `).toMatchInlineSnapshot(`
      var c = [].concat([...a], b);
    `));

  test('apply with side-effectful thisArg keeps .apply', () =>
    expectJS(`
      ${toConsumableArray}
      fn.apply(getThis(), _toConsumableArray(args));
    `).toMatchInlineSnapshot(`
      fn.apply(getThis(), [...args]);
    `));

  test('apply with undefined thisArg', () =>
    expectJS(`
      ${toConsumableArray}
      fn.apply(undefined, _toConsumableArray(args));
    `).toMatchInlineSnapshot(`fn(...args);`));

  test('apply with null thisArg', () =>
    expectJS(`
      ${toConsumableArray}
      fn.apply(null, _toConsumableArray(args));
    `).toMatchInlineSnapshot(`fn(...args);`));

  test('apply with identifier thisArg keeps .apply', () =>
    expectJS(`
      ${toConsumableArray}
      fn.apply(foo, _toConsumableArray(args));
    `).toMatchInlineSnapshot(`fn.apply(foo, [...args]);`));

  test('apply with void call thisArg keeps .apply', () =>
    expectJS(`
      ${toConsumableArray}
      fn.apply(void foo(), _toConsumableArray(args));
    `).toMatchInlineSnapshot(`fn.apply(void foo(), [...args]);`));

  test('apply with void identifier thisArg keeps .apply', () =>
    expectJS(`
      ${toConsumableArray}
      fn.apply(void foo, _toConsumableArray(args));
    `).toMatchInlineSnapshot(`fn.apply(void foo, [...args]);`));

  test('shadowed undefined keeps .apply', () =>
    expectJS(`
      ${toConsumableArray}
      function f(undefined) {
        fn.apply(undefined, _toConsumableArray(args));
      }
    `).toMatchInlineSnapshot(`
      function f(undefined) {
        fn.apply(undefined, [...args]);
      }
    `));

  test('member apply with member-chain receiver', () =>
    expectJS(`
      ${toConsumableArray}
      a.b.m.apply(a.b, _toConsumableArray(args));
    `).toMatchInlineSnapshot(`a.b.m(...args);`));

  test('member apply on this', () =>
    expectJS(`
      ${toConsumableArray}
      this.m.apply(this, _toConsumableArray(args));
    `).toMatchInlineSnapshot(`this.m(...args);`));

  test('member apply with different receiver keeps .apply', () =>
    expectJS(`
      ${toConsumableArray}
      o.m.apply(other, _toConsumableArray(args));
    `).toMatchInlineSnapshot(`o.m.apply(other, [...args]);`));

  test('member apply with call receiver keeps .apply', () =>
    expectJS(`
      ${toConsumableArray}
      foo().m.apply(foo(), _toConsumableArray(args));
    `).toMatchInlineSnapshot(`foo().m.apply(foo(), [...args]);`));
});

describe('object spread', () => {
  test('_objectSpread', () =>
    expectJS(`
      ${objectSpread}
      ${defineProperty}
      var o = _objectSpread({}, a, { b: 1 });
    `).toMatchInlineSnapshot(`
      var o = {
        ...a,
        b: 1
      };
    `));

  test('_objectSpread2', () =>
    expectJS(`
      function _objectSpread2(t) { for (var e = 1; e < arguments.length; e++) { var r = arguments[e] != null ? arguments[e] : {}; Object.defineProperties(t, Object.getOwnPropertyDescriptors(r)); } return t; }
      var o = _objectSpread2({}, a, b);
    `).toMatchInlineSnapshot(`
      var o = {
        ...a,
        ...b
      };
    `));

  test('_extends', () =>
    expectJS(`
      ${extendsHelper}
      var o = _extends({}, a);
    `).toMatchInlineSnapshot(`
      var o = {
        ...a
      };
    `));

  test('minified _extends detected by shape', () =>
    expectJS(`
      function _e() { return _e = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) n[r] = t[r]; } return n; }, _e.apply(null, arguments); }
      var o = _e({}, a);
    `).toMatchInlineSnapshot(`
      var o = {
        ...a
      };
    `));

  test('TS __assign', () =>
    expectJS(`
      ${tsAssign}
      var o = __assign({}, a, { b: 1 });
    `).toMatchInlineSnapshot(`
      var o = {
        ...a,
        b: 1
      };
    `));

  test('Object.assign with fresh target', () =>
    expectJS(`
      var o = Object.assign({}, a, { b: 1 });
    `).toMatchInlineSnapshot(`
      var o = {
        ...a,
        b: 1
      };
    `));

  test('tslib member call', () =>
    expectJS(`
      var tslib_1 = require("tslib");
      var o = (0, tslib_1.__assign)({}, a);
    `).toMatchInlineSnapshot(`
      var tslib_1 = require("tslib");
      var o = {
        ...a
      };
    `));

  test('minified object spread detected by shape', () =>
    expectJS(`
      function _s(t) { for (var e = 1; e < arguments.length; e++) { var ks = Object.keys(arguments[e]); for (var j = 0; j < ks.length; j++) t[ks[j]] = arguments[e][ks[j]]; } return t; }
      var o = _s({}, a);
    `).toMatchInlineSnapshot(`
      var o = {
        ...a
      };
    `));

  test('Object.assign with non-fresh target is left alone', () =>
    expectJS(`
      var o = Object.assign(target, a);
    `).toMatchInlineSnapshot(`
      var o = Object.assign(target, a);
    `));

  test('Object.assign with non-empty literal target is left alone', () =>
    expectJS(`
      var o = Object.assign({ x: 1 }, a);
    `).toMatchInlineSnapshot(`
      var o = Object.assign({
        x: 1
      }, a);
    `));

  test('lookalike _extends is left alone', () =>
    expectJS(`
      function _extends(a, b) { return a + b; }
      var o = _extends({}, a);
    `).toMatchInlineSnapshot(`
      function _extends(a, b) {
        return a + b;
      }
      var o = _extends({}, a);
    `));

  test('helper kept while a non-fresh use remains', () =>
    expectJS(`
      ${extendsHelper}
      var o1 = _extends({}, a);
      var o2 = _extends(target, b);
    `).toMatchInlineSnapshot(`
      function _extends() {
        return _extends = Object.assign ? Object.assign.bind() : function (n) {
          for (var e = 1; e < arguments.length; e++) {
            var t = arguments[e];
            for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]);
          }
          return n;
        }, _extends.apply(null, arguments);
      }
      var o1 = {
        ...a
      };
      var o2 = _extends(target, b);
    `));
});

describe('TS __spreadArray / __read', () => {
  test('basic form', () =>
    expectJS(`
      ${tsRead}
      ${tsSpreadArray}
      var b = __spreadArray([], __read(a), false);
    `).toMatchInlineSnapshot(`
      var b = [...a];
    `));

  test('nested spreadArray', () =>
    expectJS(`
      ${tsRead}
      ${tsSpreadArray}
      var c = __spreadArray(__spreadArray([], __read(a), false), [b], false);
    `).toMatchInlineSnapshot(`
      var c = [...a, b];
    `));

  test('minified names detected by shape', () =>
    expectJS(`
      var _r = function (o, n) { var m = typeof Symbol === "function" && o[Symbol.iterator]; if (!m) return o; try { var x = m.call(o); return [x.next().value]; } catch (e) { return []; } };
      var _s = function (to, from, pack) { if (pack) for (var i = 0; i < from.length; i++) to.push(from[i]); return to.concat(Array.prototype.slice.call(from)); };
      var b = _s([], _r(a), false);
    `).toMatchInlineSnapshot(`
      var b = [...a];
    `));

  test('bare __read is left to sliced-to-array', () =>
    expectJS(`
      ${tsRead}
      var x = __read(a)[0];
    `).toMatchInlineSnapshot(`
      var __read = function (o, n) {
        var m = typeof Symbol === "function" && o[Symbol.iterator];
        if (!m) return o;
        var i = m.call(o),
          r,
          ar = [],
          e;
        try {
          while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
        } catch (error) {
          e = {
            error: error
          };
        } finally {
          try {
            if (r && !r.done && (m = i["return"])) m.call(i);
          } finally {
            if (e) throw e.error;
          }
        }
        return ar;
      };
      var x = __read(a)[0];
    `));
});
