import { webcrack } from 'webcrack';
import type { Config } from '../config';
import { notImplemented, WcError } from '../format/errors';
import type { CachedSummary, OpenOptions, Workspace } from './types';

/** Injectable processor, so tests can spy without `vi.mock`. */
export interface StoreDeps {
  webcrack: typeof webcrack;
}

export type ProgressFn = (fraction: number, message?: string) => Promise<void>;

/**
 * Open workspaces, kept in memory. The disk cache (ROADMAP_MCP §3.3, M1.2)
 * plugs in here: `open` reuses it, `listCached` enumerates it.
 */
export class WorkspaceStore {
  #workspaces = new Map<string, Workspace>();
  #current: string | undefined;

  constructor(
    readonly config: Config,
    readonly deps: StoreDeps = { webcrack },
  ) {}

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

  /**
   * Full `wc_open` pipeline (M1.2): load the source, run it through the
   * injectable `webcrack` processor, index the clean modules, persist to
   * the disk cache, and register the workspace. `cached` is true when the
   * workspace came from the cache without reprocessing.
   */
  open(
    source: string,
    options: OpenOptions,
    progress: ProgressFn,
  ): Promise<{ workspace: Workspace; cached: boolean }> {
    void source;
    void options;
    void progress;
    return notImplemented('M1.2');
  }

  /** One-line summaries of every disk-cached workspace (M1.2). */
  listCached(): Promise<CachedSummary[]> {
    return notImplemented('M1.2');
  }
}
