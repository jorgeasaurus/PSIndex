// Build-time step: turns the raw pipeline output in data/<source>/ into
//   src/sources.generated.json        – the source list (single source of truth for the app and worker)
//   public/idx/<source>.json          – columnar search index (names + facets), loaded first
//   public/idx/<source>.desc.json     – short descriptions aligned to the index, loaded after first paint
//   public/data/<source>/<module>.json – per-module detail, fetched on demand
// Everything written here is typed against src/app/types.ts, which the app reads it as.
import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { existsSync } from 'node:fs';
import type { CmdletDetail, CmdletFile, DocumentedParam, IndexShard, SourceMeta } from '../src/app/types.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const DATA = join(ROOT, 'data');
const OUT_IDX = join(ROOT, 'public', 'idx');
const OUT_DATA = join(ROOT, 'public', 'data');
const DESC_MAX = 220;

interface SourceDef extends Pick<SourceMeta, 'id' | 'label' | 'short' | 'color' | 'sample'> {
  /** An optional per-cmdlet facet: `field` is its key in the manifest rows, `warn` a value shown as a caution. */
  extra: { label: string; field: string; warn?: string } | null;
  /** For a pipeline whose rows carry no module (MECM is one module), the module of every row. */
  module?: string;
  /** Whether the manifest records a permission count per cmdlet (`p`). */
  perms?: true;
}

// Every per-source fact lives here.
const SOURCES: SourceDef[] = [
  { id: 'graph', label: 'Microsoft Graph', short: 'Graph', color: '#9b8cff', sample: 'Get-MgUser', perms: true, extra: { label: 'API', field: 'a', warn: 'beta' } },
  { id: 'az', label: 'Azure (Az)', short: 'Az', color: '#4cb3ff', sample: 'Get-AzVM', extra: null },
  { id: 'entra', label: 'Microsoft Entra', short: 'Entra', color: '#2fd0b5', sample: 'Get-EntraGroupMember', perms: true, extra: { label: 'API', field: 'a', warn: 'beta' } },
  { id: 'exchange', label: 'Exchange, Teams & SharePoint', short: 'Exchange', color: '#f2b33d', sample: 'Set-Mailbox', extra: null },
  { id: 'mecm', label: 'Configuration Manager', short: 'MECM', color: '#7fd45a', sample: 'Invoke-CMClientAction', module: 'ConfigurationManager', extra: { label: 'Site role', field: 'r' } },
];

// ---- Pipeline output (data/<source>/), as the parsers write it -----------------------------

// Read as unknown and checked field by field: a parser change that breaks the shape fails the build.
interface Manifest { v: unknown; d: unknown }
interface RawCmdlet { syntax?: unknown; examples?: unknown; permissions?: unknown; parameters?: unknown }
type RawParam = { name: string; type: string; required: boolean; description?: string };
interface RawModuleFile { cmdlets: unknown }

/** One index row, before it is split into columns. */
interface Row { n: string; v: string; m: string; c: string; f: string; x: string; p: number; e: boolean; desc: string }

const readJson = async <T>(p: string): Promise<T> => JSON.parse(await readFile(p, 'utf8'));
const clip = (s: string) => {
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > DESC_MAX ? s.slice(0, DESC_MAX - 1).trimEnd() + '…' : s;
};

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const params = (v: unknown): v is RawParam[] => Array.isArray(v) && v.every((x) =>
  typeof x?.name === 'string' && typeof x.type === 'string' && typeof x.required === 'boolean' && (x.description === undefined || typeof x.description === 'string'));

/** The detail shape the app reads: every field present, so the UI never guesses. */
function normalizeCmdlet(where: string, raw: unknown, description: string): CmdletDetail {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${where}: not an object`);
  const c: RawCmdlet = raw; // an object whose fields are all checked below
  if (typeof c.syntax !== 'string') throw new Error(`${where}: syntax is not a string`);
  if (!strings(c.examples)) throw new Error(`${where}: examples is not a list of strings`);
  if (c.permissions !== undefined && !strings(c.permissions)) throw new Error(`${where}: permissions is not a list of strings`);
  if (c.parameters !== undefined && !params(c.parameters)) throw new Error(`${where}: parameters are not {name, type, required, description?}`);
  return {
    syntax: c.syntax,
    examples: c.examples,
    permissions: c.permissions ?? [], // only Graph and Entra document permissions
    // Only MECM documents parameters separately.
    parameters: (c.parameters ?? []).map((p): DocumentedParam => ({ ...p, description: p.description ?? '' })),
    description, // descriptions.json is the one source, as for the index row
  };
}

/**
 * One manifest row, checked: the fields every source writes, the source's own extra facet and
 * permission count, and the module (and its file) the row resolves to.
 */
function parseManifestRow(src: SourceDef, raw: unknown, holders: Map<string, string[]>, descriptions: Record<string, string>): Row {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${src.id} manifest: a row is not an object`);
  const r = raw as Record<string, unknown>; // an object; each field is checked below
  const name = typeof r.n === 'string' ? r.n : '';
  const fail = (what: string): never => { throw new Error(`${src.id} manifest, ${name || JSON.stringify(raw)}: ${what}`); };
  const str = (k: string) => { const v = r[k]; return typeof v === 'string' ? v : fail(`${k} is not a string`); };
  if (!name) fail('n (name) is not a string');
  const e = r.e;
  if (typeof e !== 'boolean') return fail('e (has examples) is not a boolean');
  const m = r.m === undefined && src.module ? src.module : str('m');
  if (!m) fail('no module');
  const files = (holders.get(name) ?? []).sort();
  if (!files.length) fail('no module file');
  return {
    n: name, v: str('v'), c: str('c'), e, m,
    p: !src.perms ? 0 : typeof r.p === 'number' ? r.p : fail('p (permission count) is not a number'),
    x: src.extra ? str(src.extra.field) : '',
    f: files.includes(m) ? m : files[0], // prefer the file named after the row's own module
    desc: descriptions[name] ?? '',
  };
}

/** Write a source's normalized module files to public/data/<source>/ and return its rows, sorted by name. */
async function loadRows(src: SourceDef, out: string): Promise<{ version: string; rows: Row[] }> {
  const dir = join(DATA, src.id);
  const manifest = await readJson<Manifest>(join(dir, 'manifest.json'));
  const descriptions = await readJson<Record<string, string>>(join(dir, 'descriptions.json'));
  // A name can live in several module files (Entra v1.0 + beta, Teams + Skype, Az.PostgreSql + Az.PostgreSqlFlexibleServer).
  const holders = new Map<string, string[]>();
  for (const f of (await readdir(join(dir, 'modules'))).filter((f) => f.endsWith('.json'))) {
    const stem = basename(f, '.json');
    const raw = await readJson<RawModuleFile>(join(dir, 'modules', f));
    if (typeof raw.cmdlets !== 'object' || raw.cmdlets === null) throw new Error(`${src.id}/${f}: cmdlets is not an object`);
    const file: CmdletFile = {};
    for (const [name, c] of Object.entries(raw.cmdlets)) {
      holders.set(name, [...(holders.get(name) ?? []), stem]);
      file[name] = normalizeCmdlet(`${src.id}/${f} ${name}`, c, descriptions[name] ?? '');
    }
    await writeFile(join(out, f), JSON.stringify(file));
  }
  if (!Array.isArray(manifest.d)) throw new Error(`${src.id} manifest: d is not a list`);
  if (manifest.v !== null && typeof manifest.v !== 'string') throw new Error(`${src.id} manifest: v is not a string or null`);
  const rows = manifest.d.map((r) => parseManifestRow(src, r, holders, descriptions));
  return { version: manifest.v ?? '', rows: rows.sort((a, b) => a.n.localeCompare(b.n)) };
}

function interner() {
  const list: string[] = [];
  const map = new Map<string, number>();
  return {
    list,
    id(v: string) {
      let i = map.get(v);
      if (i === undefined) { i = list.length; list.push(v); map.set(v, i); }
      return i;
    },
  };
}

/** Rows (already in display order) -> the columnar shard plus the aligned description array. */
function buildShard(rows: Row[]): { index: IndexShard; desc: string[] } {
  const verbs = interner(), mods = interner(), cats = interner(), files = interner(), extras = interner();
  const index: IndexShard = { n: [], v: [], m: [], c: [], f: [], x: [], p: [], e: [], verbs: verbs.list, mods: mods.list, cats: cats.list, files: files.list, extras: extras.list };
  for (const r of rows) {
    index.n.push(r.n);
    index.v.push(verbs.id(r.v));
    index.m.push(mods.id(r.m));
    index.c.push(cats.id(r.c));
    index.f.push(files.id(r.f));
    index.x.push(extras.id(r.x));
    index.p.push(r.p);
    index.e.push(r.e ? 1 : 0);
  }
  return { index, desc: rows.map((r) => clip(r.desc)) };
}

/** SOURCES, data/<id>/ and pipelines/<id>/source.env must name the same sources. */
async function checkRegistries() {
  const ids = SOURCES.map((s) => s.id).sort().join(',');
  const dirs = async (root: string, marker?: string) => (await readdir(root, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => !marker || existsSync(join(root, name, marker)))
    .sort().join(',');
  const data = await dirs(DATA);
  const pipelines = await dirs(join(ROOT, 'pipelines'), 'source.env');
  if (data !== ids || pipelines !== ids) {
    throw new Error(`Source lists disagree. SOURCES: ${ids}; data/: ${data}; pipelines/*/source.env: ${pipelines}`);
  }
}

async function main() {
  const t0 = Date.now();
  await checkRegistries();
  await rm(OUT_IDX, { recursive: true, force: true });
  await rm(OUT_DATA, { recursive: true, force: true });
  await mkdir(OUT_IDX, { recursive: true });
  const sources: SourceMeta[] = [];
  for (const src of SOURCES) {
    const out = join(OUT_DATA, src.id);
    await mkdir(out, { recursive: true });
    const { version, rows } = await loadRows(src, out);
    const { index, desc } = buildShard(rows);
    await writeFile(join(OUT_IDX, `${src.id}.json`), JSON.stringify(index));
    await writeFile(join(OUT_IDX, `${src.id}.desc.json`), JSON.stringify(desc));
    const { id, label, short, color, sample } = src;
    const extra = src.extra && { label: src.extra.label, ...(src.extra.warn && { warn: src.extra.warn }) };
    sources.push({ id, label, short, color, sample, extra, count: rows.length, version });
    console.log(`  ${src.id.padEnd(9)} ${String(rows.length).padStart(6)} cmdlets`);
  }
  const total = sources.reduce((a, s) => a + s.count, 0);
  // Shards are fetched as /idx/<id>.json?v=<build>; the id is bundled into the app, so HTML,
  // worker, index and descriptions always come from the same build.
  const build = Date.now().toString(36);
  await writeFile(join(ROOT, 'src', 'sources.generated.json'), JSON.stringify({ build, total, sources }, null, 2) + '\n');
  console.log(`  ${total} cmdlets indexed in ${Date.now() - t0} ms`);
}

main().catch((e) => { console.error(e); process.exit(1); });
