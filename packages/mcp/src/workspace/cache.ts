import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { Config } from '../config';
import { WcError } from '../format/errors';
import type { CachedSummary, ModuleEntry, ModuleTag, Workspace } from './types';

/** Module list stored in `meta.json`, preserving the bundle module order. */
export interface CachedModuleMeta {
  path: string;
  bundleId: string;
  isEntry: boolean;
  tags: ModuleTag[];
}

interface CacheMeta {
  id: string;
  source: Workspace['source'];
  bundle?: Workspace['bundle'];
  stats: Workspace['stats'];
  openedAt: string;
  webcrackVersion: string;
  modules: CachedModuleMeta[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseMeta(data: unknown): CacheMeta {
  if (!isRecord(data)) throw new Error('invalid meta.json: not an object');
  if (typeof data['id'] !== 'string' || data['id'] === '') {
    throw new Error('invalid meta.json: bad id');
  }
  const source = data['source'];
  if (!isRecord(source)) throw new Error('invalid meta.json: bad source');
  if (
    source['kind'] !== 'path' &&
    source['kind'] !== 'url' &&
    source['kind'] !== 'code'
  ) {
    throw new Error('invalid meta.json: bad source.kind');
  }
  if (
    typeof source['label'] !== 'string' ||
    typeof source['bytes'] !== 'number'
  ) {
    throw new Error('invalid meta.json: bad source label/bytes');
  }
  let bundle: CacheMeta['bundle'];
  if (data['bundle'] !== undefined) {
    const raw = data['bundle'];
    if (
      !isRecord(raw) ||
      typeof raw['type'] !== 'string' ||
      typeof raw['entryId'] !== 'string'
    ) {
      throw new Error('invalid meta.json: bad bundle');
    }
    bundle = { type: raw['type'], entryId: raw['entryId'] };
  }
  const stats = data['stats'];
  if (
    !isRecord(stats) ||
    typeof stats['openMs'] !== 'number' ||
    !Array.isArray(stats['techniques']) ||
    !stats['techniques'].every((item) => typeof item === 'string')
  ) {
    throw new Error('invalid meta.json: bad stats');
  }
  if (
    typeof data['openedAt'] !== 'string' ||
    typeof data['webcrackVersion'] !== 'string'
  ) {
    throw new Error('invalid meta.json: bad openedAt/version');
  }
  if (!Array.isArray(data['modules'])) {
    throw new Error('invalid meta.json: bad modules');
  }
  const modules: CachedModuleMeta[] = data['modules'].map((item) => {
    if (
      !isRecord(item) ||
      typeof item['path'] !== 'string' ||
      typeof item['bundleId'] !== 'string' ||
      typeof item['isEntry'] !== 'boolean' ||
      !Array.isArray(item['tags']) ||
      !item['tags'].every((tag) => typeof tag === 'string')
    ) {
      throw new Error('invalid meta.json: bad module entry');
    }
    return {
      path: item['path'],
      bundleId: item['bundleId'],
      isEntry: item['isEntry'],
      tags: item['tags'] as ModuleTag[],
    };
  });
  return {
    id: data['id'],
    source: {
      kind: source['kind'],
      label: source['label'],
      bytes: source['bytes'],
    },
    ...(bundle === undefined ? {} : { bundle }),
    stats: {
      openMs: stats['openMs'],
      techniques: stats['techniques'],
    },
    openedAt: data['openedAt'],
    webcrackVersion: data['webcrackVersion'],
    modules,
  };
}

/**
 * Reject module paths that could escape the cache directory: empty paths,
 * NUL bytes, absolute paths and `..` segments. Module code is untrusted
 * input, so a hostile bundle must never cause a write outside its own dir.
 */
function assertSafeModulePath(path: string): void {
  const refuse = (reason: string): WcError =>
    new WcError(
      `Cannot cache module "${path}": ${reason}. Rename the module or report the bundle as unsupported.`,
    );
  if (path === '' || path.includes('\0')) {
    throw refuse('the path is empty or contains a NUL byte');
  }
  if (
    isAbsolute(path) ||
    /^[a-zA-Z]:[\\/]/.test(path) ||
    path.startsWith('\\\\')
  ) {
    throw refuse('absolute paths are not allowed');
  }
  if (path.split(/[\\/]/).includes('..')) {
    throw refuse('".." segments are not allowed');
  }
}

let tmpCounter = 0;

/** Write a file atomically: temp file in the same directory plus rename. */
async function writeFileAtomic(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${tmpCounter++}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
}

/**
 * Persist a workspace under `<cacheDir>/<id>/`: `meta.json`, `original.js`,
 * `modules/<path>`, `index.json`, `report.json`, `interpreters.json` and
 * `annotations.json`. Every module path is validated before anything is
 * written, so a hostile path leaves no partial cache behind.
 */
export async function writeWorkspaceToCache(
  config: Config,
  workspace: Workspace,
  webcrackVersion: string,
): Promise<void> {
  for (const module of workspace.modules.values()) {
    assertSafeModulePath(module.path);
  }
  const dir = join(config.cacheDir, workspace.id);
  const meta: CacheMeta = {
    id: workspace.id,
    source: workspace.source,
    ...(workspace.bundle === undefined ? {} : { bundle: workspace.bundle }),
    stats: workspace.stats,
    openedAt: new Date().toISOString(),
    webcrackVersion,
    modules: [...workspace.modules.values()].map((module) => ({
      path: module.path,
      bundleId: module.bundleId,
      isEntry: module.isEntry,
      tags: module.tags,
    })),
  };
  await writeFileAtomic(
    join(dir, 'meta.json'),
    `${JSON.stringify(meta, null, 2)}\n`,
  );
  await writeFileAtomic(join(dir, 'original.js'), workspace.original);
  for (const module of workspace.modules.values()) {
    const file = join(dir, 'modules', module.path);
    if (relative(dir, file).startsWith('..')) {
      throw new WcError(
        `Cannot cache module "${module.path}": the path escapes the cache directory. Rename the module or report the bundle as unsupported.`,
      );
    }
    await writeFileAtomic(file, module.code);
  }
  await writeFileAtomic(
    join(dir, 'index.json'),
    JSON.stringify(workspace.index),
  );
  await writeFileAtomic(
    join(dir, 'report.json'),
    JSON.stringify(workspace.report),
  );
  await writeFileAtomic(
    join(dir, 'interpreters.json'),
    JSON.stringify(workspace.interpreters),
  );
  await writeFileAtomic(
    join(dir, 'annotations.json'),
    JSON.stringify(workspace.annotations),
  );
}

/**
 * Load a workspace from `<cacheDir>/<id>/`. A corrupt or incomplete cache
 * (unreadable files, invalid JSON, unexpected shapes, id mismatch) is a
 * miss: it returns `undefined` so the caller rebuilds from scratch.
 */
export async function readWorkspaceFromCache(
  config: Config,
  id: string,
): Promise<Workspace | undefined> {
  try {
    const dir = join(config.cacheDir, id);
    const meta = parseMeta(
      JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as unknown,
    );
    if (meta.id !== id) return undefined;
    const [original, index, report, interpreters, annotations]: unknown[] =
      await Promise.all([
        readFile(join(dir, 'original.js'), 'utf8'),
        JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as unknown,
        JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as unknown,
        JSON.parse(
          await readFile(join(dir, 'interpreters.json'), 'utf8'),
        ) as unknown,
        JSON.parse(
          await readFile(join(dir, 'annotations.json'), 'utf8'),
        ) as unknown,
      ]);
    if (
      typeof original !== 'string' ||
      !isRecord(index) ||
      !isRecord(report) ||
      !Array.isArray(interpreters) ||
      !Array.isArray(annotations)
    ) {
      return undefined;
    }
    const modules = new Map<string, ModuleEntry>();
    for (const item of meta.modules) {
      assertSafeModulePath(item.path);
      const code = await readFile(join(dir, 'modules', item.path), 'utf8');
      modules.set(item.path, {
        path: item.path,
        bundleId: item.bundleId,
        isEntry: item.isEntry,
        code,
        tags: item.tags,
      });
    }
    return {
      id: meta.id,
      source: meta.source,
      original,
      ...(meta.bundle === undefined ? {} : { bundle: meta.bundle }),
      modules,
      index: index as unknown as Workspace['index'],
      report: report as unknown as Workspace['report'],
      interpreters: interpreters as Workspace['interpreters'],
      annotations: annotations as Workspace['annotations'],
      stats: meta.stats,
    };
  } catch {
    return undefined;
  }
}

/**
 * One-line summaries of every disk-cached workspace, newest first.
 * Entries whose `meta.json` is missing or corrupt are skipped.
 */
export async function listCachedWorkspaces(
  config: Config,
): Promise<CachedSummary[]> {
  let entries;
  try {
    entries = await readdir(config.cacheDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const summaries: CachedSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const meta = parseMeta(
        JSON.parse(
          await readFile(
            join(config.cacheDir, entry.name, 'meta.json'),
            'utf8',
          ),
        ) as unknown,
      );
      summaries.push({
        id: meta.id,
        kind: meta.source.kind,
        label: meta.source.label,
        ...(meta.bundle === undefined ? {} : { bundleType: meta.bundle.type }),
        moduleCount: meta.modules.length,
        openedAt: meta.openedAt,
      });
    } catch {
      continue;
    }
  }
  summaries.sort((a, b) =>
    a.openedAt < b.openedAt ? 1 : a.openedAt > b.openedAt ? -1 : 0,
  );
  return summaries;
}
