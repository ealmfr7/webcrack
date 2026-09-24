# Transpile

Convert transpiled syntax back to modern JavaScript.

## classes

<https://babeljs.io/docs/babel-plugin-transform-classes>

```js
var Foo = function () { // [!code --]
  function Foo(a) { // [!code --]
    _classCallCheck(this, Foo); // [!code --]
    this.x = a; // [!code --]
  } // [!code --]
  _createClass(Foo, [{ // [!code --]
    key: "bar", // [!code --]
    value: function () { return 1; } // [!code --]
  }]); // [!code --]
  return Foo; // [!code --]
}(); // [!code --]

class Foo { // [!code ++]
  constructor(a) { // [!code ++]
    this.x = a; // [!code ++]
  } // [!code ++]
  bar() { // [!code ++]
    return 1; // [!code ++]
  } // [!code ++]
} // [!code ++]
```

Helpers from `@babel/runtime` (`require(...)`/`import` forms) are recognized
too. Static methods, getters/setters and `extends` hierarchies are restored;
unrecognized helper shapes are left alone.

## async-await

TypeScript `__awaiter`, Babel `_asyncToGenerator` and `regeneratorRuntime`
wrappers are converted back to `async`/`await`:

```js
function foo(a) { // [!code --]
  return __awaiter(this, arguments, void 0, function* () { // [!code --]
    const x = yield bar(a); // [!code --]
    return x; // [!code --]
  }); // [!code --]
} // [!code --]

async function foo(a) { // [!code ++]
  const x = await bar(a); // [!code ++]
  return x; // [!code ++]
} // [!code ++]
```

`this`/`arguments` forwarding, class and object methods, and arrow functions
keep their form; only recognized helper shapes are converted.

## spread

<https://babeljs.io/docs/babel-plugin-transform-object-rest-spread>

Babel `_toConsumableArray`/`_objectSpread`/`_extends` and TypeScript
`__assign`/`__spreadArray`/`__read` helpers:

```js
var b = _toConsumableArray(a); // [!code --]
var b = [...a]; // [!code ++]
```

```js
fn.apply(void 0, _toConsumableArray(args)); // [!code --]
fn(...args); // [!code ++]
```

```js
_extends({}, a, b); // [!code --]
({ ...a, ...b }); // [!code ++]
```

`[].concat(_toConsumableArray(a), [b])` becomes `[...a, b]` and member calls
(`o.m.apply(o, ...)`) keep their receiver (`o.m(...args)`).

## destructuring (_slicedToArray)

<https://babeljs.io/docs/babel-plugin-transform-destructuring>

```js
var _x = _slicedToArray(arr, 2), a = _x[0], b = _x[1]; // [!code --]
var [a, b] = arr; // [!code ++]
```

Defaults (`b = _x[1] === void 0 ? 10 : _x[1]` → `[a, b = 10]`), holes
(`[a,, b]`), `let`/`const` declarations and function parameters
(`function f([a, b])`) are restored.

## TypeScript enum helpers

<https://babeljs.io/docs/babel-plugin-transform-typescript>

::: warning Opt-in
Off by default: the restored `enum` is TypeScript, so the output would no
longer run in node or parse as JavaScript in other tools. Enable it with the
`tsEnums` option or the `--ts-enums` CLI flag.
:::

```js
var E; // [!code --]
(function (E) { // [!code --]
  E[E["A"] = 0] = "A"; // [!code --]
  E["B"] = "b"; // [!code --]
})(E || (E = {})); // [!code --]

enum E { // [!code ++]
  A = 0, // [!code ++]
  B = "b", // [!code ++]
} // [!code ++]
```

Numeric, string and mixed enums are recognized; other IIFE shapes are left
alone.

## default-parameters

<https://babeljs.io/docs/babel-plugin-transform-parameters>

```js
function f() { // [!code --]
  var x = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : 1; // [!code --]
  var y = arguments.length > 1 ? arguments[1] : undefined; // [!code --]
} // [!code --]

function f(x = 1, y) {} // [!code ++]
```

## logical-assignments

<https://babeljs.io/docs/babel-plugin-transform-logical-assignment-operators>, TypeScript and SWC

```js
x || (x = y) // [!code --]
x ||= y // [!code ++]
```

```js
var _x, _y; // [!code --]
(_x = x)[_y = y] && (_x[_y] = z); // [!code --]
x[y] &&= z; // [!code ++]
```

## nullish-coalescing

```js
a !== null && a !== undefined ? a : b; // [!code --]
a ?? b; // [!code ++]
```

```js
var _a$b; // [!code --]
(_a$b = a.b) !== null && _a$b !== undefined ? _a$b : c; // [!code --]
a.b ?? c; // [!code ++]
```

```js
function foo(foo, qux = (_foo$bar => (_foo$bar = foo.bar) !== null && _foo$bar !== undefined ? _foo$bar : "qux")()) {} // [!code --]
function foo(foo, qux = foo.bar ?? "qux") {} // [!code ++]
```

## nullish-coalescing-assignment

```js
a ?? (a = b); // [!code --]
a ??= b; // [!code ++]
```

```js
var _a; // [!code --]
(_a = a).b ?? (_a.b = c); // [!code --]
a.b ??= c; // [!code ++]
```

## optional-chaining

```js
a === null || a === undefined ? undefined : a.b; // [!code --]
a?.b; // [!code ++]
```

```js
var _a; // [!code --]
(_a = a) === null || _a === undefined ? undefined : _a.b; // [!code --]
a?.b; // [!code ++]
```

## template-literals

<https://babeljs.io/docs/babel-plugin-transform-template-literals>

```js
"'".concat(foo, "' \"").concat(bar, "\"") // [!code --]
`'${foo}' "${bar}"` // [!code ++]
```
