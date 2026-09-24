import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { z } from 'zod';
import { WcError } from '../format/errors';
import { textResult } from '../format/response';
import { assertSafeModulePath } from '../workspace/cache';
import { assertInsideRoots } from '../workspace/loader';
import type { Annotation, Workspace } from '../workspace/types';
import { defineTool, workspaceArg } from './define';
import { buildModulesGraph, renderDot } from './graph';

const includeItem = z.enum(['code', 'report', 'notes', 'graph']);
type IncludeItem = z.infer<typeof includeItem>;

let tmpCounter = 0;

/** Write a file atomically: temp file in the same directory plus rename. */
async function writeFileAtomic(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${tmpCounter++}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
}

async function writeChecked(
  dir: string,
  rel: string,
  content: string,
): Promise<void> {
  const file = join(dir, rel);
  if (relative(dir, file).startsWith('..')) {
    throw new WcError(
      `Cannot export ${JSON.stringify(rel)}: the path escapes the export directory. ` +
        `Rename the module or report the bundle as unsupported.`,
    );
  }
  try {
    await writeFileAtomic(file, content);
  } catch (error) {
    if (error instanceof WcError) throw error;
    throw new WcError(
      `Cannot write ${JSON.stringify(file)}: ${(error as Error).message}. ` +
        `Check the directory's permissions and disk space, then retry with overwrite: true.`,
    );
  }
}

function reportJson(ws: Workspace): string {
  return `${JSON.stringify(
    {
      report: ws.report,
      interpreters: ws.interpreters,
      bundle: ws.bundle ?? null,
      source: ws.source,
    },
    null,
    2,
  )}\n`;
}

function groupAnnotations(
  annotations: Annotation[],
): { module: string; items: { name: string; text: string }[] }[] {
  const byModule = new Map<string, { name: string; text: string }[]>();
  for (const annotation of annotations) {
    const colon = annotation.symbol.lastIndexOf(':');
    const module =
      colon === -1 ? '(unknown)' : annotation.symbol.slice(0, colon);
    const name =
      colon === -1 ? annotation.symbol : annotation.symbol.slice(colon + 1);
    let text: string;
    if (annotation.rename && annotation.note) {
      text = ` → ${annotation.rename}: ${annotation.note}`;
    } else if (annotation.rename) {
      text = ` → ${annotation.rename}`;
    } else if (annotation.note) {
      text = `: ${annotation.note}`;
    } else {
      continue;
    }
    const list = byModule.get(module) ?? [];
    list.push({ name, text });
    byModule.set(module, list);
  }
  return [...byModule.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([module, items]) => ({
      module,
      items: items.sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      ),
    }));
}

function notesMd(ws: Workspace): string {
  const lines = [`# Notes — workspace ${ws.id} (${ws.source.label})`, ''];
  const groups = groupAnnotations(ws.annotations);
  if (groups.length === 0) {
    lines.push(
      'No annotations yet. Use wc_annotate to record renames and notes.',
    );
    lines.push('');
    return lines.join('\n');
  }
  for (const group of groups) {
    lines.push(`## ${group.module}`, '');
    for (const item of group.items) {
      lines.push(`- ${item.name}${item.text}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export const exportWorkspace = defineTool({
  name: 'wc_export',
  title: 'Export workspace',
  description:
    'Write the reconstructed project to a directory: clean modules with renames, report.json, notes.md and .dot graphs.',
  inputSchema: {
    workspace: workspaceArg,
    dir: z
      .string()
      .describe('Output directory (must be inside the allowed roots).'),
    include: z.array(includeItem).default(['code', 'report', 'notes']),
    overwrite: z
      .boolean()
      .default(false)
      .describe(
        'Allow writing into a non-empty directory. Without it the export refuses to touch a directory that already has files.',
      ),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
  handler: async (args, ctx) => {
    const ws = ctx.store.get(args.workspace);
    const include: IncludeItem[] = args.include ?? ['code', 'report', 'notes'];
    const dir = await assertInsideRoots(args.dir, ctx.config);
    let entries;
    try {
      entries = await readdir(dir);
    } catch (error) {
      throw new WcError(
        `Cannot list directory ${JSON.stringify(dir)}: ${(error as Error).message}. ` +
          `Check the path and its permissions, or pick another directory inside WEBCRACK_MCP_ROOTS.`,
      );
    }
    if (entries.length > 0 && !(args.overwrite ?? false)) {
      throw new WcError(
        `Directory ${JSON.stringify(dir)} is not empty (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}). ` +
          `Pass overwrite: true to export into it anyway, or pick an empty directory.`,
      );
    }
    const written: string[] = [];
    const counts: string[] = [];
    if (include.includes('code')) {
      for (const module of ws.modules.values()) {
        assertSafeModulePath(module.path);
      }
      let modules = 0;
      for (const module of ws.modules.values()) {
        const rel = join('modules', module.path);
        await writeChecked(dir, rel, module.code);
        written.push(rel);
        modules++;
      }
      counts.push(`${modules} code`);
    }
    if (include.includes('report')) {
      await writeChecked(dir, 'report.json', reportJson(ws));
      written.push('report.json');
      counts.push('1 report');
    }
    if (include.includes('notes')) {
      await writeChecked(dir, 'notes.md', notesMd(ws));
      written.push('notes.md');
      counts.push('1 notes');
    }
    if (include.includes('graph')) {
      const dot = renderDot(
        'modules',
        buildModulesGraph(ws, undefined, Number.MAX_SAFE_INTEGER),
      );
      await writeChecked(dir, 'modules.dot', `${dot}\n`);
      written.push('modules.dot');
      counts.push('1 graph');
    }
    const body =
      `Exported workspace ${ws.id} to ${dir}: ${written.length} file${written.length === 1 ? '' : 's'} (${counts.join(', ') || 'nothing requested'}).\n` +
      written.join('\n');
    const entry =
      [...ws.modules.values()].find((m) => m.isEntry)?.path ??
      [...ws.modules.values()].map((m) => m.path)[0];
    return textResult(body, {
      budget: ctx.config.outputBudget,
      next: entry ? [`wc_read ${entry}`, 'wc_map'] : ['wc_map'],
    });
  },
});
