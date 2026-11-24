// Build-time step: turns the raw pipeline output in data/<source>/ into
//   src/sources.generated.json – the source list and build id (single source of truth for the app and worker)
//   public/a/<build>/…        – per source: search shard, description shard, module files
//                               (paths: src/app/artifacts.ts)
// Everything written here is typed against src/app/types.ts, which the app reads it as.
import { readFile, writeFile, readdir, mkdir, rm, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, basename, dirname, relative } from 'node:path';
import { existsSync } from 'node:fs';
import { artifactPath } from '../src/app/artifacts.ts';
import type { CmdletDetail, CmdletFile, DocumentedParam, IndexShard, SourceMeta } from '../src/app/types.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const DATA = join(ROOT, 'data');
// Build artifacts live under public/a/<build>/, where <build> is a hash of their content. A page
// only ever asks for its own build's paths, so a tab left open across a deploy gets a 404 (and the
// load-failure path) rather than another build's files; unchanged data keeps its cached URLs.
const OUT = join(ROOT, 'public', 'a');
const STAGE = join(OUT, '.staging');
const DESC_MAX = 220;

interface SourceDef extends Pick<SourceMeta, 'id' | 'label' | 'short' | 'color' | 'sample'> {
  /** An optional per-cmdlet facet: `field` is its key in the manifest rows, `warn` a value shown as a caution. */
  extra: { label: string; field: string; warn?: string } | null;
  /**
   * For a pipeline whose rows carry no module, the module of every row. Its files are not named
   * after that module (MECM's are per category), so a row's file is the one file holding its name.
   */
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

// Read as unknown and checked field by field: a parser change that breaks the shape fails the build.
type RawParam = { name: string; type: string; required: boolean; description?: string };

/** One index row, before it is split into columns. */
interface Row { n: string; v: string; m: string; c: string; f: string; x: string; p: number; e: boolean; desc: string }

/** A data file's JSON; a parse error names the file (relative to the repo), of the hundreds the build reads. */
async function readJson(p: string): Promise<unknown> {
  const text = await readFile(p, 'utf8');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${relative(ROOT, p)}: ${(e as Error).message}`);
  }
}
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringRecord = (v: unknown): v is Record<string, string> => isObject(v) && Object.values(v).every((x) => typeof x === 'string');
const clip = (s: string) => {
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > DESC_MAX ? s.slice(0, DESC_MAX - 1).trimEnd() + '…' : s;
};

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const params = (v: unknown): v is RawParam[] => Array.isArray(v) && v.every((x) =>
  isObject(x) && typeof x.name === 'string' && typeof x.type === 'string' && typeof x.required === 'boolean' && (x.description === undefined || typeof x.description === 'string'));

/**
 * Prose from the docs as the reader should see it: line breaks the docs left as literal text
 * ("list:\\r- item") become spaces, whitespace collapses, and template placeholders ("{{ Fill in
 * the Synopsis }}") or stray markdown headings ("## SYNTAX") count as no text at all. A word that
 * is a Windows or UNC path ("C:\\reports", "\\\\server\\new") keeps its backslashes.
 */
function cleanText(s: string): string {
  const t = s
    .replace(/\S*\\[rn]\S*/g, (word) => (/(?:^|[^A-Za-z])[A-Za-z]:\\[\w.$]{2}|^\\\\/.test(word) ? word : word.replace(/\\[rn]/g, ' ')))
    .replace(/\s+/g, ' ')
    .trim();
  return /^\{\{.*\}\}$/.test(t) || /^#+\s/.test(t) ? '' : t;
}

/** An example that is only the docs template's placeholder ("PS C:\\> {{ Add example code here }}") is no example. */
const isPlaceholder = (x: string) => /^\{\{[\s\S]*\}\}$/.test(x.replace(/^PS [^>\n]*>\s*/gm, '').trim());

/** The detail shape the app reads: every field present, so the UI never guesses. */
function normalizeCmdlet(where: string, raw: unknown, description: string): CmdletDetail {
  if (!isObject(raw)) throw new Error(`${where}: not an object`);
  const c = raw;
  if (typeof c.syntax !== 'string') throw new Error(`${where}: syntax is not a string`);
  if (!strings(c.examples)) throw new Error(`${where}: examples is not a list of strings`);
  if (c.permissions !== undefined && !strings(c.permissions)) throw new Error(`${where}: permissions is not a list of strings`);
  if (c.parameters !== undefined && !params(c.parameters)) throw new Error(`${where}: parameters are not {name, type, required, description?}`);
  return {
    syntax: c.syntax,
    examples: c.examples.filter((x) => x.trim() && !isPlaceholder(x)), // pipelines can leave blank or template example blocks
    permissions: c.permissions ?? [], // only Graph and Entra document permissions
    // Only MECM documents parameters separately.
    parameters: (c.parameters ?? []).map((p): DocumentedParam => ({ ...p, description: cleanText(p.description ?? '') })),
    description, // descriptions.json is the one source, as for the index row
  };
}

/**
 * One manifest row, checked: the fields every source writes, the source's own extra facet, and
 * the module and module file the row resolves to. "Has examples" and the permission count are
 * read off that file's normalized entry, so the index and the detail pane cannot disagree.
 */
function parseManifestRow(src: SourceDef, raw: unknown, holders: Map<string, Map<string, CmdletDetail>>, descriptions: Record<string, string>): Row {
  if (!isObject(raw)) throw new Error(`${src.id} manifest: a row is not an object`);
  const r = raw;
  const name = typeof r.n === 'string' ? r.n : '';
  const fail = (what: string): never => { throw new Error(`${src.id} manifest, ${name || JSON.stringify(raw)}: ${what}`); };
  const str = (k: string) => { const v = r[k]; return typeof v === 'string' ? v : fail(`${k} is not a string`); };
  if (!name) fail('n (name) is not a string');
  // A one-module source's rows may name its module, but never another one.
  const m = src.module ? (r.m === undefined || r.m === src.module ? src.module : fail(`module ${String(r.m)} is not ${src.module}`)) : str('m');
  if (!m) fail('no module');
  const held = holders.get(name) ?? new Map<string, CmdletDetail>();
  const files = [...held.keys()].sort();
  if (!files.length) fail('no module file');
  // The file named after the row's module; for a one-module source, the one file holding the name.
  const f = files.includes(m) ? m : src.module && files.length === 1 ? files[0] : fail(`module ${m} matches none of its files (${files.join(', ')})`);
  const detail = held.get(f)!;
  return {
    n: name, v: str('v'), c: str('c'), m, f,
    e: detail.examples.length > 0,
    p: detail.permissions.length,
    x: src.extra ? str(src.extra.field) : '',
    desc: descriptions[name] ?? '',
  };
}

/** Writes build artifacts into the staging directory, hashing paths and bytes in write order. */
const hash = createHash('sha256');
async function emit(path: string, text: string) {
  hash.update(path + '\0' + text + '\0');
  await mkdir(dirname(join(STAGE, path)), { recursive: true });
  await writeFile(join(STAGE, path), text);
}

/** Write a source's normalized module files and return its rows, sorted by name. */
async function loadRows(src: SourceDef): Promise<{ version: string; rows: Row[]; fileVersions: Map<string, string> }> {
  const dir = join(DATA, src.id);
  const manifest = await readJson(join(dir, 'manifest.json'));
  if (!isObject(manifest)) throw new Error(`${src.id} manifest: not an object`);
  const rawDescriptions = await readJson(join(dir, 'descriptions.json'));
  if (!isStringRecord(rawDescriptions)) throw new Error(`${src.id} descriptions: not an object of strings`);
  const descriptions = Object.fromEntries(Object.entries(rawDescriptions).map(([n, d]) => [n, cleanText(d)]));
  // A name can live in several module files (Entra v1.0 + beta, Teams + Skype, Az.PostgreSql + Az.PostgreSqlFlexibleServer).
  const holders = new Map<string, Map<string, CmdletDetail>>(); // name -> module file -> entry
  const fileVersions = new Map<string, string>(); // module file -> its module's version ('' when unknown)
  for (const f of (await readdir(join(dir, 'modules'))).filter((f) => f.endsWith('.json')).sort()) {
    const stem = basename(f, '.json');
    const raw = await readJson(join(dir, 'modules', f));
    if (!isObject(raw) || !isObject(raw.cmdlets)) throw new Error(`${src.id}/${f}: cmdlets is not an object`);
    // A failed version lookup leaves it null or ''; MECM's files are per category and have none.
    if (raw.version !== undefined && raw.version !== null && typeof raw.version !== 'string') throw new Error(`${src.id}/${f}: version is not a string`);
    fileVersions.set(stem, raw.version ?? '');
    const file: CmdletFile = {};
    for (const [name, c] of Object.entries(raw.cmdlets)) {
      const detail = normalizeCmdlet(`${src.id}/${f} ${name}`, c, descriptions[name] ?? '');
      file[name] = detail;
      if (!holders.has(name)) holders.set(name, new Map());
      holders.get(name)!.set(stem, detail);
    }
    await emit(artifactPath.module(src.id, stem), JSON.stringify(file));
  }
  if (!Array.isArray(manifest.d)) throw new Error(`${src.id} manifest: d is not a list`);
  const version = manifest.v;
  // pipelines/common.py source_version guarantees a version; anything else is a broken manifest.
  if (typeof version !== 'string' || !version) throw new Error(`${src.id} manifest: v is not a version string`);
  const rows = manifest.d.map((r) => parseManifestRow(src, r, holders, descriptions));
  // The manifest lists each cmdlet of each module once, and every cmdlet in a module file.
  const listed = new Set<string>();
  for (const r of rows) {
    const key = `${r.n}@${r.m}`;
    if (listed.has(key)) throw new Error(`${src.id} manifest: ${r.n} (${r.m}) is listed twice`);
    listed.add(key);
  }
  const indexed = new Set(rows.map((r) => r.n));
  const unlisted = [...holders.keys()].filter((n) => !indexed.has(n));
  if (unlisted.length) throw new Error(`${src.id}: ${unlisted.length} cmdlets in module files have no manifest row (e.g. ${unlisted.slice(0, 3).join(', ')})`);
  // And every module file is some row's: a file no row opens would be published for nothing.
  const used = new Set(rows.map((r) => r.f));
  const unused = [...fileVersions.keys()].filter((f) => !used.has(f));
  if (unused.length) throw new Error(`${src.id}: module files no manifest row points to: ${unused.join(', ')}`);
  return { version, rows: rows.sort((a, b) => a.n.localeCompare(b.n)), fileVersions };
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
function buildShard(rows: Row[], fileVersions: Map<string, string>): { index: IndexShard; desc: string[] } {
  const verbs = interner(), mods = interner(), cats = interner(), files = interner(), extras = interner();
  const index: IndexShard = { n: [], v: [], m: [], c: [], f: [], x: [], p: [], e: [], verbs: verbs.list, mods: mods.list, cats: cats.list, files: files.list, fileVersions: [], extras: extras.list };
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
  index.fileVersions = files.list.map((f) => fileVersions.get(f) ?? '');
  return { index, desc: rows.map((r) => clip(r.desc)) };
}

/** SOURCES, data/<id>/ and pipelines/<id>/source.env must name the same sources. */
async function checkRegistries() {
  const ids = SOURCES.map((s) => s.id).sort().join(',');
  const dirs = async (root: string, marker?: string) => (await readdir(root, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && !d.name.startsWith('.')) // editor and OS folders (.cache, .idea) are no source
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
  // Stage the new build beside the current one; the current one stays until this one succeeds.
  await rm(STAGE, { recursive: true, force: true });
  const sources: SourceMeta[] = [];
  for (const src of SOURCES) {
    const { version, rows, fileVersions } = await loadRows(src);
    const { index, desc } = buildShard(rows, fileVersions);
    await emit(artifactPath.shard(src.id), JSON.stringify(index));
    await emit(artifactPath.desc(src.id), JSON.stringify(desc));
    const { id, label, short, color, sample } = src;
    const extra = src.extra && { label: src.extra.label, ...(src.extra.warn && { warn: src.extra.warn }) };
    sources.push({ id, label, short, color, sample, extra, count: rows.length, version });
    console.log(`  ${src.id.padEnd(9)} ${String(rows.length).padStart(6)} cmdlets`);
  }
  const total = sources.reduce((a, s) => a + s.count, 0);
  // The id is bundled into the page and the worker, which fetch only /a/<build>/… (sources.ts assetUrl).
  const build = hash.digest('hex').slice(0, 12);
  // Put the new build in place first, then drop the others: at no point is there no usable build.
  // (Unchanged data hashes the same, so this build may already be there.)
  if (existsSync(join(OUT, build))) await rm(STAGE, { recursive: true, force: true });
  else await rename(STAGE, join(OUT, build));
  for (const old of await readdir(OUT)) if (old !== build) await rm(join(OUT, old), { recursive: true, force: true });
  await writeFile(join(ROOT, 'src', 'sources.generated.json'), JSON.stringify({ build, total, sources }, null, 2) + '\n');
  console.log(`  ${total} cmdlets indexed in ${Date.now() - t0} ms`);
}

main().catch((e) => { console.error(e); process.exit(1); });
