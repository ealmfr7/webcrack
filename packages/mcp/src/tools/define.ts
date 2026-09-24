import type {
  CallToolResult,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from '../config';
import type { WorkspaceStore } from '../workspace/store';

export interface ToolContext {
  store: WorkspaceStore;
  config: Config;
  /** Report progress in [0, 1] (forwarded as MCP progress notifications). */
  progress: (fraction: number, message?: string) => Promise<void>;
}

export interface ToolDef<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  /** Says when to use the tool and what it returns. Keep it short; it is part of the product. */
  description: string;
  inputSchema: Shape;
  annotations?: ToolAnnotations;
  handler: (
    args: z.infer<z.ZodObject<Shape>>,
    ctx: ToolContext,
  ) => Promise<CallToolResult>;
}

export function defineTool<Shape extends z.ZodRawShape>(
  def: ToolDef<Shape>,
): ToolDef {
  return def as unknown as ToolDef;
}

// -- Shared argument schemas ------------------------------------------------

export const workspaceArg = z
  .string()
  .optional()
  .describe('Workspace id from wc_open. Defaults to the last opened one.');

export const pagination = {
  limit: z.number().int().min(1).max(500).default(30),
  offset: z.number().int().min(0).default(0),
};

export const readOnly: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: false,
};
