# Deobfuscation

webcrack can deobfuscate code obfuscated with [javascript-obfuscator](https://github.com/javascript-obfuscator/javascript-obfuscator) ([obfuscator.io](https://obfuscator.io))

- String Array
  - Rotate
  - Shuffle
  - Index Shift
  - Calls Transform
  - Variable/Function Wrapper Type
  - None/Base64/RC4 Encoding
  - Split Strings
  - Unicode Escape Sequence
- Other Transformations
  - Compact
  - Simplify
  - Numbers To Expressions
  - Control Flow Flattening
  - Dead Code Injection
  - Transform Object Keys
- Disable Console Output
- Self Defending
- Debug Protection
- Domain Lock

On top of the string-array recovery, webcrack runs generic cleanup passes for
other obfuscators and packers.

## Pipeline

Unpacking (`packer`, `eval`/`Function` unwrapping, encoded payloads) runs first
in a loop, then string-array decoding, then cheap cleanup passes
(constant folding, opaque predicates, dead code, control-flow objects) repeat
until an iteration makes no more changes. The loops are capped at 10 iterations,
so heavily nested layers converge instead of running forever.

## Constant folding

Pure expressions over literals are evaluated and replaced with the result:

```js
x = "a" + "b"; // [!code --]
x = "ab"; // [!code ++]
```

```js
y = 0x1f ^ 0x3; // [!code --]
y = 28; // [!code ++]
```

```js
!![]; // [!code --]
true; // [!code ++]
```

Anything that could have side effects or read mutable state is left alone:
identifiers, calls, member access (possible getters), `NaN`/`Infinity` results,
folded strings longer than 10,000 characters, and a bare `"use" + " strict"`
at the start of a function/program (folding it would silently enable strict
mode).

## Opaque predicates

Branches whose test is statically known are resolved and the dead side is
removed:

```js
if ("xYz" !== "xYz") { // [!code --]
  foo(); // [!code --]
} else { // [!code --]
  bar(); // [!code --]
} // [!code --]
bar(); // [!code ++]
```

```js
console.log(5 > 3 && foo); // [!code --]
console.log(foo); // [!code ++]
```

```js
while (1 === 2) { // [!code --]
  foo(); // [!code --]
} // [!code --]
```

`while (true)` loops are kept. Tests with side effects are never resolved, and
`var`/function declarations hoisted from a removed branch survive
(`if (1 === 2) { var v = 1; }` keeps `var v;`).

## Dean Edwards packer

[`eval(function(p,a,c,k,e,d){...}(...))`](https://dean.edwards.name/packer/)
wrappers are recognized by their shape (dictionary `.split('|')`, token
substitution loop, encoder such as `c.toString(a)`), including renamed
parameters, radix 10/36/62/95 variants and the symbian branch. The payload is
decoded and spliced in place:

```js
eval(function(p,a,c,k,e,d){e=function(c){return c.toString(a)};/* ... */}('0("1");',10,2,'alert|hello'.split('|'),0,{})); // [!code --]
alert("hello"); // [!code ++]
```

Plain `eval("...")` strings and almost-packer shapes (wrong arity, non-`eval`
callee, non-`split` dictionary) are left for the eval pass or untouched.
Double-packed input unwraps through repeated loop iterations.

## Nested eval / Function unwrapping

Statically known `eval` and `Function` constructions are parsed and spliced
open — no code is executed. Direct `eval`, indirect `(0, eval)`,
`window.eval`/`globalThis.eval`, and `Function("...")()` / `new Function(...)`
are all handled:

```js
eval("console.log(1);"); // [!code --]
console.log(1); // [!code ++]
```

```js
Function("console.log(8);")(); // [!code --]
console.log(8); // [!code ++]
```

```js
var f = Function("a", "b", "return a + b;"); // [!code --]
var f = function (a, b) { return a + b; }; // [!code ++]
```

Only statically known strings (literals, plain template literals, `+`
concatenations) are inlined; `eval(x)` with a non-literal argument and shadowed
`eval`/`Function` bindings are left alone.

## JSFuck / JJEncode / AAEncode

Encoded payloads such as `[]["filter"]["constructor"](<payload>)()` are
evaluated in the sandbox and rewritten to `Function("<decoded>")()`, which the
eval pass splices open on the next loop iteration:

```js
[]["filter"]["constructor"](/* ... long [![] + !+[] ...] expression ... */)() // [!code --]
alert(1); // [!code ++]
```

Only the payload expression reaches the sandbox — never the outer call — and it
must be side-effect-free (literals, operators, property access on literals).
A user object's own `.constructor(...)()` call is never rewritten. Without a
sandbox these passes are no-ops.

## Generic string decoders

Small pure decoder functions (base64 via `atob`, xor loops, char-code shifts)
are detected, their calls evaluated in a batch in the sandbox, and the results
inlined:

```js
const decode = (s) => atob(s); // [!code --]
console.log(decode("aGVsbG8=")); // [!code --]
console.log("hello"); // [!code ++]
```

A function is only treated as a decoder when it touches nothing but its
arguments and deterministic builtins. Functions that read outer variables, use
globals like `console`, use `Math.random`, or return strings longer than 10,000
characters are left untouched.

## Sandbox limits

Decoding runs untrusted code in an `isolated-vm` sandbox created with
`createNodeSandbox({ timeout, memoryLimit })` — by default 10 seconds per
evaluation and a 128 MB heap. The generic-decoder pass additionally shares a
30 second budget across its batched calls. Code that times out or exceeds the
limits is left in place. In the browser there is no default sandbox:
`createBrowserSandbox()` throws and a custom implementation is required.
