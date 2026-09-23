import { test } from 'vitest';
import { testTransform } from '../../../test';
import classes from '../transforms/classes';

const expectJS = testTransform(classes);

const classCallCheck = `function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }`;
const defineProperties = `function _defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } }`;
const createClass = `function _createClass(Constructor, protoProps, staticProps) { if (protoProps) _defineProperties(Constructor.prototype, protoProps); if (staticProps) _defineProperties(Constructor, staticProps); return Constructor; }`;

test('simple class', () =>
  expectJS(`
    ${classCallCheck}
    ${defineProperties}
    ${createClass}
    var Foo = function () {
      function Foo(a) {
        _classCallCheck(this, Foo);
        this.x = a;
      }
      _createClass(Foo, [{
        key: "bar",
        value: function () {
          return 1;
        }
      }]);
      return Foo;
    }();
  `).toMatchInlineSnapshot(`
    class Foo {
      constructor(a) {
        this.x = a;
      }
      bar() {
        return 1;
      }
    }
  `));

test('class with statics and getters', () =>
  expectJS(`
    ${classCallCheck}
    ${defineProperties}
    ${createClass}
    var Foo = function () {
      function Foo() {
        _classCallCheck(this, Foo);
        this._x = 0;
      }
      _createClass(Foo, [{
        key: "qux",
        get: function () {
          return this._x;
        },
        set: function (v) {
          this._x = v;
        }
      }, {
        key: "bar",
        value: function () {
          return 1;
        }
      }], [{
        key: "baz",
        value: function () {
          return 2;
        }
      }, {
        key: "count",
        value: 0
      }]);
      return Foo;
    }();
  `).toMatchInlineSnapshot(`
    class Foo {
      constructor() {
        this._x = 0;
      }
      get qux() {
        return this._x;
      }
      bar() {
        return 1;
      }
      static baz() {
        return 2;
      }
      static count = 0;
    }
  `));

test('subclass with super call', () =>
  expectJS(`
    ${classCallCheck}
    ${defineProperties}
    ${createClass}
    function _inherits(subClass, superClass) { if (typeof superClass !== "function" && superClass !== null) { throw new TypeError("Super expression must either be null or a function"); } subClass.prototype = Object.create(superClass && superClass.prototype, { constructor: { value: subClass, writable: true, configurable: true } }); if (superClass) _setPrototypeOf(subClass, superClass); }
    function _setPrototypeOf(o, p) { _setPrototypeOf = Object.setPrototypeOf ? Object.setPrototypeOf.bind() : function (o, p) { o.__proto__ = p; return o; }; return _setPrototypeOf(o, p); }
    function _createSuper(Derived) { var hasNativeReflectConstruct = _isNativeReflectConstruct(); return function () { var Super = _getPrototypeOf(Derived), result; if (hasNativeReflectConstruct) { var NewTarget = _getPrototypeOf(this).constructor; result = Reflect.construct(Super, arguments, NewTarget); } else { result = Super.apply(this, arguments); } return _possibleConstructorReturn(this, result); }; }
    function _possibleConstructorReturn(self, call) { if (call && (typeof call === "object" || typeof call === "function")) { return call; } if (call !== void 0) { throw new TypeError("Derived constructors may only return object or undefined"); } return _assertThisInitialized(self); }
    function _getPrototypeOf(o) { _getPrototypeOf = Object.setPrototypeOf ? Object.getPrototypeOf : function (o) { return o.__proto__ || Object.getPrototypeOf(o); }; return _getPrototypeOf(o); }
    function _assertThisInitialized(self) { if (self === void 0) { throw new ReferenceError("this hasn't been initialised - super() hasn't been called"); } return self; }
    var Bar = function (_Foo) {
      function Bar(a, b) {
        var _this;
        _classCallCheck(this, Bar);
        _this = _super.call(this, a);
        _this.y = b;
        return _possibleConstructorReturn(_this);
      }
      _inherits(Bar, _Foo);
      var _super = _createSuper(Bar);
      _createClass(Bar, [{
        key: "baz",
        value: function () {
          return _get(_getPrototypeOf(Bar.prototype), "baz", this).call(this, 1);
        }
      }]);
      return Bar;
    }(Foo);
  `).toMatchInlineSnapshot(`
    class Bar extends Foo {
      constructor(a, b) {
        super(a);
        this.y = b;
      }
      baz() {
        return super.baz(1);
      }
    }
  `));

test('minified helper names', () =>
  expectJS(`
    function _x(a, b) { if (!(a instanceof b)) throw new TypeError("Cannot call a class as a function"); }
    function _z(a, b) { for (var c = 0; c < b.length; c++) { var d = b[c]; d.enumerable = d.enumerable || false; d.configurable = true; if ("value" in d) d.writable = true; Object.defineProperty(a, d.key, d); } }
    function _y(a, b, c) { if (b) _z(a.prototype, b); if (c) _z(a, c); return a; }
    var Foo = function () {
      function Foo(a) {
        _x(this, Foo);
        this.x = a;
      }
      _y(Foo, [{
        key: "bar",
        value: function () {
          return 1;
        }
      }]);
      return Foo;
    }();
  `).toMatchInlineSnapshot(`
    class Foo {
      constructor(a) {
        this.x = a;
      }
      bar() {
        return 1;
      }
    }
  `));

test('unrelated function named _classCallCheck is left alone', () =>
  expectJS(`
    function _classCallCheck(a, b) { return a + b; }
    var Foo = function () {
      function Foo(a) {
        _classCallCheck(this, Foo);
        this.x = a;
      }
      return Foo;
    }();
  `).toMatchInlineSnapshot(`
    function _classCallCheck(a, b) {
      return a + b;
    }
    var Foo = function () {
      function Foo(a) {
        _classCallCheck(this, Foo);
        this.x = a;
      }
      return Foo;
    }();
  `));

test('helpers imported from @babel/runtime', () =>
  expectJS(`
    var _classCallCheck = require("@babel/runtime/helpers/classCallCheck");
    var _createClass = require("@babel/runtime/helpers/createClass");
    var Foo = function () {
      function Foo(a) {
        _classCallCheck(this, Foo);
        this.x = a;
      }
      _createClass(Foo, [{
        key: "bar",
        value: function () {
          return 1;
        }
      }]);
      return Foo;
    }();
  `).toMatchInlineSnapshot(`
    class Foo {
      constructor(a) {
        this.x = a;
      }
      bar() {
        return 1;
      }
    }
  `));
