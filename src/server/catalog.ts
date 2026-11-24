// Reads the artifacts scripts/build-index.ts writes under public/a/<build>/, from the copy the
// build ships (dist/client/a/<build>/). The page fetches those same files; this process reads
// them from disk because a Vercel function cannot see the deployment's static files. Shards stay
// in memory after the first call. Module files are read only when a cmdlet is opened, as the
// page does.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, publicDir } from 'astro:config/server';
import { artifactPath } from '../app/artifacts';
import { parseSyntax, withDocumented } from '../app/powershell';
import { prepareSource, rowOf, rowsNamed, searchHits, setDescriptions, type Loaded, descriptionsOf } from '../app/search-core';
import { SOURCES, queryTokens } from '../app/sources';
import type { CmdletFile, IndexShard, Row } from '../app/types';
import { EMPTY_FILTERS } from '../app/url';
import generated from '../sources.generated.json';

const BUILD = generated.build;

export interface CmdletHit {
  name: string;
  module: string;
  source: string;
  description: string;
  url: string;
}

export interface CmdletRecord extends CmdletHit {
  moduleVersion: string;
  extra: string;
  syntax: string;
  parameters: { name: string; type: string; required: boolean; positional: boolean; description: string }[];
  examples: string[];
  permissions: string[];
}

export type ToolResult<T> = { ok: true; data: T } | { ok: false; message: string };

let artifactDir: string | null = null;

/**
 * Directory of this build's artifacts: a/<build>/ inside the directory the site serves its static
 * files from. In dev that is public/. In a build it is build.client, found the way @astrojs/node
 * finds it: walk up from this chunk to the build.server folder and apply the build-time path
 * from build.server to build.client. That holds for dist/ copied anywhere and for the Vercel
 * function, which carries dist/client/a/<build>/ at the same place relative to its server folder.
 */
function artifactRoot(): string {
  if (artifactDir) return artifactDir;
  let staticDir: string;
  if (import.meta.env.DEV) {
    staticDir = fileURLToPath(publicDir);
  } else {
    const serverName = basename(fileURLToPath(build.server));
    let dir = dirname(fileURLToPath(import.meta.url));
    while (basename(dir) !== serverName) {
      const parent = dirname(dir);
      if (parent === dir) throw new Error(`No "${serverName}" folder above ${fileURLToPath(import.meta.url)}`);
      dir = parent;
    }
    staticDir = join(dir, relative(fileURLToPath(build.server), fileURLToPath(build.client)));
  }
  const candidate = join(staticDir, 'a', BUILD);
  if (!existsSync(join(candidate, 'idx'))) throw new Error(`Cmdlet index ${BUILD} is not on disk (${candidate})`);
  artifactDir = candidate;
  return candidate;
}

async function readJson<T>(rel: string): Promise<T> {
  return JSON.parse(await readFile(join(artifactRoot(), rel), 'utf8')) as T;
}

let index: Promise<Loaded[]> | null = null;

function loadIndex(): Promise<Loaded[]> {
  if (!index) {
    index = loadAll().catch((err) => {
      index = null;
      throw err;
    });
  }
  return index;
}

async function loadAll(): Promise<Loaded[]> {
  const all: Loaded[] = [];
  for (let si = 0; si < SOURCES.length; si++) {
    const id = SOURCES[si].id;
    const shard = await readJson<IndexShard>(artifactPath.shard(id));
    const loaded = prepareSource(si, id, shard);
    try {
      setDescriptions(loaded, await readJson<string[]>(artifactPath.desc(id)));
    } catch {
      setDescriptions(loaded, null); // names still search, as in the worker
    }
    all.push(loaded);
  }
  return all;
}

const moduleFiles = new Map<string, Promise<CmdletFile>>();

function loadModuleFile(source: string, file: string): Promise<CmdletFile> {
  const key = `${source}/${file}`;
  let pending = moduleFiles.get(key);
  if (!pending) {
    pending = readJson<CmdletFile>(artifactPath.module(source, file));
    pending.catch(() => moduleFiles.delete(key));
    moduleFiles.set(key, pending);
  }
  return pending;
}

/** The module string the index stores, matched case-insensitively. Null when it is missing or ambiguous. */
function resolveModule(all: Loaded[], module: string): string | null {
  const want = module.toLowerCase();
  const names = new Set<string>();
  for (const L of all) for (const name of L.shard.mods) if (name && name.toLowerCase() === want) names.add(name);
  return names.size === 1 ? [...names][0] : null;
}

function resolveSource(source: string): string | null {
  const want = source.toLowerCase();
  return SOURCES.find((s) => s.id === want || s.short.toLowerCase() === want)?.id ?? null;
}

export function pageUrl(origin: string, key: string): string {
  const url = new URL('/', origin);
  url.searchParams.set('c', key);
  return url.toString();
}

function hit(origin: string, row: Row): CmdletHit {
  return {
    name: row.name,
    module: row.module,
    source: row.source,
    description: row.desc,
    url: pageUrl(origin, row.key),
  };
}

export async function searchCmdlets(origin: string, query: string, module: string | undefined, limit: number): Promise<ToolResult<{ results: CmdletHit[]; truncated: boolean; namesOnly: string[] }>> {
  // The site lists every cmdlet for an empty box. A query of only punctuation has no tokens
  // (queryTokens), and the ranker would do the same. That is not a search.
  if (!queryTokens(query).length) return { ok: false, message: 'Query needs an ASCII letter or digit; cmdlet names are ASCII, so punctuation or other scripts alone match nothing.' };
  const all = await loadIndex();
  let canonical = '';
  if (module) {
    canonical = resolveModule(all, module) ?? '';
    if (!canonical) return { ok: false, message: `Unknown module "${module}". Call list_modules for the names in the index.` };
  }
  const hits = searchHits(all, query, { ...EMPTY_FILTERS, module: canonical });
  return {
    ok: true,
    data: {
      results: hits.slice(0, limit).map((h) => hit(origin, rowOf(all, h.ref))),
      truncated: hits.length > limit,
      // Sources whose descriptions did not load: only names matched there, so an empty result
      // does not mean no cmdlet fits (the site shows a notice in the same case).
      namesOnly: descriptionsOf(all).failed,
    },
  };
}

export async function getCmdlet(origin: string, name: string, module: string | undefined): Promise<ToolResult<{ matches: CmdletRecord[] }>> {
  const all = await loadIndex();
  const anywhere = rowsNamed(all, name);
  if (!anywhere.length) return { ok: false, message: `Unknown cmdlet "${name}".` };
  const rows = module ? rowsNamed(all, name, module) : anywhere;
  if (!rows.length) {
    const where = [...new Set(anywhere.map((r) => r.module))].sort((a, b) => a.localeCompare(b));
    return { ok: false, message: `Unknown cmdlet "${name}" in module "${module}". It is in ${where.join(', ')}.` };
  }
  const matches: CmdletRecord[] = [];
  for (const row of rows) {
    const file = await loadModuleFile(row.source, row.file);
    const detail = file[row.name];
    if (!detail) return { ok: false, message: `Cmdlet "${row.name}" is in the index but its detail file has no entry.` };
    const parameters = withDocumented(parseSyntax(detail.syntax).params, detail.parameters);
    matches.push({
      ...hit(origin, row),
      description: detail.description,
      moduleVersion: row.moduleVersion,
      extra: row.extra,
      syntax: detail.syntax,
      parameters: parameters.map((p) => ({
        name: p.name,
        type: p.type,
        required: p.required,
        positional: p.positional,
        description: p.description,
      })),
      examples: detail.examples,
      permissions: detail.permissions,
    });
  }
  return { ok: true, data: { matches } };
}

export async function listModules(source: string | undefined): Promise<ToolResult<{ modules: { source: string; name: string; count: number }[] }>> {
  const all = await loadIndex();
  let id = '';
  if (source) {
    id = resolveSource(source) ?? '';
    if (!id) return { ok: false, message: `Unknown source "${source}". Sources: ${SOURCES.map((s) => s.id).join(', ')}.` };
  }
  const modulesOut: { source: string; name: string; count: number }[] = [];
  for (const L of all) {
    if (id && L.id !== id) continue;
    const counts = new Map<string, number>();
    for (const mid of L.shard.m) {
      const name = L.shard.mods[mid];
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    for (const [name, count] of counts) modulesOut.push({ source: L.id, name, count });
  }
  modulesOut.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
  return { ok: true, data: { modules: modulesOut } };
}
