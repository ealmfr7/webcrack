import { annotate } from './annotate';
import { deobfuscate } from './deobfuscate';
import type { ToolDef } from './define';
import { exportWorkspace } from './export';
import { findings } from './findings';
import { goto } from './goto';
import { graph } from './graph';
import { map } from './map';
import { open, workspaces } from './open';
import { outline } from './outline';
import { read } from './read';
import { refs } from './refs';
import { search } from './search';

/** In the order an analyst uses them: load, orient, search, navigate, understand, finish. */
export const tools: ToolDef[] = [
  open,
  workspaces,
  map,
  outline,
  search,
  findings,
  read,
  goto,
  refs,
  graph,
  deobfuscate,
  annotate,
  exportWorkspace,
];
