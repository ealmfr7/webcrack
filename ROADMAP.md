# Roadmap: ingeniería inversa avanzada

Mejoras propias sobre webcrack, desarrolladas en la rama `advanced-re` del fork.
Upstream: https://github.com/j4k0xb/webcrack

Leyenda: `[ ]` pendiente · `[~]` en progreso · `[x]` hecho

## Prioridad 1: pipeline de deobfuscación

- [x] Ejecutar `deadCode`, `controlFlowObject` y `controlFlowSwitch` aunque no haya string array
      (hoy `deobfuscate/index.ts` hace `if (!stringArray) return;` antes de estos pases).
- [x] Repetir el pipeline hasta que no haya cambios (`state.changes === 0`), con un límite de iteraciones.
- [x] Evaluación parcial y constant folding seguros, sin sandbox (`"a"+"b"`, `0x1f^0x3`, `!![]`).
- [x] Eliminar predicados opacos (`if (5 > 3)`, comparaciones de literales).

## Prioridad 2: desempaquetado (`unpack/`)

- [x] esbuild (`__commonJS`, `__export`, `__toESM`, `__require`)
- [x] Vite/Rollup (chunks ESM)
- [x] Metro / React Native (`__d(factory, id, deps)`)
- [x] Parcel
- [x] Turbopack
- [ ] Cargar varios chunks a la vez y reconstruir el grafo completo de módulos

## Prioridad 3: transpilación inversa (`transpile/`)

- [x] `_classCallCheck` / `_createClass` / `_inherits` → `class`
- [x] `__awaiter` / `regeneratorRuntime` / `_asyncToGenerator` → `async/await`
- [x] `_toConsumableArray` → spread, `_objectSpread` → `{...obj}`
- [x] `_slicedToArray` → desestructuración
- [x] Enums de TypeScript → `enum`

## Prioridad 4: otros obfuscadores

- [x] Decoders de strings genéricos (funciones puras con argumentos literales, evaluadas en el sandbox)
- [x] Packer de Dean Edwards (`eval(function(p,a,c,k,e,d){...})`)
- [~] JSFuck, JJEncode, AAEncode (JSFuck hecho; JJEncode/AAEncode reales pendientes)
- [x] `Function(...)()` / `eval` anidados (desenvolverlos capa por capa)
- [ ] Patrones de JScrambler

## Prioridad 5: obfuscación con máquina virtual (JSVMP, anti-bot)

- [x] Detectar el bucle intérprete (`while` + `switch` sobre un opcode)
- [ ] Etiquetar los handlers de cada opcode
- [ ] Extraer el bytecode y desensamblarlo
- [ ] Traducir el bytecode de vuelta a JS (*lifter*, experimental)

## Prioridad 6: nombres y legibilidad

- [x] Renombrado por heurística: `require("x")` → `x`, `event`, índices de `for`, props de React
- [ ] Renombrado opcional con un LLM, aplicado mediante `scope.rename`
- [ ] Reconocer librerías (lodash, react, crypto-js…) por hash estructural del AST → `mappings` automáticos

## Prioridad 7: salidas para análisis

- [ ] `report.json`: endpoints, URLs, claves, regex, strings interesantes
- [ ] Grafo de módulos y de llamadas (DOT / JSON)
- [ ] Source map de la salida al original para poner breakpoints sobre el código limpio
- [ ] `--trace`: diff de lo que cambió cada pase

## Robustez

- [x] Corpus de regresión con muestras reales y su resultado esperado (snapshots)
- [x] Tiempo límite y límite de memoria en el sandbox (`isolated-vm`)

## Flujo de trabajo

```bash
git fetch upstream
git switch master && git merge --ff-only upstream/master && git push origin master
git switch advanced-re && git rebase master   # o merge, si la rama ya es compartida
```
