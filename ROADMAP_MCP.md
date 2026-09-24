# Roadmap: servidor MCP de webcrack (explorador de reversing para agentes)

Paquete nuevo `packages/mcp` (`@webcrack/mcp`): un servidor MCP que convierte
webcrack en un **"IDE de reversing" para agentes**. Permite abrir un bundle o
script ofuscado, orientarse, buscar, navegar (definición / referencias),
leer, desofuscar zonas concretas bajo demanda, anotar lo entendido y exportar.

Es un roadmap **paralelo** a `ROADMAP.md`: no depende de él y no debe
modificar el core (`packages/webcrack/src`) salvo lo indicado en M0.2
(exports aditivos).

Leyenda: `[ ]` pendiente · `[~]` en progreso · `[x]` hecho

---

## 1. Objetivo y criterio de éxito

Un agente (Claude Code, Claude Desktop, Agent SDK…) con este MCP debe poder
responder preguntas reales de reversing sobre JS ofuscado/empaquetado
**rápido, con pocas llamadas y pocos tokens**:

- "¿A qué endpoints habla esta app y con qué headers/auth?"
- "¿Dónde se genera la firma `x-sign` y qué algoritmo usa?"
- "¿Qué módulo maneja el login? ¿Guarda el token en localStorage?"
- "Esta función sigue ofuscada: límpiala y explícamela."

Se considera logrado cuando el set de evaluación (M1.8 / M2.6) resuelve
≥ 80 % de las tareas con una mediana de ≤ 12 llamadas a tools.

## 2. Principios de diseño (obligatorios)

1. **Tools = verbos del trabajo del analista**, no funciones internas.
   Pocas (≈12) y de alto nivel. Si dudas entre añadir una tool o un
   parámetro, añade un parámetro.
2. **Procesar una vez, consultar muchas.** `wc_open` hace todo el trabajo
   pesado (desofuscar, desempaquetar, indexar) y lo cachea en disco. El resto
   de tools solo consulta el índice → respuestas en milisegundos.
3. **Eficiencia de tokens.**
   - Toda lista va paginada (`limit`, `offset`) con valores por defecto pequeños.
   - Toda salida pasa por el presupuesto de `format/response.ts`
     (por defecto ~20 000 caracteres); si se recorta, se dice cuánto falta y
     **cómo pedirlo** (`offset`, filtro, rango de líneas).
   - `detail: "concise" | "full"` en las tools con salidas grandes;
     por defecto `concise`.
   - El código siempre con número de línea (`  120 │ code`).
4. **Identificadores legibles y encadenables.** Todo se refiere como
   `módulo:línea` (`src/api/auth.js:120`) o `módulo:símbolo`
   (`src/api/auth.js:login`). La salida de una tool es entrada directa de
   la siguiente. Nada de UUIDs salvo el `workspace` id (que además es corto).
5. **Errores accionables.** Nunca "not found" a secas: sugerir parecidos
   ("¿quisiste decir `fetchUser`, `_fetch`?"), rangos válidos, la tool
   correcta a usar.
6. **Cada respuesta sugiere el siguiente paso** con una línea
   `Next:` breve (p. ej. `Next: wc_findings category=endpoints`).
7. **Texto primero.** La respuesta principal es texto compacto pensado para un
   LLM (tipo tabla/listado), no JSON crudo. Opcionalmente `structuredContent`
   para clientes programáticos.
8. **Seguro por defecto.** El código analizado es hostil (ver §6).

## 3. Arquitectura

```
packages/mcp/
├── package.json            # bin: webcrack-mcp
├── esbuild.config.js       # bundle ESM a dist/ (packages externos)
├── src/
│   ├── index.ts            # entrypoint: stdio transport
│   ├── server.ts           # createServer(): registra tools + prompts
│   ├── config.ts           # env: roots, cache dir, límites
│   ├── tools/              # una tool por archivo (defineTool)
│   │   ├── define.ts       # helper defineTool + registro
│   │   ├── index.ts        # lista de tools
│   │   └── open.ts, map.ts, outline.ts, search.ts, findings.ts, read.ts,
│   │       goto.ts, refs.ts, graph.ts, deobfuscate.ts, annotate.ts, export.ts
│   ├── workspace/
│   │   ├── types.ts        # Workspace, ModuleEntry, SymbolEntry, Index…
│   │   ├── store.ts        # WorkspaceStore: sesiones en memoria + caché en disco
│   │   ├── loader.ts       # source (path | url | code) → string
│   │   ├── indexer.ts      # construye el índice a partir del resultado de webcrack
│   │   └── tags.ts         # etiquetado heurístico de módulos
│   ├── format/
│   │   ├── response.ts     # presupuesto, paginación, numeración de líneas, Next:
│   │   └── errors.ts       # WcError + sugerencias (distancia de edición)
│   └── prompts/
│       └── audit.ts        # prompt MCP "audit"
├── test/                   # vitest; helpers.ts: connect() + fixtureWorkspace()
└── evals/                  # tareas de evaluación con agentes reales
```

### 3.1 Modelo: Workspace

Un **workspace** es un bundle/script abierto. Se identifica por un id corto
(primeros 8 hex del sha256 de `input + opciones + versión de webcrack`), que
sirve también de clave de caché.

```ts
interface Workspace {
  id: string; // "a1b2c3d4"
  source: { kind: 'path' | 'url' | 'code'; label: string; bytes: number };
  original: string; // código original (para view=raw)
  bundle?: { type: string; entryId: string };
  modules: Map<string, ModuleEntry>; // clave = ruta legible ("src/api.js")
  index: WorkspaceIndex; // ver 3.2
  report: Record<string, Report>; // extractReport() por módulo (clave = module path; líneas de módulo)
  interpreters: InterpreterSummary[]; // resumen serializable de detectInterpreters()
  annotations: Annotations; // renames + notas (persistidos)
  stats: { openMs: number; techniques: string[] };
}
```

- Si webcrack no detecta bundle, hay **un solo módulo** llamado `main.js`.
- Si hay bundle, cada `Module` de `result.bundle.modules` es un `ModuleEntry`
  con su `path` (`./index.js` → `index.js`) y su `code` limpio.

### 3.2 Índice

Se construye **re-parseando el código limpio generado** de cada módulo (con
`@babel/parser`, `errorRecovery`), así las líneas del índice coinciden
exactamente con lo que devuelve `wc_read`. Contenido:

- **symbols**: funciones, clases, métodos, variables de nivel superior,
  imports; con `module`, `name`, `kind`, `line`, `endLine`, `params`, `exported`.
  Sin kind `export`: el flag `exported` lo cubre. `refCount` = nº de refs cuyo
  `defModule`/`defLine`/`name` coinciden, incluyendo refs cruzadas vía imports;
  solo definido tras `linkIndex`. Reglas de nombrado: los métodos se llaman
  `Class.method` (con punto); `const f = () => {}` / `const f = function () {}`
  son kind `function` con `params` y cuentan como función nombrada para
  `caller`; `export default function () {}` y una clase anónima se llaman
  `default`; CJS `const x = require('./x.js')` es kind `import` con
  `importedName: '*'` y `from`; `module.exports.x = …` / `exports.x = …` marca
  `exported` en `x` (o crea un símbolo variable `x`).
- **refs** (`RefEntry[]`): usos de bindings de nivel de módulo (definidos o
  importados), con `module`, `line`, `name`, `defModule?`, `defLine?`, `kind`
  (`read`|`write`|`call`). `indexModule` deja SIN resolver las refs a bindings
  importados (sin `defModule`/`defLine`); `linkIndex` las resuelve al módulo
  exportador. Declaraciones e import-specifiers NO son refs; los globales nunca
  son refs y los usos de locales tampoco (los call sites los cubren `calls`).
  Acceso a miembro sobre un namespace import (`ns.sign`) → ref al símbolo
  exportado (`defModule`/`defLine` tras linkear), con `name` punteado.
- **imports/exports** entre módulos: los bindings import llevan
  `importedName` (`'default'` | `'*'` | nombre) y `from` (ruta resuelta); los
  barrels van en `index.reexports` (`{name, importedName, from}`, y con
  `module` en `WorkspaceIndex`). Los grafos (`wc_graph`, M2.2) se construyen
  a query time desde `index.imports`/`index.calls`; NO se cachean
  `moduleGraph`/`callGraph` (necesitan AST/Bundle, no disponibles en caché).
- **strings**: literales con posición (para `wc_search kind=string`),
  INCLUYENDO sources de import/require y EXCLUYENDO keys de objetos.
- **calls**: nombre de callee normalizado con posición. Raíz global o binding
  importado → nombre punteado (`fetch`, `axios.post`, `sign`,
  `localStorage.setItem`); acceso a miembro sobre namespace import → punteado
  (`ns.sign()` → `ns.sign`); raíz local u otra expresión → `*.<prop>`
  (`(await res.json())` → `*.json`). `caller` = función nombrada envolvente
  más cercana.
- **tags** por módulo (ver M1.4).

Todo el índice debe ser serializable (JSON) para la caché. Cada array del
índice va en orden de fuente (`calls` en orden de entrada de Babel). Las
claves de módulo son rutas webcrack sin el `./` inicial.

### 3.3 Caché

- Directorio: `$WEBCRACK_MCP_CACHE` o `~/.cache/webcrack-mcp/<id>/`.
- Se guarda: `meta.json`, `original.js`, `modules/<ruta>.js`, `index.json`,
  `report.json`, `annotations.json`.
- Al reabrir el mismo input → carga desde caché sin volver a desofuscar
  (objetivo: < 1 s en un bundle de 5 MB).
- `annotations.json` sobrevive a reinicios: es la "memoria" del análisis.

### 3.4 Formato de respuesta (contrato)

Ejemplo de `wc_open`:

```
Workspace a1b2c3d4 · webpack 5 · 214 modules · 1.8 MB → 2.3 MB clean · 4.1 s
Obfuscation: string-array (rotated, base64), control-flow-flattening, self-defending (removed)
Entry: index.js
Findings: 17 endpoints · 42 urls · 3 secrets · 11 regexes · 2 VM interpreters
Top modules by tag:
  network  src/api/client.js (12 calls) · 541.js · 77.js
  auth     src/auth/session.js · 902.js
  crypto   133.js (md5-like)
Next: wc_findings category=endpoints · wc_map · wc_search
```

Ejemplo de `wc_read`:

```
src/api/client.js:40-58 (clean) · function request(method, url, body)
  40 │ function request(method, url, body) {
  41 │   const headers = { "x-sign": sign(url, body) };
 ...
Refs: called from 12 places (wc_refs src/api/client.js:request)
```

## 4. Contratos de las tools

Todas llevan prefijo `wc_`. `workspace` es opcional en todas: si se omite se
usa el último abierto. Anotaciones MCP (`readOnlyHint`, etc.) donde aplique.
Los formatos `target` (`módulo`, `módulo:línea`, `módulo:inicio-fin`,
`módulo:símbolo`, `símbolo`) y `symbol` se resuelven con el helper compartido
`format/target.ts`: `resolveTarget` es el punto de entrada único (usado por
`wc_read`, `wc_goto`, `wc_refs` y `wc_deobfuscate`), construido sobre
`parseTarget`, `resolveModule` y `resolveSymbol`. Nadie reimplementa ese
parseo en su tool.

| Tool             | Entrada (resumen)                                                                                                                        | Devuelve                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `wc_open`        | `source` (ruta, URL http(s) o código), `options?` {`unpack`,`deobfuscate`,`unminify`,`jsx`,`mangle`,`renameHeuristics`}, `refresh?`      | Ficha del workspace (§3.4)                                                      |
| `wc_workspaces`  | —                                                                                                                                        | Workspaces abiertos/cacheados (id, fuente, módulos)                             |
| `wc_map`         | `path?` (prefijo de carpeta), `tag?`, `sort?` (`path`,`size`,`refs`), `detail?` (M1.4: `concise`,`full`), `limit`,`offset`               | Árbol de módulos: tamaño, nº exports/imports, tags, entry                       |
| `wc_outline`     | `module`, `detail?` (M1.5: `concise`,`full`)                                                                                             | Símbolos del módulo con línea, tipo, params, exported, nº refs                  |
| `wc_search`      | `query`, `kind` (`text`,`regex`,`string`,`identifier`,`call`,`ast`), `module?`, `limit`,`offset`                                         | Hits `módulo:línea` + línea de contexto                                         |
| `wc_findings`    | `category` (`summary`,`endpoints`,`urls`,`secrets`,`regexes`,`interesting`,`sinks`,`storage`,`crypto`,`vm`), `module?`, `reveal?` (M1.7: ver secretos completos), `limit`,`offset` | Hallazgos con `módulo:línea`                           |
| `wc_read`        | `target` (`módulo`, `módulo:línea`, `módulo:inicio-fin`, `módulo:símbolo` o `símbolo`), `view` (`clean`,`raw`), `detail?` (M1.5: `concise`,`full`), `context?` | Código numerado + resumen de refs                                      |
| `wc_goto`        | `symbol` (nombre o `módulo:nombre`), `from?` (`módulo:línea` para resolver por scope)                                                    | Definición: ubicación + firma + primeras líneas                                 |
| `wc_refs`        | `symbol`, `direction` (`callers`,`callees`,`all`), `limit`,`offset`                                                                      | Referencias / llamadas con contexto                                             |
| `wc_graph`       | `kind` (`modules`,`calls`), `root?`, `depth` (def. 2), `format` (`tree`,`json`,`dot`)                                                    | Subgrafo alrededor de `root`                                                    |
| `wc_deobfuscate` | `target` (función / rango / módulo), `passes?`, `expression?` (evaluar en sandbox), `apply?` (M2.4: integra el resultado en el workspace) | Antes/después (diff compacto) y aplica al workspace si `apply=true`            |
| `wc_annotate`    | `symbol`, `name?`, `note?`                                                                                                               | Confirmación; los renames se aplican con `scope.rename` y se reindexa el módulo |
| `wc_export`      | `dir`, `include?` (`code`,`report`,`notes`,`graph`)                                                                                      | Rutas escritas                                                                  |

**`kind=ast` en `wc_search`**: patrón en sintaxis JS con comodines
`$X` / `$$ARGS` (estilo ast-grep simplificado), p. ej.
`fetch($URL, { method: "POST", $$REST })`. Implementación sobre Babel.

**Categorías de `wc_findings`**:

- `endpoints`, `urls`, `secrets`, `regexes`, `interesting`: `extractReport()`.
- `sinks`: `eval`, `Function`, `innerHTML`, `outerHTML`, `document.write`,
  `setTimeout(string)`, `postMessage`, `addEventListener("message")`, `location = `.
- `storage`: `localStorage`/`sessionStorage`/`indexedDB`/`document.cookie`.
- `crypto`: `crypto.subtle`, constantes conocidas (MD5/SHA-1/SHA-256/AES/CRC32),
  `btoa`/`atob`, operaciones de bits densas.
- `vm`: `detectInterpreters()` (loop, dispatch, nº handlers, pc/bytecode).
- `summary`: recuento por categoría + los 5 hallazgos más relevantes.

## 5. Plan por fases

Cada tarea: una rama/commit propio, tests verdes (`pnpm test`), `typecheck`
y `lint` limpios. Los criterios de aceptación son obligatorios.

### 5.0 Trabajo en paralelo

El esqueleto está pensado para que varios agentes trabajen a la vez sin
pisarse:

- **Contratos fijos**: `workspace/types.ts` (modelo de datos),
  `tools/define.ts` (forma de una tool), `format/response.ts` y
  `format/errors.ts` (formato y errores). Solo se permiten cambios
  **aditivos**; si una tarea necesita cambiar un contrato, lo anota en su PR y
  se integra primero.
- **Registro ya hecho**: `tools/index.ts` ya lista todas las tools; ninguna
  tarea necesita editarlo.
- **Sin esperar al indexer**: cada tool se desarrolla y prueba contra
  `fixtureWorkspace()` de `test/helpers.ts`, precargado con
  `connect(fixtureWorkspace())`. La wave B/C NUNCA edita `test/helpers.ts`;
  si la tool necesita más datos, se añaden en su propio test
  (`const ws = fixtureWorkspace(); ws.interpreters = [...]`).
- **Un test por tarea**: `test/<tool>.test.ts`, para no generar conflictos.

**Orden de oleadas** (dentro de cada oleada, todo en paralelo):

| Oleada               | Tareas                | Archivos propios                                                                        |
| -------------------- | --------------------- | --------------------------------------------------------------------------------------- |
| A (serie, primero)   | M0.2, M0.3            | `packages/webcrack/{package.json,esbuild.config.js}`, `packages/webcrack/src/analysis-entry.ts` (nuevo), `mcp/src/config.ts` |
| A (serie, primero)   | A2.1                  | contratos: `workspace/types.ts`, `format/target.ts` (nuevo), stubs (`indexer`, `tags`, `loader`, `store`, `search-ast`), `test/{helpers,target}` |
| B                    | M1.1                  | `workspace/loader.ts` (suyo)                                                            |
| B                    | M1.2                  | `workspace/{indexer,store}.ts` (suyos) + módulo de caché (nuevo, suyo)                  |
| B                    | M1.4                  | `workspace/tags.ts`, `tools/map.ts`                                                     |
| B                    | M1.5                  | `tools/outline.ts`, `tools/read.ts`                                                     |
| B                    | M1.6                  | `tools/search.ts`                                                                       |
| B                    | M1.7                  | `tools/findings.ts`, `tools/goto.ts`, `workspace/findings.ts` (lógica compartida de findings, usada luego por M1.3 overview y M3.1) |
| B                    | M2.1                  | `tools/refs.ts`                                                                         |
| B                    | M2.2                  | `tools/graph.ts`                                                                        |
| B                    | M3.2                  | `prompts/audit.ts`                                                                      |
| C (tras M1.1 + M1.2) | M1.3                  | `tools/open.ts` (solo formato; `store.open`/`listCached`/caché son de M1.2)             |
| C                    | M2.3                  | `tools/annotate.ts`, `workspace/annotations.ts`                                         |
| C                    | M2.4                  | `tools/deobfuscate.ts`                                                                  |
| C                    | M2.5                  | `workspace/search-ast.ts` (lo llama `search.ts` con `kind=ast`)                         |
| C                    | M3.1, M3.3            | `tools/export.ts`, `resources/`                                                         |
| D (tras C)           | M1.8, M2.6, M3.4–M3.7 | `evals/`, `tools/trace.ts`, `tools/diff.ts`, docs                                       |

### Fase 0: cimientos

- [x] **M0.1** Esqueleto de `packages/mcp` (package.json, configs, servidor
      stdio, `defineTool`, stubs de todas las tools, helpers de formato,
      `test/helpers.ts` con `connect()` y `fixtureWorkspace()`, test de humo).
      _Ya preparado._
- [x] **M0.2** Exponer en `webcrack` un subpath aditivo `webcrack/analysis`
      que reexporte `extractReport`, `moduleGraph`, `callGraph`, `toDot`,
      `toJSON`, `detectInterpreters` y sus tipos; y `createNodeSandbox`.
      Añadir el entry a `packages/webcrack/esbuild.config.js` y a `exports` en
      su `package.json`. **No cambiar ninguna otra cosa del core.**
      _Acepta:_ `import { extractReport } from 'webcrack/analysis'` funciona
      desde `packages/mcp` tras `pnpm build`. Incluye además: ejecutar
      `pnpm install` en una terminal interactiva (pide confirmar la
      reinstalación de `node_modules`), tipar `Workspace.report` como `Report` y
      `interpreters` en `workspace/types.ts`, y rellenar `report` en
      `fixtureWorkspace()`. (Nota: ese resto —tipos y `report` del
      fixture— se hizo finalmente en A2.1.)
- [x] **M0.3** `config.ts`: `WEBCRACK_MCP_ROOTS` (rutas permitidas, por
      defecto `cwd`), `WEBCRACK_MCP_CACHE`, `WEBCRACK_MCP_MAX_INPUT` (def. 20 MB),
      `WEBCRACK_MCP_TIMEOUT_MS` (def. 120 000), `WEBCRACK_MCP_OUTPUT_BUDGET`
      (def. 20 000 chars). Tests de parseo.

### Fase 1: explorador núcleo (MVP)

- [x] **M1.1** `workspace/loader.ts`: `path` (dentro de roots, error
      accionable si no), `url` (solo http/https, límite de tamaño, timeout,
      sin seguir a `file:`), `code` literal. Detección automática del tipo.
- [ ] **M1.2** `workspace/indexer.ts` + `store.ts` (+ módulo de caché):
      `store.open`/`listCached`/caché con el pipeline de `wc_open` completo
      (§3.3) y `onProgress` → notificaciones de progreso MCP. El store recibe
      `webcrack` inyectable (`deps`) para espiar sin `vi.mock`.
      _Acepta:_ indexar el código de `fixtureWorkspace()` produce el mismo
      `index` que el fixture (test de contrato); reabrir el mismo input no
      vuelve a llamar a `webcrack()`
      (test con spy); el índice coincide en líneas con `module.code` y cada
      array del índice va en orden de fuente.
- [ ] **M1.3** `tools/open.ts` (`wc_open` + `wc_workspaces`): solo formato con
      la ficha de §3.4, incluyendo técnicas de ofuscación detectadas
      (inferidas de qué pases hicieron cambios o por heurística sobre el
      original). Usa `store.open`/`listCached` de M1.2 y la lógica
      compartida `workspace/findings.ts` de M1.7 para el overview.
- [x] **M1.4** `workspace/tags.ts` + `wc_map`: etiquetas `network`, `auth`,
      `crypto`, `storage`, `dom`, `vm`, `vendor` (librería conocida). Heurística
      simple y documentada; tests con el corpus.
- [x] **M1.5** `wc_outline` y `wc_read` (todos los formatos de `target`,
      `view=raw` sobre el original por rango de líneas).
- [x] **M1.6** `wc_search` con `text`, `regex`, `string`, `identifier`,
      `call`. (El modo `ast` va en M2.5.)
- [x] **M1.7** `wc_findings` (todas las categorías de §4) y `wc_goto`.
      La lógica compartida de findings vive en `workspace/findings.ts`
      (la usan luego M1.3 para el overview y M3.1 para exportar).
- [ ] **M1.8** Evaluación v1: `evals/tasks.jsonl` con ≥ 10 tareas sobre
      `packages/webcrack/test/corpus` y `evals/run.ts` que las ejecute con
      `claude -p --mcp-config evals/mcp.json --output-format json` y mida:
      acierto (checker por tarea), nº de tool calls y tokens.
      Documentar resultados en `evals/RESULTS.md`.

### Fase 2: relaciones y comprensión

- [x] **M2.1** `wc_refs` (callers / callees vía scope de Babel y el índice
      de llamadas; entre módulos vía imports).
- [x] **M2.2** `wc_graph` (`modules` con `moduleGraph`, `calls` con
      `callGraph`), recortado por `root` + `depth`; formatos `tree`/`json`/`dot`.
- [x] **M2.3** `wc_annotate`: renames con `scope.rename` sobre el AST del
      módulo, regenerar código, reindexar solo ese módulo, persistir en
      `annotations.json` y reaplicar al cargar de caché. Las notas se muestran
      en `wc_read`/`wc_outline` junto al símbolo.
- [x] **M2.4** `wc_deobfuscate` bajo demanda: pasar el `target` (con el
      contexto necesario del módulo) por webcrack/transformaciones de nuevo;
      `expression` evalúa en el sandbox (`createNodeSandbox`) con timeout.
      Muestra diff compacto; `apply=true` lo integra en el workspace.
- [x] **M2.5** `wc_search kind=ast` (patrones con `$X` / `$$ARGS`).
- [ ] **M2.6** Evaluación v2: ≥ 20 tareas (incluidas de navegación y
      anotación); comparar con v1 y ajustar descripciones de tools.

### Fase 3: flujo completo y funciones avanzadas

- [x] **M3.1** `wc_export` (código con renames, `report.json`, `notes.md`,
      grafos `.dot`).
- [ ] **M3.2** Prompt MCP `audit`: guía el flujo abrir → map → findings →
      investigar (goto/refs/read/annotate) → informe final.
- [x] **M3.3** Resources MCP: `webcrack://<ws>/module/<ruta>` y
      `webcrack://<ws>/report` para clientes que prefieran adjuntar recursos.
- [ ] **M3.4** `wc_trace value=…`: seguir el flujo de un valor (dónde se
      construye una URL/token y qué función lo envía) usando refs + asignaciones.
- [x] **M3.5** `wc_diff a b`: comparar dos workspaces (módulos cambiados por
      hash estructural, endpoints/secrets nuevos o eliminados).
- [ ] **M3.6** Integración con el MCP `browser-api`: documentar y probar el
      flujo `browser_trace_source` → `wc_open source=<código|url>`.
- [ ] **M3.7** README del paquete, `.mcp.json` de ejemplo en la raíz y
      sección en `README.md` principal.

## 6. Seguridad

- El código analizado es **hostil**. Nunca ejecutarlo fuera del sandbox
  (`isolated-vm`) y siempre con timeout y límite de memoria. Si `isolated-vm`
  no está disponible, `wc_open` funciona sin los pases que requieren sandbox y
  lo indica en la ficha.
- `path` restringido a `WEBCRACK_MCP_ROOTS`; `wc_export` también.
- `url`: solo `http`/`https`, tamaño máximo, sin credenciales en logs.
- Los strings del código analizado se devuelven como **datos**: el texto
  de las respuestas debe dejar claro qué es contenido del bundle (p. ej. dentro
  de bloques de código), para mitigar prompt injection desde el JS analizado.
- Los secretos se muestran recortados por defecto (`sk_live_ab…yz`) con
  `reveal=true` para verlos completos.

## 7. Pruebas

- **Unitarias** por tool: llamar al handler vía `Client` + `InMemoryTransport`
  del SDK (ver `test/server.test.ts`) usando muestras de
  `packages/webcrack/test/corpus`.
- **Snapshots** de las respuestas de texto (son el contrato con el agente).
- **Manual**: `npx @modelcontextprotocol/inspector node packages/mcp/dist/index.js`.
- **Evals** con agentes reales (M1.8, M2.6): la métrica que manda.

## 8. Convenciones

- Rama de trabajo: `feat/mcp` desde `advanced-re`. Commits `M<fase>.<n>: …`.
- No tocar `packages/webcrack/src` salvo M0.2 (aditivo). Si una tool necesita
  algo del core que no está expuesto, añadir un reexport en
  `webcrack/analysis`, nunca copiar código.
- Estilo: el del repo (TypeScript estricto, prettier, eslint compartido).
- Descripciones de tools: cortas, en inglés, diciendo **cuándo** usarla y
  qué devuelve; son parte del producto y se ajustan con las evals.

## 9. Uso

```bash
pnpm install && pnpm build
claude mcp add webcrack -- node /ruta/a/webcrack/packages/mcp/dist/index.js
```
