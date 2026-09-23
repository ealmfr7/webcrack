# @webcrack/mcp

Servidor MCP que convierte webcrack en un explorador de reversing para
agentes: abrir, orientarse, buscar, navegar, leer, desofuscar bajo demanda,
anotar y exportar.

Diseño y plan de trabajo: [`ROADMAP_MCP.md`](../../ROADMAP_MCP.md).

```bash
pnpm install && pnpm --filter @webcrack/mcp build
claude mcp add webcrack -- node "$PWD/packages/mcp/dist/index.js"
npx @modelcontextprotocol/inspector node packages/mcp/dist/index.js
```
