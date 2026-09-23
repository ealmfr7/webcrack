import type { Config } from '../config';
import { WcError } from '../format/errors';
import type { Workspace } from './types';

/**
 * Open workspaces, kept in memory. The disk cache (ROADMAP_MCP §3.3, M1.2)
 * plugs in here.
 */
export class WorkspaceStore {
  #workspaces = new Map<string, Workspace>();
  #current: string | undefined;

  constructor(readonly config: Config) {}

  add(workspace: Workspace): void {
    this.#workspaces.set(workspace.id, workspace);
    this.#current = workspace.id;
  }

  /** The workspace with `id`, or the most recently opened one. */
  get(id?: string): Workspace {
    const key = id ?? this.#current;
    if (key === undefined) {
      throw new WcError(
        'No workspace is open. Call wc_open with a file path, URL or code first.',
      );
    }
    const workspace = this.#workspaces.get(key);
    if (!workspace) {
      throw new WcError(
        `Unknown workspace "${key}". Call wc_workspaces to list them.`,
        [...this.#workspaces.keys()],
      );
    }
    return workspace;
  }

  list(): Workspace[] {
    return [...this.#workspaces.values()];
  }
}
