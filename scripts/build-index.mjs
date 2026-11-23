// Build-time step: turns the raw pipeline output in data/<source>/ into
//   src/sources.generated.json        – the source list (single source of truth for the app and worker)
//   public/idx/<source>.json          – columnar search index (names + facets), loaded first
//   public/idx/<source>.desc.json     – short descriptions aligned to the index, loaded after first paint
//   public/data/<source>/<module>.json – per-module detail, fetched on demand
import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DATA = join(ROOT, 'data');
const OUT_IDX = join(ROOT, 'public', 'idx');
const OUT_DATA = join(ROOT, 'public', 'data');
const DESC_MAX = 220;

const LEARN_MODULE = 'https://learn.microsoft.com/powershell/module/{module}/{name}';

// Every per-source fact lives here.
//   extra:  an optional per-cmdlet facet; `field` is its key in the pipeline's manifest rows,
//           `warn` a value shown as a caution (Graph/Entra "beta").
//   sample: the example search the intro panel offers.
const SOURCES = [
  { id: 'graph', label: 'Microsoft Graph', short: 'Graph', color: '#9b8cff', sample: 'Get-MgUser', learn: LEARN_MODULE, extra: { label: 'API', field: 'a', warn: 'beta' } },
  { id: 'az', label: 'Azure (Az)', short: 'Az', color: '#4cb3ff', sample: 'Get-AzVM', learn: LEARN_MODULE, extra: null },
  { id: 'entra', label: 'Microsoft Entra', short: 'Entra', color: '#2fd0b5', sample: 'Get-EntraGroupMember', learn: LEARN_MODULE, extra: { label: 'API', field: 'a', warn: 'beta' } },
  { id: 'exchange', label: 'Exchange, Teams & SharePoint', short: 'Exchange', color: '#f2b33d', sample: 'Set-Mailbox', learn: LEARN_MODULE, extra: null },
  { id: 'mecm', label: 'Configuration Manager', short: 'MECM', color: '#7fd45a', sample: 'Invoke-CMClientAction', learn: 'https://learn.microsoft.com/powershell/module/configurationmanager/{name}', extra: { label: 'Site role', field: 'r', warn: '' } },
];

const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));
const clip = (s) => {
  if (!s) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > DESC_MAX ? s.slice(0, DESC_MAX - 1).trimEnd() + '…' : s;
};

/**
 * Copy a source's module files to public/data/<source>/ and return its rows, sorted by name:
 *   { n: name, v: verb, m: module, c: category, f: module file, x: extra, p: permission count, e: has examples, desc }
 */
async function loadRows(src, out) {
  const dir = join(DATA, src.id);
  const manifest = await readJson(join(dir, 'manifest.json'));
  const descriptions = await readJson(join(dir, 'descriptions.json')).catch(() => ({}));
  // A name can live in several module files (Entra v1.0 + beta, Teams + Skype, Az.PostgreSql + Az.PostgreSqlFlexibleServer).
  const holders = new Map();
  for (const f of (await readdir(join(dir, 'modules'))).filter((f) => f.endsWith('.json'))) {
    const stem = basename(f, '.json');
    const body = await readJson(join(dir, 'modules', f));
    for (const [name, c] of Object.entries(body.cmdlets)) {
      holders.set(name, [...(holders.get(name) ?? []), stem]);
      c.description ??= descriptions[name];
    }
    await writeFile(join(out, f), JSON.stringify(body));
  }
  const rows = manifest.d.map((r) => {
    const files = (holders.get(r.n) ?? []).sort();
    return {
      n: r.n, v: r.v, m: r.m, c: r.c, p: r.p, e: r.e, desc: descriptions[r.n],
      x: src.extra ? r[src.extra.field] : '',
      f: files.includes(r.m) ? r.m : files[0], // prefer the file named after the row's own module
    };
  });
  const missing = rows.filter((r) => !r.f).length;
  if (missing) console.warn(`    ${missing} cmdlets have no detail file`);
  return { version: manifest.v, rows: rows.sort((a, b) => a.n.localeCompare(b.n)) };
}

function interner() {
  const list = [];
  const map = new Map();
  return {
    list,
    id(v = '') {
      let i = map.get(v);
      if (i === undefined) { i = list.length; list.push(v); map.set(v, i); }
      return i;
    },
  };
}

/** Rows (already in display order) -> the columnar `IndexShard` (src/app/types.ts) plus the aligned description array. */
function buildShard(rows) {
  const verbs = interner(), mods = interner(), cats = interner(), files = interner(), extras = interner();
  const index = { n: [], v: [], m: [], c: [], f: [], x: [], p: [], e: [], verbs: verbs.list, mods: mods.list, cats: cats.list, files: files.list, extras: extras.list };
  for (const r of rows) {
    index.n.push(r.n);
    index.v.push(verbs.id(r.v));
    index.m.push(mods.id(r.m));
    index.c.push(cats.id(r.c));
    index.f.push(files.id(r.f));
    index.x.push(extras.id(r.x));
    index.p.push(r.p ?? 0);
    index.e.push(r.e ? 1 : 0);
  }
  return { index, desc: rows.map((r) => clip(r.desc)) };
}

async function main() {
  const t0 = Date.now();
  await rm(OUT_IDX, { recursive: true, force: true });
  await rm(OUT_DATA, { recursive: true, force: true });
  await mkdir(OUT_IDX, { recursive: true });
  const sources = [];
  for (const src of SOURCES) {
    const out = join(OUT_DATA, src.id);
    await mkdir(out, { recursive: true });
    const { version, rows } = await loadRows(src, out);
    const { index, desc } = buildShard(rows);
    await writeFile(join(OUT_IDX, `${src.id}.json`), JSON.stringify(index));
    await writeFile(join(OUT_IDX, `${src.id}.desc.json`), JSON.stringify(desc));
    const { extra, ...meta } = src;
    sources.push({ ...meta, extraLabel: extra?.label ?? '', extraWarn: extra?.warn ?? '', count: rows.length, version: version ?? '' });
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
