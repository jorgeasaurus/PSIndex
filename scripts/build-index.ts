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
}

// Every per-source fact lives here.
const SOURCES: SourceDef[] = [
  { id: 'graph', label: 'Microsoft Graph', short: 'Graph', color: '#9b8cff', sample: 'Get-MgUser', extra: { label: 'API', field: 'a', warn: 'beta' } },
  { id: 'az', label: 'Azure (Az)', short: 'Az', color: '#4cb3ff', sample: 'Get-AzVM', extra: null },
  { id: 'entra', label: 'Microsoft Entra', short: 'Entra', color: '#2fd0b5', sample: 'Get-EntraGroupMember', extra: { label: 'API', field: 'a', warn: 'beta' } },
  { id: 'exchange', label: 'Exchange, Teams & SharePoint', short: 'Exchange', color: '#f2b33d', sample: 'Set-Mailbox', extra: null },
  { id: 'mecm', label: 'Configuration Manager', short: 'MECM', color: '#7fd45a', sample: 'Invoke-CMClientAction', module: 'ConfigurationManager', extra: { label: 'Site role', field: 'r' } },
];

// ---- Pipeline output (data/<source>/), as the parsers write it -----------------------------

interface ManifestRow { n: string; v: string; c: string; e: boolean; m?: string; p?: number; [extra: string]: unknown }
interface Manifest { v: string | null; d: ManifestRow[] }
interface RawCmdlet { syntax?: unknown; examples?: unknown; permissions?: unknown; parameters?: unknown; description?: unknown }
interface RawModuleFile { module: string; cmdlets: Record<string, RawCmdlet> }

/** One index row, before it is split into columns. */
interface Row { n: string; v: string; m: string; c: string; f: string; x: string; p: number; e: boolean; desc: string }

const readJson = async <T>(p: string): Promise<T> => JSON.parse(await readFile(p, 'utf8'));
const clip = (s: string) => {
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > DESC_MAX ? s.slice(0, DESC_MAX - 1).trimEnd() + '…' : s;
};

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const params = (v: unknown): v is DocumentedParam[] => Array.isArray(v) && v.every((x) =>
  typeof x?.name === 'string' && typeof x.type === 'string' && typeof x.required === 'boolean' && (x.description === undefined || typeof x.description === 'string'));

/** The detail shape the app reads: every field present, so the UI never guesses. */
function normalizeCmdlet(where: string, c: RawCmdlet, description: string): CmdletDetail {
  if (typeof c.syntax !== 'string') throw new Error(`${where}: syntax is not a string`);
  if (!strings(c.examples)) throw new Error(`${where}: examples is not a list of strings`);
  if (c.permissions !== undefined && !strings(c.permissions)) throw new Error(`${where}: permissions is not a list of strings`);
  if (c.parameters !== undefined && !params(c.parameters)) throw new Error(`${where}: parameters are not {name, type, required, description?}`);
  return {
    syntax: c.syntax,
    examples: c.examples,
    permissions: c.permissions ?? [], // only Graph and Entra document permissions
    parameters: c.parameters ?? [], // only MECM documents parameters separately
    description: typeof c.description === 'string' ? c.description : description,
  };
}

/** Write a source's normalized module files to public/data/<source>/ and return its rows, sorted by name. */
async function loadRows(src: SourceDef, out: string): Promise<{ version: string | null; rows: Row[] }> {
  const dir = join(DATA, src.id);
  const manifest = await readJson<Manifest>(join(dir, 'manifest.json'));
  const descriptions = await readJson<Record<string, string>>(join(dir, 'descriptions.json'));
  // A name can live in several module files (Entra v1.0 + beta, Teams + Skype, Az.PostgreSql + Az.PostgreSqlFlexibleServer).
  const holders = new Map<string, string[]>();
  for (const f of (await readdir(join(dir, 'modules'))).filter((f) => f.endsWith('.json'))) {
    const stem = basename(f, '.json');
    const raw = await readJson<RawModuleFile>(join(dir, 'modules', f));
    const file: CmdletFile = { module: raw.module, cmdlets: {} };
    for (const [name, c] of Object.entries(raw.cmdlets)) {
      holders.set(name, [...(holders.get(name) ?? []), stem]);
      file.cmdlets[name] = normalizeCmdlet(`${src.id}/${f} ${name}`, c, descriptions[name] ?? '');
    }
    await writeFile(join(out, f), JSON.stringify(file));
  }
  const rows = manifest.d.map((r): Row => {
    const files = (holders.get(r.n) ?? []).sort();
    const m = r.m ?? src.module ?? '';
    return {
      n: r.n, v: r.v, c: r.c, e: r.e, m,
      desc: descriptions[r.n] ?? '',
      p: r.p ?? 0, // only Graph and Entra record permission counts
      x: src.extra ? String(r[src.extra.field] ?? '') : '',
      f: files.includes(m) ? m : files[0] ?? '', // prefer the file named after the row's own module
    };
  });
  const checks: [string, (r: Row) => boolean][] = [['module', (r) => !r.m], ['module file', (r) => !r.f]];
  for (const [what, bad] of checks) {
    const missing = rows.filter(bad).map((r) => r.n);
    if (missing.length) throw new Error(`${src.id}: ${missing.length} cmdlets have no ${what} (e.g. ${missing.slice(0, 3).join(', ')})`);
  }
  return { version: manifest.v, rows: rows.sort((a, b) => a.n.localeCompare(b.n)) };
}

function interner() {
  const list: string[] = [];
  const map = new Map<string, number>();
  return {
    list,
    id(v: string) {
      if (typeof v !== 'string') throw new Error('missing value for an index column');
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
    sources.push({ id, label, short, color, sample, extra, count: rows.length, version: version ?? '' });
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
