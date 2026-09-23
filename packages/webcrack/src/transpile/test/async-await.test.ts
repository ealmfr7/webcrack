import { describe, test } from 'vitest';
import { testTransform } from '../../../test';
import asyncAwait from '../transforms/async-await';

const expectJS = testTransform(asyncAwait);

describe('TypeScript __awaiter', () => {
  test('function declaration', () =>
    expectJS(`
      function foo(a) {
        return __awaiter(this, arguments, void 0, function* () {
          const x = yield bar(a);
          return x;
        });
      }
    `).toMatchInlineSnapshot(`
      async function foo(a) {
        const x = await bar(a);
        return x;
      }
    `));

  test('arrow function', () =>
    expectJS(`
      const foo = (a) => __awaiter(void 0, void 0, void 0, function* () {
        yield bar(a);
      });
    `).toMatchInlineSnapshot(`
      const foo = async a => {
        await bar(a);
      };
    `));

  test('class method preserves this', () =>
    expectJS(`
      class A {
        foo() {
          return __awaiter(this, void 0, void 0, function* () {
            yield this.bar();
          });
        }
      }
    `).toMatchInlineSnapshot(`
      class A {
        async foo() {
          await this.bar();
        }
      }
    `));

  test('this and arguments preservation', () =>
    expectJS(`
      function foo(a) {
        return __awaiter(this, arguments, void 0, function* () {
          const x = yield bar(this.baz, a, arguments[0]);
          return x;
        });
      }
    `).toMatchInlineSnapshot(`
      async function foo(a) {
        const x = await bar(this.baz, a, arguments[0]);
        return x;
      }
    `));

  test('object method', () =>
    expectJS(`
      const o = {
        foo(a) {
          return __awaiter(this, void 0, void 0, function* () {
            return yield bar(a);
          });
        }
      };
    `).toMatchInlineSnapshot(`
      const o = {
        async foo(a) {
          return await bar(a);
        }
      };
    `));

  test('yield* is left untouched', () =>
    expectJS(`
      function foo(a) {
        return __awaiter(this, void 0, void 0, function* () {
          yield* bar(a);
        });
      }
    `).toMatchInlineSnapshot(`
      function foo(a) {
        return __awaiter(this, void 0, void 0, function* () {
          yield* bar(a);
        });
      }
    `));

  test('paired __generator linear machine', () =>
    expectJS(`
      function foo(a) {
        return __awaiter(this, void 0, void 0, function* () {
          return __generator(this, function (_a) {
            switch (_a.label) {
              case 0: return [4, bar(a)];
              case 1:
                _a.sent();
                return [4, baz()];
              case 2:
                _a.sent();
                return [2, "done"];
            }
          });
        });
      }
    `).toMatchInlineSnapshot(`
      async function foo(a) {
        await bar(a);
        await baz();
        return "done";
      }
    `));
});

describe('Babel _asyncToGenerator', () => {
  test('wrapper with .apply', () =>
    expectJS(`
      function foo(a) {
        return _asyncToGenerator(function* () {
          const x = yield bar(a);
          return x;
        }).apply(this, arguments);
      }
    `).toMatchInlineSnapshot(`
      async function foo(a) {
        const x = await bar(a);
        return x;
      }
    `));

  test('standalone assignment keeps params', () =>
    expectJS(`
      var foo = _asyncToGenerator(function* (a) {
        const x = yield bar(a);
        return x;
      });
    `).toMatchInlineSnapshot(`
      var foo = async function (a) {
        const x = await bar(a);
        return x;
      };
    `));

  test('regeneratorRuntime.mark with linear wrap machine', () =>
    expectJS(`
      var foo = _asyncToGenerator(regeneratorRuntime.mark(function _callee(a) {
        return regeneratorRuntime.wrap(function (_context) {
          while (1) switch (_context.prev = _context.next) {
            case 0:
              _context.next = 2;
              return regeneratorRuntime.awrap(bar(a));
            case 2:
              _context.next = 4;
              return regeneratorRuntime.awrap(baz());
            case 4:
              return _context.stop();
          }
        }, _callee);
      }));
    `).toMatchInlineSnapshot(`
      var foo = async function _callee(a) {
        await bar(a);
        await baz();
      };
    `));

  test('linear wrap machine with sent value', () =>
    expectJS(`
      function foo(a) {
        return _asyncToGenerator(regeneratorRuntime.mark(function _callee() {
          var x;
          return regeneratorRuntime.wrap(function (_context) {
            while (1) switch (_context.prev = _context.next) {
              case 0:
                _context.next = 2;
                return regeneratorRuntime.awrap(bar(a));
              case 2:
                x = _context.sent;
                _context.next = 4;
                return regeneratorRuntime.awrap(baz(x));
              case 4:
                return _context.stop();
            }
          }, _callee);
        })).apply(this, arguments);
      }
    `).toMatchInlineSnapshot(`
      async function foo(a) {
        var x;
        x = await bar(a);
        await baz(x);
      }
    `));

  test('complex wrap machine (try/catch) is left untouched', () =>
    expectJS(`
      var foo = _asyncToGenerator(regeneratorRuntime.mark(function _callee() {
        var x;
        return regeneratorRuntime.wrap(function (_context) {
          while (1) switch (_context.prev = _context.next) {
            case 0:
              _context.prev = 0;
              _context.next = 3;
              return regeneratorRuntime.awrap(bar());
            case 3:
              _context.next = 8;
              break;
            case 5:
              _context.prev = 5;
              _context.t0 = _context["catch"](0);
              x = _context.t0;
            case 8:
              return _context.stop();
          }
        }, _callee);
      }));
    `).toMatchInlineSnapshot(`
      var foo = _asyncToGenerator(regeneratorRuntime.mark(function _callee() {
        var x;
        return regeneratorRuntime.wrap(function (_context) {
          while (1) switch (_context.prev = _context.next) {
            case 0:
              _context.prev = 0;
              _context.next = 3;
              return regeneratorRuntime.awrap(bar());
            case 3:
              _context.next = 8;
              break;
            case 5:
              _context.prev = 5;
              _context.t0 = _context["catch"](0);
              x = _context.t0;
            case 8:
              return _context.stop();
          }
        }, _callee);
      }));
    `));

  test('minified helper resolved via definition shape', () =>
    expectJS(`
      function _a(fn) {
        return function () {
          var self = this, args = arguments;
          return new Promise(function (resolve, reject) {
            var gen = fn.apply(self, args);
            function step(key, arg) {
              var info = gen[key](arg);
              if (info.done) resolve(info.value);
            }
            step("next");
          });
        };
      }
      function foo(a) {
        return _a(function* () {
          const x = yield bar(a);
          return x;
        }).apply(this, arguments);
      }
    `).toMatchInlineSnapshot(`
      function _a(fn) {
        return function () {
          var self = this,
            args = arguments;
          return new Promise(function (resolve, reject) {
            var gen = fn.apply(self, args);
            function step(key, arg) {
              var info = gen[key](arg);
              if (info.done) resolve(info.value);
            }
            step("next");
          });
        };
      }
      async function foo(a) {
        const x = await bar(a);
        return x;
      }
    `));
});

describe('safety guards', () => {
  test('generator params are kept and block inlining', () =>
    expectJS(`
      function f() {
        return __awaiter(this, arguments, void 0, function* (a = 1) {
          yield g(a);
        });
      }
    `).toMatchInlineSnapshot(`
      function f() {
        return async function (a = 1) {
          await g(a);
        }.apply(this, arguments);
      }
    `));

  test('unrelated 4-arg call with a generator is untouched', () =>
    expectJS(`
      function f(a, b, c) {
        return run(a, b, c, function* () {
          const x = yield 1;
          return x;
        });
      }
    `).toMatchInlineSnapshot(`
      function f(a, b, c) {
        return run(a, b, c, function* () {
          const x = yield 1;
          return x;
        });
      }
    `));

  test('side-effectful thisArg keeps the .apply() call', () =>
    expectJS(`
      function f() {
        return __awaiter(sideEffect(), void 0, void 0, function* () {
          yield g();
        });
      }
    `).toMatchInlineSnapshot(`
      function f() {
        return async function () {
          await g();
        }.apply(sideEffect(), void 0);
      }
    `));

  test('getters and setters are never async', () =>
    expectJS(`
      class A {
        get x() {
          return __awaiter(this, void 0, void 0, function* () {
            return yield this.y;
          });
        }
        set x(v) {
          return __awaiter(this, void 0, void 0, function* () {
            yield this.setY(v);
          });
        }
      }
    `).toMatchInlineSnapshot(`
      class A {
        get x() {
          return async function () {
            return await this.y;
          }.apply(this, void 0);
        }
        set x(v) {
          return async function () {
            await this.setY(v);
          }.apply(this, void 0);
        }
      }
    `));

  test('generator wrappers are not merged into async generators', () =>
    expectJS(`
      function* w() {
        return _asyncToGenerator(function* () {
          yield g();
        }).apply(this, arguments);
      }
    `).toMatchInlineSnapshot(`
      function* w() {
        return async function () {
          await g();
        }.apply(this, arguments);
      }
    `));

  test('yields in nested functions are not converted', () =>
    expectJS(`
      function foo(a) {
        return __awaiter(this, void 0, void 0, function* () {
          function* inner() {
            yield 1;
          }
          const f = function () {
            return inner;
          };
          yield bar(a);
        });
      }
    `).toMatchInlineSnapshot(`
      async function foo(a) {
        function* inner() {
          yield 1;
        }
        const f = function () {
          return inner;
        };
        await bar(a);
      }
    `));

  test('late .sent read does not reorder evaluation', () =>
    expectJS(`
      var foo = _asyncToGenerator(regeneratorRuntime.mark(function _callee(x) {
        var y;
        return regeneratorRuntime.wrap(function (_context) {
          while (1) switch (_context.prev = _context.next) {
            case 0:
              _context.next = 2;
              return regeneratorRuntime.awrap(bar(x));
            case 2:
              x = 1;
              y = _context.sent;
              return _context.abrupt("return", y);
          }
        }, _callee);
      }));
    `).toMatchInlineSnapshot(`
      var foo = _asyncToGenerator(regeneratorRuntime.mark(function _callee(x) {
        var y;
        return regeneratorRuntime.wrap(function (_context) {
          while (1) switch (_context.prev = _context.next) {
            case 0:
              _context.next = 2;
              return regeneratorRuntime.awrap(bar(x));
            case 2:
              x = 1;
              y = _context.sent;
              return _context.abrupt("return", y);
          }
        }, _callee);
      }));
    `));

  test('wrap machine bailing in a later case stays byte-identical', () =>
    expectJS(`
      function foo(a) {
        return _asyncToGenerator(regeneratorRuntime.mark(function _callee() {
          var x, y;
          return regeneratorRuntime.wrap(function (_context) {
            while (1) switch (_context.prev = _context.next) {
              case 0:
                _context.next = 2;
                return regeneratorRuntime.awrap(bar(a));
              case 2:
                x = _context.sent;
                _context.next = 4;
                return regeneratorRuntime.awrap(baz(x));
              case 4:
                _context.next = 6;
                if (x) {
                  y = x;
                }
                return regeneratorRuntime.awrap(qux());
              case 6:
                return _context.stop();
            }
          }, _callee);
        })).apply(this, arguments);
      }
    `).toMatchInlineSnapshot(`
      function foo(a) {
        return _asyncToGenerator(regeneratorRuntime.mark(function _callee() {
          var x, y;
          return regeneratorRuntime.wrap(function (_context) {
            while (1) switch (_context.prev = _context.next) {
              case 0:
                _context.next = 2;
                return regeneratorRuntime.awrap(bar(a));
              case 2:
                x = _context.sent;
                _context.next = 4;
                return regeneratorRuntime.awrap(baz(x));
              case 4:
                _context.next = 6;
                if (x) {
                  y = x;
                }
                return regeneratorRuntime.awrap(qux());
              case 6:
                return _context.stop();
            }
          }, _callee);
        })).apply(this, arguments);
      }
    `));

  test('__generator machine with unknown opcode stays byte-identical', () =>
    expectJS(`
      function foo(a) {
        return __awaiter(this, void 0, void 0, function* () {
          return __generator(this, function (_a) {
            switch (_a.label) {
              case 0: return [4, bar(a)];
              case 1:
                x = _a.sent();
                return [4, baz()];
              case 2: return [9, 1];
            }
          });
        });
      }
    `).toMatchInlineSnapshot(`
      function foo(a) {
        return __awaiter(this, void 0, void 0, function* () {
          return __generator(this, function (_a) {
            switch (_a.label) {
              case 0:
                return [4, bar(a)];
              case 1:
                x = _a.sent();
                return [4, baz()];
              case 2:
                return [9, 1];
            }
          });
        });
      }
    `));

  test('minified __awaiter resolved via definition shape', () =>
    expectJS(`
      function n(thisArg, _arguments, P, generator) {
        return new (P || (P = Promise))(function (resolve, reject) {
          function fulfilled(value) {
            resolve(value);
          }
          fulfilled(1);
        });
      }
      function foo(a) {
        return n(this, arguments, void 0, function* () {
          const x = yield bar(a);
          return x;
        });
      }
    `).toMatchInlineSnapshot(`
      function n(thisArg, _arguments, P, generator) {
        return new (P || (P = Promise))(function (resolve, reject) {
          function fulfilled(value) {
            resolve(value);
          }
          fulfilled(1);
        });
      }
      async function foo(a) {
        const x = await bar(a);
        return x;
      }
    `));
});
