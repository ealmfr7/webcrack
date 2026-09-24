import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { WcError } from '../format/errors';
import { resolveModule } from '../format/target';
import type { WorkspaceStore } from '../workspace/store';
import type { Workspace } from '../workspace/types';

/** Max resources enumerated by the list callbacks. */
const LIST_LIMIT = 500;

/** Report resource first per workspace, then its modules. */
function collectUris(store: WorkspaceStore): { uri: string; name: string }[] {
  const out: { uri: string; name: string }[] = [];
  for (const ws of store.list()) {
    out.push({ uri: `webcrack://${ws.id}/report`, name: `report of ${ws.id}` });
    for (const path of ws.modules.keys()) {
      out.push({
        uri: `webcrack://${ws.id}/module/${path}`,
        name: `${path} in ${ws.id}`,
      });
    }
    if (out.length >= LIST_LIMIT) break;
  }
  return out.slice(0, LIST_LIMIT);
}

/** A `WcError` from `store.get`/`resolveModule` becomes `InvalidParams`. */
function invalidParams(error: unknown): never {
  if (error instanceof WcError) {
    throw new McpError(ErrorCode.InvalidParams, error.message);
  }
  throw error;
}

function decodePath(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid percent-encoding in module path "${raw}".`,
    );
  }
}

/** Expose workspace content as MCP resources (ROADMAP_MCP M3.3). */
export function registerResources(
  server: McpServer,
  store: WorkspaceStore,
): void {
  server.registerResource(
    'webcrack-report',
    new ResourceTemplate('webcrack://{ws}/report', {
      list: () =>
        Promise.resolve({
          resources: collectUris(store)
            .filter((entry) => entry.uri.endsWith('/report'))
            .map((entry) => ({
              uri: entry.uri,
              name: entry.name,
              mimeType: 'application/json',
            })),
        }),
    }),
    {
      title: 'webcrack workspace report',
      description: 'Findings report (endpoints, urls, secrets) of a workspace.',
      mimeType: 'application/json',
    },
    (uri, variables) => {
      let ws: Workspace;
      try {
        ws = store.get(String(variables.ws));
      } catch (error) {
        invalidParams(error);
      }
      return Promise.resolve({
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(ws.report),
          },
        ],
      });
    },
  );

  server.registerResource(
    'webcrack-module',
    new ResourceTemplate('webcrack://{ws}/module/{+path}', {
      list: () =>
        Promise.resolve({
          resources: collectUris(store)
            .filter((entry) => entry.uri.includes('/module/'))
            .map((entry) => ({
              uri: entry.uri,
              name: entry.name,
              mimeType: 'text/javascript',
            })),
        }),
    }),
    {
      title: 'webcrack module code',
      description: 'Clean code of one module in a workspace.',
      mimeType: 'text/javascript',
    },
    (uri, variables) => {
      let ws: Workspace;
      try {
        ws = store.get(String(variables.ws));
      } catch (error) {
        invalidParams(error);
      }
      const path = decodePath(String(variables.path ?? ''));
      try {
        const entry = resolveModule(ws, path);
        return Promise.resolve({
          contents: [
            { uri: uri.href, mimeType: 'text/javascript', text: entry.code },
          ],
        });
      } catch (error) {
        invalidParams(error);
      }
    },
  );
}
