import { parse, type ParseResult } from '@babel/parser';
import type { File } from '@babel/types';
import { expect, test } from 'vitest';
import { applyTransform } from '../src/ast-utils';
import { webcrack } from '../src';
import renameHeuristics from '../src/transforms/rename-heuristics';
import { testTransform } from '.';

const expectJS = testTransform(renameHeuristics);

function expectJSX(input: string) {
  const ast: ParseResult<File> = parse(input, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    plugins: ['jsx'],
  });
  applyTransform(ast, renameHeuristics);
  return expect(ast);
}

test('require', () => {
  expectJS('const x = require("axios"); x.get("/");').toMatchInlineSnapshot(`
    const axios = require("axios");
    axios.get("/");
  `);
  expectJS('const a = require("@scope/foo-bar"); a();').toMatchInlineSnapshot(`
    const fooBar = require("@scope/foo-bar");
    fooBar();
  `);
  expectJS('const f = require("node:fs"); f.readFileSync();')
    .toMatchInlineSnapshot(`
      const fs = require("node:fs");
      fs.readFileSync();
    `);
  expectJS(
    'const a = require("fs"); const b = require("fs"); a.readFileSync(); b.readFileSync();',
  ).toMatchInlineSnapshot(`
    const fs = require("fs");
    const fs2 = require("fs");
    fs.readFileSync();
    fs2.readFileSync();
  `);
  // Already descriptive
  expectJS('const axios = require("axios"); axios.get("/");')
    .toMatchInlineSnapshot(`
      const axios = require("axios");
      axios.get("/");
    `);
  // Destructuring is left alone
  expectJS('const { get } = require("axios"); get("/");')
    .toMatchInlineSnapshot(`
      const {
        get
      } = require("axios");
      get("/");
    `);
});

test('import', () => {
  expectJS('import x from "axios"; x.get("/");').toMatchInlineSnapshot(`
    import axios from "axios";
    axios.get("/");
  `);
  expectJS('import * as x from "axios"; x.get("/");').toMatchInlineSnapshot(`
    import * as axios from "axios";
    axios.get("/");
  `);
  // Named imports must keep their exported names
  expectJS('import { get } from "axios"; get("/");').toMatchInlineSnapshot(`
    import { get } from "axios";
    get("/");
  `);
  // Already descriptive
  expectJS('import axios from "axios"; axios.get("/");').toMatchInlineSnapshot(`
      import axios from "axios";
      axios.get("/");
    `);
});

test('event handlers', () => {
  expectJS('el.addEventListener("click", function (e) { console.log(e); });')
    .toMatchInlineSnapshot(`
    el.addEventListener("click", function (event) {
      console.log(event);
    });
  `);
  expectJS(
    'el.addEventListener("click", (e) => console.log(e));',
  ).toMatchInlineSnapshot(
    `el.addEventListener("click", event => console.log(event));`,
  );
  expectJS('el.onclick = function (e) { console.log(e); };')
    .toMatchInlineSnapshot(`
      el.onclick = function (event) {
        console.log(event);
      };
    `);
  expectJS('el.onmessage = (e) => console.log(e.data);').toMatchInlineSnapshot(
    `el.onmessage = event => console.log(event.data);`,
  );
  // Already descriptive
  expectJS(
    'el.addEventListener("click", (evt) => console.log(evt));',
  ).toMatchInlineSnapshot(
    `el.addEventListener("click", evt => console.log(evt));`,
  );
  // Non-handler member calls are untouched
  expectJS('el.observe((e) => console.log(e));').toMatchInlineSnapshot(
    `el.observe(e => console.log(e));`,
  );
});

test('for loop indices', () => {
  expectJS('for (let a = 0; a < n; a++) console.log(a);').toMatchInlineSnapshot(
    `for (let i = 0; i < n; i++) console.log(i);`,
  );
  expectJS(
    'for (let a = 0; a < 10; a++) for (let b = 0; b < 10; b++) console.log(a, b);',
  ).toMatchInlineSnapshot(
    `for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) console.log(i, j);`,
  );
  expectJS(
    'for (let a = 0; a < 10; a++) for (let b = 0; b < 10; b++) for (let c = 0; c < 10; c++) console.log(a, b, c);',
  ).toMatchInlineSnapshot(
    `for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) for (let k = 0; k < 10; k++) console.log(i, j, k);`,
  );
  // Already descriptive
  expectJS(
    'for (let index = 0; index < n; index++) console.log(index);',
  ).toMatchInlineSnapshot(
    `for (let index = 0; index < n; index++) console.log(index);`,
  );
  // Not a numeric index loop
  expectJS('for (const x of y) console.log(x);').toMatchInlineSnapshot(
    `for (const x of y) console.log(x);`,
  );
  expectJS('for (let k in o) console.log(k);').toMatchInlineSnapshot(
    `for (let k in o) console.log(k);`,
  );
});

test('props', () => {
  expectJSX('function C(x) { return <div>{x.title}</div>; }')
    .toMatchInlineSnapshot(`
    function C(props) {
      return <div>{props.title}</div>;
    }
  `);
  expectJS(
    'function C(x) { return React.createElement("div", null, x.title); }',
  ).toMatchInlineSnapshot(`
    function C(props) {
      return React.createElement("div", null, props.title);
    }
  `);
  // Already descriptive
  expectJSX('function C(props) { return <div>{props.title}</div>; }')
    .toMatchInlineSnapshot(`
      function C(props) {
        return <div>{props.title}</div>;
      }
    `);
  // No JSX: untouched
  expectJS('function f(x) { return x + 1; }').toMatchInlineSnapshot(`
    function f(x) {
      return x + 1;
    }
  `);
});

test('map callbacks', () => {
  expectJS('arr.map((x) => x * 2);').toMatchInlineSnapshot(
    `arr.map(item => item * 2);`,
  );
  expectJS('arr.map((a, b) => a + b);').toMatchInlineSnapshot(
    `arr.map((item, index) => item + index);`,
  );
  expectJS('arr.map(function (x) { return x; });').toMatchInlineSnapshot(`
    arr.map(function (item) {
      return item;
    });
  `);
  // Already descriptive
  expectJS('arr.map((item) => item * 2);').toMatchInlineSnapshot(
    `arr.map(item => item * 2);`,
  );
  // Other array methods are untouched
  expectJS('arr.filter((x) => x);').toMatchInlineSnapshot(
    `arr.filter(x => x);`,
  );
});

test('collisions get a suffix', () => {
  expectJS(
    'const event = 1; el.addEventListener("click", function (e) { console.log(e, event); });',
  ).toMatchInlineSnapshot(`
    const event = 1;
    el.addEventListener("click", function (event2) {
      console.log(event2, event);
    });
  `);
  expectJS(
    'const axios = 1; const x = require("axios"); console.log(axios, x);',
  ).toMatchInlineSnapshot(`
    const axios = 1;
    const axios2 = require("axios");
    console.log(axios, axios2);
  `);
});

test('shadowing', () => {
  expectJS(
    'function f(event) { el.addEventListener("click", (e) => console.log(e, event)); }',
  ).toMatchInlineSnapshot(`
    function f(event) {
      el.addEventListener("click", event2 => console.log(event2, event));
    }
  `);
  expectJS(
    'for (let i = 0; i < 10; i++) { for (let a = 0; a < 10; a++) console.log(i, a); }',
  ).toMatchInlineSnapshot(`
    for (let i = 0; i < 10; i++) {
      for (let j = 0; j < 10; j++) console.log(i, j);
    }
  `);
});

test('exports are never renamed', () => {
  expectJS('export const x = require("axios"); console.log(x);')
    .toMatchInlineSnapshot(`
      export const x = require("axios");
      console.log(x);
    `);
  expectJS('export function f(e) { console.log(e); }').toMatchInlineSnapshot(`
    export function f(e) {
      console.log(e);
    }
  `);
});

test('option off leaves output identical', async () => {
  const input =
    'const _0xa = require("axios"); el.addEventListener("click", (e) => _0xa.post(e));';
  const off = await webcrack(input, { renameHeuristics: false });
  const def = await webcrack(input, {});
  expect(off.code).toBe(def.code);
  expect(off.code).toContain('_0xa');
});

test('option on renames end to end', async () => {
  const input =
    'const _0xa = require("axios"); el.addEventListener("click", (e) => _0xa.post(e));';
  const result = await webcrack(input, { renameHeuristics: true });
  expect(result.code).toContain('axios');
  expect(result.code).toContain('event');
  expect(result.code).not.toContain('_0xa');
});
