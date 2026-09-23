# Evaluaciones del MCP (M1.8 / M2.6)

Miden si un agente real resuelve tareas de reversing con las tools, y con qué
coste. Es la métrica principal para ajustar descripciones y formatos.

- `tasks.jsonl`: una tarea por línea:
  `{"id", "sample", "prompt", "check": {"type": "contains" | "regex", "value"}}`.
  `sample` es relativo a `packages/webcrack/test/corpus`.
- `mcp.json`: configuración MCP que apunta a `../dist/index.js`.
- `run.ts`: ejecuta cada tarea con
  `claude -p "<prompt>" --mcp-config evals/mcp.json --output-format json`,
  aplica el `check` a la respuesta final y registra acierto, nº de tool calls,
  turnos y tokens.
- `RESULTS.md`: tabla de resultados por versión (fecha, commit, % acierto,
  mediana de llamadas, tokens).

Ejemplos de tareas: "¿Qué endpoint usa el login y con qué método?",
"¿Qué función decodifica los strings y qué devuelve para 0x1a3?",
"¿Qué módulo guarda el token y dónde?".
